import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { SkillContentError, readSkillMetadata as metadata, readSkillTree, skillTreeDigest } from "./skill-content.js";
import { installationFile, installedSkillDirectory, readInstallation, SkillRevisions, type SkillPackage, type SkillRevision } from "./skill-revisions.js";

export type SkillSource = "codex" | "agents" | "claude" | "plugin" | "upload" | "git" | "missing";

export type SkillCatalogItem = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
  available: boolean;
  sourceId?: string;
  packageName?: string;
  currentRevision?: string;
  latestRevision?: string;
  updateAvailable?: boolean;
  locallyModified?: boolean;
};

export type SkillRoot = {
  path: string;
  source: Exclude<SkillSource, "upload" | "missing" | "git">;
  recursive?: boolean;
};

type AvailableSkill = SkillCatalogItem & SkillPackage;

export type SkillManagerOptions = {
  dataDir: string;
  roots?: SkillRoot[];
  sourceCatalog?: () => AvailableSkill[];
};

export type SkillRemoveScope = "current" | "all";
export type SkillRemoveResult = "removed" | "not_found" | "global_delete_unsupported";

const maxArchiveBytes = 10 * 1024 * 1024;
const maxExtractedBytes = 50 * 1024 * 1024;
const maxArchiveFiles = 1_000;

const defaultRoots = (): SkillRoot[] => {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  return [
    { path: join(codexHome, "skills"), source: "codex", recursive: true },
    { path: join(home, ".agents", "skills"), source: "agents" },
    { path: join(home, ".claude", "skills"), source: "claude" },
    { path: join(codexHome, "plugins", "cache"), source: "plugin", recursive: true }
  ];
};

const directSkillDirectories = (root: string): string[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => join(root, entry.name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, "SKILL.md"));
      } catch {
        return false;
      }
    })
    .sort();
};

const recursiveSkillDirectories = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    if (existsSync(join(directory, "SKILL.md"))) {
      found.push(directory);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  visit(root);
  return found;
};

const skillId = (directory: string): string => createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 20);
const HOST_SKILL_CACHE_TTL_MS = 30_000;

/** Manages the host Skill catalog and each Agent's explicit Skill copies. */
export class SkillManager {
  private readonly dataDir: string;
  private readonly roots: SkillRoot[];
  private readonly revisions: SkillRevisions;
  private readonly sourceCatalog: () => AvailableSkill[];
  private hostSnapshot: { files: string[]; catalog: AvailableSkill[]; capturedAt: number } | undefined;

  constructor({ dataDir, roots = defaultRoots(), sourceCatalog = () => [] }: SkillManagerOptions) {
    this.dataDir = dataDir;
    this.roots = roots;
    this.revisions = new SkillRevisions(dataDir);
    this.sourceCatalog = sourceCatalog;
    this.recoverInstallations();
  }

