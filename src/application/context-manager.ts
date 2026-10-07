import type { Message, Task } from "../domain/models.js";
import type { TaskStore } from "../domain/ports.js";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContextSelector } from "./context-selector.js";
import { SourceContextRetriever } from "./source-context-retriever.js";

const AUTO_COMPACT_AFTER = 48;
const MODEL_MESSAGE_LIMIT = 32;
const MAX_INSTRUCTION_BYTES = 6 * 1024;
const MAX_INSTRUCTION_TOTAL_BYTES = 10 * 1024;
const MAX_REQUEST_CONTEXT_CHARS = 6_000;
const MAX_PROFILE_CONTEXT_CHARS = 4_000;
const MAX_REPOSITORY_CONTEXT_CHARS = 34_000;
const excerpt = (value: string, length = 700) =>
  value.length > length ? `${value.slice(0, length)}…` : value;

export class ContextManager {
  private readonly selector = new ContextSelector();
  private readonly retriever = new SourceContextRetriever();
  constructor(private readonly store: TaskStore) {}
  /** Builds the bounded message list that is sent to the model for the next turn. */
  async prepare(sessionId: string, task: Task): Promise<Message[]> {
    if (this.store.messageCount(sessionId) >= AUTO_COMPACT_AFTER) this.compact(sessionId, task);
    const checkpoint = this.store.latestCheckpoint(sessionId);
    const handoff = this.store.latestAgentHandoff?.(sessionId);
    const recent = this.cleanStart(
      this.store
        .recentMessages(sessionId, MODEL_MESSAGE_LIMIT)
        .filter((message) => message.toolName !== "agent_handoff"),
    );
    const profile = this.store.repositorySnapshot(sessionId);
    const repositoryContext = profile && {
      role: "user" as const,
      content: await this.profileContext(task, profile),
      createdAt: profile.createdAt,
    };
    const repairBrief = this.repairBrief(task);
    const repairContext = repairBrief && {
      role: "user" as const,
      content: repairBrief,
      createdAt: Date.now(),
    };
    const context = [
      ...(repositoryContext ? [repositoryContext] : []),
      ...(repairContext ? [repairContext] : []),
      ...(handoff && checkpoint?.summary !== handoff
        ? [{ role: "user" as const, content: handoff, createdAt: Date.now() }]
        : []),
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
  /** Converts older conversation evidence into a durable summary before it is omitted. */
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
  /** Drops leading tool-only messages that Gemini cannot interpret as a fresh conversation. */
  private cleanStart(messages: Message[]): Message[] {
    const first = messages.findIndex(
      (message) => message.role === "user" || (message.role === "model" && !message.toolCallId),
    );
    return first < 0 ? messages.slice(-1) : messages.slice(first);
  }
  /** Renders repository facts and ranked files as concise model guidance. */
  private async profileContext(
    task: Task,
    profile: NonNullable<ReturnType<TaskStore["repositorySnapshot"]>>,
  ): Promise<string> {
    const relevantFiles = this.selector.select(this.retrievalQuery(task), profile);
    const [instructions, excerpts] = await Promise.all([
      this.instructions(profile, relevantFiles),
      this.retriever.retrieve(profile.root, relevantFiles, this.retrievalQuery(task)),
    ]);
    const verification = profile.verificationCandidates.map((candidate) => {
      const evidence = candidate.evidence?.map((item) => item.path).join(", ");
      return `${candidate.label} = ${candidate.command}${evidence ? ` [${evidence}]` : ""}`;
    });
    const repositoryProfile = [
      "Repository snapshot:",
      `Root: ${excerpt(profile.root, 500)}`,
      `Ecosystems: ${profile.ecosystems.join(", ") || "none detected"}`,
      `Repository state: ${profile.fingerprint.kind}${profile.fingerprint.branch ? ` branch=${profile.fingerprint.branch}` : ""}${profile.fingerprint.head ? ` head=${profile.fingerprint.head.slice(0, 12)}` : ""}${profile.truncated ? " (inventory truncated)" : ""}`,
      `Changed paths: ${excerpt(profile.changedPaths.join(", ") || "clean or unavailable", 900)}`,
      `Package: ${profile.packageName ?? "unknown"}`,
      `Package manager: ${profile.packageManager}`,
      `Scripts: ${excerpt(Object.keys(profile.scripts).sort().join(", ") || "none detected", 500)}`,
      `Source roots: ${profile.sourceRoots.join(", ") || "none detected"}`,
      `Test roots: ${profile.testRoots.join(", ") || "none detected"}`,
      `Instruction files: ${excerpt(profile.instructionFiles.join(", ") || "none detected", 600)}`,
      `Manifests: ${excerpt(profile.manifestFiles.join(", ") || "none detected", 600)}`,
      `CI files: ${excerpt(profile.ciFiles.join(", ") || "none detected", 600)}`,
      `Build files: ${excerpt(profile.buildFiles.join(", ") || "none detected", 600)}`,
      `Documentation: ${excerpt(profile.documentationFiles.join(", ") || "none detected", 600)}`,
      `Available verification: ${excerpt(verification.join("; ") || "none detected", 900)}`,
      `Relevant files: ${relevantFiles.join(", ") || "use search_files to locate files"}`,
    ].join("\n");
    const sections = [
      `Current task request:\n${excerpt(task.prompt, MAX_REQUEST_CONTEXT_CHARS)}`,
      excerpt(repositoryProfile, MAX_PROFILE_CONTEXT_CHARS),
      instructions,
      excerpts,
      "Use the profile as a guide, inspect files before edits, and choose an appropriate verification command after changes. For custom checks use run_command with verification=true; ordinary inspection commands do not verify a task. Every edit invalidates earlier verification.",
    ].filter(Boolean);
    let remaining = MAX_REPOSITORY_CONTEXT_CHARS;
    const bounded: string[] = [];
    for (const section of sections) {
      if (remaining <= 0) break;
      const included = section.slice(0, remaining);
      bounded.push(included);
      remaining -= included.length;
    }
    return bounded.join("\n\n");
  }

  /** Loads applicable agent instructions for this request without retaining their text. */
  private async instructions(
    profile: NonNullable<ReturnType<TaskStore["repositorySnapshot"]>>,
    relevantFiles: string[],
  ): Promise<string> {
    let remaining = MAX_INSTRUCTION_TOTAL_BYTES;
    const sections: string[] = [];
    for (const path of profile.instructionFiles) {
      const directory = dirname(path).replaceAll("\\", "/");
      const global =
        directory === "." ||
        path === ".github/copilot-instructions.md" ||
        path.startsWith(".cursor/rules/");
      if (!global && !relevantFiles.some((file) => file.startsWith(`${directory}/`))) continue;
      const length = Math.min(MAX_INSTRUCTION_BYTES, remaining);
      if (length <= 0) break;
      const text = await this.readBounded(join(profile.root, path), length);
      if (!text) continue;
      sections.push(`Instructions from ${path}:\n${text}`);
      remaining -= Buffer.byteLength(text);
    }
    return sections.join("\n");
  }

  private async readBounded(path: string, length: number): Promise<string> {
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close();
    }
  }
  /** Combines the request and latest failure evidence for relevance ranking. */
  private retrievalQuery(task: Task): string {
    return [task.prompt, task.error, task.verificationOutput]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.slice(0, 8_000))
      .join("\n");
  }
  /** Renders the latest persisted failure as an actionable repair instruction. */
  private repairBrief(task: Task): string {
    const attempts = this.store.repairAttempts(task.id);
    const latest = attempts.at(-1);
    if (!latest) return "";
    const locations = latest.evidence.fileLocations
      .map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`)
      .join(", ");
    return [
      `Repair attempt ${attempts.length}/2 after \`${latest.command}\` failed.`,
      `Failure: ${latest.evidence.summary}`,
      `Locations: ${locations || "none extracted"}`,
      `Evidence: ${latest.evidence.excerpts.join(" | ") || "inspect the command output"}`,
      `Changed files: ${task.changedFiles.join(", ") || "none recorded"}`,
      `Repair budget remaining: ${Math.max(0, 2 - attempts.length)}.`,
      "Prioritize the affected files, make a materially different repair, then rerun the same focused verification.",
    ].join("\n");
  }
}
