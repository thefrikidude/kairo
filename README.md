<img width="1916" height="942" alt="Screenshot 2026-10-02 at 2 30 56 PM" src="https://github.com/user-attachments/assets/ece583de-8282-499a-bd8d-4f5d1c658463" />

Kairo is a desktop workspace for coding agents working on local repositories. Run multiple user-managed native chat sessions, inspect their activity, and review workspace files and diffs. An optional workspace terminal stays hidden until needed.

## Two ways to work

- **Kairo agent:** bring an API key for Gemini, Groq, Mistral, or OpenRouter directly into Model settings. The existing Kairo runtime provides repository context, approval controls, verification, and optional Jev routing.
- **External agents:** use an installed agent's official runtime and authentication. **Codex CLI** uses its official [app-server protocol](https://developers.openai.com/codex/app-server). **OpenCode** uses `opencode acp`. These background processes stream responses, tool activity, and supported approvals into Kairo.

External-agent support is adapter-based; arbitrary terminal commands are not treated as native-chat agents. Automatic delegation and coordination are planned after user-managed sessions are stable.

## Run from source

Requirements: macOS, Git, Node.js 24.21+, pnpm, and either a provider API key or an installed, supported external agent. Kairo uses the macOS Keychain for its own provider credentials.

```bash
git clone https://github.com/thefrikidude/kairo.git
cd kairo
pnpm install
pnpm desktop:dev
```

1. Use **Open project** to select a local workspace.
2. Choose **Kairo**, **Codex**, or **OpenCode** in the Agent selector. Use **Refresh agents** after installing the CLI.
3. For Kairo, enter a provider key in Model settings. For Codex, Kairo reuses the official CLI login; if needed, **Sign in to Codex** opens its official browser authentication flow. Kairo does not import or store Codex account tokens.
4. Select a model and send a message. Codex models come from its live catalog; OpenCode currently uses its configured default model. **Agent default model** follows the CLI configuration. An unavailable configured default produces an error; select a model from the catalog instead.
5. Create additional chats and switch between them while tasks run. Session status appears in the sidebar. Open a waiting chat to answer its approval request.

### Navigate and inspect

Use the project selector above the conversation to switch projects. **New agent session** reuses the current folder and agent; project actions also include **New session in project**. Hover a chat and use its pencil button to rename it. Names survive restarts and archiving. Sidebar dots distinguish working (pulsing green), waiting or interrupted (amber), completed (green), failed (red), and idle (gray); hover a dot for its status.

**Files** opens a lazy, expandable project tree, filename search and syntax-highlighted text previews. Use **Edit** and **Save** (Cmd/Ctrl+S) for small changes. Unsaved buffers survive switching panels or chats; closing Kairo asks you to save or discard them. Saves check the loaded revision, refuse external edits instead of overwriting them, and preserve ordinary CRLF line endings. Clean-buffer caching is bounded. Binary files and files above 1 MB have an actionable error instead of a truncated preview.

**Review** lists changed files and loads only the selected patch. Switch between unified and split views, use previous/next file navigation, or open a file in the internal viewer. Git workspaces default to changes since their recorded starting commit, including commits the agent made; **Working tree** shows staged, unstaged and untracked changes. The selected chat's recorded task result and verification evidence stay available beside review. Tool activity is collapsible and includes native file links where agents report locations, plus recorded duration/exit details. Review Git commands run asynchronously without optional index refresh locks, so they can coexist with commits.

