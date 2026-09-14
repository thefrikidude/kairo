import { readFile, writeFile } from "node:fs/promises";
import type { ModelSelection } from "../../domain/models.js";
import { configPath, ensureStateDir } from "../filesystem/platform-paths.js";
import { isProviderId } from "../providers/provider-registry.js";

export interface KairoConfig extends ModelSelection {}
export const defaultConfig: KairoConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
};

/** Reads only an explicitly stored, valid config; legacy model-only files migrate to Gemini. */
export async function loadStoredConfig(): Promise<KairoConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as Partial<KairoConfig>;
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return undefined;
    return {
      provider: isProviderId(parsed.provider) ? parsed.provider : "gemini",
      model: parsed.model.trim(),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read Kairo config: ${(error as Error).message}`);
  }
}

/** Loads the user configuration, falling back to safe defaults when it is absent. */
export async function loadConfig(): Promise<KairoConfig> {
  return (await loadStoredConfig()) ?? { ...defaultConfig };
}

/** Persists an atomic provider/model selection without storing credentials. */
export async function setModelSelection(selection: ModelSelection): Promise<void> {
  if (!isProviderId(selection.provider) || !selection.model.trim())
    throw new Error("A supported provider and non-empty model are required.");
  await ensureStateDir();
  await writeFile(
    configPath(),
    `${JSON.stringify({ provider: selection.provider, model: selection.model.trim() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Updates one supported configuration value while preserving all other settings. */
export async function setConfig(key: string, value: string): Promise<void> {
  if (key !== "model" || !value.trim())
    throw new Error("Only a non-empty `model` setting is supported.");
  const config = await loadConfig();
  config.model = value.trim();
  await setModelSelection(config);
}
