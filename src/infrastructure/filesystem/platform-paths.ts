import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export function stateDir(): string {
  return (
    process.env.KAIRO_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kairo")
  );
}
export async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export const configPath = () => join(stateDir(), "config.json");
export const databasePath = () => join(stateDir(), "sessions.sqlite");
