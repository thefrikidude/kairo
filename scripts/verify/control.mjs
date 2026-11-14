#!/usr/bin/env node
// Control CLI for verifying the real Kairo app the way a user would. See
// .claude/skills/verify-kairo/SKILL.md for the workflow. Usage: node scripts/verify/control.mjs <command>
//
// Every run uses a throwaway state directory, a throwaway Git project and fixture agents, so it
// never reads or writes the user's real data in ~/.local/state/kairo.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifyDir = join(repo, ".kairo", "verify");
const currentFile = join(verifyDir, "current");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[arg.slice(2)] = true;
    else {
      flags[arg.slice(2)] = next;
      index += 1;
    }
  }
  return { flags, positional };
}

async function loadInstance(flags) {
  const runId =
    flags.run ??
    process.env.KAIRO_VERIFY_RUN ??
    (await readFile(currentFile, "utf8").catch(() => ""));
  if (!runId)
    fail("No verification instance. Start one with: node scripts/verify/control.mjs launch");
  const file = join(verifyDir, runId.trim(), "instance.json");
  if (!existsSync(file)) fail(`No instance file for run ${runId.trim()}. Start one with: launch`);
  return JSON.parse(await readFile(file, "utf8"));
}

async function call(instance, body) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/`, {
    method: "POST",
    headers: { "x-verify-token": instance.token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error);
  return payload.result;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function show(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function newestMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const head = () =>
  execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

// --- launch -----------------------------------------------------------------------------------

async function launch() {
  const store = join(repo, "dist/infrastructure/persistence/sqlite-terminal-session-store.js");
  if (!existsSync(store) || !existsSync(join(repo, "out/main/index.js"))) {
    fail("Build first: pnpm build && pnpm desktop:build");
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(verifyDir, runId);
  const artifacts = join(runDir, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-verify-")));
  const [project, plain, state, bin] = ["project", "plain-folder", "state", "bin"].map((name) =>
    join(root, name),
  );
  for (const directory of [project, plain, state, bin]) await mkdir(directory, { recursive: true });

  await mkdir(join(project, "src"));
  await writeFile(join(project, "README.md"), "# Verification project\n");
  await writeFile(join(project, "src/lib.ts"), "export const x = 1;\n");
  await writeFile(join(plain, "notes.txt"), "plain folder\n");
  const git = (...args) =>
    execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.name", "Verify");
  git("config", "user.email", "verify@example.test");
  git("add", ".");
  git("commit", "-m", "Initial");

  const agent = `#!${process.execPath}\n${await readFile(join(repo, "scripts/verify/fixtures/agent-activity.cjs"), "utf8")}`;
  for (const name of ["codex", "claude"]) await writeFile(join(bin, name), agent, { mode: 0o755 });

  const { SqliteTerminalSessionStore } = await import(pathToFileURL(store).href);
  const { GitWorkspaces } = await import(
    pathToFileURL(join(repo, "dist/infrastructure/repository/git-workspaces.js")).href
  );
  const database = await SqliteTerminalSessionStore.open(join(state, "sessions.sqlite"));
  // --empty skips seeding so the first-run home screen can be checked.
  const seeded = {};
  // --with-project adds the repo as a project only, like opening a folder, with no workspace.
  if (flags.empty && flags["with-project"]) database.registerProject(project);
  if (!flags.empty) {
    const shared = database.registerWorkspace(await new GitWorkspaces().describe(project));
    const ticker = database.create(shared.id, "codex", "Ticker agent");
    const quiet = database.create(shared.id, "claude", "Quiet agent");
    const folder = database.registerWorkspace(await new GitWorkspaces().describe(plain));
    const plainAgent = database.create(folder.id, "codex", "Plain agent");
    database.setActiveSession(ticker.id);
    seeded.sessions = { ticker: ticker.id, quiet: quiet.id, plain: plainAgent.id };
    seeded.workspaces = { shared: shared.id, plain: folder.id };
  }
  database.close();

  const token = randomBytes(16).toString("hex");
  const infoFile = join(runDir, "host.json");
  const log = openSync(join(runDir, "host.log"), "a");
  const child = spawn(
    resolve(repo, "node_modules/.bin/electron"),
    [join(repo, "scripts/verify/host.cjs")],
    {
      cwd: repo,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        SHELL: "/bin/sh",
        KAIRO_STATE_DIR: state,
        KAIRO_VERIFY_TOKEN: token,
        KAIRO_VERIFY_INFO: infoFile,
        KAIRO_VERIFY_ARTIFACTS: artifacts,
      },
    },
  );
  child.unref();
  closeSync(log);

  const instance = {
    runId,
    runDir,
    artifacts,
    root,
    project,
    plain,
    state,
    token,
    launcherPid: child.pid,
    commit: head(),
    startedAt: new Date().toISOString(),
    ...seeded,
  };
  const abort = async (message) => {
    await cleanup(instance, { quiet: true });
    fail(
      `${message}\n--- host.log tail:\n${(await readFile(join(runDir, "host.log"), "utf8").catch(() => "")).slice(-1500)}`,
    );
  };

  const deadline = Date.now() + 30_000;
  while (!existsSync(infoFile)) {
    if (Date.now() > deadline || !alive(child.pid)) return abort("The app host did not start.");
    await sleep(100);
  }
  Object.assign(instance, JSON.parse(await readFile(infoFile, "utf8")));
  await writeFile(join(runDir, "instance.json"), JSON.stringify(instance, null, 2), {
    mode: 0o600,
  });
  await writeFile(currentFile, runId);

  // Ready means usable: the active agent's terminal is mounted and accepting input.
  const waitUntil = async (code) => {
    const readyBy = Date.now() + 60_000;
    for (;;) {
      if (await call(instance, { cmd: "eval", code }).catch(() => false)) return;
      if (Date.now() > readyBy) return abort("The app started but never reached a usable state.");
      await sleep(150);
    }
  };
  if (flags.empty) await waitUntil("!!document.querySelector('.sidebar')");
  else {
    // Kairo opens on a chat in "This computer"; move to the seeded project like a user would.
    await waitUntil("!!document.querySelector('.sidebar-section-chats .session-row.selected')");
    await call(instance, {
      cmd: "eval",
      code: `window.kairo.selectWorkspace(${JSON.stringify(instance.workspaces.shared)}).then(() => true)`,
    });
    await waitUntil("!!document.querySelector('.terminal-slot .xterm-helper-textarea')");
  }
  show({
    runId,
    artifacts,
    project,
    sessions: instance.sessions,
    note: "Run `node scripts/verify/control.mjs doctor`, then drive a feature from the feature map.",
  });
}

