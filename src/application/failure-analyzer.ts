import type { FailureEvidence } from "../domain/models.js";

const MAX_EXCERPTS = 8;
const MAX_OUTPUT = 8_000;
const SOURCE_EXTENSIONS =
  "[cm]?[jt]sx?|py|pyi|go|rs|java|kt|kts|rb|php|ex|exs|cs|fsx?|swift|c|cc|cpp|h|hpp|scala|sc";
const LOCATION_PATTERN = new RegExp(
  `([\\w@./\\-]+\\.(?:${SOURCE_EXTENSIONS})):(\\d+)(?::(\\d+))?`,
  "g",
);

export class FailureAnalyzer {
  /** Extracts bounded paths and useful error lines from a failed verification command. */
  analyze(command: string, output: string): FailureEvidence {
    // Keep persisted repair context small even when a test runner emits a large stack trace.
    const lines = output
      .slice(0, MAX_OUTPUT)
      .split("\n")
      .map((line) => line.trim());
    const fileLocations = new Map<string, { path: string; line?: number; column?: number }>();
    for (const line of lines) {
      // Covers common compiler and test-runner locations across supported ecosystems.
      for (const match of line.matchAll(LOCATION_PATTERN)) {
        const path = match[1]!;
        fileLocations.set(`${path}:${match[2]}:${match[3] ?? ""}`, {
          path,
          line: Number(match[2]),
          column: match[3] ? Number(match[3]) : undefined,
        });
      }
      // Python tracebacks put the path and line number in a different format.
      const pythonFrame = /File "([^\"]+\.py)", line (\d+)/.exec(line);
      if (pythonFrame)
        fileLocations.set(`${pythonFrame[1]}:${pythonFrame[2]}`, {
          path: pythonFrame[1]!,
          line: Number(pythonFrame[2]),
        });
      // Test runners often name the failing file without a source location.
      const testFile = new RegExp(`(?:FAIL|✖|×)\\s+([\\w@./\\-]+\\.(?:${SOURCE_EXTENSIONS}))`).exec(
        line,
      )?.[1];
      if (testFile) fileLocations.set(testFile, { path: testFile });
    }
    const excerpts = lines
      .filter((line) => /(?:error|fail|expect|assert|exception|✖|×)/i.test(line))
      .filter((line, index, all) => Boolean(line) && all.indexOf(line) === index)
      .slice(0, MAX_EXCERPTS);
    return {
      summary:
        excerpts.find((line) => /\b(error|failed|exception|assertion)\b/i.test(line)) ??
        excerpts[0] ??
        `Verification command failed: ${command}`,
      fileLocations: [...fileLocations.values()].slice(0, MAX_EXCERPTS),
      excerpts,
    };
  }
}
