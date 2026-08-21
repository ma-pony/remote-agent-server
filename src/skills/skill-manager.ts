import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";

export type SkillSource = "codex" | "agents" | "claude" | "plugin" | "upload" | "missing";

export type SkillCatalogItem = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
  available: boolean;
};

export type SkillRoot = {
  path: string;
  source: Exclude<SkillSource, "upload" | "missing">;
  recursive?: boolean;
};

type AvailableSkill = SkillCatalogItem & { directory: string };

export type SkillManagerOptions = {
  dataDir: string;
  roots?: SkillRoot[];
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

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) return trimmed.slice(1, -1);
  return trimmed;
};

const frontmatterValue = (header: string, field: string): string | undefined => {
  const lines = header.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (index === -1) return undefined;
  const value = lines[index]!.slice(field.length + 1).trim();
  if (![">", ">-", "|", "|-"].includes(value)) return unquote(value);
  const continuation: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line !== "" && !/^\s/.test(line)) break;
    if (line.trim() !== "") continuation.push(line.trim());
  }
  return continuation.join(value.startsWith("|") ? "\n" : " ");
};

const metadata = (directory: string): { name: string; description: string } => {
  const contents = readFileSync(join(directory, "SKILL.md"), "utf8");
  const header = contents.startsWith("---") ? contents.split(/^---\s*$/m)[1] ?? "" : "";
  const name = frontmatterValue(header, "name");
  const description = frontmatterValue(header, "description");
  return {
    name: name === undefined ? basename(directory) : name,
    description: description ?? ""
  };
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
  private hostSnapshot: { files: string[]; catalog: AvailableSkill[]; capturedAt: number } | undefined;

  constructor({ dataDir, roots = defaultRoots() }: SkillManagerOptions) {
    this.dataDir = dataDir;
    this.roots = roots;
  }

  list(agentId: number): SkillCatalogItem[] {
    const catalog = this.availableCatalog();
    const availableIds = new Set(catalog.map((skill) => skill.id));
    const result: SkillCatalogItem[] = catalog.map(({ directory: _directory, ...skill }) => ({
      ...skill,
      enabled: existsSync(this.destination(agentId, skill.id))
    }));
    for (const installed of this.installed(agentId)) {
      if (!availableIds.has(installed.id)) result.push(installed);
    }
    return result.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  setEnabled(agentId: number, id: string, enabled: boolean): SkillCatalogItem | undefined {
    const available = this.availableCatalog().find((skill) => skill.id === id);
    const current = this.list(agentId).find((skill) => skill.id === id);
    if (enabled) {
      if (available === undefined) return undefined;
      this.install(agentId, available);
      const { directory: _directory, ...skill } = available;
      return { ...skill, enabled: true };
    }
    if (current === undefined) return undefined;
    rmSync(this.destination(agentId, id), { force: true, recursive: true });
    return { ...current, enabled: false };
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

  upload(agentId: number, fileName: string, archive: Uint8Array): SkillCatalogItem {
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
      if (this.availableCatalog().some((skill) => skill.name === details.name)) {
        throw new SkillManagerError("skill_name_conflict");
      }
      const id = `upload-${createHash("sha256").update(details.name).digest("hex").slice(0, 20)}`;
      const directory = join(libraryRoot, id);
      this.replaceDirectory(temporary, directory);
      const skill: AvailableSkill = {
        id,
        ...details,
        source: "upload",
        enabled: false,
        available: true,
        directory
      };
      this.install(agentId, skill);
      const { directory: _directory, ...result } = skill;
      return { ...result, enabled: true };
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
            directory
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
    return [...byName.values()];
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
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .flatMap((entry) => {
        const directory = join(root, entry.name);
        if (!existsSync(join(directory, "SKILL.md"))) return [];
        try {
          return [{
            id: entry.name,
            ...metadata(directory),
            source: "missing" as const,
            enabled: true,
            available: false
          }];
        } catch {
          return [];
        }
      });
  }

  private install(agentId: number, skill: AvailableSkill): void {
    const root = join(this.dataDir, "agents", String(agentId), "skills");
    const destination = this.destination(agentId, skill.id);
    const token = randomUUID();
    const temporary = join(root, `.${skill.id}.tmp-${token}`);
    const backup = join(root, `.${skill.id}.backup-${token}`);
    let movedExisting = false;
    mkdirSync(root, { recursive: true });
    try {
      cpSync(skill.directory, temporary, { recursive: true });
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
    return join(this.dataDir, "agents", String(agentId), "skills", id);
  }
}

export class SkillManagerError extends Error {
  constructor(readonly code: "invalid_skill_archive" | "skill_archive_too_large" | "skill_name_conflict") {
    super(code);
    this.name = "SkillManagerError";
  }
}
