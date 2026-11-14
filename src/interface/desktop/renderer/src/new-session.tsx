import React, { useEffect, useState } from "react";
import { Check, ChevronDown, Folder, FolderOpen, Laptop } from "lucide-react";
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
import { Composer } from "./components/composer.js";
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
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-7 overflow-auto px-6 py-10">
        <div className="flex w-full max-w-[560px] flex-col gap-1.5 px-1">
          <h1 className="m-0 text-[28px] font-normal tracking-tight text-foreground">
            Where should we work?
          </h1>
          <p className="m-0 text-[15px] text-muted-foreground">
            Pick a project, or start a chat on this computer.
          </p>
        </div>
        <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border bg-card/60">
          {known.slice(0, 6).map((path) => (
            <button
              key={path}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent",
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
          <button
            className="flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={pending}
            onClick={chooseFolder}
          >
            <FolderOpen className="size-4 shrink-0" />
            Choose a folder to work in
          </button>
          {project && refs?.git && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
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
      </div>
      <div className="mx-auto w-full max-w-[740px] px-6 pb-5">
        {error && (
          <p className="file-error mb-2" role="alert">
            {error}
          </p>
        )}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={send}
          label="Describe a task"
          sendLabel="Start"
          autoFocus
          placeholder={
            agent ? "Describe a task or ask a question" : "Install an agent to start a session"
          }
          canSend={!!text.trim() && !pending && !!agent}
          leading={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-sm font-normal">
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
          }
          trailing={
            <Select value={agentId} disabled={pending || !agents.length} onValueChange={setAgentId}>
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
      </div>
    </div>
  );
}
