import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useMemo, useState } from "react";
import type { ModelSelection, TaskStatus, ToolCall } from "../../domain/models.js";
import type { ApprovalPolicy, CredentialStore } from "../../domain/ports.js";
import { CodingAgent } from "../../application/coding-agent.js";
import { setModelSelection } from "../../infrastructure/configuration/config.js";
import {
  isProviderId,
  providerRegistry,
} from "../../infrastructure/providers/provider-registry.js";
import { formatMetrics, formatPlan, formatTrace } from "./task-trace.js";
import {
  SqliteSessionStore,
  type Session,
} from "../../infrastructure/persistence/sqlite-session-store.js";

export type InteractionMode = "build" | "plan";

type TranscriptEntry = {
  id: number;
  kind: "user" | "assistant" | "system" | "error";
  text: string;
};

type PendingApproval = { description: string; resolve: (approved: boolean) => void };
export type ModelOption = ModelSelection & { label: string };

export const slashCommands = [
  { name: "/plan", description: "Toggle read-only planning mode" },
  { name: "/models", description: "Choose a model" },
  { name: "/new", description: "Start a new session" },
  { name: "/resume", description: "Continue a task or open a session", acceptsArgument: true },
  { name: "/history", description: "List saved sessions" },
  { name: "/status", description: "Show the latest task status" },
  { name: "/trace", description: "Show task activity", acceptsArgument: true },
  { name: "/changes", description: "Show changed files" },
  { name: "/verify", description: "Run a verification command", acceptsArgument: true },
  { name: "/compact", description: "Save a context checkpoint" },
  { name: "/cancel", description: "Cancel the current task" },
  { name: "/logout", description: "Remove the active provider credential" },
  { name: "/quit", description: "Exit Kairo" },
] as const;

/** Finds palette entries while the user is typing a slash-command name. */
export function matchingSlashCommands(input: string): readonly (typeof slashCommands)[number][] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  return slashCommands.filter((command) => command.name.startsWith(input.toLowerCase()));
}

function commandInput(command: (typeof slashCommands)[number]): string {
  return `${command.name}${"acceptsArgument" in command && command.acceptsArgument ? " " : ""}`;
}

/** Flattens the supported provider registry into the options shown by `/models`. */
export function modelOptions(): ModelOption[] {
  return providerRegistry.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      model: model.id,
      label: `${provider.name} — ${model.label}${model.recommended ? " (recommended)" : ""}`,
    })),
  );
}

/** Bridges the agent's approval port to the active Ink application. */
export class TuiApproval implements ApprovalPolicy {
  constructor(private readonly request: (pending: PendingApproval) => void) {}
  async approve(_call: ToolCall, description: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => this.request({ description, resolve }));
  }
}

/** `/plan` is intentionally a live toggle, never a one-shot planning command. */
export function interactionModeAfterCommand(
  mode: InteractionMode,
  command: string,
): InteractionMode {
  return command === "/plan" ? (mode === "build" ? "plan" : "build") : mode;
}

export function ModeBadge({ mode }: { mode: InteractionMode }): React.JSX.Element {
  return <Text color={mode === "plan" ? "yellow" : "green"}>{mode.toUpperCase()}</Text>;
}

function entryColor(entry: TranscriptEntry): string | undefined {
  if (entry.kind === "user") return "cyan";
  if (entry.kind === "error") return "red";
  if (entry.kind === "system") return "yellow";
  return undefined;
}

export interface KairoTuiProps {
  createAgent: (approval: ApprovalPolicy, selection: ModelSelection, apiKey: string) => CodingAgent;
  store: SqliteSessionStore;
  session: Session;
  initialSelection: ModelSelection;
  initialApiKey?: string;
  credentials: CredentialStore;
}

