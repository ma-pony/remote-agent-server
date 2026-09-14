import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { runProcess } from "../project-environments/project-environment-commands.js";
import { SkillContentError, readSkillMetadata, readSkillTree, skillTreeDigest } from "./skill-content.js";

export type SkillSourceStatus = "ready" | "syncing" | "failed";
export type SkillSourceErrorCode = "invalid_source" | "not_found" | "busy" | "refresh_failed" | "source_closed" | "invalid_content" | "content_too_large";

export class SkillSourceError extends Error {
  constructor(readonly code: SkillSourceErrorCode) {
    super(code);
    this.name = "SkillSourceError";
  }
}

export type SkillSource = {
  id: string; name: string; url: string; ref: string | null; path: string;
  status: SkillSourceStatus; lastSyncedAt: string | null; error: SkillSourceErrorCode | null;
  skillCount: number; warnings: string[];
};

export type SkillSourceCatalogItem = {
  id: string; name: string; description: string; directory: string; packageDirectory: string; skillPath: string;
  sourceId: string; packageName: string; repositoryUrl: string; ref: string | null; commit: string; revision: string;
  source: "git"; enabled: false; available: true;
};

export type SkillSourceCheckoutRequest = { url: string; ref: string | null; destination: string; signal: AbortSignal };
export type SkillSourceCheckout = (request: SkillSourceCheckoutRequest) => Promise<{ commit: string }>;
export type SkillSourceManagerOptions = { dataDir: string; checkout?: SkillSourceCheckout; operationTimeoutMs?: number };

type Persisted = { sources: SkillSource[]; catalog: SkillSourceCatalogItem[] };
type Plugin = { name: string; root: string; repositoryUrl: string; ref: string | null; commit: string; warnings: string[]; skillRoots?: string[]; entrySkills?: string[]; claude?: boolean; strict?: boolean; atMarketplaceRoot?: boolean };

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MARKETPLACE_PLUGINS = 1_000;
const isGitUrl = (value: string): boolean => {
  if (value.includes("?") || value.includes("#")) return false;
  if (/^git@[^:\s]+:[^\s]+$/.test(value)) return true;
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "ssh:") && (url.username === "" || url.username === "git") && url.password === "" && url.hostname !== ""; } catch { return false; }
};
const safeRef = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() !== "" && !value.startsWith("-") && !/[\0\r\n]/.test(value);
const normalizeGitUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const github = value.match(/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  return github === null ? value : `https://github.com/${github[1]}.git`;
};
const safePath = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return "";
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return "";
  if (isAbsolute(value) || normalized.includes("\\") || normalized.includes("\0") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return normalized;
};
const idFor = (url: string, ref: string | null, path: string): string => `git-${createHash("sha256").update(url).update("\0").update(ref ?? "").update("\0").update(path).digest("hex").slice(0, 20)}`;
const sourceRoot = (dataDir: string): string => join(dataDir, "skill-sources");
const sourceStatePath = (dataDir: string): string => join(sourceRoot(dataDir), "sources.json");
const within = (root: string, path: string): boolean => relative(root, path) === "" || !relative(root, path).startsWith(".." + "/") && relative(root, path) !== "..";

const copyTree = (source: string, destination: string): void => {
  for (const [path, file] of readSkillTree(source)) {
    const target = join(destination, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, { mode: file.mode });
  }
};

const skillDirectories = (root: string): string[] => {
  const found: string[] = [];
  const visit = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) throw new SkillSourceError("invalid_content");
    if (existsSync(join(directory, "SKILL.md"))) { readSkillTree(directory); found.push(directory); return; }
    for (const entry of readdirSync(directory).sort()) {
      if (entry === ".git" || entry === ".DS_Store") continue;
      const child = join(directory, entry);
      const childStat = lstatSync(child);
      if (childStat.isSymbolicLink()) throw new SkillSourceError("invalid_content");
      if (childStat.isDirectory()) visit(child);
    }
  };
  visit(root);
  return found;
};

const readJson = (path: string): unknown => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new SkillSourceError("invalid_content");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new SkillSourceError("invalid_content"); }
};
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;

