import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** Reads dotenv as data. Values already supplied by the host take precedence. */
export const readEnvironmentFile = (
  path: string,
  environment: Record<string, string | undefined>
): Record<string, string> => {
  const values: Record<string, string> = {};
  try {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      if (value !== undefined) values[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) values[key] = value;
  }
  return values;
};
