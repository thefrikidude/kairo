import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Finder-launched desktop apps may not inherit the user's interactive shell PATH. */
export async function findAgentExecutable(name: string): Promise<string | undefined> {
  const directories = [
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local/bin"),
    join(homedir(), ".opencode/bin"),
    join(homedir(), ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const directory of directories.filter((directory) => isAbsolute(directory))) {
    const path = join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try next location. */
    }
  }
  return undefined;
}
