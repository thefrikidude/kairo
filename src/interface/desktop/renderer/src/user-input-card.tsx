import React, { useState } from "react";
import type { DesktopUserInput } from "../../shared/api.js";
import type { AgentAnswers } from "../../../../domain/agent-user-input.js";

export function UserInputCard({
  request,
  onAnswered,
}: {
  request: DesktopUserInput;
  onAnswered(): void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const answerFor = (id: string) =>
    choices[id] === "custom"
      ? text[id]
      : request.questions.find((question) => question.id === id)?.options?.[Number(choices[id])]
          ?.label;
  const ready = request.questions.every((question) => Boolean(answerFor(question.id)?.trim()));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError("");
    const answers: AgentAnswers = Object.create(null);
    for (const question of request.questions)
      answers[question.id] = { answers: [answerFor(question.id)!.trim()] };
    try {
      await window.kairo.answerUserInput(request.id, answers);
      onAnswered();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  }

  return (
    <form
      className="user-input-card"
      onSubmit={(event) => void submit(event)}
      aria-label="Codex questions"
    >
      <div className="user-input-heading">
        <strong>Codex needs your input</strong>
        <span>Choose an answer to continue</span>
      </div>
      {request.questions.map((question, index) => {
        const name = `${request.id}-${index}`;
        const custom = !question.options?.length || choices[question.id] === "custom";
        return (
          <fieldset key={question.id} disabled={submitting}>
            <legend>
              {question.header && <span>{question.header}</span>}
              {question.question}
            </legend>
            {question.options?.map((option, optionIndex) => (
              <label className="question-option" key={optionIndex}>
                <input
                  type="radio"
                  name={name}
                  value={optionIndex}
                  checked={choices[question.id] === String(optionIndex)}
                  onChange={() =>
                    setChoices((current) => ({ ...current, [question.id]: String(optionIndex) }))
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            {Boolean(question.options?.length) && question.isOther && (
              <label className="question-option">
                <input
                  type="radio"
                  name={name}
                  value="custom"
                  checked={custom}
                  onChange={() =>
                    setChoices((current) => ({ ...current, [question.id]: "custom" }))
                  }
                />
                <span>Your own answer</span>
              </label>
            )}
            {custom && (
              <label className="question-text">
                Your answer
                <input
                  type={question.isSecret ? "password" : "text"}
                  autoComplete="off"
                  aria-label={`Your answer: ${question.header || question.question}`}
                  value={text[question.id] ?? ""}
                  onChange={(event) => {
                    setChoices((current) => ({ ...current, [question.id]: "custom" }));
                    setText((current) => ({ ...current, [question.id]: event.target.value }));
                  }}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      {error && (
        <p className="question-error" role="alert">
          {error}
        </p>
      )}
      <div className="user-input-footer">
        <span>Answers go directly to Codex</span>
        <button className="primary" type="submit" disabled={!ready || submitting}>
          {submitting ? "Sending…" : "Send answers"}
        </button>
      </div>
    </form>
  );
}
