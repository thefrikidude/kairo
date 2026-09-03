import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";

test("sessions persist messages and sort by latest activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-store-"));
  const store = await SessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  store.addMessage(session.id, { role: "user", content: "hello", createdAt: 1 });
  assert.equal(store.get(session.id)?.workspace, "/workspace");
  assert.deepEqual(store.messages(session.id).map((item) => item.content), ["hello"]);
  assert.equal(store.list()[0]?.id, session.id);
  store.close();
});
