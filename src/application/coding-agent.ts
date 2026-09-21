import { ContextManager } from "./context-manager.js";
import { FailureAnalyzer } from "./failure-analyzer.js";
import { VerificationPlanner } from "./verification-planner.js";
import { conversationSystemInstruction } from "./model-system-instruction.js";
import type {
  Message,
  Task,
  ToolCall,
  ToolResult,
  TaskEvent,
  ModelTurn,
  VerificationSelection,
  ModelSelection,
  TaskPlan,
  FailureEvidence,
} from "../domain/models.js";
import type {
  ApprovalPolicy,
  ModelProvider,
  TaskStore,
  ToolDefinition,
  ToolExecutor,
  JevSafetyAdvisor,
  JevFeatures,
  JevRisk,
} from "../domain/ports.js";

const MAX_MODEL_TURNS = 20;
const MAX_TOOL_CALLS = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_CALLS = 2;
// A small cap prevents an agent from repeatedly editing a workspace without converging.
const MAX_REPAIR_ATTEMPTS = 2;
const MAX_PLANNING_MODEL_TURNS = 12;
const MAX_PLANNING_TOOL_CALLS = 24;
const planningTools = new Set(["list_files", "read_file", "read_file_range", "search_files"]);

export class CodingAgent {
  private readonly context: ContextManager;
  private readonly failureAnalyzer = new FailureAnalyzer();
  private readonly verificationPlanner = new VerificationPlanner();
  /** Creates the coordinator with its model, durable state, tools, and approval boundary. */
  constructor(
    private readonly provider: ModelProvider,
    private readonly store: TaskStore,
    private readonly tools: ToolExecutor,
    private readonly approval: ApprovalPolicy,
    private readonly toolDefinitions: ToolDefinition[],
    private readonly modelSelection?: ModelSelection,
    private readonly jev?: JevSafetyAdvisor,
    private readonly jevFeatures: JevFeatures = {
      routing: true,
      safety: true,
      recovery: true,
      autonomy: false,
    },
  ) {
    this.context = new ContextManager(store);
  }

  /** Starts a new persisted task and drives it until it completes, pauses, or fails. */
  async run(sessionId: string, input: string, onText: (text: string) => void): Promise<void> {
    let task = this.store.startTask(sessionId, input);
    if (this.jev && this.jevFeatures.routing) {
      const decision = await this.jevDecision(task, "route", () =>
        this.jev!.route(this.jevTaskState(input)),
      );
      if (decision?.value === "plan") {
        task = this.store.updateTask(task.id, { mode: "planning" });
        onText("\n[Jev routed this request to a one-time read-only plan]\n");
      }
    }
    await this.executeTask(task, input, onText);
  }

  /** Inspects a workspace and saves a structured plan without allowing any mutation. */
  async plan(sessionId: string, input: string, onText: (text: string) => void): Promise<void> {
    const task = this.store.startTask(sessionId, input, "planning");
    await this.executeTask(task, input, onText);
  }

  /** Answers without creating a task, loading repository context, or allowing tools. */
  async answer(sessionId: string, input: string, onText: (text: string) => void): Promise<void> {
    this.save(sessionId, { role: "user", content: input, createdAt: Date.now() });
    const result = await this.provider.stream(
      [{ role: "user", content: input, createdAt: Date.now() }],
      onText,
      undefined,
      conversationSystemInstruction,
      false,
    );
    if (result.toolCalls.length)
      throw new Error("A conversation response unexpectedly requested a tool.");
    if (result.text)
      this.save(sessionId, { role: "model", content: result.text, createdAt: Date.now() });
  }

  /** Continues the failed task with a replacement provider after a quota exhaustion. */
  async retryAfterProviderQuota(sessionId: string, onText: (text: string) => void): Promise<void> {
    const task = this.store.latestTask(sessionId);
    if (!task || task.status !== "failed")
      throw new Error("No provider-quota failure is available to continue.");
    const resumed = this.store.updateTask(task.id, { status: "acting", error: undefined });
    await this.executeTask(resumed, undefined, onText);
  }