  list(agentId: number): SkillCatalogItem[] {
    const catalog = this.availableCatalog();
    const availableIds = new Set(catalog.map((skill) => skill.id));
    const result: SkillCatalogItem[] = catalog.map((skill) => {
      const current = this.current(agentId, skill.id);
      const selected = current === undefined ? skill : this.selectedMetadata(agentId, skill.id);
      const latestRevision = current === undefined && skill.source !== "git"
        ? undefined : this.revisions.describe(skill).revision;
      return {
        id: skill.id, name: selected.name, description: selected.description, source: skill.source,
        available: true, enabled: current !== undefined,
        ...(skill.sourceId === undefined ? {} : { sourceId: skill.sourceId }),
        ...(skill.packageName === undefined ? {} : { packageName: skill.packageName }),
        ...(latestRevision === undefined ? {} : { latestRevision }),
        ...(current === undefined ? {} : {
          currentRevision: current.revision, locallyModified: current.locallyModified,
          updateAvailable: current.revision !== latestRevision
        })
      };
    });
    for (const installed of this.installed(agentId)) {
      if (!availableIds.has(installed.id)) result.push(installed);
    }
    return result.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  setEnabled(agentId: number, id: string, enabled: boolean): SkillCatalogItem | undefined {
    const available = this.availableCatalog().find((skill) => skill.id === id);
    const current = this.list(agentId).find((skill) => skill.id === id);
    if (enabled) {
      if (current?.enabled) return current;
      if (available === undefined) return undefined;
      if (this.list(agentId).some((skill) => skill.enabled && skill.id !== id && skill.name === available.name)) {
        throw new SkillManagerError("skill_name_conflict");
      }
      this.installRevision(agentId, this.revisions.save(available));
      return this.list(agentId).find((skill) => skill.id === id);
    }
    if (current === undefined) return undefined;
    rmSync(this.destination(agentId, id), { force: true, recursive: true });
    return this.list(agentId).find((skill) => skill.id === id) ?? { id, name: current.name, description: current.description, source: "missing", enabled: false, available: false };
  }

  revisionHistory(agentId: number, id: string): { currentRevision: string | null; latestRevision: string | null; revisions: SkillRevision[] } {
    const available = this.availableCatalog().find((skill) => skill.id === id);
    const current = this.current(agentId, id);
    if (available === undefined && current === undefined) throw new SkillManagerError("skill_not_found");
    const revisions = this.revisions.list(id);
    const latest = available === undefined ? undefined : this.revisions.describe(available);
    if (latest !== undefined && !revisions.some((item) => item.revision === latest.revision)) revisions.unshift(latest);
    return { currentRevision: current?.revision ?? null, latestRevision: latest?.revision ?? null, revisions };
  }

  diff(agentId: number, id: string, revision: string): SkillDiff {
    const target = this.resolveRevision(id, revision);
    const current = this.current(agentId, id);
    if (current === undefined) throw new SkillManagerError("skill_not_enabled");
    const before = readSkillTree(realpathSync(this.destination(agentId, id)), true);
    const after = readSkillTree(target.directory);
    const files: SkillDiff["files"] = [];
    let previewBytes = 0;
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const previous = before.get(path);
      const next = after.get(path);
      if (previous !== undefined && next !== undefined && previous.mode === next.mode && previous.contents.equals(next.contents)) continue;
      const canPreview = [previous, next].every((file) => file === undefined || (
        file.contents.length <= 8_192 && !file.contents.includes(0)
        && Buffer.from(file.contents.toString("utf8")).equals(file.contents)
      ));
      const size = (previous?.contents.length ?? 0) + (next?.contents.length ?? 0);
      const includeText = canPreview && previewBytes + size <= 64 * 1024;
      if (includeText) previewBytes += size;
      files.push({ path, status: previous === undefined ? "added" : next === undefined ? "removed" : "modified",
        ...(includeText ? { before: previous?.contents.toString("utf8") ?? "", after: next?.contents.toString("utf8") ?? "" } : {}),
        beforeMode: previous?.mode ?? null, afterMode: next?.mode ?? null
      });
    }
    return { revision, expectedRevision: current.revision, locallyModified: current.locallyModified, files };
  }

  applyRevision(agentId: number, id: string, revision: string, expectedRevision: string): SkillCatalogItem {
    const current = this.current(agentId, id);
    if (current === undefined) throw new SkillManagerError("skill_not_enabled");
    if (current.locallyModified) throw new SkillManagerError("skill_locally_modified");
    if (current.revision !== expectedRevision) throw new SkillManagerError("skill_revision_conflict");
    const target = this.resolveRevision(id, revision);
    if (this.list(agentId).some((skill) => skill.enabled && skill.id !== id && skill.name === target.details.name)) {
      throw new SkillManagerError("skill_name_conflict");
    }
    if (readInstallation(this.destination(agentId, id)) === undefined) {
      const directory = this.destination(agentId, id);
      this.revisions.save({ id, ...metadata(directory), source: "missing", directory: realpathSync(directory) });
    }
    const details = target.available === undefined ? target.details : this.revisions.save(target.available);
    if (details.revision !== revision) throw new SkillManagerError("skill_revision_conflict");
    this.installRevision(agentId, details);
    return this.list(agentId).find((skill) => skill.id === id)!;
  }

