import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, extname, join, posix, relative, resolve, sep } from "node:path";
import type {
  RepositoryEntry,
  RepositoryFile,
  RepositoryFileKind,
  RepositoryFingerprint,
  RepositorySnapshot,
} from "../../domain/models.js";
import { VerificationPlanner } from "../../application/verification-planner.js";

const execute = promisify(execFile);
const gitExecutable = process.platform === "darwin" ? "/usr/bin/git" : "git";
const DEFAULT_IGNORES = new Set([
  ".git",
  ".kairo",
  ".cache",
  ".next",
  ".venv",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "out",
  "venv",
]);
const SOURCE_DIRS = new Set(["src", "app", "lib", "pkg", "cmd", "internal", "crates", "packages"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const MAX_INVENTORY_ENTRIES = 20_000;
const MAX_INDEXED_FILES = 800;
const MAX_CONTROL_FILE_BYTES = 256 * 1024;
const MAX_INDEXED_FILE_BYTES = 200_000;
const MAX_TERMS_PER_FILE = 400;
const MAX_SYMBOLS_PER_FILE = 80;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "composer.json",
  "mix.exs",
  "workspace.json",
  "nx.json",
  "turbo.json",
  "lerna.json",
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "cargo.lock",
  "go.sum",
  "gemfile.lock",
  "composer.lock",
  "mix.lock",
]);
const BUILD_NAMES = new Set([
  "makefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "dockerfile",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "cmakelists.txt",
  "build",
  "build.bazel",
  "workspace",
  "jenkinsfile",
]);
const CONFIG_NAMES = new Set([
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "jest.config.js",
  "eslint.config.js",
  ".eslintrc.json",
  "tox.ini",
  "pytest.ini",
  "ruff.toml",
]);

interface Inventory {
  entries: RepositoryEntry[];
  truncated: boolean;
  git?: { root: string; branch?: string; head?: string; changedPaths: string[] };
}

export class RepositoryProfiler {
  constructor(
    private readonly limits: {
      maxInventoryEntries?: number;
      maxControlFileBytes?: number;
    } = {},
  ) {}

  /** Builds a bounded, language-neutral snapshot with optional JS/TS enrichment. */
  async profile(root: string): Promise<RepositorySnapshot> {
    const absoluteRoot = resolve(root);
    const inventory = await this.inventory(absoluteRoot);
    const [packageJson, gitignore] = await Promise.all([
      this.readPackage(absoluteRoot),
      this.readGitignore(absoluteRoot),
    ]);
    const paths = new Set(inventory.entries.map((entry) => entry.path));
    const sourceRoots = [...SOURCE_DIRS].filter((name) =>
      inventory.entries.some((entry) => entry.path.startsWith(`${name}/`)),
    );
    const testRoots = [...TEST_DIRS].filter((name) =>
      inventory.entries.some((entry) => entry.path.startsWith(`${name}/`)),
    );
    const packageManager = paths.has("pnpm-lock.yaml")
      ? "pnpm"
      : paths.has("yarn.lock")
        ? "yarn"
        : paths.has("bun.lockb") || paths.has("bun.lock")
          ? "bun"
          : paths.has("package-lock.json")
            ? "npm"
            : "unknown";
    const files = await this.indexFiles(absoluteRoot, inventory.entries);
    const snapshot: RepositorySnapshot = {
      schemaVersion: 1,
      root: absoluteRoot,
      fingerprint: this.inventoryFingerprint(inventory),
      entries: inventory.entries,
      ecosystems: this.ecosystems(paths),
      changedPaths: inventory.git?.changedPaths ?? [],
      instructionFiles: this.pathsOf(inventory.entries, "instruction"),
      documentationFiles: this.pathsOf(inventory.entries, "documentation"),
      manifestFiles: this.pathsOf(inventory.entries, "manifest"),
      ciFiles: this.pathsOf(inventory.entries, "ci"),
      buildFiles: this.pathsOf(inventory.entries, "build"),
      truncated: inventory.truncated,
      packageName: typeof packageJson?.name === "string" ? packageJson.name : undefined,
      packageManager,
      scripts: this.scripts(packageJson),
      configFiles: this.pathsOf(inventory.entries, "config"),
      sourceRoots,
      testRoots,
      ignoredPaths: [...new Set([...DEFAULT_IGNORES, ...gitignore])].sort(),
      indexedFiles: files.map((file) => file.path),
      files: this.connectFiles(files, sourceRoots, testRoots),
      verificationCandidates: [],
      createdAt: Date.now(),
    };
    snapshot.verificationCandidates = new VerificationPlanner().candidates(snapshot);
    return snapshot;
  }

