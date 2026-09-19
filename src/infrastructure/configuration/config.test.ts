import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadStoredConfig,
  setConfig,
  setJevEnabled,
  setJevFeature,
  setModelSelection,
} from "./config.js";

test("config migrates legacy Gemini files and persists provider selections", async () => {
  const previous = process.env.KAIRO_STATE_DIR;
  const directory = await mkdtemp(join(tmpdir(), "kairo-config-"));
  process.env.KAIRO_STATE_DIR = directory;
  try {
    assert.equal(await loadStoredConfig(), undefined);
    await writeFile(join(directory, "config.json"), '{"model":"gemini-legacy"}\n');
    assert.deepEqual(await loadConfig(), {
      provider: "gemini",
      model: "gemini-legacy",
      jevEnabled: false,
      jevRoutingEnabled: true,
      jevSafetyEnabled: true,
      jevRecoveryEnabled: true,
    });
    await setModelSelection({ provider: "groq", model: "openai/gpt-oss-120b" });
    assert.deepEqual(await loadConfig(), {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      jevEnabled: false,
      jevRoutingEnabled: true,
      jevSafetyEnabled: true,
      jevRecoveryEnabled: true,
    });
    await setJevEnabled(true);
    await setJevFeature("routing", false);
    await setConfig("model", "custom/groq");
    assert.deepEqual(await loadConfig(), {
      provider: "groq",
      model: "custom/groq",
      jevEnabled: true,
      jevRoutingEnabled: false,
      jevSafetyEnabled: true,
      jevRecoveryEnabled: true,
    });
  } finally {
    if (previous === undefined) delete process.env.KAIRO_STATE_DIR;
    else process.env.KAIRO_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
