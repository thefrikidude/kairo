import React from "react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";

export type ThemeChoice = "system" | "dark" | "light";
const settingsTabs: [string, string][] = [
  ["general", "General"],
  ["chats", "Archived chats"],
  ["workspaces", "Workspaces"],
  ["tabs", "Closed agent tabs"],
  ["shortcuts", "Keyboard shortcuts"],
];
const shortcuts: [string, string][] = [
  ["Cmd/Ctrl+Shift+N", "New workspace"],
  ["Cmd/Ctrl+J", "Jump to a workspace or tab, or run a command"],
  ["Cmd/Ctrl+P", "Quick open file"],
  ["Cmd/Ctrl+`", "New terminal tab"],
  ["Cmd/Ctrl+Shift+E", "Files"],
  ["Cmd/Ctrl+Shift+D", "Review"],
  ["Cmd/Ctrl+Shift+B", "Toggle sidebar"],
];

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function SettingsNav({
  hidden,
  tab,
  onTab,
  onBack,
}: {
  hidden: boolean;
  tab: string;
  onTab(id: string): void;
  onBack(): void;
}): React.JSX.Element {
  return (
    <aside className="sidebar settings-nav" aria-label="Settings sections" hidden={hidden}>
      <Button
        variant="ghost"
        className="settings-back h-9 justify-start text-muted-foreground"
        onClick={() => onBack()}
      >
        ← Back to app
      </Button>
      <div className="section-label sidebar-section-title">Settings</div>
      {settingsTabs.map(([id, label]) => (
        <Button
          key={id}
          variant="ghost"
          className={`settings-tab h-9 justify-start font-normal ${tab === id ? "selected bg-accent font-medium" : "text-muted-foreground"}`}
          aria-current={tab === id ? "page" : undefined}
          onClick={() => onTab(id)}
        >
          {label}
        </Button>
      ))}
    </aside>
  );
}

export function SettingsContent({
  hidden,
  tab,
  theme,
  onTheme,
  state,
  archived,
  archivedChats,
  pending,
  isChat,
  run,
  apply,
  confirm,
  deleteWorkspace,
  closeSettings,
}: {
  hidden: boolean;
  tab: string;
  theme: ThemeChoice;
  onTheme(value: ThemeChoice): void;
  state?: DesktopBootstrap;
  archived: DesktopBootstrap["archivedSessions"];
  archivedChats: TaskWorkspace[];
  pending: boolean;
  isChat(item: TaskWorkspace): boolean;
  run(operation: () => Promise<DesktopBootstrap | undefined>): Promise<void>;
  apply(value: DesktopBootstrap): void;
  confirm(value: { title: string; description: string; action: () => Promise<unknown> }): void;
  deleteWorkspace(item: TaskWorkspace): void;
  closeSettings(): void;
}): React.JSX.Element {
  return (
    <section className="settings-content terminal-settings" hidden={hidden}>
      <h2>{settingsTabs.find(([id]) => id === tab)?.[1]}</h2>
      {tab === "general" && (
        <>
          <div className="settings-field">
            <span id="theme-label">Appearance</span>
            <Select value={theme} onValueChange={(value) => onTheme(value as ThemeChoice)}>
              <SelectTrigger aria-labelledby="theme-label" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="empty-small">
            Agent conversations run inside the selected CLI. Models, authentication and approvals
            are managed by that agent.
          </p>
        </>
      )}
      {tab === "chats" && (
        <>
          {!archivedChats.length && <p className="empty-small">No archived chats</p>}
          {archivedChats.length > 0 && (
            <div className="bulk-row">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    let last: DesktopBootstrap | undefined;
                    for (const item of archivedChats)
                      last = await window.kairo.restoreWorkspace(item.id);
                    return last;
                  })
                }
              >
                Recover all
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() =>
                  confirm({
                    title: "Delete all archived chats?",
                    description: `Permanently delete ${archivedChats.length} archived ${archivedChats.length === 1 ? "chat" : "chats"} and their scratch folders. This cannot be undone.`,
                    action: async () => {
                      let last: DesktopBootstrap | undefined;
                      for (const item of archivedChats)
                        last = await window.kairo.deleteWorkspace(item.id);
                      if (last) apply(last);
                    },
                  })
                }
              >
                Delete all
              </Button>
            </div>
          )}
          {archivedChats.map((item) => (
            <article className="workspace-catalog-row" key={item.id}>
              <div>
                <strong>{item.name ?? name(item.directory)}</strong>
                <small>archived</small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void run(() => window.kairo.restoreWorkspace(item.id))}
              >
                Restore
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() => deleteWorkspace(item)}
              >
                Delete
              </Button>
            </article>
          ))}
        </>
      )}
      {tab === "workspaces" && (
        <>
          {state?.workspaces
            .filter((item) => !item.removedAt && !(isChat(item) && item.archivedAt))
            .map((item) => (
              <article className="workspace-catalog-row" key={item.id}>
                <div>
                  <strong>{item.name ?? item.branch ?? name(item.directory)}</strong>
                  <small>{item.archivedAt ? `${item.kind} · archived` : item.kind}</small>
                  <code>{item.directory}</code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    closeSettings();
                    void run(() =>
                      item.archivedAt
                        ? window.kairo
                            .restoreWorkspace(item.id)
                            .then(() => window.kairo.selectWorkspace(item.id))
                        : window.kairo.selectWorkspace(item.id),
                    );
                  }}
                >
                  {item.archivedAt ? "Restore" : "Open"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() => deleteWorkspace(item)}
                >
                  Delete
                </Button>
              </article>
            ))}
          {!state?.workspaces.some((item) => !item.removedAt) && (
            <p className="empty-small">No workspaces yet</p>
          )}
        </>
      )}
      {tab === "tabs" && (
        <>
          {!archived.length && <p className="empty-small">No closed agent tabs</p>}

          {archived.map((session) => (
            <article className="workspace-catalog-row" key={session.id}>
              <div>
                <strong>{session.title}</strong>
                <code>
                  {state?.workspaces.find((item) => item.id === session.workspaceId)?.directory}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  pending ||
                  !!state?.workspaces.find((item) => item.id === session.workspaceId)?.removedAt
                }
                onClick={() => void run(() => window.kairo.restoreSession(session.id))}
              >
                Restore
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  confirm({
                    title: "Delete closed tab?",
                    description: `Delete “${session.title}” from Kairo. Its workspace and the agent’s own history are kept.`,
                    action: () => window.kairo.deleteSession(session.id).then(apply),
                  })
                }
              >
                Delete
              </Button>
            </article>
          ))}
        </>
      )}
      {tab === "shortcuts" && (
        <dl className="shortcut-list">
          {shortcuts.map(([keys, description]) => (
            <React.Fragment key={keys}>
              <dt>{keys}</dt>
              <dd>{description}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}