  /** Computes the same deterministic identity used by a full snapshot. */
  async fingerprint(root: string): Promise<RepositoryFingerprint> {
    return this.inventoryFingerprint(await this.inventory(resolve(root)));
  }

  private async inventory(root: string): Promise<Inventory> {
    const git = await this.gitMetadata(root);
    const paths = git
      ? await this.gitPaths(root)
      : await this.walkPaths(root, new Set(await this.readGitignore(root)));
    const maxEntries = this.limits.maxInventoryEntries ?? MAX_INVENTORY_ENTRIES;
    const truncated = paths.length > maxEntries;
    const entries: RepositoryEntry[] = [];
    for (const path of paths.slice(0, maxEntries).sort()) {
      const full = resolve(root, path);
      if (full !== root && !full.startsWith(`${root}${sep}`)) continue;
      try {
        const file = await lstat(full);
        if (!file.isFile() || file.isSymbolicLink()) continue;
        const kind = this.classify(path);
        entries.push({
          path: path.split(sep).join("/"),
          kind,
          size: file.size,
          mtimeMs: Math.trunc(file.mtimeMs),
          contentHash:
            this.isControlFile(kind) &&
            file.size <= (this.limits.maxControlFileBytes ?? MAX_CONTROL_FILE_BYTES)
              ? await this.hashFile(full)
              : undefined,
        });
      } catch {
        // A concurrent edit can remove a file; the next fingerprint will observe it.
      }
    }
    return { entries, truncated, git };
  }

  private async gitMetadata(root: string): Promise<Inventory["git"] | undefined> {
    try {
      const [{ stdout: gitRoot }, head, branch, { stdout: status }] = await Promise.all([
        execute(gitExecutable, ["-C", root, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }),
        execute(gitExecutable, ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).catch(
          () => ({
            stdout: "",
          }),
        ),
        execute(gitExecutable, ["-C", root, "branch", "--show-current"], {
          encoding: "utf8",
        }).catch(() => ({ stdout: "" })),
        execute(
          gitExecutable,
          ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
          {
            encoding: "utf8",
          },
        ),
      ]);
      return {
        root: gitRoot.trim(),
        head: head.stdout.trim() || undefined,
        branch: branch.stdout.trim() || undefined,
        changedPaths: this.changedPaths(status),
      };
    } catch {
      return undefined;
    }
  }

