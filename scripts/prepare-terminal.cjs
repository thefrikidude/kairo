const { chmodSync, existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
// node-pty's prebuilt POSIX helper must be executable; some package installs lose its mode.
if (process.platform !== "win32") {
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const helper of [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
