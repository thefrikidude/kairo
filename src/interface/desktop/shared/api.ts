export * from "./terminal-api.js";
import type { TerminalDesktopApi, TerminalDesktopBootstrap } from "./terminal-api.js";
export type DesktopBootstrap = TerminalDesktopBootstrap;
export type DesktopApi = TerminalDesktopApi;
declare global {
  interface Window {
    kairo: DesktopApi;
  }
}
