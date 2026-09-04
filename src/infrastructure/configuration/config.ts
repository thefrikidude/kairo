import { readFile, writeFile } from "node:fs/promises";
import { configPath, ensureStateDir } from "../filesystem/platform-paths.js";

export interface KairoConfig {
  model: string;
}
const defaults: KairoConfig = { model: "gemini-2.5-flash" };

/** Loads the user configuration, falling back to safe defaults when it is absent. */
export async function loadConfig(): Promise<KairoConfig> {
  try {
    return {
      ...defaults,
      ...(JSON.parse(await readFile(configPath(), "utf8")) as Partial<KairoConfig>),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw new Error(`Could not read Kairo config: ${(error as Error).message}`);
  }
}
/** Updates one supported configuration value while preserving all other settings. */
export async function setConfig(key: string, value: string): Promise<void> {
  if (key !== "model" || !value.trim())
    throw new Error("Only a non-empty `model` setting is supported.");
  const config = await loadConfig();
  config.model = value.trim();
  await ensureStateDir();
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
