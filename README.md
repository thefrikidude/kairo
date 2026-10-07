<img width="1916" height="942" alt="Screenshot 2026-10-02 at 2 30 56 PM" src="https://github.com/user-attachments/assets/ece583de-8282-499a-bd8d-4f5d1c658463" />


Kairo is a desktop workspace for coding agents working on local repositories. Run multiple user-managed native chat sessions, inspect their activity, and review workspace files and diffs. There is no embedded terminal UI.


## Two ways to work

- **Kairo agent:** bring an API key for Gemini, Groq, Mistral, or OpenRouter directly into Model settings. The existing Kairo runtime provides repository context, approval controls, verification, and optional Jev routing.
- **External agents:** use an installed agent's official runtime and authentication. **Codex CLI** uses its official [app-server protocol](https://developers.openai.com/codex/app-server). **OpenCode** uses `opencode acp`. These background processes stream responses, tool activity, and supported approvals into Kairo.

External-agent support is adapter-based; arbitrary terminal commands are not treated as native-chat agents. Automatic delegation and coordination are planned after user-managed sessions are stable.

## Run from source

Requirements: macOS, Node.js 24.21+, pnpm, and either a provider API key or an installed, supported external agent. Kairo uses the macOS Keychain for its own provider credentials.

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

### Codex commands

Codex chats support `/plan`, `/default`, `/model <model>`, and `/compact` through Codex's native app-server commands. `/plan`, `/default`, and `/model` can be used before the first message; Kairo saves those preferences and applies them when Codex starts the first real turn. `/compact` requires an existing Codex conversation history. Unsupported slash commands are rejected by Kairo and are not sent as prompts.

Kairo saves a Codex conversation ID after Codex accepts the first turn. If an older saved ID no longer has a Codex rollout, Kairo retries the next prompt once in a fresh Codex conversation and displays a notice. Kairo supplies bounded context from its saved transcript when the native history is unavailable.

### Switch agents in the same chat

Use the composer’s **Task agent** selector at any point. Switching during a run validates the destination, stops the current agent, waits for termination, and automatically resumes the interrupted task with the selected agent. Switching an idle chat takes effect on the next message. Models can change between turns without switching agents.

Kairo keeps the same chat, workspace, and history. It saves an expandable handoff containing the original request, recent conversation excerpts, task state, changed-file paths, and recorded verification evidence. The destination starts a fresh native session, including when switching back to an earlier agent. This is a bounded evidence handoff, not a complete copy of native context; the new agent must inspect current files and resolve missing details. Historical replies retain their author names. Checkpoints and handoff notices survive app restarts.

OpenCode requires its CLI and a configured provider (`opencode auth login`). Refresh agents after setup. Kairo checks CLI authentication status without copying credentials. OpenCode authentication currently needs terminal setup; its default model comes from CLI configuration. OpenCode is preselected for new chats when it is installed and authenticated. Claude integration is deferred and is not shown in the agent selector.

ACP processes are owned per run and stopped after completion. If an agent advertises session loading, Kairo reloads its recorded session on the next turn; otherwise it creates a fresh session with a Kairo handoff. ACP client filesystem and terminal methods are not advertised; tools run in the agent runtime. Permission requests select an `allow_once` or `reject_once` option; Kairo does not select persistent grants. Native agent settings still govern operations that do not request client approval. Unrecognized client requests fail explicitly. Slash-command expansion for these agents is deferred.

Chats opened in the same project currently share its files. Review shows the workspace's changes, not per-agent ownership. Use separate folders/worktrees for isolated work; automatic worktree management is not implemented. File saves are blocked while a session is working in that workspace.

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
```

The application is organized into domain, application, infrastructure, and desktop interface layers. The Electron renderer is isolated from Node.js and agent processes communicate over private stdio, without a network listener. Add native-chat agent adapters to the infrastructure registry by implementing discovery, official authentication, streamed turns, approvals, cancellation, and resume identity.
