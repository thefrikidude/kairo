import React from "react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { ModalFrame } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/utils.js";

type Agent = DesktopBootstrap["agents"][number];

/** The panel every Kairo dialog shares; `new-session-dialog` is also a hook for the verify scripts. */
const panel =
  "new-session-dialog max-h-[85vh] overflow-auto rounded-xl border border-border bg-background p-[22px]";
const title = "mb-4 text-[17px] font-semibold";
const actions = "mt-5 flex justify-end gap-2";

export function AgentPicker({
  agents,
  installed,
  listAll,
  detecting,
  agentId,
  query,
  showAll,
  onAgent,
  onQuery,
  onToggleAll,
  onInstall,
}: {
  agents: Agent[];
  installed: Agent[];
  listAll: boolean;
  detecting: boolean;
  agentId: string;
  query: string;
  showAll: boolean;
  onAgent(id: string): void;
  onQuery(value: string): void;
  onToggleAll(): void;
  onInstall(id: string): void;
}): React.JSX.Element {
  const selected = agents.find((agent) => agent.id === agentId);
  const rows = (listAll ? agents : installed)
    .filter((agent) =>
      `${agent.name} ${agent.id} ${agent.commands.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  return (
    <>
      {listAll && (
        <Input
          aria-label="Search agents"
          placeholder="Search agents…"
          className="my-3"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      )}
      <div
        className="max-h-[250px] overflow-auto rounded-lg border border-border"
        role="listbox"
        aria-label="CLI agents"
      >
        {rows.map((agent) => (
          <div
            key={agent.id}
            className={cn("flex items-center gap-2 p-1", agentId === agent.id && "bg-accent")}
          >
            <Button
              variant="ghost"
              role="option"
              aria-selected={agentId === agent.id}
              className="h-auto min-w-0 flex-1 flex-col items-start gap-0 p-2 text-left"
              onClick={() => onAgent(agent.id)}
            >
              <strong>{agent.name}</strong>
              <small className="font-normal text-muted-foreground">
                {agent.installed ? agent.commands[0] : "Not installed"}
              </small>
            </Button>
            {!agent.installed && (
              <Button
                variant="ghost"
                size="sm"
                className="text-[11px] text-muted-foreground"
                aria-label={`Install ${agent.name}`}
                onClick={() => onInstall(agent.id)}
              >
                Install guide ↗
              </Button>
            )}
          </div>
        ))}
      </div>
      {detecting && !installed.length && (
        <p className="empty-small text-left">Looking for agents…</p>
      )}
      {!detecting && !installed.length && (
        <p className="empty-small text-left">
          No agent CLI found. Install one, then come back to Kairo; the list updates on its own.
        </p>
      )}
      {!!installed.length && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-1 text-xs text-muted-foreground underline underline-offset-4"
          onClick={onToggleAll}
        >
          {showAll ? "Show installed agents only" : "Add another agent…"}
        </Button>
      )}
      {selected?.unavailableReason && (
        <p className="empty-small text-left">{selected.unavailableReason}</p>
      )}
    </>
  );
}

export function NewSessionDialog({
  workspace,
  isChat,
  runningAgents,
  picker,
  error,
  pending,
  canOpen,
  onClose,
  onSeparateWorkspace,
  onOpen,
}: {
  workspace?: TaskWorkspace;
  isChat: boolean;
  runningAgents: number;
  picker: React.ReactNode;
  error: string;
  pending: boolean;
  canOpen: boolean;
  onClose(): void;
  onSeparateWorkspace(): void;
  onOpen(): void;
}): React.JSX.Element {
  return (
    <ModalFrame labelledBy="new-session-title" blocked={pending} onDismiss={onClose}>
      <div className={panel}>
        <h2 id="new-session-title" className={title}>
          New agent session
        </h2>
        <p className="empty-small text-left">
          New agent tab in {workspace?.name}. Files and Git state are shared with this workspace’s
          other tabs.
        </p>
        {runningAgents > 0 && workspace && (
          <div className="shared-warning" role="note">
            <p>
              {runningAgents === 1 ? "An agent is" : `${runningAgents} agents are`} already running
              here. Agents in the same workspace edit the same files, and Kairo cannot stop one from
              overwriting the other.
            </p>
            {!isChat && (
              <Button variant="outline" size="sm" onClick={onSeparateWorkspace}>
                Use a separate workspace instead
              </Button>
            )}
          </div>
        )}
        {picker}
        {error && (
          <p className="file-error" role="alert">
            {error}
          </p>
        )}
        <div className={actions}>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button className="primary" disabled={!canOpen} onClick={onOpen}>
            {pending ? "Opening…" : "Open agent terminal"}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}

export function RenameDialog({
  noun,
  value,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  noun: string;
  value: string;
  pending: boolean;
  onChange(value: string): void;
  onClose(): void;
  onSubmit(): void;
}): React.JSX.Element {
  return (
    <ModalFrame labelledBy="rename-title" blocked={pending} onDismiss={onClose}>
      <form
        className={panel}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2 id="rename-title" className={title}>
          Rename {noun}
        </h2>
        <Input
          autoFocus
          aria-label="Session name"
          maxLength={200}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className={actions}>
          <Button variant="outline" type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button className="primary" disabled={pending || !value.trim()}>
            Save name
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}

export function ConfirmDialog({
  title: heading,
  description,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  error: string;
  pending: boolean;
  onClose(): void;
  onConfirm(): void;
}): React.JSX.Element {
  return (
    <ModalFrame labelledBy="confirm-title" blocked={pending} onDismiss={onClose}>
      <div className={panel}>
        <h2 id="confirm-title" className={title}>
          {heading}
        </h2>
        <p>{description}</p>
        {error && (
          <p className="file-error" role="alert">
            {error}
          </p>
        )}
        <div className={actions}>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button className="primary" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : "Confirm"}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
