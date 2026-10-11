import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

/** The env file that was loaded, if any. The doctor points client configs at it instead of copying its values. */
export let loadedEnvFile: string | undefined;

export function loadDotenv(): void {
  const candidates = [process.env.MOLPHA_ENV_FILE, ".env"].filter(
    (value): value is string => Boolean(value && value.trim().length > 0)
  );

  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      config({ path, override: false });
      loadedEnvFile = path;
      return;
    }
  }
}

loadDotenv();