const pluginManifest = (root: string): Record<string, unknown> | undefined => {
  const path = [join(root, ".codex-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json"), join(root, ".agents", "plugins", "plugin.json"), join(root, "plugin.json")].find(existsSync);
  if (path === undefined) return undefined;
  return object(readJson(path));
};

/** Publishes immutable Skill package snapshots from manually refreshed Git sources. */
export class SkillSourceManager {
  private readonly dataDir: string;
  private readonly checkout: SkillSourceCheckout;
  private readonly timeoutMs: number;
  private sources: SkillSource[] = [];
  private items: SkillSourceCatalogItem[] = [];
  private operation: Promise<unknown> | undefined;
  private activeController: AbortController | undefined;
  private closed = false;

  constructor({ dataDir, checkout = defaultCheckout, operationTimeoutMs = 30_000 }: SkillSourceManagerOptions) {
    this.dataDir = dataDir;
    this.checkout = checkout;
    this.timeoutMs = operationTimeoutMs;
    this.load();
  }

  list(): SkillSource[] { return this.sources.map((source) => ({ ...source, warnings: [...source.warnings] })); }
  catalog(): SkillSourceCatalogItem[] { return this.items.map((item) => ({ ...item })); }

  async add(input: { name: string; url: string; ref?: string | null; path?: string }): Promise<SkillSource> {
    if (this.closed) throw new SkillSourceError("source_closed");
    if (input.name.trim() === "" || !isGitUrl(input.url) || !safeRef(input.ref) || safePath(input.path) === undefined) throw new SkillSourceError("invalid_source");
    return this.exclusive(async () => {
      const ref = input.ref ?? null;
      const path = input.path ?? "";
      const source: SkillSource = { id: idFor(input.url, ref, path), name: input.name.trim(), url: input.url, ref, path, status: "syncing", lastSyncedAt: null, error: null, skillCount: 0, warnings: [] };
      if (this.sources.some((candidate) => candidate.id === source.id)) throw new SkillSourceError("invalid_source");
      this.sources.push(source); this.persist();
      try { await this.refreshLocked(source.id); return this.byId(source.id)!; }
      catch (error) { throw error; }
    });
  }

  async refresh(id: string): Promise<SkillSource> {
    if (this.closed) throw new SkillSourceError("source_closed");
    return this.exclusive(() => this.refreshLocked(id));
  }

