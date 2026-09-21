import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelSelection, TaskStatus, ToolCall } from "../../domain/models.js";
import type { ApprovalPolicy, CredentialStore, JevFeatures } from "../../domain/ports.js";
import { ProviderError } from "../../domain/provider-error.js";
import { CodingAgent } from "../../application/coding-agent.js";
import {
  autoInteractionMode,
  greetingResponse,
  interactionIntentState,
} from "../../application/interaction-routing.js";
import {
  setAutoModelRoutingEnabled,
  setJevEnabled,
  setJevFeature,
  setModelSelection,
} from "../../infrastructure/configuration/config.js";
import { JevDecisionProvider } from "../../infrastructure/providers/jev-safety-advisor.js";
import {
  modelRoutingState,
  quotaFallbackModels,
  selectAutoModel,
  type AvailableModel,
} from "../../application/model-routing.js";
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

export type TranscriptEntry = {
  id: number;
  kind: "user" | "assistant" | "system" | "error";
  text: string;
};

type PendingApproval = { description: string; resolve: (approved: boolean) => void };
export type ModelOption = ModelSelection & { label: string };
type TaskAgentRoute = {
  agent: CodingAgent;
  selection: ModelSelection;
  fallbacks: AvailableModel[];
};

export type RepositoryStatus = { branch?: string; changedFiles: number };
const colors = {
  accent: "#7dd3fc",
  accentSoft: "#a5b4fc",
  muted: "#64748b",
  textSoft: "#94a3b8",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#fb7185",
  jev: "#c084fc",
} as const;

export const slashCommands = [
  { name: "/help", description: "Show commands and shortcuts" },
  { name: "/plan", description: "Toggle read-only planning mode" },
  { name: "/build", description: "Build the latest saved plan" },
  { name: "/models", description: "Choose a model" },
  { name: "/auto", description: "Toggle Jev automatic model routing" },
  { name: "/jev", description: "Manage the Jev safety advisor" },
  { name: "/new", description: "Start a new session" },
  { name: "/resume", description: "Continue a task or open a session", acceptsArgument: true },
  { name: "/history", description: "List saved sessions" },
  { name: "/status", description: "Show the latest task status" },
  { name: "/trace", description: "Show task trace", acceptsArgument: true },
  { name: "/changes", description: "Show changed files" },
  { name: "/verify", description: "Run a verification command", acceptsArgument: true },
  { name: "/compact", description: "Save a context checkpoint" },
  { name: "/cancel", description: "Cancel the current task" },
  { name: "/logout", description: "Remove the active provider credential" },
  { name: "/quit", description: "Exit Kairo" },
] as const;

