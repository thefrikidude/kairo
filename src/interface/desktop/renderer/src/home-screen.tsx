import React, { useEffect, useRef, useState } from "react";
import { Folder } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Composer } from "./components/composer.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { cn } from "./lib/utils.js";

type Message = {
  id: string;
  role: "user" | "notice" | "switch";
  text: string;
  agentId?: string;
};
type Thread = { agentId?: string; messages: Message[] };

function load(key: string): Thread {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Thread | null;
    if (value && Array.isArray(value.messages)) return value;
  } catch {
    /* an unreadable thread starts empty */
  }
  return { messages: [] };
}

/** What Kairo says when a message cannot reach an agent yet. */
const undelivered = (agentName?: string) =>
  agentName
    ? `${agentName} is selected, but Kairo is not connected to agents yet, so this message was not delivered.`
    : "Install an agent CLI to chat. Kairo will list it here once it is found.";

/** Starts (or continues) a chat's saved history with a first message, as if it had been typed there. */
export function seedThread(storageKey: string, agentId: string, text: string, agentName?: string) {
  const thread = load(storageKey);
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        agentId,
        messages: [
          ...thread.messages,
          { id: crypto.randomUUID(), role: "user", text },
          { id: crypto.randomUUID(), role: "notice", text: undelivered(agentName) },
        ],
      }),
    );
  } catch {
    /* the chat opens empty without saved history */
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
  storageKey = "kairo.chat:home",
  location,
  agents = [],
  recents = [],
  onOpenRecent,
  onOpenProject,
  onNewChat,
}: {
  pending?: boolean;
  /** Threads are kept per workspace so each chat remembers its history and agent. */
  storageKey?: string;
  /** Where this chat lives, for example "This computer" or a project name. */
  location?: string;
  agents?: { id: string; name: string }[];
  /** Sessions to pick up again, shown under the empty chat's composer. */
  recents?: Recent[];
  onOpenRecent?(id: string): void;
  onOpenProject?(): void;
  onNewChat?(): void;
}): React.JSX.Element {
  const [thread, setThread] = useState<Thread>(() => load(storageKey));
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setThread(load(storageKey));
  }, [storageKey]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [thread.messages.length]);

  const last = localStorage.getItem("kairo-last-agent");
  const agent =
    agents.find((item) => item.id === thread.agentId) ??
    agents.find((item) => item.id === last) ??
    agents[0];
  const update = (next: Thread) => {
    setThread(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* the chat still works without saved history */
    }
  };
  const add = (...messages: Omit<Message, "id">[]) =>
    update({
      agentId: agent?.id,
      messages: [
        ...thread.messages,
        ...messages.map((message) => ({ ...message, id: crypto.randomUUID() })),
      ],
    });

  const choose = (id: string) => {
    const next = agents.find((item) => item.id === id);
    if (!next || next.id === agent?.id) return;
    try {
      localStorage.setItem("kairo-last-agent", next.id);
    } catch {
      /* remembering the choice is optional */
    }
    update({
      agentId: next.id,
      messages: thread.messages.length
        ? [
            ...thread.messages,
            { id: crypto.randomUUID(), role: "switch", text: `Switched to ${next.name}` },
          ]
        : [],
    });
  };
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    add({ role: "user", text: body }, { role: "notice", text: undelivered(agent?.name) });
    setText("");
  };

  const composer = (
    <Composer
      value={text}
      onChange={setText}
      onSubmit={submit}
      label="Message"
      placeholder={agent ? `Message ${agent.name}…` : "Install an agent to start chatting"}
      canSend={!!text.trim()}
      leading={
        location && (
          <span
            className="flex items-center gap-1.5 px-2 text-sm text-muted-foreground"
            title={location}
          >
            <Folder className="size-4 shrink-0" />
            <span className="max-w-48 truncate">{location}</span>
          </span>
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
          {location && <p className="m-0 text-[15px] text-muted-foreground">in {location}</p>}
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
        {(onNewChat || onOpenProject) && (
          <div className="flex gap-2">
            {onNewChat && (
              <Button disabled={pending} onClick={onNewChat}>
                New chat on this computer
              </Button>
            )}
            {onOpenProject && (
              <Button variant="outline" disabled={pending} onClick={onOpenProject}>
                Open project folder
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
