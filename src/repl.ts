import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalPolicy, ToolCall } from "./types.js";
import { Agent } from "./agent.js";
import { SessionStore, type Session } from "./store.js";

export class TerminalApproval implements ApprovalPolicy {
  constructor(private readonly rl: ReturnType<typeof createInterface>) {}
  async approve(_call: ToolCall, description: string): Promise<boolean> { const answer = await this.rl.question(`\nApproval required:\n${description}\nAllow? [y/N] `); return /^(y|yes)$/i.test(answer.trim()); }
}

export async function runRepl(createAgent: (approval: ApprovalPolicy) => Agent, store: SessionStore, session: Session): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`Kairo session ${session.id}\nWorkspace: ${session.workspace}\nType /help for commands.`);
  const approval = new TerminalApproval(rl);
  const agent = createAgent(approval);
  let active = session;
  for (;;) {
    const line = (await rl.question("\nkairo> ")).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    if (line === "/help") { console.log("/help  /new  /resume <id>  /history  /model  /quit"); continue; }
    if (line === "/new") { active = store.create(active.workspace); console.log(`New session: ${active.id}`); continue; }
    if (line === "/history") { for (const item of store.list()) console.log(`${item.id}  ${item.workspace}  ${new Date(item.updatedAt).toLocaleString()}`); continue; }
    if (line === "/model") { console.log("Model is configured with `kairo config get model`."); continue; }
    if (line.startsWith("/resume ")) { const next = store.get(line.slice(8).trim()); if (!next) console.log("Session not found."); else { active = next; console.log(`Resumed ${active.id}`); } continue; }
    try { await agent.run(active.id, line, (text) => stdout.write(text)); stdout.write("\n"); } catch (error) { console.error(`Kairo: ${(error as Error).message}`); }
  }
  rl.close();
}