  async remove(id: string): Promise<void> {
    if (this.closed) throw new SkillSourceError("source_closed");
    await this.exclusive(async () => {
      if (this.byId(id) === undefined) throw new SkillSourceError("not_found");
      this.sources = this.sources.filter((source) => source.id !== id);
      this.items = this.items.filter((item) => item.sourceId !== id);
      this.persist();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    await this.operation?.catch(() => undefined);
  }

  private async refreshLocked(id: string): Promise<SkillSource> {
    const source = this.byId(id);
    if (source === undefined) throw new SkillSourceError("not_found");
    source.status = "syncing"; source.error = null; this.persist();
    const stage = join(sourceRoot(this.dataDir), ".staging", `${source.id}-${randomUUID()}`);
    const controller = new AbortController();
    this.activeController = controller;
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs); deadline.unref();
    try {
      mkdirSync(stage, { recursive: true });
      const repository = join(stage, "repository");
      const result = await this.checkoutWithTimeout({ url: source.url, ref: source.ref, destination: repository, signal: controller.signal });
      const root = this.resolveSourcePath(repository, source.path);
      const { catalog, warnings, preservePackages } = await this.discover(source, root, result.commit, stage);
      const preserved = this.items.filter((item) => item.sourceId === source.id && preservePackages.has(item.packageName));
      this.items = [...this.items.filter((item) => item.sourceId !== source.id), ...catalog, ...preserved];
      source.status = "ready"; source.lastSyncedAt = new Date().toISOString(); source.error = null;
      source.skillCount = catalog.length + preserved.length; source.warnings = warnings;
      this.persist();
      return { ...source, warnings: [...source.warnings] };
    } catch (error) {
      source.status = "failed"; source.error = safeError(error); this.persist();
      if (error instanceof SkillSourceError && ["invalid_source", "not_found", "source_closed"].includes(error.code)) throw error;
      throw new SkillSourceError(source.error);
    } finally { clearTimeout(deadline); if (this.activeController === controller) this.activeController = undefined; if (existsSync(stage)) rmSync(stage, { force: true, recursive: true }); }
  }

  private async discover(source: SkillSource, root: string, commit: string, stage: string): Promise<{ catalog: SkillSourceCatalogItem[]; warnings: string[]; preservePackages: Set<string> }> {
    const warnings: string[] = [];
    const marketplace = [join(root, ".agents", "plugins", "marketplace.json"), join(root, ".claude-plugin", "marketplace.json")].find(existsSync);
    const discovered = marketplace === undefined
      ? { plugins: [{ name: source.id, root, repositoryUrl: source.url, ref: source.ref, commit, warnings: [],
        ...(pluginManifest(root) === undefined ? { skillRoots: ["__all__"] } : {
          claude: existsSync(join(root, ".claude-plugin", "plugin.json")) && !existsSync(join(root, ".codex-plugin", "plugin.json"))
        }) }], preservePackages: new Set<string>() }
      : await this.pluginsFromMarketplace(readJson(marketplace), root, source, commit, stage, warnings, marketplace.endsWith(".claude-plugin/marketplace.json"));
    const plugins = discovered.plugins;
    const catalog: SkillSourceCatalogItem[] = [];
    for (const plugin of plugins) {
      warnings.push(...plugin.warnings);
      let paths: string[];
      try { paths = this.pluginSkills(plugin); } catch (error) { warnings.push(`Skipped ${plugin.name}: invalid Skill content`); discovered.preservePackages.add(plugin.name); continue; }
      let revision: string;
      let packageDirectory: string;
      try {
        revision = skillTreeDigest(plugin.root);
        packageDirectory = join(sourceRoot(this.dataDir), source.id, "revisions", revision, safeName(plugin.name));
        if (!existsSync(packageDirectory)) {
          const temporary = join(stage, "packages", randomUUID());
          try { mkdirSync(temporary, { recursive: true }); copyTree(plugin.root, temporary); mkdirSync(dirname(packageDirectory), { recursive: true }); renameSync(temporary, packageDirectory); }
          catch (error) { if (existsSync(temporary)) rmSync(temporary, { force: true, recursive: true }); throw error; }
        }
      } catch { warnings.push(`Skipped ${plugin.name}: invalid Skill content`); discovered.preservePackages.add(plugin.name); continue; }
      const catalogStart = catalog.length;
      for (const directory of paths) {
        try {
          const details = readSkillMetadata(directory);
          if (details.name.trim() === "" || details.description.trim() === "") { warnings.push(`Skipped ${plugin.name}: Skill metadata is incomplete`); catalog.splice(catalogStart); discovered.preservePackages.add(plugin.name); break; }
          const skillPath = relative(plugin.root, directory) || ".";
          catalog.push({ id: createHash("sha256").update(source.id).update("\0").update(plugin.name).update("\0").update(skillPath).digest("hex").slice(0, 20), ...details, directory: skillPath === "." ? packageDirectory : join(packageDirectory, ...skillPath.split("/")), packageDirectory, skillPath, sourceId: source.id, packageName: plugin.name, repositoryUrl: plugin.repositoryUrl, ref: plugin.ref, commit: plugin.commit, revision, source: "git", enabled: false, available: true });
        } catch (error) { warnings.push(`Skipped ${plugin.name}: invalid Skill content`); catalog.splice(catalogStart); discovered.preservePackages.add(plugin.name); break; }
      }
    }
    return { catalog, warnings: [...new Set(warnings)], preservePackages: discovered.preservePackages };
  }

  private async pluginsFromMarketplace(value: unknown, root: string, source: SkillSource, commit: string, stage: string, warnings: string[], claude: boolean): Promise<{ plugins: Plugin[]; preservePackages: Set<string> }> {
    const manifest = object(value); const entries = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
    if (manifest === undefined || !Array.isArray(manifest.plugins)) throw new SkillSourceError("invalid_content");
    if (entries.length > MAX_MARKETPLACE_PLUGINS) throw new SkillSourceError("content_too_large");
    const plugins: Plugin[] = [];
    const preservePackages = new Set<string>();
    const names = new Set<string>();
    const pluginRoot = safePath(string(object(manifest?.metadata)?.pluginRoot));
    if (pluginRoot === undefined) throw new SkillSourceError("invalid_content");
    for (const entry of entries) {
      if (this.activeController?.signal.aborted) throw new SkillSourceError("refresh_failed");
      const plugin = object(entry); const name = string(plugin?.name);
      if (plugin === undefined || name === undefined) { warnings.push("Skipped marketplace entry with invalid metadata"); continue; }
      if (names.has(name)) { warnings.push(`Skipped ${name}: duplicate plugin name`); continue; }
      names.add(name);
      const candidate = plugin.source;
      const entrySkills = typeof plugin.skills === "string" ? [plugin.skills] : Array.isArray(plugin.skills) && plugin.skills.every((item) => typeof item === "string") ? plugin.skills : undefined;
      if (plugin.skills !== undefined && entrySkills === undefined) { warnings.push(`Skipped ${name}: invalid Skill paths`); continue; }
      const sourceObject = object(candidate);
      const sourceKind = string(sourceObject?.source);
      const bareSource = typeof candidate === "string" && !candidate.startsWith("./") && !candidate.includes("/") && pluginRoot !== "" ? `${pluginRoot}/${candidate}` : candidate;
      const local = typeof bareSource === "string" ? safePath(bareSource.replace(/^\.\//, "")) : undefined;
      const localPath = sourceKind === "local" ? safePath(string(sourceObject?.path)?.replace(/^\.\//, "")) : local;
      if (localPath !== undefined && (sourceKind === "local" || (typeof candidate === "string" && !isGitUrl(candidate)))) {
        let pluginRoot: string;
        try { pluginRoot = this.resolveSourcePath(root, localPath); }
        catch { warnings.push(`Skipped ${name}: local path is outside the marketplace or missing`); continue; }
        plugins.push({ name, root: pluginRoot, repositoryUrl: source.url, ref: source.ref, commit, warnings: [], entrySkills, claude, strict: plugin.strict !== false, atMarketplaceRoot: resolve(pluginRoot) === resolve(root) }); continue;
      }
      const url = normalizeGitUrl(sourceKind === "github" ? `github:${string(sourceObject?.repo) ?? ""}` : sourceKind?.startsWith("github:") ? sourceKind : typeof candidate === "string" ? candidate : string(sourceObject?.url) ?? string(sourceObject?.repository) ?? string(sourceObject?.github));
      const ref = string(sourceObject?.sha) ?? string(sourceObject?.ref) ?? null;
      const path = safePath(string(sourceObject?.path) ?? (sourceKind === "git-subdir" ? string(sourceObject?.subdir) : undefined));
      if (url === undefined || !isGitUrl(url) || !safeRef(ref) || path === undefined) { warnings.push(`Skipped ${name}: unsupported marketplace source`); continue; }
      const destination = join(stage, "external", String(plugins.length)); mkdirSync(dirname(destination), { recursive: true });
      try {
        const result = await this.checkoutWithTimeout({ url, ref, destination, signal: this.activeController!.signal });
        const pluginRoot = this.resolveSourcePath(destination, path);
        plugins.push({ name, root: pluginRoot, repositoryUrl: url, ref, commit: result.commit, warnings: [], entrySkills, claude, strict: plugin.strict !== false });
      } catch { warnings.push(`Skipped ${name}: unable to fetch plugin source`); preservePackages.add(name); }
    }
    return { plugins, preservePackages };
  }

  private resolveSourcePath(repository: string, path: string): string {
    const root = resolve(repository); const destination = resolve(root, path);
    if (!within(root, destination) || !existsSync(destination) || !lstatSync(destination).isDirectory()) throw new SkillSourceError("invalid_content");
    let current = root;
    for (const segment of relative(root, destination).split("/").filter((item) => item !== "")) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new SkillSourceError("invalid_content");
    }
    return destination;
  }
  private pluginSkills(plugin: Plugin): string[] {
    if (plugin.skillRoots?.includes("__all__")) return skillDirectories(plugin.root);
    const manifest = pluginManifest(plugin.root);
    const manifestSkills = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) && manifest.skills.every((value) => typeof value === "string") ? manifest.skills : undefined;
    if (plugin.claude && plugin.strict === false && manifestSkills !== undefined) throw new SkillSourceError("invalid_content");
    const declared = plugin.claude && plugin.strict !== false && (manifestSkills !== undefined || plugin.entrySkills !== undefined)
      ? [...(manifestSkills ?? []), ...(plugin.entrySkills ?? [])]
      : plugin.entrySkills ?? manifestSkills;
    const values = declared === undefined ? undefined : [...new Set(declared)];
    const roots = values === undefined
      ? (existsSync(join(plugin.root, "skills")) ? ["skills"] : existsSync(join(plugin.root, "SKILL.md")) ? [""] : [])
      : [...(plugin.claude && !plugin.atMarketplaceRoot && existsSync(join(plugin.root, "skills")) ? ["skills"] : []), ...values];
    const selected: string[] = [];
    for (const value of roots) {
      const normalized = safePath(value.replace(/^\.\//, ""));
      if (normalized === undefined) throw new SkillSourceError("invalid_content");
      const path = this.resolveSourcePath(plugin.root, normalized.endsWith("/SKILL.md") ? dirname(normalized) : normalized);
      if (existsSync(join(path, "SKILL.md"))) selected.push(path);
      else selected.push(...skillDirectories(path));
    }
    return [...new Set(selected)].sort();
  }
  private byId(id: string): SkillSource | undefined { return this.sources.find((source) => source.id === id); }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation !== undefined) return Promise.reject(new SkillSourceError("busy"));
    const pending = operation(); this.operation = pending;
    return pending.finally(() => { if (this.operation === pending) this.operation = undefined; });
  }
  private async checkoutWithTimeout(request: SkillSourceCheckoutRequest): Promise<{ commit: string }> {
    if (request.signal.aborted) throw new SkillSourceError("refresh_failed");
    const timeoutController = new AbortController();
    const stop = () => timeoutController.abort();
    request.signal.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(stop, this.timeoutMs); timeout.unref();
    try { return await this.checkout({ ...request, signal: timeoutController.signal }); }
    finally { clearTimeout(timeout); request.signal.removeEventListener("abort", stop); }
  }
  private load(): void {
    const root = sourceRoot(this.dataDir);
    if (existsSync(join(root, ".staging"))) rmSync(join(root, ".staging"), { force: true, recursive: true });
    const path = sourceStatePath(this.dataDir); if (!existsSync(path)) return;
    // This is our aggregate persisted catalog, not one external marketplace manifest.
    try { const saved = JSON.parse(readFileSync(path, "utf8")) as Persisted; if (Array.isArray(saved.sources) && Array.isArray(saved.catalog)) { this.sources = saved.sources.map((source) => source.status === "syncing" ? { ...source, status: "failed", error: "refresh_failed" } : source); this.items = saved.catalog.filter((item) => existsSync(item.packageDirectory)); this.persist(); } } catch { /* invalid interrupted state is ignored */ }
  }
  private persist(): void {
    const root = sourceRoot(this.dataDir); mkdirSync(root, { recursive: true });
    const temporary = join(root, `.sources-${randomUUID()}.json`); writeFileSync(temporary, JSON.stringify({ sources: this.sources, catalog: this.items }), { mode: 0o600 }); renameSync(temporary, sourceStatePath(this.dataDir));
  }
}

const safeName = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 20);
const safeError = (error: unknown): SkillSourceErrorCode => {
  if (error instanceof SkillSourceError) return error.code;
  if (error instanceof SkillContentError) return error.code === "skill_content_too_large" ? "content_too_large" : "invalid_content";
  return "refresh_failed";
};
const defaultCheckout: SkillSourceCheckout = async ({ url, ref, destination, signal }) => {
  if (signal.aborted || !safeRef(ref)) throw new SkillSourceError("refresh_failed");
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[], cwd?: string) => {
    if (signal.aborted) return Promise.reject(new SkillSourceError("refresh_failed"));
    return runProcess("git", ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.hooksPath=/dev/null", ...args], { cwd, environment, signal, timeoutMs: 30_000 });
  };
  await git(["init", "--template=", "--", destination]);
  await git(["remote", "add", "origin", url], destination);
  await git(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], destination);
  await git(["checkout", "--detach", "FETCH_HEAD"], destination);
  const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd: destination, environment: process.env, signal, timeoutMs: 30_000 });
  return { commit: result.stdout.trim() };
};
