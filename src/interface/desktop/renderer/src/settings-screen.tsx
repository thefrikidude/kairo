import React, { useState } from "react";
import {
  Keyboard,
  LayoutGrid,
  MessageSquare,
  PanelsTopLeft,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent } from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { cn } from "./lib/utils.js";

export type ThemeChoice = "system" | "dark" | "light";

const settingsTabs = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    keywords: "appearance theme dark light",
  },
  { id: "chats", label: "Archived chats", icon: MessageSquare, keywords: "restore recover delete" },
  {
    id: "workspaces",
    label: "Workspaces",
    icon: LayoutGrid,
    keywords: "open restore delete folder",
  },
  {
    id: "tabs",
    label: "Closed agent tabs",
    icon: PanelsTopLeft,
    keywords: "restore agent session",
  },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, keywords: "keys hotkeys" },
] as const;
const shortcuts: [string, string][] = [
  ["⌘ ⇧ N", "New workspace"],
  ["⌘ J", "Jump to a workspace or tab, or run a command"],
  ["⌘ P", "Quick open file"],
  ["⌘ `", "Show or hide the terminal"],
  ["⌘ ⇧ E", "Files"],
  ["⌘ ⇧ D", "Review"],
  ["⌘ ⇧ B", "Toggle sidebar"],
  ["⌘ F", "Find in a terminal"],
  ["⌘ K", "Clear a terminal"],
];

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** One setting: its name and explanation on the left, the control or actions on the right. */
function SettingRow({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-border py-5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[15px]">{title}</div>
        {description && (
          <div className="mt-1 break-words text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-6 text-sm text-muted-foreground">{children}</p>
);

/** Settings as a dialog over the app, like Claude's: a searchable list of sections beside the rows. */
export function SettingsDialog({
  open,
  onClose,
  tab,
  onTab,
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
}: {
  open: boolean;
  onClose(): void;
  tab: string;
  onTab(id: string): void;
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
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = settingsTabs.filter(
    (item) => !needle || `${item.label} ${item.keywords}`.toLowerCase().includes(needle),
  );
  const current = settingsTabs.find((item) => item.id === tab) ?? settingsTabs[0];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="settings-dialog flex h-[min(calc(100vh-48px),700px)] w-[min(calc(100vw-48px),1040px)] flex-col overflow-hidden border border-border bg-background"
        aria-labelledby="settings-title"
        aria-describedby={undefined}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-7 py-4">
          <h2 id="settings-title" className="text-lg font-medium">
            Settings
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-muted-foreground"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-64 shrink-0 flex-col gap-1 overflow-auto border-r border-border p-4"
            aria-label="Settings sections"
          >
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search settings"
                placeholder="Search"
                className="h-10 pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {visible.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={cn(
                  "h-10 w-full justify-start gap-3 px-3 text-[15px] font-normal",
                  item.id === current.id ? "bg-accent" : "text-foreground/80",
                )}
                aria-current={item.id === current.id ? "page" : undefined}
                onClick={() => onTab(item.id)}
              >
                <item.icon className="size-[18px] text-muted-foreground" />
                {item.label}
              </Button>
            ))}
            {!visible.length && <Empty>No settings match.</Empty>}
          </nav>
          <section
            className="settings-content min-w-0 flex-1 overflow-auto px-8 py-6"
            aria-label={current.label}
          >
            <h3 className="mb-1 text-lg font-medium">{current.label}</h3>
            {current.id === "general" && (
              <>
                <SettingRow title="Appearance" description="Choose how Kairo looks.">
                  <NativeSelect
                    aria-label="Theme"
                    className="w-44"
                    value={theme}
                    onChange={(event) => onTheme(event.target.value as ThemeChoice)}
                  >
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </NativeSelect>
                </SettingRow>
                <SettingRow
                  title="Agents"
                  description="Conversations run inside the selected CLI. Models, authentication and approvals are managed by that agent."
                />
              </>
            )}
            {current.id === "chats" && (
              <>
                {!archivedChats.length && <Empty>No archived chats</Empty>}
                {archivedChats.length > 0 && (
                  <SettingRow
                    title="All archived chats"
                    description={`${archivedChats.length} archived ${archivedChats.length === 1 ? "chat" : "chats"}`}
                  >
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
                  </SettingRow>
                )}
                {archivedChats.map((item) => (
                  <SettingRow
                    key={item.id}
                    title={item.name ?? name(item.directory)}
                    description="Archived"
                  >
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
                  </SettingRow>
                ))}
              </>
            )}
            {current.id === "workspaces" && (
              <>
                {state?.workspaces
                  .filter((item) => !item.removedAt && !(isChat(item) && item.archivedAt))
                  .map((item) => (
                    <SettingRow
                      key={item.id}
                      title={item.name ?? item.branch ?? name(item.directory)}
                      description={
                        <>
                          <span>{item.archivedAt ? `${item.kind} · archived` : item.kind}</span>
                          <code className="mt-0.5 block break-all text-xs">{item.directory}</code>
                        </>
                      }
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          onClose();
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
                    </SettingRow>
                  ))}
                {!state?.workspaces.some((item) => !item.removedAt) && (
                  <Empty>No workspaces yet</Empty>
                )}
              </>
            )}
            {current.id === "tabs" && (
              <>
                {!archived.length && <Empty>No closed agent tabs</Empty>}
                {archived.map((session) => (
                  <SettingRow
                    key={session.id}
                    title={session.title}
                    description={
                      <code className="break-all text-xs">
                        {
                          state?.workspaces.find((item) => item.id === session.workspaceId)
                            ?.directory
                        }
                      </code>
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        pending ||
                        !!state?.workspaces.find((item) => item.id === session.workspaceId)
                          ?.removedAt
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
                  </SettingRow>
                ))}
              </>
            )}
            {current.id === "shortcuts" &&
              shortcuts.map(([keys, description]) => (
                <SettingRow key={keys} title={description}>
                  <kbd className="rounded-md border border-border bg-muted px-2 py-1 font-sans text-sm text-muted-foreground">
                    {keys}
                  </kbd>
                </SettingRow>
              ))}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
