import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, posix, relative } from "node:path";
import type { RepositoryFile, RepositoryProfile } from "../../domain/models.js";
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
const MAX_TERMS_PER_FILE = 400;
const MAX_SYMBOLS_PER_FILE = 80;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

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
    const files = await this.indexFiles(root, ignoredPaths);
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
      indexedFiles: files.map((file) => file.path),
      files: this.connectFiles(files, sourceRoots, testRoots),
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
  private async indexFiles(root: string, ignoredPaths: string[]): Promise<RepositoryFile[]> {
    const files: RepositoryFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (files.length >= MAX_INDEXED_FILES || ignoredPaths.includes(entry.name)) continue;
        const full = join(directory, entry.name);
        const path = relative(root, full);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile() && this.isUseful(path, await stat(full))) {
          const text = await this.readText(full);
          files.push({
            path,
            terms: this.terms(text),
            symbols: this.symbols(text),
            imports: this.imports(text),
            relatedFiles: [],
          });
        }
      }
    };
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
  private async readText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }
  private terms(text: string): string[] {
    return [text, text.replace(/([a-z])([A-Z])/g, "$1 $2")]
      .flatMap((part) => part.toLowerCase().split(/[^a-z0-9_$]+/))
      .filter((term) => term.length > 2)
      .filter((term, index, terms) => terms.indexOf(term) === index)
      .slice(0, MAX_TERMS_PER_FILE);
  }
  private symbols(text: string): string[] {
    return [
      ...text.matchAll(
        /(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      ),
    ]
      .map((match) => match[1]!.toLowerCase())
      .slice(0, MAX_SYMBOLS_PER_FILE);
  }
  private connectFiles(
    files: RepositoryFile[],
    sourceRoots: string[],
    testRoots: string[],
  ): RepositoryFile[] {
    const paths = new Set(files.map((file) => file.path));
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const file of files) {
      const targets = new Set<string>();
      for (const specifier of file.imports) {
        const target = this.resolveImport(file.path, specifier, paths);
        if (target) targets.add(target);
      }
      const testTarget = this.testTarget(file.path, paths, sourceRoots, testRoots);
      if (testTarget) targets.add(testTarget);
      file.relatedFiles = [...targets].sort();
    }
    for (const file of files) {
      for (const target of file.relatedFiles) {
        const targetFile = byPath.get(target);
        if (targetFile && !targetFile.relatedFiles.includes(file.path))
          targetFile.relatedFiles.push(file.path);
      }
    }
    return files.map((file) => ({ ...file, relatedFiles: file.relatedFiles.sort() }));
  }
  private imports(text: string): string[] {
    return [...text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.startsWith("."));
  }
  private resolveImport(from: string, specifier: string, paths: Set<string>): string | undefined {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const extensionless = base.replace(/\.[^.\/]+$/, "");
    return [
      base,
      extensionless,
      ...SOURCE_EXTENSIONS.map((extension) => `${extensionless}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => `${extensionless}/index${extension}`),
    ].find((candidate) => paths.has(candidate));
  }
  private testTarget(
    file: string,
    paths: Set<string>,
    sourceRoots: string[],
    testRoots: string[],
  ): string | undefined {
    if (!testRoots.some((root) => file.startsWith(`${root}/`))) return undefined;
    const name = basename(file).replace(/\.(test|spec)\.[^.]+$/, "");
    return sourceRoots
      .flatMap((root) => SOURCE_EXTENSIONS.map((extension) => `${root}/${name}${extension}`))
      .find((candidate) => paths.has(candidate));
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
