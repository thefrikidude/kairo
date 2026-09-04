import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { RepositoryProfile } from "../../domain/models.js";
import { VerificationPlanner } from "../../application/verification-planner.js";

const DEFAULT_IGNORES = [".git", "node_modules", "dist", "build", "coverage", ".next", ".kairo"];
const SOURCE_DIRS = ["src", "app", "lib", "packages"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec"];
const CONFIG_FILES = [
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "jest.config.js",
  "eslint.config.js",
  ".eslintrc.json",
];
const MAX_INDEXED_FILES = 800;

export class RepositoryProfiler {
  async profile(root: string): Promise<RepositoryProfile> {
    const [packageJson, gitignore] = await Promise.all([
      this.readPackage(root),
      this.readGitignore(root),
    ]);
    const ignoredPaths = [...new Set([...DEFAULT_IGNORES, ...gitignore])];
    const entries = await readdir(root, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    const sourceRoots = SOURCE_DIRS.filter((name) => names.has(name));
    const testRoots = TEST_DIRS.filter((name) => names.has(name));
    const configFiles = CONFIG_FILES.filter((name) => names.has(name));
    const packageManager = names.has("pnpm-lock.yaml")
      ? "pnpm"
      : names.has("yarn.lock")
        ? "yarn"
        : names.has("bun.lockb") || names.has("bun.lock")
          ? "bun"
          : names.has("package-lock.json")
            ? "npm"
            : "unknown";
    const indexedFiles = await this.indexFiles(root, ignoredPaths);
    const scripts = this.scripts(packageJson);
    const profile: RepositoryProfile = {
      root,
      packageName: typeof packageJson?.name === "string" ? packageJson.name : undefined,
      packageManager,
      scripts,
      configFiles,
      sourceRoots,
      testRoots,
      ignoredPaths,
      indexedFiles,
      verificationCandidates: [],
      createdAt: Date.now(),
    };
    return { ...profile, verificationCandidates: new VerificationPlanner().candidates(profile) };
  }

  private async readPackage(root: string): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async readGitignore(root: string): Promise<string[]> {
    try {
      return (await readFile(join(root, ".gitignore"), "utf8"))
        .split("\n")
        .map((line) => line.trim().replace(/\/$/, ""))
        .filter(
          (line) => line && !line.startsWith("#") && !line.includes("*") && !line.startsWith("!"),
        );
    } catch {
      return [];
    }
  }
  private scripts(packageJson: Record<string, unknown> | undefined): Record<string, string> {
    const scripts = packageJson?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  private async indexFiles(root: string, ignoredPaths: string[]): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (files.length >= MAX_INDEXED_FILES || ignoredPaths.includes(entry.name)) continue;
        const full = join(directory, entry.name);
        const path = relative(root, full);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile() && this.isUseful(path, await stat(full))) files.push(path);
      }
    };
    await visit(root);
    return files.sort();
  }
  private isUseful(path: string, file: { size: number }): boolean {
    return (
      file.size <= 200_000 &&
      !/(\.min\.js|\.map|\.lock|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/i.test(
        basename(path),
      )
    );
  }
}
