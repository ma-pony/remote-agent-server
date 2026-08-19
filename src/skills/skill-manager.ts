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

/** Manages the host Skill catalog and each Agent's explicit Skill copies. */
export class SkillManager {
  private readonly dataDir: string;
  private readonly roots: SkillRoot[];

  constructor({ dataDir, roots = defaultRoots() }: SkillManagerOptions) {
    this.dataDir = dataDir;
    this.roots = roots;
  }

  list(agentId: number): SkillCatalogItem[] {
    const catalog = this.availableCatalog(agentId);
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
    const available = this.availableCatalog(agentId).find((skill) => skill.id === id);
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
    if (manifests.length !== 1) throw new SkillManagerError("invalid_skill_archive");
    const prefix = manifests[0]!.slice(0, -"SKILL.md".length);
    if (names.some((name) => !name.startsWith(prefix))) throw new SkillManagerError("invalid_skill_archive");

    const libraryRoot = join(this.dataDir, "agents", String(agentId), "skill-library");
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
      if (this.catalog().some((skill) => skill.name === details.name)) {
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
    const files: string[] = [];
    for (const root of this.roots) {
      const directories = root.recursive === true
        ? recursiveSkillDirectories(root.path)
        : directSkillDirectories(root.path);
      for (const directory of directories) files.push(join(directory, "SKILL.md"));
    }
    return [...new Set(files)];
  }

  private catalog(): AvailableSkill[] {
    const names = new Set<string>();
    const result: AvailableSkill[] = [];
    for (const root of this.roots) {
      const directories = root.recursive === true
        ? recursiveSkillDirectories(root.path)
        : directSkillDirectories(root.path);
      for (const directory of directories) {
        try {
          const details = metadata(directory);
          if (details.name === "" || names.has(details.name)) continue;
          names.add(details.name);
          result.push({
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
    return result;
  }

  private availableCatalog(agentId: number): AvailableSkill[] {
    return [...this.catalog(), ...this.uploadedCatalog(agentId)];
  }

  private uploadedCatalog(agentId: number): AvailableSkill[] {
    const root = join(this.dataDir, "agents", String(agentId), "skill-library");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".")) return [];
      const directory = join(root, entry.name);
      if (!existsSync(join(directory, "SKILL.md"))) return [];
      try {
        return [{
          id: entry.name,
          ...metadata(directory),
          source: "upload" as const,
          enabled: false,
          available: true,
          directory
        }];
      } catch {
        return [];
      }
    });
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
