import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWorkspacePaths, literalPath, runWorkspaceSetup } from "./workspace-preparation.js";
const execute = promisify(execFile);
test("ignored copies are independent, exclusive, retryable and reject tracked, missing and escaping paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-copy-")));
  const source = join(root, "source"),
    destination = join(root, "destination");
  try {
    await mkdir(source);
    await mkdir(destination);
    await execute("git", ["init", source]);
    await writeFile(join(source, ".gitignore"), ".env\nconfig/\nlink\n");
    await writeFile(join(source, ".env"), "original");
    await mkdir(join(source, "config"));
    await writeFile(join(source, "config", "a"), "A");
    const controller = new AbortController(),
      copied: string[] = [];
    const copy = (paths: string[]) =>
      copyWorkspacePaths(source, destination, paths, copied, controller.signal, (path) =>
        copied.push(path),
      );
    await copy([".env", "config"]);
    assert.deepEqual(copied, [".env", "config/a"]);
    await writeFile(join(destination, ".env"), "independent");
    await copy([".env", "config"]);
    assert.equal(await readFile(join(source, ".env"), "utf8"), "original");
    assert.equal(await readFile(join(destination, ".env"), "utf8"), "independent");
    await assert.rejects(
      copyWorkspacePaths(source, destination, [".env"], [], controller.signal, () => {}),
      /EEXIST/,
    );
    await assert.rejects(copy(["missing"]), /ENOENT/);
    await assert.rejects(copy([".gitignore"]), /not ignored/);
    await symlink(join(source, ".env"), join(source, "link"));
    await assert.rejects(copy(["link"]), /symlink/);
    await execute("git", ["-C", source, "add", "-f", "config/a"]);
    await assert.rejects(copy(["config"]), /tracked/);
    for (const path of ["../escape", "/tmp/a", ".git/config", "a/*", "a/../b"])
      assert.throws(() => literalPath(path));
    controller.abort();
    await assert.rejects(copy([".env"]), /abort/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("setup uses its workspace cwd and env, exposes failures, and cancels owned children", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-setup-")));
  try {
    let output = "";
    await runWorkspaceSetup(
      'printf "%s\\n%s\\n%s" "$PWD" "$KAIRO_SOURCE_DIR" "$KAIRO_WORKSPACE_DIR"; touch setup-proof',
      "/source",
      root,
      new AbortController().signal,
      (text) => (output += text),
    );
    assert.equal(output, `${root}\n/source\n${root}`);
    await assert.rejects(
      runWorkspaceSetup("exit 7", root, root, new AbortController().signal, () => {}),
      /exited 7/,
    );
    const controller = new AbortController();
    let pid = 0;
    const running = runWorkspaceSetup(
      "sleep 60 & echo $!; wait",
      root,
      root,
      controller.signal,
      (text) => {
        if (/^\d+$/.test(text.trim())) {
          pid = Number(text.trim());
          controller.abort();
        }
      },
    );
    await assert.rejects(running, /abort/i);
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
