import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
};

/** Private stdio transport: no network listener and no shell interpolation. */
export class JsonRpcProcess {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: RpcMessage) => void>();
  private exits = new Set<(error: Error) => void>();
  private buffer = "";
  private stopped = false;

  constructor(
    private readonly executable: string,
    private readonly args: string[],
  ) {}

  start(): void {
    if (this.child) return;
    this.child = spawn(this.executable, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.fail(new Error("Agent protocol message exceeded 4 MiB."));
        void this.close();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as RpcMessage;
          if (!message || typeof message !== "object") throw new Error("Invalid RPC message");
          if (!message.method && typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
              pending.reject(new Error(message.error.message || "Agent request failed."));
            else pending.resolve(message.result);
          } else {
            for (const listener of this.listeners) listener(message);
          }
        } catch {
          this.fail(new Error("Agent emitted invalid JSON protocol data."));
          void this.close();
          return;
        }
      }
    });
    // Drain stderr, but do not relay CLI diagnostics or credentials to the renderer.
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("Agent background service stopped.")));
    this.child.stdin.on("error", (error) => this.fail(error));
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    this.start();
    if (this.stopped) return Promise.reject(new Error("Agent background service is unavailable."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  send(message: unknown): void {
    if (this.stopped || !this.child?.stdin.writable)
      throw new Error("Agent background service is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.exits) listener(error);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.fail(new Error("Agent background service closed."));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already stopped. */
      }
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      kill("SIGTERM");
    });
  }
}
