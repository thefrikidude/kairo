export const activityLabel = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  none: "No terminal open",
} as const;
export const activityClass = {
  working: "status-running",
  waiting: "status-waiting",
  idle: "status-open",
  none: "",
} as const;
