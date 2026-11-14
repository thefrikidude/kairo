import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { Composer } from "./components/composer.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { cn } from "./lib/utils.js";
import type { ChatEvent, ChatThread } from "../../shared/api.js";
import type { StartOptions } from "./new-session.js";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

type Message = { id: string; role: ChatEvent["kind"]; text: string };
type Thread = { agentId?: string; messages: Message[] };

const toThread = (value: ChatThread): Thread => ({
  agentId: value.agentId,
  messages: value.events.map((event) => ({ id: event.id, role: event.kind, text: event.text })),
});

/** What Kairo says when a message cannot reach an agent yet. */
const undelivered = (agentName?: string) =>
  agentName
    ? `${agentName} is selected, but Kairo is not connected to agents yet, so this message was not delivered.`
    : "Install an agent CLI to chat. Kairo will list it here once it is found.";

/** Starts (or continues) a chat's saved history with a first message, as if it had been typed there. */
export async function seedThread(
  chatId: string,
  agentId: string,
  text: string,
  agentName?: string,
): Promise<void> {
  try {
    await window.kairo.appendChat(
      chatId,
      [
        { kind: "user", text },
        { kind: "notice", text: undelivered(agentName) },
      ],
      agentId,
    );
  } catch {
    /* the chat opens empty if its history cannot be saved */
  }
}

/**
 * The Kairo chat view. The agent picker lists real agents; Kairo itself is the layer between
 * this UI and whichever agent is selected. Transport to agents (ACP) and hand-off between
 * them (A2A) plug in where messages are sent and where the agent is switched.
 */
export type Recent = { id: string; title: string; detail: string };