  private resolveRevision(id: string, revision: string): { details: SkillRevision; directory: string; available?: AvailableSkill } {
    const saved = this.revisions.get(id, revision);
    if (saved !== undefined) return { details: saved, directory: this.revisions.content(id, revision) };
    const available = this.availableCatalog().find((skill) => skill.id === id);
    if (available !== undefined) {
      const details = this.revisions.describe(available);
      if (details.revision === revision) return { details, directory: available.packageDirectory ?? available.directory, available };
    }
    throw new SkillManagerError("skill_revision_not_found");
  }

  private current(agentId: number, id: string): { revision: string; locallyModified: boolean } | undefined {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return undefined;
    const directory = this.destination(agentId, id);
    if (!existsSync(directory)) return undefined;
    const record = readInstallation(directory);
    if (record !== undefined && !existsSync(join(installedSkillDirectory(directory), "SKILL.md"))) {
      return { revision: record.revision, locallyModified: true };
    }
    try {
      const actual = skillTreeDigest(realpathSync(directory), true);
      return { revision: record?.revision ?? actual, locallyModified: record !== undefined && actual !== record.revision };
    } catch (error) {
      if (record !== undefined && error instanceof SkillContentError) return { revision: record.revision, locallyModified: true };
      throw error;
    }
  }

  private selectedMetadata(agentId: number, id: string): { name: string; description: string } {
    const directory = this.destination(agentId, id);
    try { return metadata(installedSkillDirectory(directory)); }
    catch (error) {
      const record = readInstallation(directory);
      if (record === undefined) throw error;
      return { name: record.name, description: record.description };
    }
  }

  remove(agentId: number, id: string, scope: SkillRemoveScope): SkillRemoveResult {
    const current = this.list(agentId).find((skill) => skill.id === id);
    if (current === undefined) return "not_found";
    if (scope === "current") {
      rmSync(this.destination(agentId, id), { force: true, recursive: true });
      return "removed";
    }
    if (current.source !== "upload") return "global_delete_unsupported";

    rmSync(join(this.dataDir, "skill-library", id), { force: true, recursive: true });
    const agentsRoot = join(this.dataDir, "agents");
    if (existsSync(agentsRoot)) {
      for (const agent of readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        rmSync(join(agentsRoot, agent.name, "skills", id), { force: true, recursive: true });
        rmSync(join(agentsRoot, agent.name, "skill-library", id), { force: true, recursive: true });
      }
    }
    return "removed";
  }

  upload(agentId: number, fileName: string, archive: Uint8Array, replaceId?: string): SkillCatalogItem {
    if (!fileName.toLowerCase().endsWith(".zip")) throw new SkillManagerError("invalid_skill_archive");
    if (archive.byteLength > maxArchiveBytes) throw new SkillManagerError("skill_archive_too_large");
    let extractedBytes = 0;
    let fileCount = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(archive, {
        filter: (file) => {
          this.validateArchivePath(file.name);
          fileCount += 1;
          if (fileCount > maxArchiveFiles) throw new SkillManagerError("skill_archive_too_large");
          if (file.name.endsWith("/") || file.name.startsWith("__MACOSX/") || file.name.endsWith("/.DS_Store")) {
            return false;
          }
          extractedBytes += file.originalSize;
          if (extractedBytes > maxExtractedBytes) {
            throw new SkillManagerError("skill_archive_too_large");
          }
          return true;
        }
      });
    } catch (error) {
      if (error instanceof SkillManagerError) throw error;
      throw new SkillManagerError("invalid_skill_archive");
    }

    const names = Object.keys(files);
    const manifests = names.filter((name) => name === "SKILL.md" || name.endsWith("/SKILL.md"));
    const roots = manifests
      .map((manifest) => manifest.slice(0, -"SKILL.md".length))
      .filter((prefix) => names.every((name) => name.startsWith(prefix)));
    if (roots.length !== 1) throw new SkillManagerError("invalid_skill_archive");
    const prefix = roots[0]!;

