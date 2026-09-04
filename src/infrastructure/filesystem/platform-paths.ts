import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/** Returns Kairo's overridable platform state directory. */
export function stateDir(): string {
  return (
    process.env.KAIRO_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kairo")
  );
}
/** Creates the state directory before SQLite or configuration writes use it. */
export async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
/** Returns the configuration-file path inside Kairo's platform state directory. */
export const configPath = () => join(stateDir(), "config.json");
/** Returns the SQLite database path inside Kairo's platform state directory. */
export const databasePath = () => join(stateDir(), "sessions.sqlite");