// --- doctor -----------------------------------------------------------------------------------

async function doctor(instance) {
  let failed = false;
  const report = (level, message) => {
    if (level === "FAIL") failed = true;
    console.log(`${level.padEnd(4)} ${message}`);
  };
  report(
    alive(instance.pid) ? "ok" : "FAIL",
    `app process ${instance.pid} is ${alive(instance.pid) ? "running" : "gone"}`,
  );
  try {
    const info = await call(instance, { cmd: "info" });
    report("ok", `control server answers on 127.0.0.1:${instance.port}`);
    report(
      info.stateDir === instance.state && instance.state.startsWith(await realpath(tmpdir()))
        ? "ok"
        : "FAIL",
      `state directory is the isolated run directory (${info.stateDir})`,
    );
    const windows = await call(instance, { cmd: "windows" });
    report("ok", `${windows.filter((window) => !window.destroyed).length} open window(s)`);
    const errors = await call(instance, { cmd: "errors" });
    report(errors.length ? "warn" : "ok", `${errors.length} renderer console error(s)`);
  } catch (error) {
    report("FAIL", `control server unreachable: ${error.message}`);
  }
  const built = statSync(join(repo, "out/main/index.js")).mtimeMs;
  const edited = newestMtime(join(repo, "src"));
  report(
    built >= edited ? "ok" : "warn",
    built >= edited
      ? "build is newer than every source file"
      : "source changed after the last build: run pnpm build && pnpm desktop:build, then relaunch",
  );
  report(
    head() === instance.commit ? "ok" : "warn",
    `running commit ${instance.commit}, checkout is at ${head()}`,
  );
  if (failed) process.exit(1);
}

// --- cleanup ----------------------------------------------------------------------------------

async function cleanup(instance, options = {}) {
  await call(instance, { cmd: "quit" }).catch(() => {});
  await sleep(500);
  // Only processes this run started: the app host and the launcher's own process group.
  for (const pid of [instance.pid, instance.launcherPid].filter(Boolean)) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (!alive(pid)) break;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
      await sleep(signal === "SIGTERM" ? 1500 : 300);
    }
  }
  const survivors = [instance.pid, instance.launcherPid].filter((pid) => pid && alive(pid));
  if (
    instance.root.startsWith(await realpath(tmpdir())) &&
    instance.root.includes(`${sep}kairo-verify-`)
  ) {
    await rm(instance.root, { recursive: true, force: true });
  }
  await rm(currentFile, { force: true });
  if (survivors.length) fail(`Could not stop process(es): ${survivors.join(", ")}`);
  if (!options.quiet) show({ cleaned: true, evidence: instance.artifacts });
}

// --- commands ---------------------------------------------------------------------------------

const { flags, positional } = parse(process.argv.slice(2));
const [command, ...args] = positional;
const windowIndex = Number(flags.window ?? 0);

if (!command || command === "help") {
  console.log(`Usage: node scripts/verify/control.mjs <command>
  launch                          start an isolated Kairo run (build first)
  doctor                          read-only health check; run before driving
  status                          print the instance details
  windows                         list app windows
  eval '<js>' [--window N]        run JavaScript in a window and print the result
  text '<selector>'               print the visible text of the first match
  click '<selector>' [--text T]   click the first match (optionally with exact text T)
  wait '<js>' [--timeout ms]      wait until the expression is truthy
  key <Key> [--window N]          send a key press (for example Escape)
  screenshot <name> [--window N]  save that window only to the artifacts folder
  note <name> '<text>'            save a text note to the artifacts folder
  start-session <alias>           start an agent (ticker, quiet, plain)
  select-workspace <shared|plain> switch workspace
  wait-agent <alias> [--state idle|working]  wait until the fixture agent is ready and in that state
  agent-write <alias> <file> <text>  make a fixture agent write a file
  fs-write <path> <text> | fs-rm <path>  change the project's files from outside Kairo
  errors [--clear]                print renderer console errors
  cleanup                         stop what this run started; evidence is kept`);
  process.exit(command ? 0 : 1);
}