/** Renders one bounded Kairo session and dispatches terminal commands without readline. */
export function KairoTui(props: KairoTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const [active, setActive] = useState(props.session);
  const [selection, setSelection] = useState(props.initialSelection);
  const [apiKey, setApiKey] = useState<string | undefined>(props.initialApiKey);
  const [mode, setMode] = useState<InteractionMode>("build");
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<TranscriptEntry[]>([
    {
      id: 0,
      kind: "system",
      text: `Kairo session ${props.session.id} — BUILD mode. Type / for commands.`,
    },
  ]);
  const [busy, setBusy] = useState<"idle" | "planning" | "acting" | "verifying" | "cancelled">(
    "idle",
  );
  const [activity, setActivity] = useState<string>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [modelPicker, setModelPicker] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const models = useMemo(modelOptions, []);
  const commandMatches = useMemo(() => matchingSlashCommands(input), [input]);
  const approval = useMemo(
    () =>
      new TuiApproval((pending) => {
        setBusy("acting");
        setPendingApproval(pending);
      }),
    [],
  );
  const agent = useMemo(
    () => (apiKey ? props.createAgent(approval, selection, apiKey) : undefined),
    [apiKey, approval, props.createAgent, selection],
  );
  const append = useCallback((kind: TranscriptEntry["kind"], text: string) => {
    setEntries((current) => [...current, { id: current.length, kind, text }]);
  }, []);
  const appendStream = useCallback((entryId: number, chunk: string) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === entryId ? { ...entry, text: entry.text + chunk } : entry,
      ),
    );
  }, []);
  const answerApproval = useCallback(
    (approved: boolean) => {
      if (!pendingApproval) return;
      setPendingApproval(undefined);
      append("system", approved ? "Approved action." : "Denied action.");
      pendingApproval.resolve(approved);
    },
    [append, pendingApproval],
  );

  useInput((inputKey, key) => {
    if (!pendingApproval) return;
    if (inputKey.toLowerCase() === "y" || key.return) answerApproval(true);
    if (inputKey.toLowerCase() === "n" || key.escape) answerApproval(false);
  });

  useInput((inputKey, key) => {
    if (pendingApproval || modelPicker || !commandMatches.length) return;
    if (key.upArrow) return setCommandIndex((current) => Math.max(0, current - 1));
    if (key.downArrow)
      return setCommandIndex((current) => Math.min(commandMatches.length - 1, current + 1));
    if (key.tab) {
      const selected = commandMatches[commandIndex];
      if (selected) setInput(commandInput(selected));
    }
  });

  const chooseModel = useCallback(
    async (next: ModelSelection) => {
      const nextKey = await props.credentials.get(next.provider);
      if (!nextKey) {
        append(
          "error",
          `No ${next.provider} credential. Run \`kairo auth login ${next.provider}\`, then reopen /models.`,
        );
        return;
      }
      await setModelSelection(next);
      setSelection(next);
      setApiKey(nextKey);
      append("system", `Using ${next.provider}/${next.model}.`);
    },
    [append, props.credentials],
  );

  useInput((inputKey, key) => {
    if (!modelPicker) return;
    if (key.escape) return setModelPicker(false);
    if (key.upArrow) return setModelIndex((current) => Math.max(0, current - 1));
    if (key.downArrow) return setModelIndex((current) => Math.min(models.length - 1, current + 1));
    if (key.return) {
      const next = models[modelIndex];
      setModelPicker(false);
      if (next) void chooseModel(next);
    }
    if (/^[1-9]$/.test(inputKey)) {
      const next = models[Number(inputKey) - 1];
      if (next) {
        setModelPicker(false);
        void chooseModel(next);
      }
    }
  });

  const runTask = useCallback(
    async (request: string, taskMode: InteractionMode) => {
      if (!agent)
        return append(
          "error",
          "No active credential. Run `kairo auth login <provider>`, then use /models.",
        );
      append("user", request);
      const entryId = entries.length + 1;
      setEntries((current) => [...current, { id: entryId, kind: "assistant", text: "" }]);
      setBusy(taskMode === "plan" ? "planning" : "acting");
      setActivity(taskMode === "plan" ? "Planning" : "Working");
      const onAgentText = (chunk: string) => {
        const tool = /^\n\[Tool] ([^\n]+)\n$/.exec(chunk);
        if (tool) {
          setActivity(`${taskMode === "plan" ? "Planning" : "Working"} · ${tool[1]}…`);
          return;
        }
        if (/^\n\[(Plan saved|Verification passed)]\n$/.test(chunk)) return;
        appendStream(entryId, chunk);
      };
      try {
        if (taskMode === "plan") await agent.plan(active.id, request, onAgentText);
        else await agent.run(active.id, request, onAgentText);
        const task = agent.status(active.id);
        if (task?.mode === "planning" && task.plan) append("system", formatPlan(task.plan));
        if ((task?.status as TaskStatus | undefined) === "cancelled")
          append("system", "Task cancelled.");
        setActivity(undefined);
        setBusy("idle");
      } catch (error) {
        setActivity(undefined);
        setBusy("idle");
        append("error", `Kairo: ${(error as Error).message}`);
      }
    },
    [active.id, agent, append, appendStream, entries.length],
  );

  const submit = useCallback(
    async (value: string) => {
      const line = value.trim();
      if (!line || busy !== "idle" || pendingApproval) return;
      const selectedCommand = commandMatches[commandIndex];
      if (selectedCommand && line !== selectedCommand.name) {
        setInput(commandInput(selectedCommand));
        return;
      }
      setInput("");
      if (line === "/plan") {
        const next = interactionModeAfterCommand(mode, line);
        setMode(next);
        return;
      }
      if (line === "/quit" || line === "/exit") return exit();
      if (line === "/new") {
        const next = props.store.create(active.workspace);
        setActive(next);
        setMode("build");
        return append("system", `New session: ${next.id} — BUILD mode.`);
      }
      if (line === "/history") {
        return append(
          "system",
          props.store
            .list()
            .map((item) => `${item.id}  ${item.workspace}`)
            .join("\n") || "No sessions.",
        );
      }
      if (line === "/status" || line === "/changes") {
        const task = agent?.status(active.id);
        return append(
          "system",
          !task
            ? "No task has run in this session."
            : line === "/changes"
              ? task.changedFiles.join("\n") || "No files changed."
              : `${task.status} (${task.mode}): ${task.prompt}\n${formatMetrics(props.store.taskEvents(task.id))}`,
        );
      }
      if (line === "/trace" || line.startsWith("/trace ")) {
        const task =
          line === "/trace" ? agent?.status(active.id) : props.store.task(line.slice(7).trim());
        return append(
          "system",
          task && task.sessionId === active.id
            ? formatTrace(task, props.store.taskEvents(task.id))
            : "Task not found in this session.",
        );
      }
      if (line === "/compact")
        return append(
          "system",
          agent?.compact(active.id) ? "Context checkpoint saved." : "No task to compact.",
        );
      if (line === "/cancel") {
        agent?.cancel(active.id);
        setBusy("acting");
        return append("system", "Task cancelled.");
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const sessionId = line.slice(7).trim();
        if (sessionId) {
          const next = props.store.get(sessionId);
          if (!next) return append("error", "Session not found.");
          setActive(next);
          setMode("build");
          return append("system", `Resumed ${next.id} — BUILD mode.`);
        }
        if (!agent) return append("error", "No active credential.");
        setMode("build");
        setBusy("acting");
        try {
          await agent.resume(active.id, (chunk) => append("assistant", chunk));
          setBusy("idle");
        } catch (error) {
          setBusy("idle");
          append("error", `Kairo: ${(error as Error).message}`);
        }
        return;
      }
      if (line.startsWith("/verify ")) {
        if (!agent) return append("error", "No active credential.");
        setBusy("verifying");
        try {
          await agent.verify(active.id, line.slice(8).trim(), (chunk) =>
            append("assistant", chunk),
          );
          setBusy("idle");
        } catch (error) {
          setBusy("idle");
          append("error", `Kairo: ${(error as Error).message}`);
        }
        return;
      }
      if (line === "/models") {
        const selected = models.findIndex(
          (item) => item.provider === selection.provider && item.model === selection.model,
        );
        setModelIndex(Math.max(0, selected));
        setModelPicker(true);
        return;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const [provider, ...modelParts] = line.slice(6).trim().split(/\s+/);
        if (!provider || !modelParts.length || !isProviderId(provider))
          return append(
            "system",
            `Current model: ${selection.provider}/${selection.model}\nUse: /model <gemini|groq> <model-id>`,
          );
        const next = { provider, model: modelParts.join(" ") };
        await chooseModel(next);
        return;
      }
      if (line === "/logout") {
        await props.credentials.clear(selection.provider);
        setApiKey(undefined);
        return append(
          "system",
          `${selection.provider} credential removed. Use /model with another logged-in provider.`,
        );
      }
      await runTask(line, mode);
    },
    [
      active,
      agent,
      append,
      busy,
      exit,
      mode,
      pendingApproval,
      props.credentials,
      props.store,
      runTask,
      selection,
      models,
      chooseModel,
      commandIndex,
      commandMatches,
    ],
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={mode === "plan" ? "yellow" : "green"} paddingX={1}>
        <Text bold>Kairo</Text>
        <Text>
          {" "}
          {active.workspace} · {active.id}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry) => (
          <Text key={entry.id} color={entryColor(entry)} wrap="wrap">
            {entry.kind === "user" ? "> " : ""}
            {entry.text || "…"}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={pendingApproval ? "yellow" : "gray"}>
          {pendingApproval ? "Approval required" : (activity ?? `Status: ${busy}`)}
        </Text>
      </Box>
      {pendingApproval ? (
        <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text bold>Approval required</Text>
          <Text>{pendingApproval.description}</Text>
          <Text>Allow? [y/N]</Text>
        </Box>
      ) : modelPicker ? (
        <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold>Select a model</Text>
          {models.map((item, index) => (
            <Text
              key={`${item.provider}/${item.model}`}
              color={index === modelIndex ? "cyan" : undefined}
            >
              {index === modelIndex ? "›" : " "} {index + 1}. {item.label} — {item.model}
            </Text>
          ))}
          <Text color="gray">↑/↓ choose · Enter select · Esc cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {commandMatches.length ? (
            <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
              {commandMatches.map((command, index) => (
                <Text key={command.name} color={index === commandIndex ? "cyan" : undefined}>
                  {index === commandIndex ? "›" : " "} {command.name.padEnd(10)}{" "}
                  {command.description}
                </Text>
              ))}
              <Text color="gray">↑/↓ choose · Enter or Tab select</Text>
            </Box>
          ) : null}
          <Box borderStyle="round" borderColor={mode === "plan" ? "yellow" : "green"} paddingX={1}>
            <Text color={mode === "plan" ? "yellow" : "green"}>
              {mode === "plan" ? "plan> " : "kairo> "}
            </Text>
            <TextInput
              value={input}
              onChange={(value) => {
                setInput(value);
                setCommandIndex(0);
              }}
              onSubmit={submit}
              placeholder={
                busy === "idle"
                  ? mode === "plan"
                    ? "Ask Kairo to inspect and plan…"
                    : "Ask Kairo to implement…"
                  : "Task in progress…"
              }
              focus={busy === "idle"}
            />
          </Box>
          <Box paddingX={1}>
            <ModeBadge mode={mode} />
            <Text color="gray">
              {" "}
              · {selection.provider}/{selection.model}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Starts the Ink renderer and keeps the existing CLI composition boundary intact. */
export async function runTui(props: Omit<KairoTuiProps, "initialApiKey">): Promise<void> {
  const key = await props.credentials.get(props.initialSelection.provider);
  const app = render(<KairoTui {...props} initialApiKey={key} />);
  await app.waitUntilExit();
}
