import React, { useState } from "react";
import { KairoLogo } from "./chrome.js";

/** Landing screen when no project is open. Chat across agents will grow out of this input. */
export function HomeScreen({
  pending,
  onOpenProject,
  onNewChat,
}: {
  pending: boolean;
  onOpenProject(): void;
  onNewChat(): void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    setNote("Chat is coming soon. Open a project to start an agent in a terminal.");
    setText("");
  };
  return (
    <div className="welcome home-screen">
      <KairoLogo className="welcome-logo" />
      <h1>What should we work on?</h1>
      <form
        className="home-input"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Ask anything…"
          rows={3}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setNote("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className="primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      {note && <p role="status">{note}</p>}
      <button className="primary" disabled={pending} onClick={onNewChat}>
        New chat on this computer
      </button>
      <button disabled={pending} onClick={onOpenProject}>
        Open project folder
      </button>
    </div>
  );
}
