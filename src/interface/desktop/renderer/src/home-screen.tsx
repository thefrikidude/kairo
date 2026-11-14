import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder } from "lucide-react";
import { KairoLogo } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";

type Message = {
  id: string;
  role: "user" | "notice" | "switch";
  text: string;
  agentId?: string;
};
type Thread = { agentId?: string; messages: Message[] };

const suggestions = [
  "Summarize what changed in this repository recently",
  "Find a small TODO in the codebase and fix it",
  "Review my uncommitted changes for bugs",
];

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
export function HomeScreen({
  pending = false,
  storageKey = "kairo.chat:home",
  location,
  agents = [],
  onOpenProject,
  onNewChat,
}: {
  pending?: boolean;
  /** Threads are kept per workspace so each chat remembers its history and agent. */
  storageKey?: string;
  /** Where this chat lives, for example "This computer" or a project name. */
  location?: string;
  agents?: { id: string; name: string }[];
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
    add(
      { role: "user", text: body },
      {
        role: "notice",
        text: undelivered(agent?.name),
      },
    );
    setText("");
  };

  const composer = (
    <form
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 pb-3 focus-within:border-ring"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label="Message"
        placeholder={agent ? `Message ${agent.name}…` : "Install an agent to start chatting"}
        rows={3}
        className="min-h-14"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <Select value={agent?.id ?? ""} disabled={pending || !agents.length} onValueChange={choose}>
          <SelectTrigger aria-label="Agent" className="max-w-[60%]">
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
        <Button type="submit" size="icon" aria-label="Send" disabled={!text.trim()}>
          <ArrowUp />
        </Button>
      </div>
    </form>
  );

  if (thread.messages.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col gap-3 overflow-auto px-6 pt-7 pb-2"
          role="log"
          aria-label="Conversation"
        >
          {thread.messages.map((message) => (
            <p
              key={message.id}
              className={cn(
                "m-0 break-words whitespace-pre-wrap",
                message.role === "user" &&
                  "max-w-[80%] self-end rounded-2xl border border-border bg-card px-3.5 py-2.5",
                message.role === "notice" && "text-muted-foreground",
                message.role === "switch" &&
                  "self-center rounded-full border border-border px-3 py-0.5 text-xs text-muted-foreground",
              )}
            >
              {message.text}
            </p>
          ))}
          <div ref={end} />
        </div>
        <div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-5">{composer}</div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[radial-gradient(var(--line)_1px,transparent_1px)] bg-[length:22px_22px] p-8">
      <div className="flex w-full max-w-[760px] flex-col gap-3">
        <KairoLogo className="mb-1 ml-1 size-14 text-foreground" />
        {location && (
          <div
            className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3.5"
            title={location}
          >
            <Folder className="size-4 shrink-0" />
            <span className="truncate font-medium">{location}</span>
          </div>
        )}
        {composer}
        <div className="mt-1 grid grid-cols-3 gap-2.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="min-h-[72px] rounded-xl border border-border bg-transparent p-3.5 text-left leading-snug text-foreground hover:bg-accent"
              onClick={() => setText(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
        {(onNewChat || onOpenProject) && (
          <div className="mt-2 flex justify-center gap-2">
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