    const libraryRoot = join(this.dataDir, "skill-library");
    const temporary = join(libraryRoot, `.upload-${randomUUID()}`);
    mkdirSync(temporary, { recursive: true });
    try {
      for (const [name, contents] of Object.entries(files)) {
        const relative = name.slice(prefix.length);
        if (relative === "") continue;
        const destination = join(temporary, ...relative.split("/"));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, contents, { mode: 0o700 });
      }
      const details = metadata(temporary);
      if (details.name.trim() === "" || details.description.trim() === "") {
        throw new SkillManagerError("invalid_skill_archive");
      }
      const previous = replaceId === undefined ? undefined : this.availableCatalog().find((skill) => skill.id === replaceId);
      if (replaceId !== undefined && (previous?.source !== "upload" || previous.name !== details.name)) {
        throw new SkillManagerError("invalid_skill_archive");
      }
      if (this.availableCatalog().some((skill) => skill.name === details.name && skill.id !== replaceId)) {
        throw new SkillManagerError("skill_name_conflict");
      }
      const id = `upload-${createHash("sha256").update(details.name).digest("hex").slice(0, 20)}`;
      const directory = join(libraryRoot, id);
      if (previous !== undefined) this.revisions.save(previous);
      this.replaceDirectory(temporary, directory);
      const skill: AvailableSkill = {
        id,
        ...details,
        source: "upload",
        enabled: false,
        available: true,
        directory
      };
      const revision = this.revisions.save(skill);
      if (replaceId === undefined) this.installRevision(agentId, revision);
      return this.list(agentId).find((item) => item.id === id)!;
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { force: true, recursive: true });
      if (error instanceof SkillManagerError) throw error;
      throw new SkillManagerError("invalid_skill_archive");
    }
  }

  hostSkillFiles(): string[] {
    return [...this.hostSkills().files];
  }

  private hostSkills(): { files: string[]; catalog: AvailableSkill[] } {
    if (this.hostSnapshot !== undefined && Date.now() - this.hostSnapshot.capturedAt < HOST_SKILL_CACHE_TTL_MS) {
      return this.hostSnapshot;
    }
    const files: string[] = [];
    const names = new Set<string>();
    const catalog: AvailableSkill[] = [];
    for (const root of this.roots) {
      const directories = root.recursive === true
        ? recursiveSkillDirectories(root.path)
        : directSkillDirectories(root.path);
      for (const directory of directories) {
        files.push(join(directory, "SKILL.md"));
        try {
          const details = metadata(directory);
          if (details.name === "" || names.has(details.name)) continue;
          names.add(details.name);
          catalog.push({
            id: skillId(directory),
            ...details,
            source: root.source,
            enabled: false,
            available: true,
            directory: realpathSync(directory)
          });
        } catch {
          // A broken host Skill is not safe to offer for installation.
        }
      }
    }
    this.hostSnapshot = { files: [...new Set(files)], catalog, capturedAt: Date.now() };
    return this.hostSnapshot;
  }

  private catalog(): AvailableSkill[] {
    return this.hostSkills().catalog.filter(({ directory }) => existsSync(join(directory, "SKILL.md")));
  }

  private availableCatalog(): AvailableSkill[] {
    const byName = new Map<string, AvailableSkill>();
    for (const skill of [...this.catalog(), ...this.uploadedCatalog()]) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    return [...byName.values(), ...this.sourceCatalog()];
  }

  private uploadedCatalog(): AvailableSkill[] {
    const roots = [join(this.dataDir, "skill-library")];
    const agentsRoot = join(this.dataDir, "agents");
    if (existsSync(agentsRoot)) {
      for (const agent of readdirSync(agentsRoot, { withFileTypes: true })) {
        if (agent.isDirectory()) roots.push(join(agentsRoot, agent.name, "skill-library"));
      }
    }
    const found = new Map<string, AvailableSkill>();
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || found.has(entry.name)) continue;
        const directory = join(root, entry.name);
        if (!existsSync(join(directory, "SKILL.md"))) continue;
        try {
          found.set(entry.name, {
            id: entry.name,
            ...metadata(directory),
            source: "upload",
            enabled: false,
            available: true,
            directory
          });
        } catch {
          // Invalid uploaded Skills are not offered to other Agents.
        }
      }
    }
    return [...found.values()];
  }

  private installed(agentId: number): SkillCatalogItem[] {
    const root = join(this.dataDir, "agents", String(agentId), "skills");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .flatMap((entry) => {
        const directory = join(root, entry.name);
        try {
          const current = this.current(agentId, entry.name);
          if (current === undefined) return [];
          const record = readInstallation(directory);
          return [{
            id: entry.name,
            ...this.selectedMetadata(agentId, entry.name),
            source: "missing" as const,
            enabled: true,
            available: false,
            currentRevision: current.revision,
            locallyModified: current.locallyModified,
            ...(record?.sourceId === undefined ? {} : { sourceId: record.sourceId }),
            ...(record?.packageName === undefined ? {} : { packageName: record.packageName })
          }];
        } catch {
          return [];
        }
      });
  }

  private installRevision(agentId: number, skill: SkillRevision): void {
    const root = join(this.dataDir, "agents", String(agentId), "skills");
    const destination = this.destination(agentId, skill.id);
    const token = randomUUID();
    const temporary = join(root, `.${skill.id}.tmp-${token}`);
    const backup = join(root, `.${skill.id}.backup-${token}`);
    let movedExisting = false;
    mkdirSync(root, { recursive: true });
    try {
      cpSync(this.revisions.content(skill.id, skill.revision), temporary, { recursive: true });
      writeFileSync(join(temporary, installationFile), JSON.stringify(skill), { mode: 0o600 });
      if (existsSync(destination)) {
        renameSync(destination, backup);
        movedExisting = true;
      }
      renameSync(temporary, destination);
      if (movedExisting) rmSync(backup, { force: true, recursive: true });
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { force: true, recursive: true });
      if (!existsSync(destination) && movedExisting && existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
  }

  private replaceDirectory(source: string, destination: string): void {
    const backup = `${destination}.backup-${randomUUID()}`;
    let movedExisting = false;
    try {
      if (existsSync(destination)) {
        renameSync(destination, backup);
        movedExisting = true;
      }
      renameSync(source, destination);
      if (movedExisting) rmSync(backup, { force: true, recursive: true });
    } catch (error) {
      if (!existsSync(destination) && movedExisting && existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
  }

  private validateArchivePath(path: string): void {
    const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
    const segments = normalized.split("/");
    if (
      normalized === ""
      || normalized.length > 1_024
      || path.includes("\0")
      || path.includes("\\")
      || path.startsWith("/")
      || /^[A-Za-z]:/.test(path)
      || segments.some((segment) => segment === "." || segment === ".." || segment === "")
    ) throw new SkillManagerError("invalid_skill_archive");
  }

  private destination(agentId: number, id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new SkillManagerError("skill_not_found");
    return join(this.dataDir, "agents", String(agentId), "skills", id);
  }

  private recoverInstallations(): void {
    const agents = join(this.dataDir, "agents");
    if (!existsSync(agents)) return;
    for (const agent of readdirSync(agents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const root = join(agents, agent.name, "skills");
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const match = name.match(/^\.([a-zA-Z0-9_-]+)\.(backup|tmp)-[a-f0-9-]+$/);
        if (match === null) continue;
        const path = join(root, name);
        const destination = join(root, match[1]!);
        if (match[2] === "backup" && !existsSync(destination)) renameSync(path, destination);
        else rmSync(path, { recursive: true, force: true });
      }
    }
  }
}

export type SkillDiff = {
  revision: string;
  expectedRevision: string;
  locallyModified: boolean;
  files: { path: string; status: "added" | "removed" | "modified"; before?: string; after?: string; beforeMode: number | null; afterMode: number | null }[];
};

export class SkillManagerError extends Error {
  constructor(readonly code: "invalid_skill_archive" | "skill_archive_too_large" | "skill_name_conflict" | "skill_not_found" | "skill_revision_not_found" | "skill_revision_conflict" | "skill_locally_modified" | "skill_not_enabled") {
    super(code);
    this.name = "SkillManagerError";
  }
}
