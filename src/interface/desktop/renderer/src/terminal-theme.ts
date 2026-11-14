import type { ITheme } from "@xterm/xterm";

/** The 16 ANSI colours agents use for diffs, status lines and syntax; balanced for each theme. */
const dark = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
  selectionBackground: "#58a6ff4d",
  scrollbarSliderBackground: "#ffffff1f",
  scrollbarSliderHoverBackground: "#ffffff38",
  scrollbarSliderActiveBackground: "#ffffff4d",
};
const light = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
  selectionBackground: "#0969da33",
  scrollbarSliderBackground: "#24292f26",
  scrollbarSliderHoverBackground: "#24292f40",
  scrollbarSliderActiveBackground: "#24292f59",
};

/** The terminal blends into the surface it sits on, so it takes the app's own background. */
export function terminalTheme(element: Element): ITheme {
  const colors = getComputedStyle(element);
  const background = colors.getPropertyValue("--bg").trim() || "#202020";
  const foreground = colors.getPropertyValue("--text").trim() || "#eee";
  const palette = document.documentElement.dataset.theme === "light" ? light : dark;
  return { ...palette, background, foreground, cursor: foreground, cursorAccent: background };
}
