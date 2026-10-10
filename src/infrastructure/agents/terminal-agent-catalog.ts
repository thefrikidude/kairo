// Catalog metadata adapted from Orca (MIT), copyright 2026 Lovecast Inc.
// See THIRD_PARTY_NOTICES.md. Snapshot: 10 October 2026.
import type { TerminalAgentDefinition, NativeAgentSession } from "../../domain/terminal-agent.js";

export const terminalAgentCatalog: readonly TerminalAgentDefinition[] = [
  {
    id: "claude",
    name: "Claude",
    commands: ["claude"],
    args: [],
    homepage: "https://code.claude.com/docs",
  },
  {
    id: "claude-agent-teams",
    name: "Claude Agent Teams",
    commands: ["claude"],
    args: [],
    homepage: "https://code.claude.com/docs/en/agent-teams",
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    commands: ["codebuddy", "cbc"],
    args: [],
    homepage: "https://www.codebuddy.ai/cli",
  },
  {
    id: "openclaude",
    name: "OpenClaude",
    commands: ["openclaude"],
    args: [],
    homepage: "https://openclaude.gitlawb.com/",
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    args: [],
    homepage: "https://github.com/openai/codex",
  },
  {
    id: "devin",
    name: "Devin",
    commands: ["devin"],
    args: [],
    homepage: "https://devin.ai/cli",
  },
  {
    id: "ante",
    name: "Ante",
    commands: ["ante"],
    args: [],
    homepage: "https://github.com/AntigmaLabs/ante-preview",
  },
  {
    id: "trae",
    name: "Trae",
    commands: ["traecli"],
    args: [],
    homepage: "https://docs.trae.cn/cli_get-started-with-trae-cli",
  },
  {
    id: "muse",
    name: "Muse",
    commands: ["muse"],
    args: [],
    homepage: "https://dev.meta.ai/docs/muse-code",
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    commands: ["dsh-tui", "dst"],
    args: ["."],
    homepage: "https://deepseek-harness.github.io/deepseek-harness/",
    requiredCommands: ["dsh"],
  },
  {
    id: "zcode",
    name: "ZCode",
    commands: ["zcode"],
    args: [],
    homepage: "https://zcode.z.ai/en/docs",
  },
  {
    id: "autohand",
    name: "Autohand Code",
    commands: ["autohand"],
    args: [],
    homepage: "https://github.com/autohandai/code-cli",
  },
  {
    id: "opencode",
    name: "OpenCode",
    commands: ["opencode"],
    args: [],
    homepage: "https://opencode.ai/docs/cli/",
  },
  {
    id: "opencode2",
    name: "OpenCode 2",
    commands: ["opencode2"],
    args: ["--standalone"],
    homepage: "https://opencode.ai/v2/docs/",
  },
  {
    id: "mimo-code",
    name: "MiMo Code",
    commands: ["mimo"],
    args: [],
    homepage: "https://mimo.xiaomi.com/coder",
  },
  {
    id: "pi",
    name: "Pi",
    commands: ["pi"],
    args: [],
    homepage: "https://pi.dev",
  },
  {
    id: "omp",
    name: "OMP",
    commands: ["omp"],
    args: [],
    homepage: "https://omp.sh",
  },
  {
    id: "prime-agent",
    name: "Prime Agent",
    commands: ["prime-agent"],
    args: [],
    homepage: "https://github.com/PrimeIntellect-ai/prime-agent",
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    commands: ["qodercli", "qoder"],
    args: [],
    homepage: "https://docs.qoder.com/cli/overview",
  },
  {
    id: "qoder-cn",
    name: "Qoder CLI China",
    commands: ["qoderclicn", "qodercn"],
    args: [],
    homepage: "https://docs.qoder.cn/cli/overview",
  },
  {
    id: "gemini",
    name: "Gemini",
    commands: ["gemini"],
    args: [],
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    commands: ["agy"],
    args: [],
    homepage: "https://antigravity.google/docs/cli-overview",
  },
  {
    id: "aider",
    name: "Aider",
    commands: ["aider"],
    args: [],
    homepage: "https://aider.chat/docs/",
  },
  {
    id: "goose",
    name: "Goose",
    commands: ["goose"],
    args: [],
    homepage: "https://block.github.io/goose/docs/quickstart/",
  },
  {
    id: "amp",
    name: "Amp",
    commands: ["amp"],
    args: [],
    homepage: "https://ampcode.com/manual#install",
  },
  {
    id: "kilo",
    name: "Kilocode",
    commands: ["kilo"],
    args: [],
    homepage: "https://kilo.ai/docs/cli",
  },
  {
    id: "kiro",
    name: "Kiro",
    commands: ["kiro-cli"],
    args: ["chat", "--tui"],
    homepage: "https://kiro.dev/docs/cli/",
  },
  {
    id: "crush",
    name: "Charm",
    commands: ["crush"],
    args: [],
    homepage: "https://github.com/charmbracelet/crush",
  },
  {
    id: "aug",
    name: "Auggie",
    commands: ["auggie"],
    args: [],
    homepage: "https://docs.augmentcode.com/cli/overview",
  },
  {
    id: "cline",
    name: "Cline",
    commands: ["cline"],
    args: [],
    homepage: "https://docs.cline.bot/cline-cli/overview",
  },
  {
    id: "codebuff",
    name: "Codebuff",
    commands: ["codebuff"],
    args: [],
    homepage: "https://www.codebuff.com/docs/help/quick-start",
  },
  {
    id: "freebuff",
    name: "Freebuff",
    commands: ["freebuff"],
    args: [],
    homepage: "https://freebuff.com/cli",
  },
  {
    id: "command-code",
    name: "Command Code",
    commands: ["command-code"],
    args: [],
    homepage: "https://commandcode.ai/docs/quickstart",
  },
  {
    id: "continue",
    name: "Continue",
    commands: ["cn"],
    args: [],
    homepage: "https://docs.continue.dev/guides/cli",
  },
  {
    id: "cursor",
    name: "Cursor",
    commands: ["cursor-agent"],
    args: [],
    homepage: "https://cursor.com/cli",
  },
  {
    id: "droid",
    name: "Droid",
    commands: ["droid"],
    args: [],
    homepage: "https://docs.factory.ai/cli/getting-started/quickstart",
  },
  {
    id: "kimi",
    name: "Kimi",
    commands: ["kimi", "kimi-code"],
    args: [],
    homepage: "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html",
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    commands: ["vibe", "mistral-vibe"],
    args: [],
    homepage: "https://github.com/mistralai/mistral-vibe",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    commands: ["qwen"],
    args: [],
    homepage: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "rovo",
    name: "Rovo Dev",
    commands: ["acli"],
    args: ["rovodev", "run"],
    homepage: "https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli/",
  },
  {
    id: "hermes",
    name: "Hermes",
    commands: ["hermes"],
    args: ["--tui"],
    homepage: "https://hermes-agent.nousresearch.com/docs/",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    commands: ["openclaw"],
    args: [],
    homepage: "https://github.com/openclaw/openclaw",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    commands: ["copilot"],
    args: [],
    homepage: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
  },
  {
    id: "grok",
    name: "Grok",
    commands: ["grok"],
    args: [],
    homepage: "https://x.ai/cli",
  },
  {
    id: "jcode",
    name: "Jcode",
    commands: ["jcode"],
    args: [],
    homepage: "https://github.com/1jehuang/jcode",
  },
];