The contextual panel stays hidden until opened; drag its left edge to resize it, or focus that edge and use the arrow keys. File lists and patches render a bounded window of rows as you scroll. Syntax highlighting uses selected [highlight.js grammars](https://highlightjs.org/); OpenCode file navigation follows [ACP tool locations](https://agentclientprotocol.com/protocol/v1/tool-calls#following-the-agent).

**Terminal** opens a collapsible bottom panel in the current workspace. Tabs retain their shells across chat and project switches; hiding the panel keeps commands running. Use **+** for another tab, **×** to stop a shell and its attached child processes, and the top edge to resize the panel. Terminals are ephemeral and stop when Kairo quits. **Settings → Workspaces** can close terminals even after their chats have been deleted. Manual shell input uses a separate native PTY service; Codex and OpenCode continue using their official protocols.

Session and confirmation dialogs keep keyboard focus inside while open and return focus when closed. Workspace and terminal tabs support Left/Right and Home/End keys.

Keyboard shortcuts: **Cmd/Ctrl+Shift+E** opens Files, **Cmd/Ctrl+Shift+D** opens Changes, and **Cmd/Ctrl+Shift+B** toggles the sidebar. **Cmd/Ctrl+`** toggles Terminal. **Escape** closes the active dialog or contextual panel before cancelling a running task. Escape inside Terminal is passed to the shell.

Final UX/accessibility polish and complete-workflow/performance verification remain in progress. See [the audit and implementation plan](docs/product-workspace-plan.md).

### Codex commands

Codex chats support `/plan`, `/default`, `/model <model>`, and `/compact` through Codex's native app-server commands. `/plan`, `/default`, and `/model` can be used before the first message; Kairo saves those preferences and applies them when Codex starts the first real turn. `/compact` requires an existing Codex conversation history. Unsupported slash commands are rejected by Kairo and are not sent as prompts.

Kairo saves a Codex conversation ID after Codex accepts the first turn. If an older saved ID no longer has a Codex rollout, Kairo retries the next prompt once in a fresh Codex conversation and displays a notice. Kairo supplies bounded context from its saved transcript when the native history is unavailable.

### Switch agents in the same chat

Use the composer’s **Task agent** selector at any point. Switching during a run validates the destination, stops the current agent, waits for termination, and automatically resumes the interrupted task with the selected agent. Switching an idle chat takes effect on the next message. Models can change between turns without switching agents.

Kairo keeps the same chat, workspace, and history. It saves an expandable handoff containing the original request, recent conversation excerpts, task state, changed-file paths, and recorded verification evidence. The destination starts a fresh native session, including when switching back to an earlier agent. This is a bounded evidence handoff, not a complete copy of native context; the new agent must inspect current files and resolve missing details. Historical replies retain their author names. Checkpoints and handoff notices survive app restarts.

OpenCode requires its CLI and a configured provider (`opencode auth login`). Refresh agents after setup. Kairo checks CLI authentication status without copying credentials. OpenCode authentication currently needs terminal setup; its default model comes from CLI configuration. New chats reuse the current project and agent/model selection. Claude integration is deferred and is not shown in the agent selector.

ACP processes are owned per run and stopped after completion. If an agent advertises session loading, Kairo reloads its recorded session on the next turn; otherwise it creates a fresh session with a Kairo handoff. ACP client filesystem and terminal methods are not advertised; tools run in the agent runtime. Permission requests select an `allow_once` or `reject_once` option; Kairo does not select persistent grants. Native agent settings still govern operations that do not request client approval. Unrecognized client requests fail explicitly. Slash-command expansion for these agents is deferred.

### Isolated task workspaces

When creating a chat in a Git project, **New isolated worktree** is selected by default. Choose a branch and starting ref (HEAD, a branch, or a commit). It starts from committed files; uncommitted changes remain in the original folder. You can also choose **Use this folder** or an **Existing worktree** belonging to the same repository. Plain folders remain supported.

Each workspace owns its directory, repository identity, branch and starting commit. Chats own their agent runtime, native conversation ID and history. Worktree chats stay grouped under their parent project, with branch names in the sidebar. All native agents, file tools and review requests use the chat's associated working directory. Kairo refuses concurrent agent runs in the same Git checkout, including sibling subfolders that share its index and branch. Plain folders use directory overlap guards. Use separate worktrees for parallel tasks. File saves are blocked while agents are using that checkout.

Kairo stores managed worktrees under its state directory. **Settings → Workspaces** lists them, including workspaces whose chats were deleted. Archive all associated chats before removing a worktree. Removal refuses staged, unstaged, untracked or ignored files and task commits not merged into the primary checkout. It keeps the branch and archived conversation history. Kairo never removes a worktree when you delete a chat, and externally created worktrees cannot be removed from this screen. A removed worktree's chats stay archived and cannot resume against a different folder. Use **Settings → Archived chats → View** to read the saved conversation, last task, activity and verification result, even after the directory is gone. Viewing history does not restore the chat or change the active session.

Worktrees isolate files; they do not provide OS-level command sandboxing. Native agent safeguards and approval controls still apply. There is no automatic agent delegation.

Build and preview with:

```bash
pnpm desktop:build
pnpm desktop:preview
```

Installers, signing, and release distribution are not configured yet.

## Runtime safeguards and persistence

The built-in Kairo agent retains workspace-confined file tools, symlink protection, command approvals, bounded model/tool loops, and verification/repair behavior. External agents use their own runtime safeguards. Codex uses its native collaboration mode (including Plan mode) and workspace-write sandbox, with human approval requests routed into Kairo. Kairo does not translate Codex Plan mode into its own planning workflow or launch Codex with permission or sandbox bypass flags.

The Codex bridge handles command and file-change approvals and native structured questions. Select an option or type your own answer in the chat to continue the Codex turn; pending questions survive switching chats and clear when the turn stops. Secret answer fields are masked. Kairo forwards answers directly to Codex without appending a separate transcript message for them. Unsupported requests, including additional permission grants, fail explicitly rather than being automatically approved. External-agent turn completion is not independent proof of verification: changed work is marked as requiring verification.

The app footer shows account usage for the active chat’s agent. Codex reports remaining quota percentages and reset times through its native App Server; click the indicator to see all reported quota buckets or refresh them. Usage updates automatically and is shared across chats. Providers that do not expose limits show “Usage unavailable.”

SQLite preserves chat history, runtime/model choices, Codex collaboration mode, and official external conversation IDs. Codex conversations resume after restarting Kairo when the saved rollout is available. Live processes are managed for the app's lifetime and are stopped on app exit; quitting does not leave a detached Kairo service running. Interrupted turns remain interrupted until the user sends another message.

## Development

```bash
pnpm check
pnpm test
pnpm desktop:build
node scripts/desktop-smoke.mjs
```

The application is organized into domain, application, infrastructure, and desktop interface layers. The Electron renderer is isolated from Node.js and agent processes communicate over private stdio, without a network listener. Add native-chat agent adapters to the infrastructure registry by implementing discovery, official authentication, streamed turns, approvals, cancellation, and resume identity.

### Optional workflow and performance checks

After `pnpm build` and `pnpm desktop:build`, run `node scripts/desktop-smoke.mjs` for the Electron fixture/restart check. `KAIRO_SMOKE_LARGE=1` includes the large explorer/diff fixture.

`node scripts/native-workflow-smoke.mjs` uses your installed, authenticated Codex and OpenCode accounts for tiny local tasks in temporary isolated worktrees. It checks concurrent runs, actual file isolation, review patches and SQLite/native-history persistence. Codex uses an explicit `gpt-6-sol` selection; set `KAIRO_NATIVE_CODEX_MODEL` to another available model if needed. Temporary fixtures are removed and owned runtimes are stopped afterward.

`node scripts/desktop-benchmark.mjs` measures three fresh Electron launches with 24 workspaces and ten session switches per launch. Set `KAIRO_BENCH_OUTPUT` to retain reports, or pass another built checkout directory as its argument. Reports include summed resident memory for Electron, the Node backend and child agents; shared memory pages may be counted more than once. These local measurements are not performance guarantees. See the implementation plan for the measured checkpoint and remaining audit.
