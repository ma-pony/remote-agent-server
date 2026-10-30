import { accessSync, constants, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Provider } from "../domain.js";
import { runProcess } from "../project-environments/project-environment-commands.js";
import { removeServiceSecretsFromEnvironment } from "../runtime/service-path.js";
import { compareRtkVersions, fetchRtkBytes, fetchRtkRelease, RtkError, rtkTarget, unpackRtk } from "./rtk-download.js";
import { RTK_RECOMMENDED_VERSION, rtkVersionPattern, type RtkOperation, type RtkRelease, type RtkRunPlan, type RtkStatus } from "./rtk-types.js";

const versionSchema = z.string().regex(rtkVersionPattern);
const stateSchema = z.object({
  enabled: z.boolean(), currentVersion: versionSchema.nullable(), previousVersion: versionSchema.nullable(),
  latestVersion: versionSchema.nullable(), lastCheckedAt: z.string().datetime().nullable(), checkError: z.string().nullable()
});
type State = z.infer<typeof stateSchema>;
const defaults = (): State => ({ enabled: true, currentVersion: null, previousVersion: null, latestVersion: null, lastCheckedAt: null, checkError: null });
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const integrations = [
  { provider: "claude_code", integration: "hook" }, { provider: "codex", integration: "hook" },
  { provider: "hermes", integration: "plugin" }, { provider: "deepseek_harness", integration: "unsupported" }
] as const;

type Options = {
  dataDir: string;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  now?: () => Date;
  probe?: (binary: string, version: string, signal: AbortSignal) => Promise<void>;
};

/** One owner for RTK's desired state and atomically activated, immutable versions. */
export class RtkManager {
  private state: State;
  private operation: RtkOperation | null = null;
  private task: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly root: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly target: string | null;
  private readonly probe: NonNullable<Options["probe"]>;

