import test from "node:test";
import assert from "node:assert/strict";
import { MacOSKeychainStore } from "./macos-keychain-store.js";

test("credentials use independent provider services and environment overrides", async () => {
  const calls: string[][] = [];
  const store = new MacOSKeychainStore(
    async (_file, args) => {
      calls.push(args);
      if (args[0] === "find-generic-password") return { stdout: "saved-key\n" };
      return { stdout: "" };
    },
    { GROQ_API_KEY: "environment-key" },
  );
  assert.equal(await store.get("groq"), "environment-key");
  assert.equal(calls.length, 0);
  assert.equal(await store.get("gemini"), "saved-key");
  await store.save("groq", "gsk_saved");
  await store.clear("gemini");
  await store.save("openrouter", "or_saved");
  await store.save("jev", "ts_saved");
  assert.ok(calls.some((args) => args.includes("dev.kairo.gemini")));
  assert.ok(calls.some((args) => args.includes("dev.kairo.groq")));
  assert.ok(calls.some((args) => args.includes("dev.kairo.openrouter")));
  assert.ok(calls.some((args) => args.includes("dev.kairo.jev")));
  assert.doesNotMatch(JSON.stringify(calls), /environment-key/);
});
