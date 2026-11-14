type Agent = { id: string; name: string; commands: readonly string[] };

const interpreters = new Set(["node", "bun", "deno", "python", "python3", "ruby", "npx", "env"]);
const stem = (word: string) => word.replace(/\.(m?js|cjs|py|rb|ts)$/, "");

/** Names a command could be run as: its program, or the script an interpreter was given. */
function programNames(commandLine: string): string[] {
  const words = commandLine.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.replace(/^-/, "");
  if (!first) return [];
  const targets = [first];
  if (interpreters.has(first.split("/").at(-1) ?? "")) {
    const script = words.slice(1).find((word) => !word.startsWith("-"));
    if (script) targets.push(script);
  }
  // Every path segment counts, so `…/claude/versions/2.1` is still recognised as claude.
  return targets.flatMap((target) => target.split("/").filter(Boolean).map(stem));
}

/**
 * The agent CLI running as a terminal's foreground job, if any. Several catalog entries can share a
 * command (Claude and Claude Agent Teams both run `claude`), so agents the workspace already used
 * win when more than one matches.
 */
export function detectAgent(
  foreground: string | undefined,
  agents: readonly Agent[],
  preferred: readonly string[] = [],
): Agent | undefined {
  if (!foreground) return undefined;
  const names = new Set(programNames(foreground));
  const matches = agents.filter((agent) => agent.commands.some((command) => names.has(command)));
  return matches.find((agent) => preferred.includes(agent.id)) ?? matches[0];
}
