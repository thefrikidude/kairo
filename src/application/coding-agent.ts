import { ContextManager } from "./context-manager.js";
import type { Message, Task, ToolCall, ToolResult } from "../domain/models.js";
import type { ApprovalPolicy, ModelProvider, TaskStore, ToolDefinition, ToolExecutor } from "../domain/ports.js";

const MAX_MODEL_TURNS = 20;
const MAX_TOOL_CALLS = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_CALLS = 2;

export class CodingAgent {
  private readonly context: ContextManager;
  constructor(private readonly provider: ModelProvider, private readonly store: TaskStore, private readonly tools: ToolExecutor, private readonly approval: ApprovalPolicy, private readonly toolDefinitions: ToolDefinition[]) { this.context = new ContextManager(store); }

  async run(sessionId: string, input: string, onText: (text: string) => void): Promise<void> {
    const task = this.store.startTask(sessionId, input);
    await this.executeTask(task, input, onText);
  }

  async resume(sessionId: string, onText: (text: string) => void): Promise<void> {
    const task = this.store.latestTask(sessionId);
    if (!task) throw new Error("This session has no task to resume.");
    if (task.status === "completed" || task.status === "cancelled") throw new Error(`Task is already ${task.status}. Start a new task instead.`);
    const resumed = this.store.updateTask(task.id, { status: "planning", error: undefined });
    this.save(sessionId, { role: "user", content: `Resume the interrupted task: ${resumed.prompt}. Inspect the recorded context, resolve unfinished work, and verify any prior changes.`, createdAt: Date.now() });
    await this.executeTask(resumed, undefined, onText);
  }

  status(sessionId: string): Task | undefined { return this.store.latestTask(sessionId); }
  cancel(sessionId: string): Task | undefined { const task = this.store.latestTask(sessionId); return task && this.store.updateTask(task.id, { status: "cancelled", summary: "Cancelled by user." }); }
  compact(sessionId: string): string | undefined { const task = this.store.latestTask(sessionId); return task && this.context.compact(sessionId, task); }

  async verify(sessionId: string, command: string, onText: (text: string) => void): Promise<void> {
    let task = this.store.latestTask(sessionId);
    if (!task) throw new Error("Start a task before running verification.");
    task = this.store.updateTask(task.id, { status: "verifying", verificationCommand: command, verificationOutput: undefined, verificationPassed: undefined });
    const call: ToolCall = { id: crypto.randomUUID(), name: "run_command", args: { command } };
    const result = await this.executeTool(task, call, onText);
    task = this.store.updateTask(task.id, { verificationOutput: result.output, verificationPassed: result.ok, status: result.ok ? "completed" : "failed", error: result.ok ? undefined : result.output });
    onText(result.ok ? "\n[Verification passed]\n" : "\n[Verification failed]\n");
  }

  private async executeTask(initialTask: Task, initialInput: string | undefined, onText: (text: string) => void): Promise<void> {
    let task = this.store.updateTask(initialTask.id, { status: "acting" });
    if (initialInput) this.save(task.sessionId, { role: "user", content: initialInput, createdAt: Date.now() });
    const calls = new Map<string, number>(); let toolCalls = 0; let failures = 0;
    try {
      for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
        if (this.store.task(task.id)?.status === "cancelled") { onText("\nTask cancelled.\n"); return; }
        const result = await this.provider.stream(this.context.prepare(task.sessionId, task), onText);
        if (result.text) this.save(task.sessionId, { role: "model", content: result.text, createdAt: Date.now() });
        if (!result.toolCalls.length) {
          task = this.finish(task);
          if (task.status === "verification_required") onText("\nChanges were made but no successful verification command ran. Use `/verify <command>`.\n");
          return;
        }
        for (const call of result.toolCalls) {
          toolCalls += 1;
          if (toolCalls > MAX_TOOL_CALLS) return this.fail(task, "Tool-call limit reached.", onText);
          const fingerprint = `${call.name}:${JSON.stringify(call.args)}`;
          const count = (calls.get(fingerprint) || 0) + 1; calls.set(fingerprint, count);
          if (count > MAX_IDENTICAL_CALLS) return this.fail(task, `Repeated identical tool call blocked: ${call.name}.`, onText);
          const outcome = await this.executeTool(task, call, onText);
          task = this.store.task(task.id)!;
          failures = outcome.ok ? 0 : failures + 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) return this.fail(task, "Too many consecutive tool failures.", onText);
        }
      }
      this.fail(task, "Model-turn limit reached.", onText);
    } catch (error) {
      this.fail(task, `Model error: ${(error as Error).message}`, onText);
      throw error;
    }
  }

  private finish(task: Task): Task { return this.store.updateTask(task.id, { status: task.changedFiles.length && task.verificationPassed !== true ? "verification_required" : "completed" }); }
  private fail(task: Task, error: string, onText: (text: string) => void): void { this.store.updateTask(task.id, { status: "failed", error }); onText(`\nKairo stopped: ${error}\n`); }
  private save(session: string, message: Message): void { this.store.addMessage(session, message); }

  private async executeTool(task: Task, call: ToolCall, onText: (text: string) => void): Promise<ToolResult> {
    const definition = this.toolDefinitions.find((item) => item.name === call.name);
    this.save(task.sessionId, { role: "model", content: JSON.stringify(call.args), toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    let approved: boolean | null = null;
    if (!definition) return this.record(task, call, false, "Unknown tool requested.", false);
    if (definition.mutating) {
      approved = await this.approval.approve(call, this.tools.description(call));
      if (!approved) { onText(`\n[Denied] ${call.name}\n`); return this.record(task, call, false, "User denied this action.", false); }
    }
    onText(`\n[Tool] ${call.name}\n`);
    const result = await this.tools.execute(call);
    if (result.ok && (call.name === "write_file" || call.name === "edit_file") && typeof call.args.path === "string") {
      const changedFiles = [...new Set([...task.changedFiles, call.args.path])];
      this.store.updateTask(task.id, { changedFiles }); task = this.store.task(task.id)!;
    }
    if (call.name === "run_command") this.store.updateTask(task.id, { verificationCommand: String(call.args.command ?? ""), verificationOutput: result.output, verificationPassed: result.ok });
    this.store.recordTool(task.sessionId, call.id, call.name, call.args, approved, result.output);
    this.save(task.sessionId, { role: "tool", content: result.output, toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    return result;
  }

  private record(task: Task, call: ToolCall, ok: boolean, output: string, approved: boolean): ToolResult {
    this.store.recordTool(task.sessionId, call.id, call.name, call.args, approved, output);
    this.save(task.sessionId, { role: "tool", content: output, toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    return { ok, output };
  }
}
