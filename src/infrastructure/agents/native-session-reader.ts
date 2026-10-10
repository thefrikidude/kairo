import Database from "better-sqlite3";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { NativeAgentSession } from "../../domain/terminal-agent.js";
import { normalizeNativeSession } from "./terminal-agent-catalog.js";

export type NativeSessionRecord = NativeAgentSession & { createdAt: number; updatedAt: number };
export type NativeSessionLookup = {
  agentId: string;
  directory: string;
  since: number;
  includeExisting?: boolean;
  env?: NodeJS.ProcessEnv;
};
const timestamp = (value: unknown) => {
  const number = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(number) ? (number < 100_000_000_000 ? number * 1000 : number) : 0;
};
/** Reads native identities only: no conversation messages, credentials or vendor-store mutations. */
export class NativeSessionReader {
  constructor(private readonly home = homedir()) {}
  supports(agent: string): boolean {
    return agent === "codex" || agent === "opencode";
  }
  async list(lookup: NativeSessionLookup): Promise<NativeSessionRecord[]> {
    if (!this.supports(lookup.agentId)) return [];
    const env = { ...process.env, ...lookup.env };
    const canonical = await realpath(lookup.directory).catch(() => lookup.directory);
    if (lookup.agentId === "codex") {
      const home = env.CODEX_HOME || join(this.home, ".codex");
      const entries = await readdir(home).catch(() => []);
      const databases = entries
        .filter((name) => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
      if (databases[0]) {
        const result = this.sql(join(home, databases[0]), "threads", canonical, lookup);
        if (result !== undefined) return result;
      }
      return this.codexFiles(home, canonical, lookup);
    }
    const data = join(env.XDG_DATA_HOME || join(this.home, ".local/share"), "opencode");
    if (env.OPENCODE_DB === ":memory:") return [];
    const selected = env.OPENCODE_DB || "opencode.db";
    const database = isAbsolute(selected) ? selected : join(data, selected);
    return this.sql(database, "session", canonical, lookup) ?? [];
  }
  private sql(
    path: string,
    table: "threads" | "session",
    directory: string,
    lookup: NativeSessionLookup,
  ): NativeSessionRecord[] | undefined {
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 50 });
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      const codex = table === "threads";
      const codexTime = (field: string) =>
        columns.has(`${field}_ms`)
          ? columns.has(field)
            ? `COALESCE(NULLIF(${field}_ms,0),${field} * 1000)`
            : `${field}_ms`
          : `${field} * 1000`;
      const created = codex ? codexTime("created_at") : "time_created";
      const updated = codex
        ? columns.has("recency_at_ms")
          ? `MAX(${codexTime("updated_at")}, COALESCE(recency_at_ms,0))`
          : codexTime("updated_at")
        : "time_updated";
      const cwd = codex ? "cwd" : "directory";
      const root = codex
        ? columns.has("thread_source")
          ? "(source='cli' OR (source='vscode' AND thread_source='user'))"
          : "source='cli'"
        : "parent_id IS NULL";
      const archived = columns.has(codex ? "archived" : "time_archived")
        ? codex
          ? "AND archived=0"
          : "AND time_archived IS NULL"
        : "";
      const rows = db
        .prepare(
          `SELECT id, ${codex && columns.has("rollout_path") ? "rollout_path" : "NULL"} AS transcriptPath, ${created} AS createdAt, ${updated} AS updatedAt FROM ${table}
        WHERE ${cwd}=? AND ${root} ${archived} AND ${lookup.includeExisting ? updated : created}>=? ORDER BY ${created} LIMIT 65`,
        )
        .all(directory, lookup.since - 1000) as Record<string, unknown>[];
      return rows.flatMap((row) => {
        try {
          return [
            {
              ...normalizeNativeSession({
                id: row.id,
                ...(typeof row.transcriptPath === "string" && row.transcriptPath
                  ? { transcriptPath: row.transcriptPath }
                  : {}),
              }),
              createdAt: timestamp(row.createdAt),
              updatedAt: timestamp(row.updatedAt),
            },
          ];
        } catch {
          return [];
        }
      });
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  }
  private async codexFiles(
    home: string,
    directory: string,
    lookup: NativeSessionLookup,
  ): Promise<NativeSessionRecord[]> {
    const dates = [
      ...new Set([
        new Date(lookup.since - 86400000).toISOString().slice(0, 10),
        new Date(lookup.since + 86400000).toISOString().slice(0, 10),
        new Date(lookup.since).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
      ]),
    ];
    const found: NativeSessionRecord[] = [];
    let inspected = 0;
    for (const date of dates) {
      const folder = join(home, "sessions", ...date.split("-"));
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (++inspected > 256) return []; // Incomplete discovery must never claim a unique match.
        const path = join(folder, entry.name);
        let handle;
        try {
          const metadata = await stat(path);
          if (metadata.mtimeMs < lookup.since - 1000) continue;
          handle = await open(path, "r");
          const buffer = Buffer.alloc(64 * 1024),
            { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const newline = buffer.indexOf(10, 0);
          if (newline < 0 || newline >= bytesRead) continue;
          const value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
          if (
            value.type !== "session_meta" ||
            value.payload?.source !== "cli" ||
            typeof value.payload?.cwd !== "string"
          )
            continue;
          const cwd = await realpath(value.payload.cwd).catch(() => value.payload.cwd);
          const createdAt = timestamp(value.payload.timestamp ?? value.timestamp);
          if (cwd !== directory || (!lookup.includeExisting && createdAt < lookup.since - 1000))
            continue;
          found.push({
            ...normalizeNativeSession({ id: value.payload.id, transcriptPath: path }),
            createdAt,
            updatedAt: metadata.mtimeMs,
          });
        } catch {
          /* A concurrent native-store write or unsupported format is retried later. */
        } finally {
          await handle?.close();
        }
      }
    }
    return found;
  }
}

/** Baseline identity/recency prevents adopting old conversations just because they share a cwd. */
export function freshNativeCandidates(
  records: NativeSessionRecord[],
  baseline: Map<string, number>,
  includeExisting = false,
): NativeSessionRecord[] {
  return records.filter(
    (record) =>
      !baseline.has(record.id) || (includeExisting && record.updatedAt > baseline.get(record.id)!),
  );
}
