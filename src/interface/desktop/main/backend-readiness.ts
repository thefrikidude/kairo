import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Spawn errors do not emit exit; readiness must listen for both failure paths. */
export function backendReadiness(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 30_000,
): {
  ready: Promise<void>;
  succeed: () => void;
  fail: (error: Error) => void;
} {
  let succeed!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("error", fail);
      child.removeListener("exit", exited);
    };
    succeed = () => {
      cleanup();
      resolve();
    };
    fail = (error) => {
      cleanup();
      reject(error);
    };
    const exited = () => fail(new Error("Kairo runtime exited before it was ready."));
    const timer = setTimeout(
      () => fail(new Error("Kairo runtime did not start in time.")),
      timeoutMs,
    );
    child.once("error", fail);
    child.once("exit", exited);
  });
  return { ready, succeed, fail };
}