export function HomeScreen({
  pending = false,
  chatId,
  location,
  agents = [],
  recents = [],
  onOpenRecent,
  onOpenProject,
  onNewChat,
  projects = [],
  onStart,
}: {
  pending?: boolean;
  /** The workspace whose saved history this shows; without one the thread only lives on screen. */
  chatId?: string;
  /** Where this chat lives, for example "This computer" or a project name. */
  location?: string;
  agents?: { id: string; name: string }[];
  /** Sessions to pick up again, shown under the empty chat's composer. */
  recents?: Recent[];
  onOpenRecent?(id: string): void;
  onOpenProject?(): void;
  onNewChat?(): void;
  /** Projects offered in the folder menu. */
  projects?: string[];
  /** Starts a session inside the chosen project with the typed message. */
  onStart?(options: StartOptions): void;
}): React.JSX.Element {
  const [project, setProject] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const known = [...picked.filter((path) => !projects.includes(path)), ...projects];
  const [thread, setThread] = useState<Thread>({ messages: [] });
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    setThread({ messages: [] });
    if (chatId)
      void window.kairo
        .chatThread(chatId)
        .then((value) => !disposed && setThread(toThread(value)))
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [chatId]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [thread.messages.length]);

  const last = localStorage.getItem("kairo-last-agent");
  const agent =
    agents.find((item) => item.id === thread.agentId) ??
    agents.find((item) => item.id === last) ??
    agents[0];
  /** Saves new messages (and the selected agent) with the backend, then shows what it stored. */
  const append = (events: Omit<ChatEvent, "id" | "createdAt">[], agentId?: string) => {
    if (!chatId) {
      setThread((current) => ({
        agentId: agentId ?? current.agentId,
        messages: [
          ...current.messages,
          ...events.map((event) => ({
            id: crypto.randomUUID(),
            role: event.kind,
            text: event.text,
          })),
        ],
      }));
      return;
    }
    void window.kairo
      .appendChat(chatId, events, agentId)
      .then((value) => setThread(toThread(value)))
      .catch(() => {});
  };

  const choose = (id: string) => {
    const next = agents.find((item) => item.id === id);
    if (!next || next.id === agent?.id) return;
    try {
      localStorage.setItem("kairo-last-agent", next.id);
    } catch {
      /* remembering the choice is optional */
    }
    append(
      thread.messages.length ? [{ kind: "switch", text: `Switched to ${next.name}` }] : [],
      next.id,
    );
  };
  const chooseFolder = () =>
    void window.kairo.pickWorkspace().then((path) => {
      if (!path) return;
      setPicked((all) => (all.includes(path) ? all : [path, ...all]));
      setProject(path);
    });
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    if (project && onStart && agent) {
      if (starting) return;
      setStarting(true);
      void window.kairo
        .projectRefs(project)
        .catch(() => undefined)
        .then((refs) => {
          onStart({
            project,
            mode: refs?.git ? "worktree" : "folder",
            baseRef: refs?.defaultRef ?? "",
            agentId: agent.id,
            text: body,
          });
          setText("");
        })
        .finally(() => setStarting(false));
      return;
    }
    append(
      [
        { kind: "user", text: body },
        { kind: "notice", text: undelivered(agent?.name) },
      ],
      agent?.id,
    );
    setText("");
  };

  const composer = (
    <Composer
      value={text}
      onChange={setText}
      onSubmit={submit}
      label="Message"
      placeholder={agent ? `Message ${agent.name}…` : "Install an agent to start chatting"}
      canSend={!!text.trim() && !starting}
      leading={
        location && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-sm font-normal text-muted-foreground"
                title="Choose folder"
                aria-label="Location"
              >
                <Folder />
                <span className="max-w-48 truncate">
                  {project
                    ? folderName(project)
                    : location === "This computer"
                      ? "Choose folder"
                      : location}
                </span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              {known.map((path) => (
                <DropdownMenuItem key={path} onSelect={() => setProject(path)}>
                  <Folder className="mr-2 size-4 text-muted-foreground" />
                  <span className="truncate">{folderName(path)}</span>
                </DropdownMenuItem>
              ))}
              {known.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={chooseFolder}>
                <FolderOpen className="mr-2 size-4 text-muted-foreground" />
                Choose folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
      trailing={
        <Select value={agent?.id ?? ""} disabled={pending || !agents.length} onValueChange={choose}>
          <SelectTrigger aria-label="Agent" className="h-8 max-w-48 border-0 text-sm">
            <SelectValue placeholder="No agents installed" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );

  if (thread.messages.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="mx-auto flex min-h-0 w-full max-w-[740px] flex-1 flex-col gap-4 overflow-auto px-6 pt-8 pb-3"
          role="log"
          aria-label="Conversation"
        >
          {thread.messages.map((message) => (
            <p
              key={message.id}
              className={cn(
                "m-0 break-words whitespace-pre-wrap text-[15px] leading-7",
                message.role === "user" && "max-w-[80%] self-end rounded-2xl bg-card px-4 py-2.5",
                message.role === "notice" && "text-sm text-muted-foreground",
                message.role === "switch" &&
                  "self-center rounded-full border border-border px-3 py-0.5 text-xs text-muted-foreground",
              )}
            >
              {message.text}
            </p>
          ))}
          <div ref={end} />
        </div>
        <div className="mx-auto w-full max-w-[740px] px-6 pt-2 pb-5">{composer}</div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-10">
      <div className="flex w-full max-w-[680px] flex-col gap-7">
        <div className="flex flex-col gap-1.5 px-1">
          <h1 className="m-0 text-[28px] font-normal tracking-tight text-foreground">
            What should we work on?
          </h1>
        </div>
        {composer}
        {recents.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="px-3 pb-1 text-xs text-muted-foreground">Recent</span>
            {recents.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-accent"
                onClick={() => onOpenRecent?.(item.id)}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>
              </button>
            ))}
          </div>
        )}
        {onNewChat && !location && (
          <Button disabled={pending} onClick={onNewChat} className="self-start">
            New chat on this computer
          </Button>
        )}
        {onOpenProject && !location && (
          <button
            type="button"
            disabled={pending}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onOpenProject}
          >
            <FolderOpen className="size-4" />
            Open a folder
          </button>
        )}
      </div>
    </div>
  );
}