  /** Restarts the latest unfinished task using its saved conversation and repair history. */
  async resume(sessionId: string, onText: (text: string) => void): Promise<void> {
    const task = this.store.latestTask(sessionId);
    if (!task) throw new Error("This session has no task to resume.");
    if (task.status === "completed" || task.status === "planned" || task.status === "cancelled")
      throw new Error(`Task is already ${task.status}. Start a new task instead.`);
    const resumed = this.store.updateTask(task.id, {
      status: "planning",
      error: undefined,
    });
    this.save(sessionId, {
      role: "user",
      content: `Resume the interrupted task: ${resumed.prompt}. Inspect the recorded context, resolve unfinished work, and verify any prior changes.`,
      createdAt: Date.now(),
    });
    await this.executeTask(resumed, undefined, onText);
  }

  /** Returns the newest task state for a session without changing it. */
  status(sessionId: string): Task | undefined {
    return this.store.latestTask(sessionId);
  }
  /** Marks the active task as cancelled so later model turns cannot continue it. */
  cancel(sessionId: string): Task | undefined {
    const task = this.store.latestTask(sessionId);
    return (
      task &&
      this.store.updateTask(task.id, {
        status: "cancelled",
        summary: "Cancelled by user.",
      })
    );
  }
  /** Saves a compact checkpoint for the current task's long conversation. */
  compact(sessionId: string): string | undefined {
    const task = this.store.latestTask(sessionId);
    return task && this.context.compact(sessionId, task);
  }

  /** Runs a user-requested verification command through the normal approval gate. */
  async verify(sessionId: string, command: string, onText: (text: string) => void): Promise<void> {
    let task = this.store.latestTask(sessionId);
    if (!task) throw new Error("Start a task before running verification.");
    task = this.store.updateTask(task.id, {
      status: "verifying",
      verificationCommand: command,
      verificationOutput: undefined,
      verificationPassed: undefined,
      verificationExitCode: undefined,
      verificationDiscovered: this.isDiscoveredVerification(task.sessionId, command),
      verificationSelection: this.verificationPlanner.selectionForCommand(
        this.store.repositorySnapshot(task.sessionId),
        command,
        "manual",
      ),
    });
    this.recordVerificationSelection(task, task.verificationSelection!);
    const call: ToolCall = {
      id: crypto.randomUUID(),
      name: "run_command",
      args: { command, verification: true },
    };
    const result = await this.executeTool(task, call, onText);
    task = this.store.updateTask(task.id, {
      verificationOutput: result.output,
      verificationPassed: result.ok,
      verificationExitCode: result.exitCode ?? null,
      status: result.ok ? "completed" : "failed",
      error: result.ok ? undefined : result.output,
    });
    onText(result.ok ? "\n[Verification passed]\n" : "\n[Verification failed]\n");
  }

