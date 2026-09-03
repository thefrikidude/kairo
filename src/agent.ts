import type { ApprovalPolicy, Message, ModelProvider, ToolCall } from "./types.js";
import { definitions, WorkspaceTools } from "./tools.js";
import { SessionStore } from "./store.js";

export class Agent {
  constructor(private readonly provider: ModelProvider, private readonly store: SessionStore, private readonly tools: WorkspaceTools, private readonly approval: ApprovalPolicy) {}
  async run(sessionId: string, input: string, onText: (text: string) => void): Promise<void> {
    this.save(sessionId, { role: "user", content: input, createdAt: Date.now() });
    for (let turn = 0; turn < 20; turn += 1) {
      const result = await this.provider.stream(this.store.messages(sessionId), onText);
      if (result.text) this.save(sessionId, { role: "model", content: result.text, createdAt: Date.now() });
      if (!result.toolCalls.length) return;
      for (const call of result.toolCalls) await this.execute(sessionId, call, onText);
    }
    onText("\nKairo stopped after 20 tool turns; please refine the request.\n");
  }
  private save(session: string, message: Message): void { this.store.addMessage(session, message); }
  private async execute(session: string, call: ToolCall, onText: (text: string) => void): Promise<void> {
    const definition = definitions.find((item) => item.name === call.name);
    this.save(session, { role: "model", content: JSON.stringify(call.args), toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    let approved: boolean | null = null;
    if (!definition) { const output = `Unknown tool requested: ${call.name}`; this.store.recordTool(session, call.id, call.name, call.args, false, output); this.save(session, { role: "tool", content: output, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }); return; }
    if (definition.mutating) { approved = await this.approval.approve(call, this.tools.description(call)); if (!approved) { const output = "User denied this action."; onText(`\n[Denied] ${call.name}\n`); this.store.recordTool(session, call.id, call.name, call.args, false, output); this.save(session, { role: "tool", content: output, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }); return; } }
    onText(`\n[Tool] ${call.name}\n`); const result = await this.tools.execute(call); this.store.recordTool(session, call.id, call.name, call.args, approved, result.output); this.save(session, { role: "tool", content: result.output, toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
  }
}
