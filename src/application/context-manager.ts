import type { Message, Task } from "../domain/models.js";
import type { TaskStore } from "../domain/ports.js";

const AUTO_COMPACT_AFTER = 48;
const MODEL_MESSAGE_LIMIT = 32;
const excerpt = (value: string, length = 700) =>
  value.length > length ? `${value.slice(0, length)}…` : value;

export class ContextManager {
  constructor(private readonly store: TaskStore) {}
  prepare(sessionId: string, task: Task): Message[] {
    if (this.store.messageCount(sessionId) >= AUTO_COMPACT_AFTER) this.compact(sessionId, task);
    const checkpoint = this.store.latestCheckpoint(sessionId);
    const recent = this.cleanStart(this.store.recentMessages(sessionId, MODEL_MESSAGE_LIMIT));
    if (!checkpoint) return recent;
    return [
      {
        role: "user",
        content: `Context checkpoint from earlier work:\n${checkpoint.summary}`,
        createdAt: checkpoint.createdAt,
      },
      ...recent,
    ];
  }
  compact(sessionId: string, task: Task): string {
    const current = this.store.latestCheckpoint(sessionId);
    const lastId = this.store.lastMessageId(sessionId);
    if (current?.throughMessageId === lastId) return current.summary;
    const recent = this.store
      .recentMessages(sessionId, 12)
      .map(
        (message) =>
          `${message.role}${message.toolName ? `:${message.toolName}` : ""}: ${excerpt(message.content, 420)}`,
      )
      .join("\n");
    const summary = [
      `Task: ${task.prompt}`,
      `State: ${task.status}`,
      `Changed files: ${task.changedFiles.length ? task.changedFiles.join(", ") : "none"}`,
      `Verification: ${task.verificationCommand ? `${task.verificationCommand} (${task.verificationPassed ? "passed" : "not passed"})` : "not run"}`,
      task.error ? `Last error: ${excerpt(task.error)}` : "",
      "Recent durable evidence:",
      recent,
    ]
      .filter(Boolean)
      .join("\n");
    this.store.saveCheckpoint(sessionId, task.id, summary, lastId);
    this.store.updateTask(task.id, { summary });
    return summary;
  }
  private cleanStart(messages: Message[]): Message[] {
    const first = messages.findIndex(
      (message) => message.role === "user" || (message.role === "model" && !message.toolCallId),
    );
    return first < 0 ? messages.slice(-1) : messages.slice(first);
  }
}
