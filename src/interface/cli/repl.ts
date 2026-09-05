import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ToolCall } from "../../domain/models.js";
import type { ApprovalPolicy } from "../../domain/ports.js";
import { CodingAgent } from "../../application/coding-agent.js";
import { formatMetrics, formatTrace } from "./task-trace.js";
import {
  SqliteSessionStore,
  type Session,
} from "../../infrastructure/persistence/sqlite-session-store.js";

export class TerminalApproval implements ApprovalPolicy {
  /** Keeps the shared readline interface used for approval questions. */
  constructor(private readonly rl: ReturnType<typeof createInterface>) {}
  /** Prompts the user for explicit approval and denies every other response. */
  async approve(_call: ToolCall, description: string): Promise<boolean> {
    const answer = await this.rl.question(`\nApproval required:\n${description}\nAllow? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  }
}

/** Runs the interactive command loop for one active workspace session. */
export async function runRepl(
  createAgent: (approval: ApprovalPolicy) => CodingAgent,
  store: SqliteSessionStore,
  session: Session,
): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(
    `Kairo session ${session.id}\nWorkspace: ${session.workspace}\nType /help for commands.`,
  );
  const approval = new TerminalApproval(rl);
  const agent = createAgent(approval);
  let active = session;
  for (;;) {
    const line = (await rl.question("\nkairo> ")).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    if (line === "/help") {
      console.log(
        "/help  /new  /resume [session-id]  /history  /status  /trace [task-id]  /changes  /verify <command>  /compact  /cancel  /model  /quit",
      );
      continue;
    }
    if (line === "/new") {
      active = store.create(active.workspace);
      console.log(`New session: ${active.id}`);
      continue;
    }
    if (line === "/history") {
      for (const item of store.list())
        console.log(`${item.id}  ${item.workspace}  ${new Date(item.updatedAt).toLocaleString()}`);
      continue;
    }
    if (line === "/model") {
      console.log("Model is configured with `kairo config get model`.");
      continue;
    }
    if (line === "/trace" || line.startsWith("/trace ")) {
      const task = line === "/trace" ? agent.status(active.id) : store.task(line.slice(7).trim());
      console.log(
        task && task.sessionId === active.id
          ? formatTrace(task, store.taskEvents(task.id))
          : "Task not found in this session.",
      );
      continue;
    }
    if (line === "/status" || line === "/changes") {
      const task = agent.status(active.id);
      if (!task) console.log("No task has run in this session.");
      else if (line === "/changes")
        console.log(task.changedFiles.length ? task.changedFiles.join("\n") : "No files changed.");
      else {
        console.log(
          `${task.status}: ${task.prompt}${task.error ? `\nError: ${task.error}` : ""}${task.verificationCommand ? `\nVerification: ${task.verificationCommand}` : ""}`,
        );
        console.log(formatMetrics(store.taskEvents(task.id)));
      }
      continue;
    }
    if (line === "/compact") {
      const summary = agent.compact(active.id);
      console.log(summary ? "Context checkpoint saved." : "No task to compact.");
      continue;
    }
    if (line === "/cancel") {
      const task = agent.cancel(active.id);
      console.log(task ? "Task cancelled." : "No task to cancel.");
      continue;
    }
    if (line === "/resume") {
      try {
        await agent.resume(active.id, (text) => stdout.write(text));
        stdout.write("\n");
      } catch (error) {
        console.error(`Kairo: ${(error as Error).message}`);
      }
      continue;
    }
    if (line.startsWith("/verify ")) {
      try {
        await agent.verify(active.id, line.slice(8).trim(), (text) => stdout.write(text));
      } catch (error) {
        console.error(`Kairo: ${(error as Error).message}`);
      }
      continue;
    }
    if (line.startsWith("/resume ")) {
      const next = store.get(line.slice(8).trim());
      if (!next) console.log("Session not found.");
      else {
        active = next;
        console.log(`Resumed ${active.id}`);
      }
      continue;
    }
    try {
      await agent.run(active.id, line, (text) => stdout.write(text));
      stdout.write("\n");
    } catch (error) {
      console.error(`Kairo: ${(error as Error).message}`);
    }
  }
  rl.close();
}
