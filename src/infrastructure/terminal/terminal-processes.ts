import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type TerminalProcess = {
  pid: number;
  parent: number;
  group: number;
  started: string;
  zombie: boolean;
};

/** Names/arguments are deliberately omitted: process commands may contain credentials. */
export async function terminalProcesses(): Promise<TerminalProcess[]> {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            zombie: match[4].startsWith("Z"),
            started: match[5].trim(),
          },
        ]
      : [];
  });
}
export function descendants(rows: TerminalProcess[], root: number): TerminalProcess[] {
  const owned = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  return rows.filter((row) => row.pid !== root && owned.has(row.pid) && !row.zombie);
}
export function sameProcess(a: TerminalProcess, b: TerminalProcess): boolean {
  return a.pid === b.pid && a.started === b.started && a.group === b.group && !b.zombie;
}
export class TerminalCleanupError extends Error {
  constructor(readonly processes: TerminalProcess[]) {
    super(
      "Some terminal child processes did not stop. Stop them before closing this terminal or removing its worktree.",
    );
  }
}
function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Re-derive children while the owned root is alive; never kill an unrelated reused PID. */
export async function stopTerminalTree(
  pid: number,
  killRoot: () => void,
  exited: () => boolean,
): Promise<void> {
  if (process.platform === "win32") {
    killRoot();
    return;
  }
  const initial = await terminalProcesses();
  const root = initial.find((row) => row.pid === pid && !row.zombie);
  if (!root || exited()) {
    killRoot();
    return;
  }
  const children = descendants(initial, pid);
  for (const child of [...children].reverse()) signal(child.pid, "SIGTERM");
  if (children.length) await pause(150);
  const fresh = await terminalProcesses();
  const liveRoot = fresh.find(
    (row) =>
      row.pid === pid && row.started === root.started && row.group === root.group && !row.zombie,
  );
  const targets = liveRoot && !exited() ? descendants(fresh, pid) : [];
  for (const child of [...targets].reverse()) signal(child.pid, "SIGKILL");
  killRoot();
  const expected = [...children, ...targets];
  let remaining: TerminalProcess[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await terminalProcesses();
    remaining = expected.filter((child) => current.some((row) => sameProcess(child, row)));
    if (!remaining.length) return;
    await pause(100);
  }
  throw new TerminalCleanupError(remaining);
}
