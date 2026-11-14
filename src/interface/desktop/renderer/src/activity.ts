export const activityLabel = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  done: "Finished",
  error: "Ran into a problem",
  none: "No terminal open",
} as const;
export const activityClass = {
  working: "status-running",
  waiting: "status-waiting",
  idle: "status-none",
  done: "status-complete",
  error: "status-error",
  none: "status-none",
} as const;