  /** Executes bounded model and tool turns for one task. */
  private async executeTask(
    initialTask: Task,
    initialInput: string | undefined,
    onText: (text: string) => void,
  ): Promise<void> {
    let task = this.store.updateTask(initialTask.id, {
      status: initialTask.mode === "planning" ? "planning" : "acting",
    });
    if (initialInput)
      this.save(task.sessionId, {
        role: "user",
        content: initialInput,
        createdAt: Date.now(),
      });
    const calls = new Map<string, number>();
    let toolCalls = 0;
    let failures = 0;
    try {
      const maxTurns = task.mode === "planning" ? MAX_PLANNING_MODEL_TURNS : MAX_MODEL_TURNS;
      const maxToolCalls = task.mode === "planning" ? MAX_PLANNING_TOOL_CALLS : MAX_TOOL_CALLS;
      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (this.store.task(task.id)?.status === "cancelled") {
          onText("\nTask cancelled.\n");
          return;
        }
        const result = await this.modelTurn(task, onText);
        if (result.text)
          this.save(task.sessionId, {
            role: "model",
            content: result.text,
            createdAt: Date.now(),
          });
        if (!result.toolCalls.length) {
          if (task.mode === "planning") {
            // PLAN mode can also answer a greeting or conceptual question. A plan is
            // durable only after submit_plan, but plain conversational text is not an
            // agent failure and should not be presented as one.
            this.finish(task);
            return;
          }
          const verification = await this.runRecommendedVerification(task, onText);
          task = this.store.task(task.id)!;
          if (verification === "ran") {
            if (task.status === "failed") {
              onText(`\nKairo couldn't complete this task: ${task.error}\n`);
              return;
            }
            failures = 0;
            continue;
          }
          if (verification === "denied") return;
          task = this.finish(task);
          if (task.status === "verification_required")
            onText(
              "\nChanges were made but no successful verification command ran. Use `/verify <command>`.\n",
            );
          return;
        }
        for (const call of result.toolCalls) {
          toolCalls += 1;
          if (toolCalls > maxToolCalls) return this.fail(task, "Tool-call limit reached.", onText);
          const fingerprint = `${call.name}:${JSON.stringify(call.args)}`;
          const count = (calls.get(fingerprint) || 0) + 1;
          calls.set(fingerprint, count);
          if (count > MAX_IDENTICAL_CALLS)
            return this.fail(task, `Repeated identical tool call blocked: ${call.name}.`, onText);
          const outcome = await this.executeTool(task, call, onText);
          task = this.store.task(task.id)!;
          if (task.status === "planned" || task.status === "verification_required") return;
          if (task.status === "failed") {
            onText(`\nKairo couldn't complete this task: ${task.error}\n`);
            return;
          }
          failures = outcome.ok ? 0 : failures + 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES)
            return this.fail(task, "Too many consecutive tool failures.", onText);
        }
      }
      this.fail(task, "Model-turn limit reached.", onText);
    } catch (error) {
      this.fail(task, `Model error: ${(error as Error).message}`, onText);
      throw error;
    }
  }

  /** Completes only tasks whose changed files have a successful verification result. */
  private finish(task: Task): Task {
    return this.store.updateTask(task.id, {
      status:
        task.changedFiles.length && task.verificationPassed !== true
          ? "verification_required"
          : "completed",
    });
  }
  /** Records a terminal task failure and makes the reason visible in the REPL. */
  private fail(task: Task, error: string, onText: (text: string) => void): void {
    this.store.updateTask(task.id, { status: "failed", error });
    onText(`\nKairo couldn't complete this task: ${error}\n`);
  }
  /** Appends a durable conversation message for later context reconstruction. */
  private save(session: string, message: Message): void {
    this.store.addMessage(session, message);
  }

  /** Applies approval, executes one tool call, and persists its observable outcome. */
  private async executeTool(
    task: Task,
    call: ToolCall,
    onText: (text: string) => void,
  ): Promise<ToolResult> {
    this.event(task, {
      kind: "tool_requested",
      operationId: call.id,
      name: call.name.slice(0, 120),
    });
    if (task.mode === "planning") return this.executePlanningTool(task, call, onText);
    return this.executeApprovedTool(task, call, onText);
  }

  /** Keeps planning tasks read-only and accepts their final artifact without a workspace call. */
  private async executePlanningTool(
    task: Task,
    call: ToolCall,
    onText: (text: string) => void,
  ): Promise<ToolResult> {
    if (call.name === "submit_plan") {
      this.save(task.sessionId, {
        role: "model",
        content: JSON.stringify(call.args),
        toolCallId: call.id,
        toolName: call.name,
        createdAt: Date.now(),
      });
      const plan = this.validatePlan(call.args);
      if (!plan) return this.record(task, call, false, "Invalid plan submission.", false);
      this.event(task, { kind: "tool_started", operationId: call.id, name: call.name });
      this.store.updateTask(task.id, { status: "planned", plan });
      this.event(task, {
        kind: "tool_finished",
        operationId: call.id,
        name: call.name,
        outcome: "succeeded",
      });
      this.event(task, { kind: "plan_submitted", operationId: call.id, name: "plan" });
      this.store.recordTool(task.sessionId, call.id, call.name, call.args, null, "Plan saved.");
      this.save(task.sessionId, {
        role: "tool",
        content: "Plan saved.",
        toolCallId: call.id,
        toolName: call.name,
        createdAt: Date.now(),
      });
      onText("\n[Plan saved]\n");
      return { ok: true, output: "Plan saved." };
    }
    if (!planningTools.has(call.name))
      return this.record(
        task,
        call,
        false,
        "Planning mode allows only repository reads and submit_plan; no edits or commands ran.",
        false,
      );
    return this.executeApprovedTool(task, call, onText);
  }

  /** Validates persisted plan data rather than trusting provider-produced tool arguments. */
  private validatePlan(args: Record<string, unknown>): TaskPlan | undefined {
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
        ? value.map((item) => item.trim())
        : undefined;
    const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim() : undefined;
    const assumptions = strings(args.assumptions);
    const steps = strings(args.steps);
    const risks = strings(args.risks);
    const files = Array.isArray(args.files)
      ? args.files.map((file) => {
          const value = file as Record<string, unknown>;
          return {
            path: typeof value.path === "string" ? value.path.trim() : "",
            reason: typeof value.reason === "string" ? value.reason.trim() : "",
          };
        })
      : undefined;
    const verification = args.verification as Record<string, unknown> | undefined;
    const command =
      typeof verification?.command === "string" ? verification.command.trim() : undefined;
    const reason = typeof verification?.reason === "string" ? verification.reason.trim() : "";
    if (
      !goal ||
      !assumptions ||
      !steps?.length ||
      !risks ||
      !files?.length ||
      !reason ||
      files.some(
        (file) =>
          !file.path ||
          !file.reason ||
          file.path.startsWith("/") ||
          file.path.split("/").includes(".."),
      )
    )
      return undefined;
    return {
      goal,
      assumptions,
      files,
      steps,
      verification: { ...(command ? { command } : {}), reason },
      risks,
    };
  }

  /** Records model latency even when streaming fails; partial operations remain visible after restart. */
  private async modelTurn(task: Task, onText: (text: string) => void): Promise<ModelTurn> {
    const messages = this.context.prepare(task.sessionId, task);
    const operationId = crypto.randomUUID();
    const modelName = this.modelSelection
      ? `${this.modelSelection.provider}/${this.modelSelection.model}`
      : undefined;
    this.event(task, { kind: "model_started", operationId, name: modelName });
    const started = performance.now();
    try {
      const result = await this.provider.stream(
        messages,
        onText,
        (progress) => {
          this.event(task, {
            kind:
              progress.kind === "retry"
                ? "provider_retry"
                : progress.kind === "retry_wait"
                  ? "provider_retry_wait"
                  : "provider_exhausted",
            operationId,
            outcome: progress.category,
            durationMs: progress.kind === "retry_wait" ? progress.delayMs : undefined,
          });
          if (progress.kind === "retry")
            onText(
              `\n[${this.modelSelection?.provider ?? "provider"} ${progress.category}: retry ${progress.retry}/3 in ${(progress.delayMs / 1000).toFixed(1)}s]\n`,
            );
          if (progress.kind === "exhausted")
            onText(
              `\n[${this.modelSelection?.provider ?? "provider"} ${progress.category}: stopped retrying after ${progress.retry} retries]\n`,
            );
        },
        this.instruction(task),
      );
      this.event(task, {
        kind: "model_finished",
        operationId,
        name: modelName,
        outcome: "succeeded",
        durationMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      this.event(task, {
        kind: "model_finished",
        operationId,
        name: modelName,
        outcome: "failed",
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }

  /** Gives planning its own strict contract while preserving the existing implementation prompt. */
  private instruction(task: Task): string | undefined {
    if (task.mode !== "planning") return undefined;
    return [
      "You are Kairo in read-only planning mode.",
      "For a request to change, investigate, or plan repository work, inspect only the files needed to make a concrete plan. You may use only list_files, read_file, read_file_range, and search_files.",
      "For greetings or general questions that do not need repository context, answer directly without tools and do not submit a plan.",
      "Never call write_file, edit_file, or run_command. Do not claim to have changed or verified anything.",
      "When ready, call submit_plan with a concrete goal, assumptions, affected repository-relative files and reasons, ordered steps, a recommended verification command or no-command explanation, and risks.",
      "For repository work, submit_plan is required to save the structured plan; do not end with prose alone.",
    ].join(" ");
  }

  /** Attaches identity and wall-clock time without retaining prompts or tool arguments. */
  private event(task: Task, event: Omit<TaskEvent, "taskId" | "createdAt">): void {
    this.store.recordTaskEvent({ ...event, taskId: task.id, createdAt: Date.now() });
  }

  /** Executes a tool after user approval, except for the deliberately narrow Jev trust envelope. */
  private async executeApprovedTool(
    task: Task,
    call: ToolCall,
    onText: (text: string) => void,
  ): Promise<ToolResult> {
    const definition = this.toolDefinitions.find((item) => item.name === call.name);
    const isVerification =
      call.name === "run_command" &&
      (call.args.verification === true ||
        this.isDiscoveredVerification(task.sessionId, String(call.args.command ?? "")));
    this.save(task.sessionId, {
      role: "model",
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: call.name,
      createdAt: Date.now(),
    });
    let approved: boolean | null = null;
    if (!definition) return this.record(task, call, false, "Unknown tool requested.", false);
    if (definition.mutating) {
      if (await this.autonomouslyApprovedVerification(task, call, isVerification)) {
        this.event(task, {
          kind: "autonomous",
          operationId: call.id,
          name: call.name,
          outcome: "jev-low-risk-discovered-verification",
        });
        onText(`\n[Jev autonomously approved discovered verification]\n`);
      } else {
        const description = await this.approvalDescription(task, call);
        const approvalStarted = performance.now();
        approved = await this.approval.approve(call, description);
        this.event(task, {
          kind: "approval",
          operationId: call.id,
          outcome: approved ? "approved" : "denied",
          durationMs: performance.now() - approvalStarted,
        });
        if (!approved) {
          onText(`\n[Denied] ${call.name}\n`);
          return this.record(task, call, false, "User denied this action.", false);
        }
      }
    }
    onText(`\n[Tool] ${call.name}\n`);
    this.event(task, { kind: "tool_started", operationId: call.id, name: call.name });
    const started = performance.now();
    let result: ToolResult;
    try {
      result = await this.tools.execute(call);
    } catch (error) {
      this.event(task, {
        kind: "tool_finished",
        operationId: call.id,
        name: call.name,
        outcome: "failed",
        durationMs: performance.now() - started,
      });
      throw error;
    }
    this.event(task, {
      kind: "tool_finished",
      operationId: call.id,
      name: call.name,
      outcome: result.ok ? "succeeded" : "failed",
      durationMs: performance.now() - started,
      exitCode: result.exitCode,
    });
    if (isVerification && task.verificationSelection?.command !== String(call.args.command ?? "")) {
      const selection = this.verificationPlanner.selectionForCommand(
        this.store.repositorySnapshot(task.sessionId),
        String(call.args.command ?? ""),
        "model",
      );
      task = this.store.updateTask(task.id, { verificationSelection: selection });
      this.recordVerificationSelection(task, selection);
    }
    if (isVerification)
      this.event(task, {
        kind: "verification",
        operationId: call.id,
        outcome: result.ok ? "passed" : "failed",
        exitCode: result.exitCode,
      });
    if (
      result.ok &&
      (call.name === "write_file" || call.name === "edit_file") &&
      typeof call.args.path === "string"
    ) {
      const changedFiles = [...new Set([...task.changedFiles, call.args.path])];
      this.store.updateTask(task.id, {
        changedFiles,
        verificationPassed: undefined,
        verificationExitCode: undefined,
        verificationOutput: undefined,
      });
      task = this.store.task(task.id)!;
    }
    if (isVerification)
      this.store.updateTask(task.id, {
        verificationCommand: String(call.args.command ?? ""),
        verificationOutput: result.output,
        verificationPassed: result.ok,
        verificationExitCode: result.exitCode ?? null,
        verificationDiscovered: this.isDiscoveredVerification(
          task.sessionId,
          String(call.args.command ?? ""),
        ),
      });
    if (isVerification && !result.ok && task.changedFiles.length) {
      const attempts = this.store.repairAttempts(task.id);
      const command = String(call.args.command ?? "");
      const evidence = this.failureAnalyzer.analyze(command, result.output);
      const decision =
        this.jev && this.jevFeatures.recovery
          ? await this.jevDecision(task, "recovery", () =>
              this.jev!.recover(this.jevRecoveryState(task, evidence)),
            )
          : undefined;
      if (decision?.value === "escalate") {
        this.store.updateTask(task.id, {
          status: "verification_required",
          error: "Jev recommends manual verification review before further repair.",
        });
        onText(
          "\n[Jev escalated failed verification for manual review. Use /verify <command> when ready.]\n",
        );
      } else if (decision?.value === "broaden") {
        const profile = this.store.repositorySnapshot(task.sessionId);
        const selection =
          profile && task.verificationSelection
            ? this.verificationPlanner.broader(profile, task.verificationSelection)
            : undefined;
        if (selection) {
          task = this.store.updateTask(task.id, {
            status: "verifying",
            verificationSelection: selection,
          });
          this.recordVerificationSelection(task, selection);
          onText(
            `\n[Jev recommends broader verification: ${selection.command}. Approval required before it runs.]\n`,
          );
          const broadened = await this.executeTool(
            task,
            {
              id: crypto.randomUUID(),
              name: "run_command",
              args: { command: selection.command, verification: true },
            },
            onText,
          );
          if (broadened.output === "User denied this action.")
            this.store.updateTask(task.id, { status: "verification_required" });
        } else {
          this.recordRepair(task, attempts.length, command, evidence, onText);
        }
      } else if (attempts.length >= MAX_REPAIR_ATTEMPTS) {
        this.store.updateTask(task.id, {
          status: "failed",
          error: `Repair limit reached after ${MAX_REPAIR_ATTEMPTS} failed verification attempts.`,
        });
      } else {
        this.recordRepair(task, attempts.length, command, evidence, onText);
      }
    }
    this.store.recordTool(task.sessionId, call.id, call.name, call.args, approved, result.output);
    this.save(task.sessionId, {
      role: "tool",
      content: result.output,
      toolCallId: call.id,
      toolName: call.name,
      createdAt: Date.now(),
    });
    return result;
  }

  /** Auto-authorizes only known verification after a high-confidence low-risk Jev assessment. */
  private async autonomouslyApprovedVerification(
    task: Task,
    call: ToolCall,
    isVerification: boolean,
  ): Promise<boolean> {
    if (
      !this.jev ||
      !this.jevFeatures.safety ||
      !this.jevFeatures.autonomy ||
      call.name !== "run_command" ||
      !isVerification ||
      !this.isDiscoveredVerification(task.sessionId, String(call.args.command ?? ""))
    )
      return false;
    const assessment = await this.jevAssessment(task, call);
    return assessment?.value === "low";
  }

  /** Adds an advisory Jev label while preserving user approval outside the trust envelope. */
  private async approvalDescription(task: Task, call: ToolCall): Promise<string> {
    const description = this.tools.description(call);
    const assessment = await this.jevAssessment(task, call);
    return assessment
      ? `${description}\nJev risk: ${assessment.value} (${Math.round(assessment.confidence * 100)}% confidence).`
      : this.jev && this.jevFeatures.safety
        ? `${description}\nJev risk: unavailable — standard approval required.`
        : description;
  }

  /** Requests a typed risk assessment once; uncertain and failed assessments fall back safely. */
  private async jevAssessment(
    task: Task,
    call: ToolCall,
  ): Promise<{ value: JevRisk; confidence: number } | undefined> {
    if (!this.jev || !this.jevFeatures.safety) return undefined;
    return this.jevDecision(task, "safety", async () => {
      const result = await this.jev!.assess(this.jevState(task, call));
      return { value: result.risk, confidence: result.confidence };
    });
  }

  /** Records only decision metadata; low-confidence and failed decisions never change agent behavior. */
  private async jevDecision<T extends string>(
    task: Task,
    name: string,
    decide: () => Promise<{ value: T; confidence: number }>,
  ): Promise<{ value: T; confidence: number } | undefined> {
    const operationId = crypto.randomUUID();
    const started = performance.now();
    this.event(task, { kind: "jev_requested", operationId, name });
    try {
      const decision = await decide();
      const reliable = decision.confidence >= 0.85;
      this.event(task, {
        kind: "jev_completed",
        operationId,
        name,
        outcome: `${decision.value}:${reliable ? "high-confidence" : "uncertain"}`,
        durationMs: performance.now() - started,
      });
      return reliable ? decision : undefined;
    } catch {
      this.event(task, {
        kind: "jev_failed",
        operationId,
        name,
        outcome: "unavailable",
        durationMs: performance.now() - started,
      });
      return undefined;
    }
  }

  /** Builds bounded operation metadata without sending source, output, or secret-bearing edit content. */
  private jevState(task: Task, call: ToolCall): string {
    const redact = (value: string) =>
      value
        .replace(/(?:sk|gsk|or|AIza)[-_a-zA-Z0-9]{12,}/g, "[redacted]")
        .replace(/((?:api[_-]?key|token|password))\s*[=:]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 1_500);
    const detail =
      call.name === "run_command"
        ? `command: ${redact(String(call.args.command ?? ""))}`
        : `path: ${redact(String(call.args.path ?? "workspace"))}`;
    return [
      `Task: ${redact(task.prompt)}`,
      `Tool: ${call.name}`,
      detail,
      "No source file contents, prior tool output, or credentials are included.",
    ].join("\n");
  }

  private jevTaskState(input: string): string {
    return `Task request: ${input.replace(/(?:sk|gsk|or|AIza)[-_a-zA-Z0-9]{12,}/g, "[redacted]").slice(0, 1_500)}\nChoose whether Kairo should build directly or first create a read-only plan.`;
  }

  /** Supplies failure metadata only; provider output and source snippets remain local. */
  private jevRecoveryState(task: Task, evidence: FailureEvidence): string {
    return [
      `Changed paths: ${task.changedFiles.map((path) => path.slice(0, 240)).join(", ")}`,
      `Verification scope: ${task.verificationSelection?.scope ?? "unknown"}`,
      `Failure evidence: ${evidence.fileLocations.length ? "file locations extracted" : "no file locations extracted"}`,
      `Affected paths: ${evidence.fileLocations.map((location) => location.path.slice(0, 240)).join(", ") || "unknown"}`,
      "Choose repair, broader verification, or manual escalation. No source or command output is included.",
    ]
      .join("\n")
      .slice(0, 1_500);
  }

  private recordRepair(
    task: Task,
    previousAttempts: number,
    command: string,
    evidence: FailureEvidence,
    onText: (text: string) => void,
  ): void {
    this.store.recordRepairAttempt({
      id: `repair-${crypto.randomUUID()}`,
      taskId: task.id,
      command,
      evidence,
      selectedFiles: evidence.fileLocations.map((location) => location.path),
      createdAt: Date.now(),
    });
    onText(
      `\n[Verification failed — repair attempt ${previousAttempts + 1}/${MAX_REPAIR_ATTEMPTS}]\n`,
    );
  }

  /** Persists a tool call that could not reach the executor, such as a denied request. */
  private record(
    task: Task,
    call: ToolCall,
    ok: boolean,
    output: string,
    approved: boolean,
  ): ToolResult {
    this.event(task, {
      kind: "tool_finished",
      operationId: call.id,
      name: call.name.slice(0, 120),
      outcome: output === "User denied this action." ? "denied" : "rejected",
    });
    this.store.recordTool(task.sessionId, call.id, call.name, call.args, approved, output);
    this.save(task.sessionId, {
      role: "tool",
      content: output,
      toolCallId: call.id,
      toolName: call.name,
      createdAt: Date.now(),
    });
    return { ok, output };
  }
  /** Identifies commands suggested by the workspace's discovered verification scripts. */
  private isDiscoveredVerification(sessionId: string, command: string): boolean {
    return (
      this.store
        .repositorySnapshot(sessionId)
        ?.verificationCandidates.some((candidate) => candidate.command === command) ?? false
    );
  }

  /** Recommends and runs one post-edit check through the ordinary approval gate. */
  private async runRecommendedVerification(
    task: Task,
    onText: (text: string) => void,
  ): Promise<"none" | "ran" | "denied"> {
    if (!task.changedFiles.length) return "none";
    const latestRepair = this.store.repairAttempts(task.id).at(-1);
    const profile = this.store.repositorySnapshot(task.sessionId);
    const selection: VerificationSelection | undefined =
      task.verificationPassed === true &&
      task.verificationSelection?.label === "typecheck" &&
      profile
        ? this.verificationPlanner.broader(profile, task.verificationSelection)
        : latestRepair && task.verificationPassed !== true
          ? {
              command: latestRepair.command,
              label: "custom",
              scope: task.verificationSelection?.scope ?? "broad",
              reason: "Rerun the failed verification after a focused repair.",
              source: "repair",
            }
          : task.verificationPassed !== true && profile
            ? this.verificationPlanner.select(profile, task.changedFiles)
            : undefined;
    if (!selection) return "none";
    task = this.store.updateTask(task.id, {
      status: "verifying",
      verificationSelection: selection,
      verificationCommand: selection.command,
      verificationOutput: undefined,
      verificationPassed: undefined,
      verificationExitCode: undefined,
      verificationDiscovered: this.isDiscoveredVerification(task.sessionId, selection.command),
    });
    this.recordVerificationSelection(task, selection);
    onText(
      `\n[Recommended ${selection.scope} verification: ${selection.command} — ${selection.reason}]\n`,
    );
    const result = await this.executeTool(
      task,
      {
        id: crypto.randomUUID(),
        name: "run_command",
        args: { command: selection.command, verification: true },
      },
      onText,
    );
    if (result.output === "User denied this action.") {
      this.store.updateTask(task.id, { status: "verification_required" });
      onText("\n[Verification recommendation declined. Use /verify <command> when ready.]\n");
      return "denied";
    }
    return "ran";
  }

  /** Stores selection metadata in the trace without command arguments or output. */
  private recordVerificationSelection(task: Task, selection: VerificationSelection): void {
    this.event(task, {
      kind: "verification_selected",
      name: selection.label,
      outcome: selection.scope,
    });
  }
}
