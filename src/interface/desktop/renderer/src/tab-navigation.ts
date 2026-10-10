import type { KeyboardEvent } from "react";

/** Roving focus for the small workspace/terminal tablists; selection follows focus. */
export function navigateTabs(event: KeyboardEvent<HTMLDivElement>): void {
  if (
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  )
    return;
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[role="tab"]')
      : null;
  if (!target) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
    (tab) => !tab.disabled,
  );
  const index = tabs.indexOf(target);
  if (index < 0 || !tabs.length) return;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].click();
  tabs[next].focus();
}
