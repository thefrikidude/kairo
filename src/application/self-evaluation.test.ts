import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { selfEvaluationScenarios } from "./self-evaluation.js";

const seededMarkers: Record<string, { path: string; missing: string }> = {
  "verification-check-script": {
    path: "src/application/verification-planner.ts",
    missing: '"check"]]',
  },
  "bun-lockfile-discovery": {
    path: "src/infrastructure/repository/repository-profiler.ts",
    missing: '|| names.has("bun.lock")',
  },
  "context-relationship-ranking": {
    path: "src/application/context-selector.ts",
    missing: "const relationshipScore = file.relatedFiles",
  },
  "verifying-task-recovery": {
    path: "src/infrastructure/persistence/sqlite-session-store.ts",
    missing: "'planning', 'acting', 'verifying'",
  },
  "symlink-escape-read": {
    path: "src/infrastructure/tools/workspace-tools.ts",
    missing: "const actual = await realpath(candidate);",
  },
  "repair-brief-evidence": {
    path: "src/application/context-manager.ts",
    missing: "Evidence: ${latest.evidence.excerpts",
  },
};
const runFile = promisify(execFile);

test("self-evaluation seeds remove each targeted safeguard", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kairo-self-seeds-"));
  try {
    await cp(join(process.cwd(), "src"), join(workspace, "src"), { recursive: true });
    for (const scenario of selfEvaluationScenarios) {
      const copy = await mkdtemp(join(tmpdir(), `kairo-${scenario.id}-`));
      try {
        await cp(join(workspace, "src"), join(copy, "src"), { recursive: true });
        await scenario.seed(copy);
        const marker = seededMarkers[scenario.id]!;
        assert.doesNotMatch(
          await readFile(join(copy, marker.path), "utf8"),
          new RegExp(marker.missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("self-evaluation hidden graders accept the correct implementation", async () => {
  for (const scenario of selfEvaluationScenarios) await scenario.verify(process.cwd());
});

test("self-evaluation hidden graders reject every seeded implementation", async () => {
  for (const scenario of selfEvaluationScenarios) {
    const workspace = await mkdtemp(join(tmpdir(), `kairo-self-broken-${scenario.id}-`));
    try {
      await Promise.all([
        cp(join(process.cwd(), "src"), join(workspace, "src"), { recursive: true }),
        symlink(join(process.cwd(), "node_modules"), join(workspace, "node_modules")),
        writeFile(
          join(workspace, "tsconfig.json"),
          `${JSON.stringify(
            {
              compilerOptions: {
                target: "ES2024",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                rootDir: "src",
                outDir: "dist",
                strict: true,
                esModuleInterop: true,
                forceConsistentCasingInFileNames: true,
                skipLibCheck: true,
                declaration: true,
              },
              include: ["src/**/*.ts"],
              exclude: ["src/**/*.test.ts"],
            },
            null,
            2,
          )}\n`,
        ),
      ]);
      await scenario.seed(workspace);
      try {
        await runFile(
          process.execPath,
          [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
          { cwd: workspace },
        );
      } catch (error) {
        throw new Error(
          `${scenario.id}: ${(error as { stdout?: string; stderr?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`,
        );
      }
      await assert.rejects(scenario.verify(workspace), () => true, scenario.id);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});
