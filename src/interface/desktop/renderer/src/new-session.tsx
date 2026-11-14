import React, { useEffect, useState } from "react";
import { ArrowUp, Check, ChevronDown, Folder, FolderOpen, Laptop } from "lucide-react";
import { KairoLogo } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export type StartOptions = {
  /** Absent means a chat on this computer, outside any project. */
  project?: string;
  mode: "worktree" | "folder";
  /** The ref a new worktree starts from. */
  baseRef: string;
  agentId: string;
  text: string;
};

/**
 * The start screen, like Claude's: pick where to work (a project you already opened, a new folder,
 * or just this computer), describe the task, and Kairo creates the workspace or chat for it.
 */
export function NewSession({
  projects,
  agents,
  pending,
  error,
  onStart,
}: {
  projects: string[];
  agents: { id: string; name: string }[];
  pending: boolean;
  error: string;
  onStart(options: StartOptions): void;
}): React.JSX.Element {
  const [project, setProject] = useState<string>();
  // Folders picked here are listed straight away, before any workspace exists in them.
  const [picked, setPicked] = useState<string[]>([]);
  const known = [...picked.filter((path) => !projects.includes(path)), ...projects];
  const [mode, setMode] = useState<"worktree" | "folder">("worktree");
  const [refs, setRefs] = useState<{ git: boolean; defaultRef: string }>();
  const [text, setText] = useState("");
  const last = localStorage.getItem("kairo-last-agent");
  const [agentId, setAgentId] = useState(
    () => (agents.find((agent) => agent.id === last) ?? agents[0])?.id ?? "",
  );

  // Whether the chosen project is a Git repository decides if an isolated worktree is offered.
  useEffect(() => {
    setRefs(undefined);
    if (!project) return;
    let disposed = false;
    void window.kairo
      .projectRefs(project)
      .then((value) => {
        if (disposed) return;
        setRefs({ git: value.git, defaultRef: value.defaultRef });
        setMode(value.git ? "worktree" : "folder");
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [project]);

  const agent = agents.find((item) => item.id === agentId);
  const location = project ? name(project) : "This computer";
  const send = () => {
    const body = text.trim();
    if (!body || pending || !agent) return;
    try {
      localStorage.setItem("kairo-last-agent", agent.id);
    } catch {
      /* remembering the choice is optional */
    }
    onStart({
      project,
      mode: project && refs?.git ? mode : "folder",
      baseRef: refs?.defaultRef ?? "",
      agentId: agent.id,
      text: body,
    });
  };
  const chooseFolder = () =>
    void window.kairo.pickWorkspace().then((path) => {
      if (!path) return;
      setPicked((all) => (all.includes(path) ? all : [path, ...all]));
      setProject(path);
    });

  return (
    <div className="new-session flex min-h-0 flex-1 flex-col items-center">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-8">
        <KairoLogo className="size-12 text-foreground" />
        <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-border bg-popover">
          {known.slice(0, 6).map((path) => (
            <button
              key={path}
              className={cn(
                "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm hover:bg-accent",
                project === path && "bg-accent",
              )}
              title={path}
              aria-pressed={project === path}
              onClick={() => setProject(project === path ? undefined : path)}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{name(path)}</span>
              {project === path && <Check className="size-4 text-muted-foreground" />}
            </button>
          ))}
          {!known.length && (
            <p className="px-3.5 py-3 text-sm text-muted-foreground">
              No projects yet. Choose a folder to start one.
            </p>
          )}
          {project && refs?.git && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-3.5 py-2">
              <span className="text-sm text-muted-foreground">Workspace</span>
              <Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                <SelectTrigger aria-label="Workspace type" className="h-8 border-0 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worktree">Isolated worktree</SelectItem>
                  <SelectItem value="folder">Project folder (shared)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <button
          className="flex w-full max-w-[420px] items-center gap-2.5 rounded-xl border border-border bg-popover px-3.5 py-3 text-left text-sm hover:bg-accent"
          disabled={pending}
          onClick={chooseFolder}
        >
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          Choose a folder to work in
        </button>
      </div>
      <form
        className="mx-auto w-full max-w-[760px] px-6 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {error && (
          <p className="file-error mb-2" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 pb-3 focus-within:border-ring">
          <Textarea
            aria-label="Describe a task"
            placeholder={
              agent ? "Describe a task or ask a question" : "Install an agent to start a session"
            }
            rows={2}
            className="min-h-10"
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2 text-sm font-normal"
                  >
                    {project ? <Folder /> : <Laptop />}
                    <span className="max-w-40 truncate">{location}</span>
                    <ChevronDown className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuItem onSelect={() => setProject(undefined)}>
                    <Laptop className="mr-2 size-4 text-muted-foreground" />
                    This computer
                  </DropdownMenuItem>
                  {known.map((path) => (
                    <DropdownMenuItem key={path} onSelect={() => setProject(path)}>
                      <Folder className="mr-2 size-4 text-muted-foreground" />
                      <span className="truncate">{name(path)}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={chooseFolder}>
                    <FolderOpen className="mr-2 size-4 text-muted-foreground" />
                    Choose folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={agentId}
                disabled={pending || !agents.length}
                onValueChange={setAgentId}
              >
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
              <Button
                type="submit"
                size="icon"
                aria-label="Start"
                disabled={!text.trim() || pending || !agent}
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