  constructor(options: Options) {
    this.root = join(options.dataDir, "tools", "rtk");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    try { this.target = rtkTarget(options.platform ?? process.platform, options.arch ?? process.arch); }
    catch { this.target = null; }
    this.state = existsSync(join(this.root, "state.json"))
      ? stateSchema.parse(JSON.parse(readFileSync(join(this.root, "state.json"), "utf8"))) : defaults();
    this.probe = options.probe ?? (async (binary, version, signal) => {
      const environment = { ...process.env, HOME: dirname(binary), XDG_CONFIG_HOME: join(dirname(binary), ".config"),
        XDG_DATA_HOME: join(dirname(binary), ".data"), RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1" };
      removeServiceSecretsFromEnvironment(environment);
      const result = await runProcess(binary, ["--version"], { environment, signal, timeoutMs: 10_000 });
      if (!new RegExp(`^rtk\\s+${version.replaceAll(".", "\\.")}(?:\\s|$)`).test(result.stdout.trim())) throw new RtkError("rtk_version_mismatch");
      const rewrite = await runProcess(binary, ["rewrite", "git status"], { environment, signal, timeoutMs: 10_000, successExitCodes: [0, 3] });
      if (!rewrite.stdout.trim().includes("rtk")) throw new RtkError("rtk_self_test_failed");
    });
  }

  private binary(version: string): string { return join(this.root, "versions", version, "rtk"); }
  private save(patch: Partial<State>): void {
    const state = { ...this.state, ...patch };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, "state.json.tmp");
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, join(this.root, "state.json"));
    this.state = state;
  }

  /** Also excludes an operator running init against an already running service. */
  private lock(): () => void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "operation.lock");
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const temporary = `${path}.${randomUUID()}`;
    writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
    try {
      try { linkSync(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let alive = true;
        try { const owner = JSON.parse(readFileSync(path, "utf8")); process.kill(owner.pid, 0); }
        catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new RtkError("rtk_busy");
        unlinkSync(path);
        try { linkSync(temporary, path); } catch { throw new RtkError("rtk_busy"); }
      }
      if (existsSync(join(this.root, "state.json"))) this.state = stateSchema.parse(JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")));
      return () => { if (readFileSync(path, "utf8") === token) unlinkSync(path); };
    } finally { unlinkSync(temporary); }
  }

  status(): RtkStatus {
    if (!this.task && existsSync(join(this.root, "state.json"))) this.state = stateSchema.parse(JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")));
    const current = this.state.currentVersion;
    let installed = false;
    if (current) try { accessSync(this.binary(current), constants.X_OK); installed = statSync(this.binary(current)).isFile(); } catch {}
    return {
      ...this.state, installed, recommendedVersion: RTK_RECOMMENDED_VERSION,
      releaseUrl: this.state.latestVersion === null ? null : `https://github.com/rtk-ai/rtk/releases/tag/v${this.state.latestVersion}`,
      updateAvailable: this.state.latestVersion !== null && (current === null || compareRtkVersions(this.state.latestVersion, current) > 0),
      operation: this.operation === null ? null : { ...this.operation }, providers: integrations.map((item) => ({ ...item }))
    };
  }

  setEnabled(enabled: boolean): RtkStatus {
    // This manager already owns the disk lock. Activation merges the latest desired setting.
    if (this.task) { this.save({ enabled }); return this.status(); }
    const release = this.lock();
    try { this.save({ enabled }); return this.status(); } finally { release(); }
  }

  async resolveForRun(provider: Provider): Promise<RtkRunPlan> {
    this.status();
    const { enabled: requested, currentVersion: version } = this.state;
    const integration = integrations.find((item) => item.provider === provider)!.integration;
    let available = false;
    if (version !== null) try { await access(this.binary(version), constants.X_OK); available = true; } catch {}
    const reason = !requested ? "disabled" : !available ? "unavailable" : integration === "unsupported" ? "unsupported" : null;
    return { requested, enabled: reason === null, version, binaryPath: available ? this.binary(version!) : null,
      mode: reason !== null ? "off" : integration === "plugin" ? "plugin" : "hook", reason };
  }

  private begin(kind: RtkOperation["kind"], target: string | null, action: (signal: AbortSignal) => Promise<void>): RtkStatus {
    if (this.stopped) throw new RtkError("rtk_stopped");
    if (this.task) {
      if (kind === "check" && this.operation?.kind === "check") return this.status();
      throw new RtkError("rtk_busy");
    }
    const release = this.lock();
    this.operation = { kind, target, stage: "checking", error: null };
    this.controller = new AbortController();
    this.task = Promise.resolve().then(() => action(this.controller!.signal)).then(() => {
      this.operation!.stage = "succeeded";
    }, (error: unknown) => {
      const code = error instanceof RtkError ? error.code : this.controller?.signal.aborted ? "rtk_operation_cancelled"
        : this.operation?.stage === "testing" ? "rtk_self_test_failed"
        : ["checking", "downloading"].includes(this.operation?.stage ?? "") ? "rtk_download_failed" : "rtk_operation_failed";
      this.operation = { ...this.operation!, stage: "failed", error: code };
      if (kind === "check") try { this.save({ checkError: code }); } catch { /* Preserve the original state on disk. */ }
    }).finally(() => { this.task = undefined; this.controller = undefined; release(); });
    return this.status();
  }

  check(): RtkStatus {
    return this.begin("check", null, async (signal) => {
      if (!this.target) throw new RtkError("rtk_platform_unsupported");
      const release = await fetchRtkRelease(this.fetcher, this.target, null, signal);
      this.save({ latestVersion: release.version, lastCheckedAt: this.now().toISOString(), checkError: null });
    });
  }

  update(version: string): RtkStatus {
    if (!rtkVersionPattern.test(version)) throw new RtkError("rtk_invalid_version");
    if (version !== this.state.latestVersion && version !== this.state.currentVersion && !(this.state.currentVersion === null && version === RTK_RECOMMENDED_VERSION)) throw new RtkError("rtk_version_conflict");
    return this.begin("update", version, async (signal) => {
      if (!this.target) throw new RtkError("rtk_platform_unsupported");
      const release = await fetchRtkRelease(this.fetcher, this.target, version, signal);
      await this.install(release, signal);
    });
  }

  rollback(expectedVersion: string): RtkStatus {
    if (!this.state.previousVersion || expectedVersion !== this.state.previousVersion) throw new RtkError("rtk_version_conflict");
    return this.begin("rollback", expectedVersion, async (signal) => {
      this.operation!.stage = "testing";
      await this.probe(this.binary(expectedVersion), expectedVersion, signal);
      signal.throwIfAborted();
      this.operation!.stage = "activating";
      this.save({ currentVersion: expectedVersion, previousVersion: this.state.currentVersion });
    });
  }

  private async install(release: RtkRelease, signal: AbortSignal): Promise<void> {
    const versions = join(this.root, "versions");
    await mkdir(versions, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(versions, ".staging-"));
    try {
      this.operation!.stage = "downloading";
      const archive = await fetchRtkBytes(this.fetcher, release.downloadUrl, signal, 32 * 1024 * 1024, 120_000);
      this.operation!.stage = "verifying";
      const executable = await unpackRtk(archive, release.sha256);
      const path = join(staging, "rtk");
      await writeFile(path, executable, { mode: 0o700 });
      await chmod(path, 0o700);
      this.operation!.stage = "testing";
      await this.probe(path, release.version, signal);
      signal.throwIfAborted();
      const destination = join(versions, release.version);
      if (existsSync(destination)) {
        try {
          await access(this.binary(release.version), constants.X_OK);
          await this.probe(this.binary(release.version), release.version, signal);
        } catch {
          signal.throwIfAborted();
          // Replace only an unusable executable. Rename never truncates an executing inode.
          await rename(path, this.binary(release.version));
        }
      } else await rename(staging, destination);
      signal.throwIfAborted();
      this.operation!.stage = "activating";
      this.save({ currentVersion: release.version,
        previousVersion: this.state.currentVersion === release.version ? this.state.previousVersion : this.state.currentVersion });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async waitForIdle(): Promise<void> { await this.task; }

  /** Called before scheduling any Runs; live-process version directories are never reclaimed. */
  async recover(): Promise<void> {
    let release: () => void;
    try { release = this.lock(); } catch (error) { if (error instanceof RtkError && error.code === "rtk_busy") return; throw error; }
    try {
      const versions = join(this.root, "versions");
      let entries: string[];
      try { entries = await readdir(versions); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (entry.startsWith(".staging-") || (rtkVersionPattern.test(entry) && ![this.state.currentVersion, this.state.previousVersion].includes(entry)))
          await rm(join(versions, entry), { recursive: true, force: true });
      }
    } finally { release(); }
  }

  async ensureInstalled(): Promise<RtkStatus> {
    try {
      if (!(await this.inspect()).installed) { this.update(this.state.currentVersion ?? RTK_RECOMMENDED_VERSION); await this.waitForIdle(); }
    } catch (error) {
      this.operation = { kind: "update", target: this.state.currentVersion ?? RTK_RECOMMENDED_VERSION, stage: "failed",
        error: error instanceof RtkError ? error.code : "rtk_operation_failed" };
    }
    return this.status();
  }

  async inspect(): Promise<RtkStatus> {
    const status = this.status();
    if (status.installed && status.currentVersion) {
      try { await this.probe(this.binary(status.currentVersion), status.currentVersion, AbortSignal.timeout(15_000)); }
      catch { return { ...status, installed: false, operation: { kind: "check", stage: "failed", target: status.currentVersion, error: "rtk_local_check_failed" } }; }
    }
    return status;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = (): void => {
      if (this.stopped) return;
      const last = this.state.lastCheckedAt === null ? 0 : Date.parse(this.state.lastCheckedAt);
      if (!this.task && this.now().getTime() - last >= CHECK_INTERVAL) try { this.check(); } catch { /* Another installation owner may hold the lock. */ }
      this.timer = setTimeout(tick, 60 * 60 * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, 1_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.task;
  }
}
