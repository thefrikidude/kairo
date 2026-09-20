/** The bounded interaction classes used before Kairo creates a coding task. */
export type InteractionIntent = "conversation" | "answer" | "repository_task";
export type AutoInteractionMode = "plan" | "build";

const simpleGreeting =
  /^(?:hi|hello|hey|yo|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you)[!.\s]*$/i;

/** Keeps obvious social messages local so they spend neither Jev nor coding-model capacity. */
export function greetingResponse(input: string): string | undefined {
  if (!simpleGreeting.test(input.trim())) return undefined;
  if (/thank/i.test(input)) return "You're welcome. What would you like to work on?";
  return "Hello! What would you like to inspect, plan, change, or verify?";
}

/** Builds minimal, credential-free context for Jev's pre-loop intent decision. */
export function interactionIntentState(input: string): string {
  return [
    `User message: ${input.replace(/(?:sk|gsk|or|AIza)[-_a-zA-Z0-9]{12,}/g, "[redacted]").slice(0, 1_500)}`,
    "Classify the interaction before any repository context or tools are exposed.",
  ].join("\n");
}

/** AUTO keeps conversational inputs read-only and enables BUILD only for repository work. */
export function autoInteractionMode(intent: InteractionIntent): AutoInteractionMode {
  return intent === "repository_task" ? "build" : "plan";
}
