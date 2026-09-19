import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useMemo, useState } from "react";
import type { ModelSelection, TaskStatus, ToolCall } from "../../domain/models.js";
import type { ApprovalPolicy, CredentialStore, JevFeatures } from "../../domain/ports.js";
import { CodingAgent } from "../../application/coding-agent.js";
import {
  setJevEnabled,
  setJevFeature,
  setModelSelection,
} from "../../infrastructure/configuration/config.js";
import { JevDecisionProvider } from "../../infrastructure/providers/jev-safety-advisor.js";
import {
  isProviderId,
  providerById,
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
  { name: "/jev", description: "Manage the Jev safety advisor" },
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
  createAgent: (
    approval: ApprovalPolicy,
    selection: ModelSelection,
    apiKey: string,
    jev?: JevDecisionProvider,
    jevFeatures?: JevFeatures,
  ) => CodingAgent;
  store: SqliteSessionStore;
  session: Session;
  initialSelection: ModelSelection;
  initialApiKey?: string;
  initialJevKey?: string;
  initialJevEnabled: boolean;
  initialJevFeatures: JevFeatures;
  credentials: CredentialStore;
}

/** Renders one bounded Kairo session and dispatches terminal commands without readline. */
export function KairoTui(props: KairoTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const [active, setActive] = useState(props.session);
  const [selection, setSelection] = useState(props.initialSelection);
  const [apiKey, setApiKey] = useState<string | undefined>(props.initialApiKey);
  const [jevKey, setJevKey] = useState<string | undefined>(props.initialJevKey);
  const [jevEnabled, setJevEnabledState] = useState(props.initialJevEnabled);
  const [jevFeatures, setJevFeatures] = useState(props.initialJevFeatures);
  const [mode, setMode] = useState<InteractionMode>("build");
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState<"idle" | "planning" | "acting" | "verifying" | "cancelled">(
    "idle",
  );
  const [activity, setActivity] = useState<string>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [modelPicker, setModelPicker] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [credentialModel, setCredentialModel] = useState<ModelSelection>();
  const [credentialInput, setCredentialInput] = useState("");
  const [credentialError, setCredentialError] = useState<string>();
  const [savingCredential, setSavingCredential] = useState(false);
  const [jevPanel, setJevPanel] = useState(false);
  const [jevIndex, setJevIndex] = useState(0);
  const [jevCredentialInput, setJevCredentialInput] = useState("");
  const [jevCredentialError, setJevCredentialError] = useState<string>();
  const [jevCredentialMode, setJevCredentialMode] = useState(false);
  const [savingJevCredential, setSavingJevCredential] = useState(false);
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
    () =>
      apiKey
        ? props.createAgent(
            approval,
            selection,
            apiKey,
            jevEnabled && jevKey ? new JevDecisionProvider(jevKey) : undefined,
            jevFeatures,
          )
        : undefined,
    [apiKey, approval, jevEnabled, jevFeatures, jevKey, props.createAgent, selection],
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

  const saveJevCredential = useCallback(
    async (value: string) => {
      if (savingJevCredential) return;
      const key = value.trim();
      if (!key) return setJevCredentialError("API key cannot be empty.");
      setSavingJevCredential(true);
      setJevCredentialError(undefined);
      try {
        await new JevDecisionProvider(key).validate();
        await props.credentials.save("jev", key);
        await setJevEnabled(true);
        setJevKey(key);
        setJevEnabledState(true);
        setJevCredentialInput("");
        setJevCredentialMode(false);
        setJevPanel(false);
        append("system", "Jev safety advisor enabled.");
      } catch (error) {
        setJevCredentialError((error as Error).message);
      } finally {
        setSavingJevCredential(false);
      }
    },
    [append, props.credentials, savingJevCredential],
  );

  useInput((inputKey, key) => {
    if (!jevPanel || savingJevCredential) return;
    if (jevCredentialMode) {
      if (key.escape) {
        setJevCredentialInput("");
        setJevCredentialError(undefined);
        setJevCredentialMode(false);
      }
      return;
    }
    if (key.escape) return setJevPanel(false);
    if (key.upArrow) return setJevIndex((current) => Math.max(0, current - 1));
    if (key.downArrow) return setJevIndex((current) => Math.min(5, current + 1));
    if (key.return || /^[1-6]$/.test(inputKey)) {
      const action = /^[1-6]$/.test(inputKey) ? Number(inputKey) - 1 : jevIndex;
      if (action === 0) {
        if (!jevKey) {
          setJevCredentialError("Add a TypeSafe API key before enabling Jev.");
          setJevCredentialMode(true);
          return;
        }
        const next = !jevEnabled;
        void setJevEnabled(next).then(() => {
          setJevEnabledState(next);
          append("system", `Jev safety advisor ${next ? "enabled" : "disabled"}.`);
        });
        return setJevPanel(false);
      }
      if (action === 1) {
        const next = !jevFeatures.routing;
        void setJevFeature("routing", next).then(() =>
          setJevFeatures((current) => ({ ...current, routing: next })),
        );
        return;
      }
      if (action === 2) {
        const next = !jevFeatures.safety;
        void setJevFeature("safety", next).then(() =>
          setJevFeatures((current) => ({ ...current, safety: next })),
        );
        return;
      }
      if (action === 3) {
        const next = !jevFeatures.recovery;
        void setJevFeature("recovery", next).then(() =>
          setJevFeatures((current) => ({ ...current, recovery: next })),
        );
        return;
      }
      if (action === 4) {
        setJevCredentialInput("");
        setJevCredentialError(undefined);
        setJevCredentialMode(true);
        return;
      }
      if (action === 5) {
        void props.credentials.clear("jev").then(async () => {
          await setJevEnabled(false);
          setJevKey(undefined);
          setJevEnabledState(false);
          setJevPanel(false);
          append("system", "Jev credential removed.");
        });
      }
    }
  });

  const chooseModel = useCallback(
    async (next: ModelSelection) => {
      const nextKey = await props.credentials.get(next.provider);
      if (!nextKey) {
        setCredentialInput("");
        setCredentialError(undefined);
        setCredentialModel(next);
        return;
      }
      await setModelSelection(next);
      setSelection(next);
      setApiKey(nextKey);
      append("system", `Using ${next.provider}/${next.model}.`);
    },
    [append, props.credentials],
  );

  const saveCredential = useCallback(
    async (value: string) => {
      if (!credentialModel || savingCredential) return;
      const key = value.trim();
      if (!key) return setCredentialError("API key cannot be empty.");
      setSavingCredential(true);
      setCredentialError(undefined);
      try {
        await providerById(credentialModel.provider).validate(key);
        await props.credentials.save(credentialModel.provider, key);
        await setModelSelection(credentialModel);
        setSelection(credentialModel);
        setApiKey(key);
        setCredentialInput("");
        setCredentialModel(undefined);
        append("system", `Using ${credentialModel.provider}/${credentialModel.model}.`);
      } catch (error) {
        setCredentialError((error as Error).message);
      } finally {
        setSavingCredential(false);
      }
    },
    [append, credentialModel, props.credentials, savingCredential],
  );

  useInput((inputKey, key) => {
    if (!credentialModel || savingCredential) return;
    if (key.escape) {
      setCredentialInput("");
      setCredentialError(undefined);
      setCredentialModel(undefined);
    }
  });

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
        return append("error", "No active credential. Use /models to add a provider API key.");
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
        // CodingAgent already rendered and persisted a terminal task failure. Avoid echoing it.
        if (agent.status(active.id)?.status !== "failed")
          append("error", `Kairo: ${(error as Error).message}`);
      }
    },
    [active.id, agent, append, appendStream, entries.length],
  );

  const submit = useCallback(
    async (value: string) => {
      let line = value.trim();
      if (!line || busy !== "idle" || pendingApproval) return;
      const selectedCommand = commandMatches[commandIndex];
      if (selectedCommand && line !== selectedCommand.name) {
        if ("acceptsArgument" in selectedCommand && selectedCommand.acceptsArgument) {
          setInput(commandInput(selectedCommand));
          return;
        }
        line = selectedCommand.name;
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
      if (line === "/jev") {
        setJevCredentialInput("");
        setJevCredentialError(undefined);
        setJevCredentialMode(false);
        setJevIndex(0);
        setJevPanel(true);
        return;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const [provider, ...modelParts] = line.slice(6).trim().split(/\s+/);
        if (!provider || !modelParts.length || !isProviderId(provider))
          return append(
            "system",
            `Current model: ${selection.provider}/${selection.model}\nUse: /model <gemini|groq|openrouter> <model-id>`,
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

  useInput((inputKey, key) => {
    if (pendingApproval || modelPicker || jevPanel || !commandMatches.length) return;
    if (key.upArrow) return setCommandIndex((current) => Math.max(0, current - 1));
    if (key.downArrow)
      return setCommandIndex((current) => Math.min(commandMatches.length - 1, current + 1));
    if (key.tab) {
      const selected = commandMatches[commandIndex];
      if (!selected) return;
      if ("acceptsArgument" in selected && selected.acceptsArgument) {
        setInput(commandInput(selected));
      } else {
        void submit(selected.name);
      }
    }
  });

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
      ) : credentialModel ? (
        <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold>{providerById(credentialModel.provider).name} API key</Text>
          <Text color="gray">Saved securely in macOS Keychain.</Text>
          <TextInput
            value={credentialInput}
            onChange={(value) => {
              setCredentialInput(value);
              setCredentialError(undefined);
            }}
            onSubmit={saveCredential}
            mask="•"
            placeholder={savingCredential ? "Validating…" : "Paste API key"}
            focus={!savingCredential}
          />
          {credentialError ? <Text color="red">{credentialError}</Text> : null}
          <Text color="gray">Enter save · Esc cancel</Text>
        </Box>
      ) : jevPanel ? (
        <Box borderStyle="single" borderColor="magenta" flexDirection="column" paddingX={1}>
          <Text bold>Jev safety advisor · {jevEnabled ? "enabled" : "disabled"}</Text>
          <Text color="gray">
            {jevKey ? "TypeSafe key saved in macOS Keychain." : "No TypeSafe API key saved."}
          </Text>
          {jevCredentialMode ? (
            <>
              <TextInput
                value={jevCredentialInput}
                onChange={(value) => {
                  setJevCredentialInput(value);
                  setJevCredentialError(undefined);
                }}
                onSubmit={saveJevCredential}
                mask="•"
                placeholder={savingJevCredential ? "Validating…" : "Paste TypeSafe API key"}
                focus={!savingJevCredential}
              />
              {jevCredentialError ? <Text color="red">{jevCredentialError}</Text> : null}
              <Text color="gray">Enter save · Esc cancel</Text>
            </>
          ) : (
            <>
              {[
                `${jevEnabled ? "Disable" : "Enable"} advisor`,
                `Task routing: ${jevFeatures.routing ? "on" : "off"}`,
                `Safety context: ${jevFeatures.safety ? "on" : "off"}`,
                `Recovery advice: ${jevFeatures.recovery ? "on" : "off"}`,
                "Add or replace API key",
                "Remove API key",
              ].map((label, index) => (
                <Text key={label} color={index === jevIndex ? "magenta" : undefined}>
                  {index === jevIndex ? "›" : " "} {index + 1}. {label}
                </Text>
              ))}
              <Text color="gray">↑/↓ choose · Enter select · Esc close</Text>
            </>
          )}
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
  const jevKey = await props.credentials.get("jev");
  const app = render(<KairoTui {...props} initialApiKey={key} initialJevKey={jevKey} />);
  await app.waitUntilExit();
}
