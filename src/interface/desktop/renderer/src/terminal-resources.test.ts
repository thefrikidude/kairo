import test from "node:test";
import assert from "node:assert/strict";
import { subscribeTerminalOutput } from "./terminal-resources.js";
import type { DesktopApi, TerminalData } from "../../shared/api.js";
test("terminal output shares one bridge subscription and releases it after the last terminal", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let subscriptions = 0,
    releases = 0;
  let deliver: (packet: TerminalData) => void = () => {};
  const api = {
    onTerminalData(callback) {
      subscriptions++;
      deliver = callback;
      return () => {
        releases++;
      };
    },
  } satisfies Pick<DesktopApi, "onTerminalData">;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { kairo: api } });
  try {
    const received: string[] = [];
    const offA = subscribeTerminalOutput("a", (packet) => received.push(packet.data));
    const offB = subscribeTerminalOutput("b", (packet) => received.push(packet.data));
    assert.equal(subscriptions, 1);
    deliver({ id: "a", workspaceId: "workspace", data: "first", sequence: 1 });
    deliver({ id: "missing", workspaceId: "workspace", data: "ignored", sequence: 1 });
    offA();
    deliver({ id: "a", workspaceId: "workspace", data: "closed", sequence: 2 });
    deliver({ id: "b", workspaceId: "workspace", data: "second", sequence: 1 });
    assert.deepEqual(received, ["first", "second"]);
    assert.equal(releases, 0);
    offB();
    assert.equal(releases, 1);
    const offC = subscribeTerminalOutput("c", () => {});
    assert.equal(subscriptions, 2);
    offC();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
