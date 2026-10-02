/** Codex App Server's native request_user_input wire types. */
export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
};
export type AgentAnswers = Record<string, { answers: string[] }>;

export function parseAgentQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 3)
    throw new Error("Invalid Codex questions.");
  const ids = new Set<string>();
  for (const question of value) {
    if (
      !question ||
      typeof question !== "object" ||
      typeof question.id !== "string" ||
      !question.id ||
      ids.has(question.id) ||
      typeof question.header !== "string" ||
      typeof question.question !== "string" ||
      typeof question.isOther !== "boolean" ||
      typeof question.isSecret !== "boolean" ||
      (question.options !== null &&
        (!Array.isArray(question.options) ||
          question.options.some(
            (option: unknown) =>
              !option ||
              typeof option !== "object" ||
              typeof (option as { label?: unknown }).label !== "string" ||
              typeof (option as { description?: unknown }).description !== "string",
          )))
    )
      throw new Error("Invalid Codex questions.");
    ids.add(question.id);
  }
  return value as AgentQuestion[];
}

export function validateAgentAnswers(questions: AgentQuestion[], value: unknown): AgentAnswers {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Answer each Codex question before continuing.");
  const answers: AgentAnswers = Object.create(null);
  for (const question of questions) {
    const entry = Object.hasOwn(value, question.id)
      ? (value as AgentAnswers)[question.id]
      : undefined;
    if (
      !entry ||
      !Array.isArray(entry.answers) ||
      entry.answers.length !== 1 ||
      typeof entry.answers[0] !== "string" ||
      !entry.answers[0].trim()
    )
      throw new Error("Answer each Codex question before continuing.");
    const answer = entry.answers[0].trim();
    if (
      question.options?.length &&
      !question.isOther &&
      !question.options.some((option) => option.label === answer)
    )
      throw new Error("Choose one of the offered Codex answers.");
    answers[question.id] = { answers: [answer] };
  }
  if (Object.keys(value).some((id) => !questions.some((question) => question.id === id)))
    throw new Error("Unknown Codex question.");
  return answers;
}
