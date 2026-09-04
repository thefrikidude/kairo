import type { FailureEvidence } from "../domain/models.js";

const MAX_EXCERPTS = 8;
const MAX_OUTPUT = 8_000;

export class FailureAnalyzer {
  analyze(command: string, output: string): FailureEvidence {
    // Keep persisted repair context small even when a test runner emits a large stack trace.
    const lines = output
      .slice(0, MAX_OUTPUT)
      .split("\n")
      .map((line) => line.trim());
    const fileLocations = new Map<string, { path: string; line?: number; column?: number }>();
    for (const line of lines) {
      // Covers the common JavaScript/TypeScript `path:line[:column]` stack-trace form.
      for (const match of line.matchAll(/([\w@./-]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?/g)) {
        const path = match[1]!;
        fileLocations.set(`${path}:${match[2]}:${match[3] ?? ""}`, {
          path,
          line: Number(match[2]),
          column: match[3] ? Number(match[3]) : undefined,
        });
      }
      // Test runners often name the failing file without a source location.
      const testFile = /(?:FAIL|✖|×)\s+([\w@./-]+\.[cm]?[jt]sx?)/.exec(line)?.[1];
      if (testFile) fileLocations.set(testFile, { path: testFile });
    }
    const excerpts = lines
      .filter((line) => /(?:error|fail|expect|assert|exception|✖|×)/i.test(line))
      .filter((line, index, all) => Boolean(line) && all.indexOf(line) === index)
      .slice(0, MAX_EXCERPTS);
    return {
      summary: excerpts[0] || `Verification command failed: ${command}`,
      fileLocations: [...fileLocations.values()].slice(0, MAX_EXCERPTS),
      excerpts,
    };
  }
}