const resumeFlags: Record<string, readonly string[]> = {
  claude: ["--resume"],
  "claude-agent-teams": ["--resume"],
  codebuddy: ["--resume"],
  codex: ["resume"],
  cursor: ["--resume"],
  qoder: ["--resume"],
  "qoder-cn": ["--resume"],
  "qwen-code": ["--resume"],
  gemini: ["--resume"],
  antigravity: ["--conversation"],
  opencode: ["--session"],
  opencode2: ["--session"],
  "mimo-code": ["--session"],
  droid: ["--resume"],
  grok: ["--resume"],
  devin: ["--resume"],
  omp: ["--resume"],
  kimi: ["--session"],
  muse: ["resume"],
  zcode: ["--resume"],
  dsh: ["--resume"],
  jcode: ["--resume"],
  kiro: ["--resume-id"],
  pi: ["--session"],
  "prime-agent": ["--resume"],
  copilot: ["--resume="],
};
export function canResumeAgent(id: string): boolean {
  return Object.hasOwn(resumeFlags, id);
}
export function agentDefinition(id: unknown): TerminalAgentDefinition {
  const agent = terminalAgentCatalog.find((agent) => agent.id === id);
  if (!agent) throw new Error("Choose a supported terminal agent.");
  return agent;
}
export function normalizeNativeSession(value: unknown): NativeAgentSession {
  if (!value || typeof value !== "object") throw new Error("Invalid native agent session.");
  const raw = value as Record<string, unknown>;
  const safe = (value: unknown, max: number): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.startsWith("-") &&
    !/[\x00-\x1f\x7f]/.test(value);
  if (!safe(raw.id, 512)) throw new Error("Invalid native agent session ID.");
  if (raw.transcriptPath !== undefined && !safe(raw.transcriptPath, 4096))
    throw new Error("Invalid native transcript path.");
  return {
    id: raw.id,
    ...(typeof raw.transcriptPath === "string" ? { transcriptPath: raw.transcriptPath } : {}),
  };
}
/** Exact native identifiers only: never use a global --last that might resume another task. */
export function nativeResumeArgs(id: string, value: NativeAgentSession): string[] {
  const session = normalizeNativeSession(value);
  const flags = resumeFlags[id];
  if (!flags) throw new Error("This agent does not support native session resume.");
  if (["pi", "prime-agent"].includes(id) && !session.transcriptPath)
    throw new Error("This agent needs its native transcript path to resume.");
  const target = ["pi", "prime-agent"].includes(id) ? session.transcriptPath! : session.id;
  return id === "copilot" ? [`--resume=${target}`] : [...flags, target];
}

/** Known CLI-native conversation pickers, without a global last-session shortcut. */
export function nativePickerArgs(id: string): string[] | undefined {
  if (id === "codex") return ["resume"];
  if (id === "claude" || id === "claude-agent-teams") return ["--resume"];
  return undefined;
}