  private async gitPaths(root: string): Promise<string[]> {
    const { stdout } = await execute(
      gitExecutable,
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  }

  private async walkPaths(root: string, ignored: Set<string>): Promise<string[]> {
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const maxEntries = this.limits.maxInventoryEntries ?? MAX_INVENTORY_ENTRIES;
      if (paths.length > maxEntries) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = relative(root, join(directory, entry.name)).split(sep).join("/");
        if (
          DEFAULT_IGNORES.has(entry.name) ||
          ignored.has(entry.name) ||
          ignored.has(path) ||
          entry.isSymbolicLink()
        )
          continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) paths.push(relative(root, full));
        if (paths.length > maxEntries) return;
      }
    };
    await visit(root);
    return paths;
  }

  private changedPaths(status: string): string[] {
    const fields = status.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.length < 4) continue;
      paths.push(field.slice(3));
      if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") index += 1;
    }
    return [...new Set(paths)].sort();
  }

  private inventoryFingerprint(inventory: Inventory): RepositoryFingerprint {
    const payload = {
      gitRoot: inventory.git?.root,
      branch: inventory.git?.branch,
      head: inventory.git?.head,
      changedPaths: inventory.git?.changedPaths,
      truncated: inventory.truncated,
      entries: inventory.entries.map(({ path, size, mtimeMs, contentHash }) => ({
        path,
        size,
        mtimeMs,
        contentHash,
      })),
    };
    return {
      value: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      kind: inventory.git ? "git" : "filesystem",
      gitRoot: inventory.git?.root,
      branch: inventory.git?.branch,
      head: inventory.git?.head,
    };
  }

  private classify(path: string): RepositoryFileKind {
    const lower = path.replaceAll("\\", "/").toLowerCase();
    const name = basename(lower);
    if (
      name === "agents.md" ||
      name === "claude.md" ||
      lower === ".github/copilot-instructions.md" ||
      lower.startsWith(".cursor/rules/")
    )
      return "instruction";
    if (MANIFEST_NAMES.has(name) || /\.(?:sln|csproj)$/.test(name)) return "manifest";
    if (
      lower.startsWith(".github/workflows/") ||
      lower === ".gitlab-ci.yml" ||
      lower === ".gitlab-ci.yaml" ||
      lower.startsWith(".circleci/")
    )
      return "ci";
    if (BUILD_NAMES.has(name) || /^dockerfile(?:\..+)?$/.test(name)) return "build";
    if (
      name.startsWith("readme") ||
      name.startsWith("contributing") ||
      name.startsWith("architecture") ||
      lower.startsWith("docs/")
    )
      return "documentation";
    if (CONFIG_NAMES.has(name) || /(?:^|\/)[^/]+\.config\.[^/]+$/.test(lower)) return "config";
    const segments = lower.split("/");
    if (
      segments.some((segment) => TEST_DIRS.has(segment)) ||
      /(?:^|[._-])(test|spec)\.[^.]+$/.test(name)
    )
      return "test";
    if (
      segments.some((segment) => SOURCE_DIRS.has(segment)) ||
      SOURCE_FILE_EXTENSIONS.has(extname(name))
    )
      return "source";
    return "other";
  }

  private ecosystems(paths: Set<string>): string[] {
    const detected = new Set<string>();
    const has = (...names: string[]) => names.some((name) => paths.has(name));
    if (has("package.json")) detected.add("node");
    if (has("pyproject.toml", "requirements.txt", "setup.py")) detected.add("python");
    if (has("go.mod")) detected.add("go");
    if (has("Cargo.toml")) detected.add("rust");
    if (has("pom.xml", "build.gradle", "build.gradle.kts")) detected.add("jvm");
    if (has("Gemfile")) detected.add("ruby");
    if (has("composer.json")) detected.add("php");
    if (has("mix.exs")) detected.add("elixir");
    if ([...paths].some((path) => /\.(?:sln|csproj)$/.test(path))) detected.add("dotnet");
    return [...detected].sort();
  }

  private pathsOf(entries: RepositoryEntry[], kind: RepositoryFileKind): string[] {
    return entries.filter((entry) => entry.kind === kind).map((entry) => entry.path);
  }

  private isControlFile(kind: RepositoryFileKind): boolean {
    return kind === "instruction" || kind === "manifest" || kind === "ci" || kind === "build";
  }

  private async hashFile(path: string): Promise<string> {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
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

  private async indexFiles(root: string, entries: RepositoryEntry[]): Promise<RepositoryFile[]> {
    const files: RepositoryFile[] = [];
    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES || !this.isUseful(entry)) continue;
      const text = await this.readText(join(root, entry.path));
      if (!text) continue;
      const isJavaScript = SOURCE_EXTENSIONS.includes(extname(entry.path));
      files.push({
        path: entry.path,
        terms: this.terms(text),
        symbols: isJavaScript ? this.symbols(text) : [],
        imports: isJavaScript ? this.imports(text) : [],
        relatedFiles: [],
      });
    }
    return files;
  }

  private async readText(path: string): Promise<string> {
    try {
      const content = await readFile(path);
      if (content.subarray(0, 8_000).includes(0)) return "";
      return content.toString("utf8");
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

  private isUseful(entry: RepositoryEntry): boolean {
    return (
      entry.size <= MAX_INDEXED_FILE_BYTES &&
      !LOCKFILE_NAMES.has(basename(entry.path).toLowerCase()) &&
      !/(\.min\.js|\.map|\.lock)$/i.test(entry.path)
    );
  }
}
