import type { ModelSelection } from "../../domain/models.js";
import type { ApprovalPolicy, CredentialStore } from "../../domain/ports.js";
import { CodingAgent } from "../../application/coding-agent.js";
import {
  SqliteSessionStore,
  type Session,
} from "../../infrastructure/persistence/sqlite-session-store.js";
import { runTui } from "./tui.js";
import type { KairoConfig } from "../../infrastructure/configuration/config.js";

/** Keeps the CLI entrypoint stable while the interaction layer is implemented by Ink. */
export async function runRepl(
  createAgent: (
    approval: ApprovalPolicy,
    selection: ModelSelection,
    apiKey: string,
    jev?: import("../../infrastructure/providers/jev-safety-advisor.js").JevDecisionProvider,
    jevFeatures?: import("../../domain/ports.js").JevFeatures,
  ) => CodingAgent,
  store: SqliteSessionStore,
  session: Session,
  initialConfig: KairoConfig,
  credentials: CredentialStore,
): Promise<void> {
  await runTui({
    createAgent,
    store,
    session,
    initialSelection: initialConfig,
    initialJevEnabled: initialConfig.jevEnabled,
    initialJevFeatures: {
      routing: initialConfig.jevRoutingEnabled,
      safety: initialConfig.jevSafetyEnabled,
      recovery: initialConfig.jevRecoveryEnabled,
      autonomy: initialConfig.jevAutonomyEnabled,
    },
    initialAutoModelRoutingEnabled: initialConfig.autoModelRoutingEnabled,
    credentials,
  });
}
