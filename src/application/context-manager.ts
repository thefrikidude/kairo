import type { Message, Task } from "../domain/models.js";
import type { TaskStore } from "../domain/ports.js";
import { ContextSelector } from "./context-selector.js";

const AUTO_COMPACT_AFTER = 48;
const MODEL_MESSAGE_LIMIT = 32;
const excerpt = (value: string, length = 700) =>
  value.length > length ? `${value.slice(0, length)}…` : value;

export class ContextManager {
  private readonly selector = new ContextSelector();
  constructor(private readonly store: TaskStore) {}
  prepare(sessionId: string, task: Task): Message[] {
    if (this.store.messageCount(sessionId) >= AUTO_COMPACT_AFTER) this.compact(sessionId, task);
    const checkpoint = this.store.latestCheckpoint(sessionId);
    const recent = this.cleanStart(this.store.recentMessages(sessionId, MODEL_MESSAGE_LIMIT));
    const profile = this.store.repositoryProfile(sessionId);
    const repositoryContext = profile && {
      role: "user" as const,
      content: this.profileContext(task, profile),
      createdAt: profile.createdAt,
    };
    const context = [
      ...(repositoryContext ? [repositoryContext] : []),
      ...(checkpoint
        ? [
            {
              role: "user" as const,
              content: `Context checkpoint from earlier work:\n${checkpoint.summary}`,
              createdAt: checkpoint.createdAt,
            },
          ]
        : []),
      ...recent,
    ];
    return context;
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
  private profileContext(
    task: Task,
    profile: NonNullable<ReturnType<TaskStore["repositoryProfile"]>>,
  ): string {
    const relevantFiles = this.selector.select(this.retrievalQuery(task), profile);
    return [
      "Repository profile:",
      `Root: ${profile.root}`,
      `Package: ${profile.packageName ?? "unknown"}`,
      `Package manager: ${profile.packageManager}`,
      `Scripts: ${Object.keys(profile.scripts).length ? Object.keys(profile.scripts).sort().join(", ") : "none detected"}`,
      `Source roots: ${profile.sourceRoots.join(", ") || "none detected"}`,
      `Test roots: ${profile.testRoots.join(", ") || "none detected"}`,
      `Recommended verification: ${profile.verificationCandidates.map((candidate) => `${candidate.label} = ${candidate.command}`).join("; ") || "none detected"}`,
      `Relevant files for this task: ${relevantFiles.join(", ") || "use search_files to locate files"}`,
      "Use the profile as a guide, inspect files before edits, and choose an appropriate verification command after changes.",
    ].join("\n");
  }
  private retrievalQuery(task: Task): string {
    return [task.prompt, task.error, task.verificationOutput]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.slice(0, 8_000))
      .join("\n");
  }
}
