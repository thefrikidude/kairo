import { ProviderError } from "../../domain/provider-error.js";
import type {
  JevAssessment,
  JevDecision,
  JevRecovery,
  JevModelTier,
  JevInteractionIntent,
  JevRisk,
  JevRoute,
  JevSafetyAdvisor,
} from "../../domain/ports.js";

const endpoint = "https://api.typesafe.ai/v1/systemone";
const riskChoices: Record<JevRisk, string> = {
  low: "A workspace-local, reversible action with limited impact, such as an ordinary source edit or focused test.",
  medium:
    "An action that can affect multiple files, dependencies, build artifacts, or execute a command with meaningful workspace impact.",
  high: "An action that can delete data, publish or transmit data, change credentials, alter broad configuration, or run a destructive command.",
};

type JevResponse = {
  answers?: Record<
    string,
    {
      choice?: unknown;
      confidence?: unknown;
    }
  >;
};

/** Calls TypeSafe Jev directly for one bounded, typed action-risk decision. */
export class JevDecisionProvider implements JevSafetyAdvisor {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async assess(state: string): Promise<JevAssessment> {
    const decision = await this.decide("action_risk", state, riskChoices);
    return { risk: decision.value, confidence: decision.confidence };
  }

  /** Separates chat from repository work before Kairo exposes workspace context or tools. */
  async intent(state: string): Promise<JevDecision<JevInteractionIntent>> {
    return this.decide("interaction_intent", state, {
      conversation:
        "A greeting, acknowledgement, or casual social message that needs a short direct reply and no model call.",
      answer:
        "A general question or explanation that can be answered without repository context or tools.",
      repository_task:
        "A request to inspect, explain using, change, test, run, or otherwise act on the current repository.",
    });
  }

  async route(state: string): Promise<JevDecision<JevRoute>> {
    return this.decide("task_route", state, {
      build: "A bounded implementation request that can proceed directly with the coding agent.",
      plan: "A broad, ambiguous, multi-file, risky, or architectural request that should first create a read-only plan.",
    });
  }

  async recover(state: string): Promise<JevDecision<JevRecovery>> {
    return this.decide("verification_recovery", state, {
      repair: "The failure is specific enough for the coding model to attempt a focused repair.",
      broaden:
        "The current check is too narrow; recommend the next broader discovered verification command.",
      escalate:
        "The failure is ambiguous, risky, or lacks enough evidence; stop automatic repair and ask the user.",
    });
  }

  /** Selects a bounded coding-model tier; Kairo applies the local allowlist and credentials. */
  async modelTier(state: string): Promise<JevDecision<JevModelTier>> {
    return this.decide("coding_model_tier", state, {
      fast: "A small, focused, low-risk implementation or explanation where low latency matters most.",
      balanced:
        "A normal feature or bug fix that benefits from reliable coding ability and moderate latency.",
      strong:
        "A complex, multi-file, architectural, or difficult debugging task needing the strongest available coding model.",
    });
  }

  private async decide<T extends string>(
    questionId: string,
    state: string,
    criteria: Record<T, string>,
  ): Promise<JevDecision<T>> {
    const response = await this.fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: state.slice(0, 4_000),
        questions: {
          [questionId]: {
            type: "choice",
            instructions:
              "Classify only the operational risk of the proposed Kairo action. Do not authorize it.",
            criteria,
          },
        },
      }),
    });
    if (!response.ok) throw this.error(response.status);
    const answer = (await response.json()) as JevResponse;
    const choice = answer.answers?.[questionId]?.choice;
    const confidence = answer.answers?.[questionId]?.confidence;
    if (
      typeof choice !== "string" ||
      !Object.hasOwn(criteria, choice) ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      throw new ProviderError("request", false, undefined, "Jev");
    return { value: choice as T, confidence };
  }

  /** Uses a minimal typed request because TypeSafe does not publish a key-only probe. */
  async validate(): Promise<void> {
    await this.assess("Kairo credential validation. Proposed action: no operation.");
  }

  private error(status: number): ProviderError {
    if (status === 401 || status === 403)
      return new ProviderError("authentication", false, undefined, "Jev");
    if (status === 429) return new ProviderError("quota", true, undefined, "Jev");
    if (status >= 500) return new ProviderError("service", true, undefined, "Jev");
    return new ProviderError("request", false, undefined, "Jev");
  }
}