/** Reads only compact repository metadata for the header. */
export function repositoryStatus(workspace: string): RepositoryStatus {
  const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
  const run = (args: string[]) =>
    execFileSync(git, args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  try {
    const branch = run(["branch", "--show-current"]) || undefined;
    const status = run(["status", "--short", "--untracked-files=normal"]);
    return { branch, changedFiles: status ? status.split("\n").length : 0 };
  } catch {
    return { changedFiles: 0 };
  }
}

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

/** Reflects a completed Jev planning route in the persistent TUI interaction mode. */
export function interactionModeAfterTask(
  mode: InteractionMode,
  taskMode: "implementation" | "planning" | undefined,
): InteractionMode {
  return taskMode === "planning" ? "plan" : mode;
}

export function ModeBadge({ mode }: { mode: InteractionMode }): React.JSX.Element {
  return (
    <Text bold color={mode === "plan" ? "yellow" : "green"}>
      {mode === "plan" ? "PLAN" : "BUILD"}
    </Text>
  );
}

function entryColor(entry: TranscriptEntry): string | undefined {
  if (entry.kind === "user") return "cyan";
  if (entry.kind === "error") return "red";
  if (entry.kind === "system") return "yellow";
  return undefined;
}

function entryLabel(kind: TranscriptEntry["kind"]): string {
  return { user: "YOU", assistant: "KAIRO", system: "SYSTEM", error: "ERROR" }[kind];
}

/** A compact chat row that keeps requests, answers, and operational notices distinct. */
export function TranscriptRow({ entry }: { entry: TranscriptEntry }): React.JSX.Element {
  const color = entryColor(entry);
  const isConversation = entry.kind === "user" || entry.kind === "assistant";
  return (
    <Box flexDirection="column" marginTop={isConversation ? 1 : 0}>
      <Text bold color={color} dimColor={entry.kind === "system"}>
        {entryLabel(entry.kind)}
      </Text>
      <Box paddingLeft={1}>
        {entry.kind === "assistant" && !entry.text ? (
          <LoadingIndicator label="Generating response" />
        ) : (
          <Text color={color} wrap="wrap">
            {entry.text}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function LoadingIndicator({ label, color = "yellow" }: { label: string; color?: string }) {
  const frames = ["◐", "◓", "◑", "◒"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), 120);
    timer.unref();
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color={color}>
      {frames[frame]} {label}…
    </Text>
  );
}

export function BrandMark(): React.JSX.Element {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text bold color={colors.accent}>
        {"██╗  ██╗ █████╗ ██╗██████╗  ██████╗"}
      </Text>
      <Text bold color={colors.accent}>
        {"██║ ██╔╝██╔══██╗██║██╔══██╗██╔═══██╗"}
      </Text>
      <Text bold color={colors.accentSoft}>
        {"█████╔╝ ███████║██║██████╔╝██║   ██║"}
      </Text>
      <Text bold color={colors.accentSoft}>
        {"██╔═██╗ ██╔══██║██║██╔══██╗██║   ██║"}
      </Text>
      <Text bold color={colors.accentSoft}>
        {"██║  ██╗██║  ██║██║██║  ██║╚██████╔╝"}
      </Text>
      <Text color={colors.muted}>{"╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝"}</Text>
    </Box>
  );
}

function EmptyState({
  mode,
  workspace,
  repo,
}: {
  mode: InteractionMode;
  workspace: string;
  repo: RepositoryStatus;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={2} marginBottom={1}>
      <BrandMark />
      <Box marginTop={1}>
        <Text bold color={colors.textSoft}>
          dependable coding, right in your terminal
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>{basename(workspace)}</Text>
        {repo.branch ? <Text color={colors.muted}> · {repo.branch}</Text> : null}
        {repo.changedFiles ? (
          <Text color={colors.warning}> · {repo.changedFiles} changed</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginTop={2}>
        {[
          ["/plan", "inspect first, change nothing"],
          ["/models", "choose the coding model"],
          ["/resume", "continue previous work"],
          ["/help", "see every command"],
        ].map(([command, description]) => (
          <Box key={command}>
            <Text bold color={colors.accent}>
              {command.padEnd(11)}
            </Text>
            <Text color={colors.textSoft}>{description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>
          {mode === "plan" ? "Read-only planning is active" : "Describe an outcome to begin"}
        </Text>
      </Box>
    </Box>
  );
}

function ActivityLine({
  busy,
  pendingApproval,
}: {
  busy: "idle" | "planning" | "acting" | "verifying" | "cancelled";
  pendingApproval?: PendingApproval;
}): React.JSX.Element {
  if (pendingApproval)
    return (
      <Text bold color="yellow">
        ! Approval needed — your choice is required to continue
      </Text>
    );
  if (busy === "idle") return <Text color="gray">Ready</Text>;
  return (
    <LoadingIndicator
      color={busy === "verifying" ? "cyan" : "yellow"}
      label={
        busy === "planning" ? "Generating plan" : busy === "verifying" ? "Verifying" : "Working"
      }
    />
  );
}

function WorkspaceBar({
  workspace,
  repo,
  model,
}: {
  workspace: string;
  repo: RepositoryStatus;
  model: ModelSelection;
}): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor={colors.muted} paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color={colors.accent}>
          KAIRO
        </Text>
        <Text color={colors.textSoft}> · {basename(workspace)}</Text>
        {repo.branch ? <Text color={colors.muted}> · {repo.branch}</Text> : null}
        {repo.changedFiles ? (
          <Text color={colors.warning}> · {repo.changedFiles} changed</Text>
        ) : null}
      </Box>
      <Text color={colors.muted}>
        {model.provider}/{model.model}
      </Text>
    </Box>
  );
}

function ApprovalCard({ pending }: { pending: PendingApproval }): React.JSX.Element {
  const [summary, ...details] = pending.description.split("\n");
  const command = summary.startsWith("Run command");
  return (
    <Box
      borderStyle="round"
      borderColor={colors.warning}
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={colors.warning}>
          REVIEW ACTION
        </Text>
        <Text bold color={colors.danger}>
          {command ? "COMMAND" : "WRITE"}
        </Text>
      </Box>
      <Text color={colors.textSoft}>{summary}</Text>
      {details.length ? <Text>{details.join("\n")}</Text> : null}
      <Box marginTop={1}>
        <Text bold color={colors.success}>
          y / Enter allow
        </Text>
        <Text color={colors.muted}> · </Text>
        <Text bold color={colors.danger}>
          n / Esc deny
        </Text>
      </Box>
    </Box>
  );
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
  initialAutoModelRoutingEnabled: boolean;
  credentials: CredentialStore;
}

/** Renders one bounded Kairo session and dispatches terminal commands without readline. */
export function KairoTui(props: KairoTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const [active, setActive] = useState(props.session);
  const [repo, setRepo] = useState(() => repositoryStatus(props.session.workspace));
  const [selection, setSelection] = useState(props.initialSelection);
  const [apiKey, setApiKey] = useState<string | undefined>(props.initialApiKey);
  const [jevKey, setJevKey] = useState<string | undefined>(props.initialJevKey);
  const [jevEnabled, setJevEnabledState] = useState(props.initialJevEnabled);
  const [jevFeatures, setJevFeatures] = useState(props.initialJevFeatures);
  const [autoModelRouting, setAutoModelRouting] = useState(props.initialAutoModelRoutingEnabled);
  const [routedSelection, setRoutedSelection] = useState<ModelSelection>();
  const [mode, setMode] = useState<InteractionMode>("build");
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState<"idle" | "planning" | "acting" | "verifying" | "cancelled">(
    "idle",
  );
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
  const resolveTaskAgent = useCallback(
    async (request: string): Promise<TaskAgentRoute | undefined> => {
      if (!autoModelRouting || !jevEnabled || !jevKey || !agent) {
        setRoutedSelection(undefined);
        return agent && { agent, selection, fallbacks: [] };
      }
      const providerKeys = new Map(
        await Promise.all(
          providerRegistry.map(
            async (provider) => [provider.id, await props.credentials.get(provider.id)] as const,
          ),
        ),
      );
      const available: AvailableModel[] = models.flatMap((model) => {
        const apiKey = providerKeys.get(model.provider);
        const tier = providerById(model.provider).models.find(
          (item) => item.id === model.model,
        )?.tier;
        return apiKey && tier ? [{ ...model, apiKey, tier }] : [];
      });
      if (!available.length) {
        setRoutedSelection(undefined);
        return { agent, selection, fallbacks: [] };
      }
      try {
        const decision = await new JevDecisionProvider(jevKey).modelTier(
          modelRoutingState(request, available),
        );
        if (decision.confidence < 0.85) {
          setRoutedSelection(undefined);
          return { agent, selection, fallbacks: [] };
        }
        const routed = selectAutoModel(available, selection, decision.value);
        if (!routed) {
          setRoutedSelection(undefined);
          return { agent, selection, fallbacks: [] };
        }
        setRoutedSelection({ provider: routed.provider, model: routed.model });
        const routedSelection = { provider: routed.provider, model: routed.model };
        return {
          agent: props.createAgent(
            approval,
            routedSelection,
            routed.apiKey,
            new JevDecisionProvider(jevKey),
            jevFeatures,
          ),
          selection: routedSelection,
          fallbacks: quotaFallbackModels(available, routedSelection, selection, decision.value),
        };
      } catch {
        setRoutedSelection(undefined);
        return { agent, selection, fallbacks: [] };
      }
    },
    [agent, approval, autoModelRouting, jevEnabled, jevFeatures, jevKey, models, props, selection],
  );
  const classifyInteraction = useCallback(
    async (request: string) => {
      const localResponse = greetingResponse(request);
      if (localResponse) return { intent: "conversation" as const, localResponse };
      if (!jevEnabled || !jevKey || !jevFeatures.routing)
        return { intent: "repository_task" as const };
      try {
        const decision = await new JevDecisionProvider(jevKey).intent(
          interactionIntentState(request),
        );
        return decision.confidence >= 0.85
          ? { intent: decision.value }
          : { intent: "repository_task" as const };
      } catch {
        return { intent: "repository_task" as const };
      }
    },
    [jevEnabled, jevFeatures.routing, jevKey],
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
    if (key.downArrow) return setJevIndex((current) => Math.min(6, current + 1));
    if (key.return || /^[1-7]$/.test(inputKey)) {
      const action = /^[1-7]$/.test(inputKey) ? Number(inputKey) - 1 : jevIndex;
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
        const next = !jevFeatures.autonomy;
        void setJevFeature("autonomy", next).then(() =>
          setJevFeatures((current) => ({ ...current, autonomy: next })),
        );
        return;
      }
      if (action === 5) {
        setJevCredentialInput("");
        setJevCredentialError(undefined);
        setJevCredentialMode(true);
        return;
      }
      if (action === 6) {
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
      await setAutoModelRoutingEnabled(false);
      setSelection(next);
      setApiKey(nextKey);
      setAutoModelRouting(false);
      setRoutedSelection(undefined);
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
        await setAutoModelRoutingEnabled(false);
        setSelection(credentialModel);
        setApiKey(key);
        setAutoModelRouting(false);
        setRoutedSelection(undefined);
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
    async (request: string, requestedMode: InteractionMode) => {
      // Render optimistically before routing can make a network request through Jev.
      append("user", request);
      setBusy(requestedMode === "plan" ? "planning" : "acting");
      const interaction =
        requestedMode === "build" || autoModelRouting
          ? await classifyInteraction(request)
          : undefined;
      const taskMode =
        autoModelRouting && interaction ? autoInteractionMode(interaction.intent) : requestedMode;
      if (autoModelRouting && taskMode !== mode) setMode(taskMode);
      setBusy(taskMode === "plan" ? "planning" : "acting");
      if (interaction?.intent === "conversation") {
        setBusy("idle");
        return append("assistant", interaction.localResponse ?? "How can I help?");
      }
      if (!agent) {
        setBusy("idle");
        return append("error", "No active credential. Use /models to add a provider API key.");
      }
      const entryId = entries.length + 1;
      setEntries((current) => [...current, { id: entryId, kind: "assistant", text: "" }]);
      const onAgentText = (chunk: string) => {
        if (chunk === "\n[Jev routed this request to a one-time read-only plan]\n") {
          setMode("plan");
          return;
        }
        if (
          /^\n\[Tool] [^\n]+\n$/.test(chunk) ||
          chunk === "\n[Plan saved]\n" ||
          chunk === "\n[Verification passed]\n" ||
          chunk === "\n[Verification failed]\n"
        )
          return;
        appendStream(entryId, chunk);
      };
      try {
        const route =
          taskMode === "build" && interaction?.intent === "repository_task"
            ? await resolveTaskAgent(request)
            : agent && { agent, selection, fallbacks: [] };
        if (!route) throw new Error("No credential is available for the selected model.");
        let taskAgent = route.agent;
        if (taskMode === "plan") await taskAgent.plan(active.id, request, onAgentText);
        else if (interaction?.intent === "answer")
          await taskAgent.answer(active.id, request, onAgentText);
        else {
          try {
            await taskAgent.run(active.id, request, onAgentText);
          } catch (error) {
            if (!(error instanceof ProviderError) || error.category !== "quota") throw error;
            let latestError: unknown = error;
            for (const fallback of route.fallbacks) {
              append(
                "system",
                `Automatic fallback: ${route.selection.provider}/${route.selection.model} reached its quota; switching to ${fallback.provider}/${fallback.model}.`,
              );
              taskAgent = props.createAgent(
                approval,
                { provider: fallback.provider, model: fallback.model },
                fallback.apiKey,
                new JevDecisionProvider(jevKey!),
                jevFeatures,
              );
              try {
                await taskAgent.retryAfterProviderQuota(active.id, onAgentText);
                latestError = undefined;
                break;
              } catch (fallbackError) {
                latestError = fallbackError;
                if (!(fallbackError instanceof ProviderError) || fallbackError.category !== "quota")
                  throw fallbackError;
              }
            }
            if (latestError) throw latestError;
          }
        }
        const task = taskAgent.status(active.id);
        setMode((current) => interactionModeAfterTask(current, task?.mode));
        if (task?.mode === "planning" && task.plan) append("system", formatPlan(task.plan));
        if ((task?.status as TaskStatus | undefined) === "cancelled")
          append("system", "Task cancelled.");
        setRepo(repositoryStatus(active.workspace));
        setBusy("idle");
      } catch (error) {
        setRepo(repositoryStatus(active.workspace));
        setBusy("idle");
        // CodingAgent already rendered and persisted a terminal task failure. Avoid echoing it.
        if (agent.status(active.id)?.status !== "failed")
          append("error", `Kairo: ${(error as Error).message}`);
      }
    },
    [
      active.id,
      active.workspace,
      agent,
      append,
      appendStream,
      approval,
      autoModelRouting,
      classifyInteraction,
      entries.length,
      jevFeatures,
      jevKey,
      props,
      resolveTaskAgent,
      selection,
      mode,
    ],
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
      if (line === "/help") {
        return append(
          "system",
          slashCommands
            .map((command) => `${command.name.padEnd(10)} ${command.description}`)
            .join("\n"),
        );
      }
      if (line === "/plan") {
        const next = interactionModeAfterCommand(mode, line);
        setMode(next);
        return;
      }
      if (line === "/build") {
        setMode("build");
        const latest = agent?.status(active.id);
        if (latest?.status === "planned" && latest.plan) {
          append("system", "Building the saved plan.");
          await runTask("Implement the saved plan and verify the result.", "build");
        }
        return;
      }
      if (line === "/quit" || line === "/exit") return exit();
      if (line === "/new") {
        const next = props.store.create(active.workspace);
        setActive(next);
        setMode("build");
        setEntries([]);
        setRepo(repositoryStatus(next.workspace));
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
          setRepo(repositoryStatus(next.workspace));
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
          setRepo(repositoryStatus(active.workspace));
          setBusy("idle");
        } catch (error) {
          setBusy("idle");
          append("error", `Kairo: ${(error as Error).message}`);
        }
        return;
      }
      if (line === "/auto") {
        if (!autoModelRouting && (!jevEnabled || !jevKey))
          return append(
            "error",
            "Enable Jev and add its API key with /jev before enabling auto routing.",
          );
        const next = !autoModelRouting;
        await setAutoModelRoutingEnabled(next);
        setAutoModelRouting(next);
        setRoutedSelection(undefined);
        return append(
          "system",
          next
            ? "Automatic Jev model routing enabled. Your selected model remains the fallback."
            : `Manual model selection enabled: ${selection.provider}/${selection.model}.`,
        );
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
            `Current model: ${selection.provider}/${selection.model}\nUse: /model <gemini|groq|mistral> <model-id>`,
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
      autoModelRouting,
      jevEnabled,
      jevKey,
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

  const visibleEntries = entries.slice(-8);
  const hiddenEntries = entries.length - visibleEntries.length;
  const terminalHeight = process.stdout.rows ? Math.max(20, process.stdout.rows - 1) : undefined;
  const activeModel = routedSelection ?? selection;

  return (
    <Box flexDirection="column" minHeight={terminalHeight}>
      {entries.length ? (
        <WorkspaceBar workspace={active.workspace} repo={repo} model={activeModel} />
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {entries.length ? (
          <Box flexDirection="column" marginTop={1}>
            {hiddenEntries > 0 ? (
              <Text color={colors.muted}> … {hiddenEntries} earlier messages hidden</Text>
            ) : null}
            {visibleEntries.map((entry) => (
              <TranscriptRow key={entry.id} entry={entry} />
            ))}
          </Box>
        ) : (
          <EmptyState mode={mode} workspace={active.workspace} repo={repo} />
        )}
        {busy !== "idle" || pendingApproval ? (
          <Box marginTop={1} paddingX={1}>
            <ActivityLine busy={busy} pendingApproval={pendingApproval} />
          </Box>
        ) : null}
      </Box>
      {pendingApproval ? (
        <ApprovalCard pending={pendingApproval} />
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
                `Safe autonomy: ${jevFeatures.autonomy ? "on" : "off"}`,
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
            <Box
              borderStyle="round"
              borderColor={colors.accent}
              flexDirection="column"
              marginTop={1}
              paddingX={1}
            >
              <Text bold color={colors.accent}>
                COMMANDS
              </Text>
              {commandMatches.map((command, index) => (
                <Text
                  key={command.name}
                  color={index === commandIndex ? colors.accent : colors.textSoft}
                  bold={index === commandIndex}
                >
                  {index === commandIndex ? "›" : " "} {command.name.padEnd(10)}{" "}
                  {command.description}
                </Text>
              ))}
              <Text color={colors.muted}>↑/↓ navigate · Tab complete · Enter run</Text>
            </Box>
          ) : null}
          <Box
            borderStyle="round"
            borderColor={mode === "plan" ? colors.warning : colors.accentSoft}
            marginTop={1}
            paddingX={1}
            minHeight={3}
            alignItems="center"
          >
            <Text color={colors.accent} bold>
              {">"}
            </Text>
            <Text> </Text>
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
          <Box paddingX={1} justifyContent="space-between">
            <Box>
              <Text color={colors.muted}>enter send · / commands</Text>
            </Box>
            <Text color={colors.textSoft}>
              {activeModel.provider}/{activeModel.model}
            </Text>
          </Box>
          <Box paddingX={1} justifyContent="space-between">
            <Box>
              <ModeBadge mode={mode} />
              <Text color={colors.muted}>
                {" "}
                · {autoModelRouting ? "Auto routing" : "Manual model"}
              </Text>
            </Box>
            {autoModelRouting || jevEnabled ? (
              <Box>
                {autoModelRouting ? <Text color={colors.accent}>AUTO</Text> : null}
                {autoModelRouting && jevEnabled ? <Text color={colors.muted}> · </Text> : null}
                {jevEnabled ? <Text color={colors.jev}>JEV</Text> : null}
              </Box>
            ) : null}
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
