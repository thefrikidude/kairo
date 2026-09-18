import type { ModelSelection } from "../../domain/models.js";
import type { ApprovalPolicy, CredentialStore } from "../../domain/ports.js";
import { CodingAgent } from "../../application/coding-agent.js";
import {
  SqliteSessionStore,
  type Session,
} from "../../infrastructure/persistence/sqlite-session-store.js";
import { runTui } from "./tui.js";

/** Keeps the CLI entrypoint stable while the interaction layer is implemented by Ink. */
export async function runRepl(
  createAgent: (approval: ApprovalPolicy, selection: ModelSelection, apiKey: string) => CodingAgent,
  store: SqliteSessionStore,
  session: Session,
  initialSelection: ModelSelection,
  credentials: CredentialStore,
): Promise<void> {
  await runTui({ createAgent, store, session, initialSelection, credentials });
}