if (command === "launch") {
  await launch();
} else {
  const instance = await loadInstance(flags);
  const run = (body) => call(instance, { window: windowIndex, ...body });
  const evalIn = (code) => run({ cmd: "eval", code });
  const sessionId = (alias) =>
    instance.sessions[alias] ?? fail(`Unknown agent alias ${alias}. Use ticker, quiet or plain.`);
  const inside = (path) => {
    const file = resolve(instance.project, path);
    return file.startsWith(instance.project + sep)
      ? file
      : fail("Path must stay inside the run's project.");
  };
  const fileName = (name) =>
    /^[\w.-]+$/.test(name ?? "") ? name : fail("Use a simple name: letters, digits, dot, dash.");

  switch (command) {
    case "doctor":
      await doctor(instance);
      break;
    case "status":
      show({ ...instance, token: "(hidden)" });
      break;
    case "windows":
      show(await run({ cmd: "windows" }));
      break;
    case "eval":
      show(await evalIn(args[0] ?? fail("Give the JavaScript to run.")));
      break;
    case "text":
      show(await evalIn(`document.querySelector(${q(args[0])})?.innerText ?? null`));
      break;
    case "click":
      show(
        await run({
          cmd: "click",
          selector: args[0],
          text: typeof flags.text === "string" ? flags.text : undefined,
        }),
      );
      break;
    case "wait": {
      const deadline = Date.now() + Number(flags.timeout ?? 15_000);
      let last;
      for (;;) {
        try {
          last = await evalIn(args[0]);
          if (last) break;
        } catch (error) {
          last = error.message;
        }
        if (Date.now() > deadline)
          fail(`Timed out waiting for ${args[0]} (last value: ${q(last)})`);
        await sleep(100);
      }
      console.log("ok");
      break;
    }
    case "key":
      show(await run({ cmd: "key", key: args[0] }));
      break;
    case "screenshot":
      show(
        await run({
          cmd: "screenshot",
          path: join(instance.artifacts, `${fileName(args[0])}.png`),
        }),
      );
      break;
    case "note":
      await writeFile(
        join(instance.artifacts, `${fileName(args[0])}.txt`),
        `${args.slice(1).join(" ")}\n`,
      );
      console.log("saved");
      break;
    case "start-session":
      await evalIn(`window.kairo.startSession(${q(sessionId(args[0]))}).then(() => true)`);
      console.log("started");
      break;
    case "select-workspace":
      await evalIn(
        `window.kairo.selectWorkspace(${q(instance.workspaces[args[0]] ?? fail("Use shared or plain."))}).then(() => true)`,
      );
      console.log("selected");
      break;
    case "wait-agent": {
      // Ready means the fixture printed its banner; state is working (ticker) or idle (quiet).
      const id = sessionId(args[0]);
      const wanted = typeof flags.state === "string" ? flags.state : "idle";
      const deadline = Date.now() + Number(flags.timeout ?? 20_000);
      for (;;) {
        const seen = await evalIn(`(async () => {
          const state = await window.kairo.bootstrap();
          const terminal = state.terminals.find((item) => item.sessionId === ${q(id)} && item.state === "running");
          if (!terminal) return "not running";
          const snapshot = await window.kairo.attachTerminal(terminal.id);
          return snapshot.buffer.includes("E2E_READY") ? terminal.activity : "starting";
        })()`).catch((error) => error.message);
        if (seen === wanted) break;
        if (Date.now() > deadline) fail(`${args[0]} is "${seen}", wanted "${wanted}".`);
        await sleep(150);
      }
      console.log("ok");
      break;
    }
    case "agent-write": {
      const id = sessionId(args[0]);
      const line = q(`${JSON.stringify({ file: args[1], content: args.slice(2).join(" ") })}\r`);
      await evalIn(`(async () => {
        const state = await window.kairo.bootstrap();
        const terminal = state.terminals.find((item) => item.sessionId === ${q(id)});
        if (!terminal) throw new Error("That agent is not running. Start it with start-session.");
        await window.kairo.writeTerminal(terminal.id, ${line});
        return true;
      })()`);
      console.log("sent");
      break;
    }
    case "fs-write":
      await writeFile(inside(args[0]), `${args.slice(1).join(" ")}\n`);
      console.log("written");
      break;
    case "fs-rm":
      await rm(inside(args[0]), { force: true });
      console.log("removed");
      break;
    case "errors":
      show(await run({ cmd: "errors", clear: !!flags.clear }));
      break;
    case "cleanup":
      await cleanup(instance);
      break;
    default:
      fail(`Unknown command: ${command}. Run with no arguments for usage.`);
  }
}
