import type { Message } from "../domain/models.js";
import type { JevSafetyAdvisor, TaskStore } from "../domain/ports.js";
import type { CodingAgent } from "./coding-agent.js";

/** Shared intent and dispatch logic used by every Kairo interface. */
export type InteractionIntent = "conversation" | "answer" | "repository_task";
export type InteractionMode = "answer" | "plan" | "build";
export type RequestedInteractionMode = Exclude<InteractionMode, "answer">;
export type InteractionRoute = {
  intent: InteractionIntent;
  mode: InteractionMode;
  localResponse?: string;
};

const simpleGreeting =
  /^(?:hi|hello|hey|yo|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you)[!.\s]*$/i;

/** Keeps obvious social messages local so they spend neither Jev nor coding-model capacity. */
export function greetingResponse(input: string): string | undefined {
  if (!simpleGreeting.test(input.trim())) return undefined;
  if (/thank/i.test(input)) return "You're welcome. What would you like to work on?";
  return "Hello! What would you like to inspect, plan, change, or verify?";
}

function casualResponse(input: string): string {
  const greeting = greetingResponse(input);
  if (greeting) return greeting;
  if (/\bhow are you\b|\bhow's it going\b/i.test(input))
    return "I'm here and ready to help. What would you like to work on?";
  return "I'm here to help. What would you like to work on?";
}

/** Builds minimal, credential-free context for Jev's pre-loop intent decision. */
export function interactionIntentState(input: string): string {
  return [
    `User message: ${input.replace(/(?:sk|gsk|or|AIza)[-_a-zA-Z0-9]{12,}/g, "[redacted]").slice(0, 1_500)}`,
    "Classify the interaction before any repository context or tools are exposed.",
  ].join("\n");
}

/** Routes one message before repository context or tools are made available. */
export async function routeInteraction(
  input: string,
  requestedMode: RequestedInteractionMode,
  autoRouting: boolean,
  advisor?: Pick<JevSafetyAdvisor, "intent">,
): Promise<InteractionRoute> {
  const shouldClassify = requestedMode === "build" || autoRouting;
  if (shouldClassify) {
    const localResponse = greetingResponse(input);
    if (localResponse) return { intent: "conversation", mode: "answer", localResponse };
  }

  let intent: InteractionIntent = "repository_task";
  if (shouldClassify && advisor?.intent) {
    try {
      const decision = await advisor.intent(interactionIntentState(input));
      if (decision.confidence >= 0.85) intent = decision.value;
    } catch {
      // A routing service outage must not silently skip an explicitly requested code task.
    }
  }

  if (intent === "conversation")
    return { intent, mode: "answer", localResponse: casualResponse(input) };
  if (intent === "answer") return { intent, mode: "answer" };
  return { intent, mode: autoRouting ? "build" : requestedMode };
}

/** Executes a classified interaction and persists local conversational replies. */
export async function executeInteraction(
  route: InteractionRoute,
  sessionId: string,
  input: string,
  store: Pick<TaskStore, "addMessage">,
  agent: CodingAgent | undefined,
  onText: (text: string) => void,
  runBuild?: (
    agent: CodingAgent,
    sessionId: string,
    input: string,
    onText: (text: string) => void,
  ) => Promise<void>,
): Promise<void> {
  if (route.localResponse) {
    const now = Date.now();
    const userMessage: Message = { role: "user", content: input, createdAt: now };
    const assistantMessage: Message = {
      role: "model",
      content: route.localResponse,
      createdAt: now,
    };
    store.addMessage(sessionId, userMessage);
    store.addMessage(sessionId, assistantMessage);
    onText(route.localResponse);
    return;
  }
  if (!agent) throw new Error("No model agent is available for this interaction.");
  if (route.mode === "answer") return agent.answer(sessionId, input, onText);
  if (route.mode === "plan") return agent.plan(sessionId, input, onText);
  return runBuild ? runBuild(agent, sessionId, input, onText) : agent.run(sessionId, input, onText);
}
