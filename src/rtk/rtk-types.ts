import type { Provider } from "../domain.js";

export const RTK_RECOMMENDED_VERSION = "1.1.0";
export const rtkVersionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export type RtkRunSnapshot = {
  requested: boolean;
  enabled: boolean;
  version: string | null;
  mode: "hook" | "plugin" | "off";
  reason: "disabled" | "unavailable" | "unsupported" | null;
};
export type RtkRunPlan = RtkRunSnapshot & { binaryPath: string | null };
export type RtkRelease = { version: string; url: string; downloadUrl: string; sha256: string };
export type RtkOperation = {
  kind: "check" | "update" | "rollback";
  stage: "checking" | "downloading" | "verifying" | "testing" | "activating" | "succeeded" | "failed";
  target: string | null;
  error: string | null;
};
export type RtkStatus = {
  enabled: boolean;
  installed: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  recommendedVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  lastCheckedAt: string | null;
  checkError: string | null;
  operation: RtkOperation | null;
  providers: Array<{ provider: Provider; integration: "hook" | "plugin" | "unsupported" }>;
};
