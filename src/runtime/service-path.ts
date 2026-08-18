import { execFileSync } from "node:child_process";
import { delimiter, dirname } from "node:path";

const LOGIN_PATH_MARKER = "__REMOTE_AGENT_LOGIN_PATH__=";

type ServicePathInput = {
  execPath: string;
  loginPath?: string;
  servicePath?: string;
};

type ApplyServicePathInput = {
  environment?: Record<string, string | undefined>;
  execPath?: string;
  loadLoginPath?: (shell: string, environment: Record<string, string | undefined>) => string;
};

const isServiceSecret = (key: string): boolean => key === "API_TOKEN" || key.startsWith("SMOKE_");

const entries = (value: string | undefined): string[] =>
  (value ?? "").split(delimiter).map((entry) => entry.trim()).filter((entry) => entry !== "");

/** Merges the service Node directory, login Shell PATH and inherited service PATH without reordering them. */
export const buildServicePath = ({ execPath, loginPath, servicePath }: ServicePathInput): string => {
  const unique = new Set<string>();
  for (const entry of [dirname(execPath), ...entries(loginPath), ...entries(servicePath)]) unique.add(entry);
  return [...unique].join(delimiter);
};

/** Reads PATH from the service user's login and interactive Shell. */
export const loadLoginShellPath = (
  shell: string,
  environment: Record<string, string | undefined>
): string => {
  const output = execFileSync(
    shell,
    ["-lic", `printf '\n${LOGIN_PATH_MARKER}%s' "$PATH"`],
    {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    }
  );
  const markerIndex = output.lastIndexOf(LOGIN_PATH_MARKER);
  if (markerIndex === -1) throw new Error("login_shell_path_missing");
  return output.slice(markerIndex + LOGIN_PATH_MARKER.length).split(/\r?\n/, 1)[0] ?? "";
};

/** Hydrates the real service process PATH before Provider runtimes are created. */
export const applyServicePath = ({
  environment = process.env,
  execPath = process.execPath,
  loadLoginPath = loadLoginShellPath
}: ApplyServicePathInput = {}): string => {
  const shell = environment.SHELL?.trim()
    || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  let loginPath: string | undefined;
  try {
    loginPath = loadLoginPath(shell, environment);
  } catch (_error) {
    loginPath = undefined;
  }
  const resolved = buildServicePath({ execPath, loginPath, servicePath: environment.PATH });
  environment.PATH = resolved;
  return resolved;
};

/** Removes management and acceptance credentials before untrusted project or Provider processes start. */
export const removeServiceSecretsFromEnvironment = (
  environment: Record<string, string | undefined>
): void => {
  for (const key of Object.keys(environment)) {
    if (isServiceSecret(key)) delete environment[key];
  }
};
