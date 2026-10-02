# Kairo

Kairo is a desktop workspace for coding agents working on local repositories. Run multiple user-managed native chat sessions, inspect their activity, and review workspace files and diffs. There is no embedded terminal UI.

## Two ways to work

- **Kairo agent:** bring an API key for Gemini, Groq, Mistral, or OpenRouter directly into Model settings. The existing Kairo runtime provides repository context, approval controls, verification, and optional Jev routing.
- **External agents:** use an installed agent's official runtime and authentication. The first native-chat adapter supports **Codex CLI**, through its official [app-server protocol](https://developers.openai.com/codex/app-server). Its CLI runs as a background service and streams responses, tool activity, and supported approvals into Kairo.

External-agent support is adapter-based. Claude Code and other agents are not integrated yet; arbitrary terminal commands are not treated as native-chat agents. Automatic delegation and coordination are planned after user-managed sessions are stable.

## Run from source

Requirements: macOS, Node.js 24.21+, pnpm, and either a provider API key or an installed, supported external agent. Kairo uses the macOS Keychain for its own provider credentials.

```bash
git clone https://github.com/thefrikidude/kairo.git
cd kairo
pnpm install
pnpm desktop:dev
```

1. Use **Open project** to select a local workspace.
2. Choose **Kairo · API key** or **Codex** in the Agent selector before sending the first message. Use **Refresh agents** after installing the CLI.
3. For Kairo, enter a provider key in Model settings. For Codex, Kairo reuses the official CLI login; if needed, **Sign in to Codex** opens its official browser authentication flow. Kairo does not import or store Codex account tokens.
4. Select a model and send a message. External models come from the agent's live catalog; **Agent default model** follows the CLI configuration. An unavailable configured default produces an error; select a model from the catalog instead.
5. Create additional chats and switch between them while tasks run. Session status appears in the sidebar. Open a waiting chat to answer its approval request.

### Codex commands

Codex chats support `/plan`, `/default`, `/model <model>`, and `/compact` through Codex's native app-server commands. `/plan`, `/default`, and `/model` can be used before the first message; Kairo saves those preferences and applies them when Codex starts the first real turn. `/compact` requires an existing Codex conversation history. Unsupported slash commands are rejected by Kairo and are not sent as prompts.

Kairo saves a Codex conversation ID after Codex accepts the first turn. If an older saved ID no longer has a Codex rollout, Kairo retries the next prompt once in a fresh Codex conversation and displays a notice. The messages remain in Kairo's transcript, but Codex cannot use the missing conversation's context.

A chat keeps its agent identity once its conversation starts. Models can change between turns; create a new chat to use another agent. Each new chat inherits the current chat's runtime choice.

Chats opened in the same project currently share its files. Review shows the workspace's changes, not per-agent ownership. Use separate folders/worktrees for isolated work; automatic worktree management is not implemented. File saves are blocked while a session is working in that workspace.

Build and preview with:

```bash
pnpm desktop:build
pnpm desktop:preview
```

Installers, signing, and release distribution are not configured yet.

## Runtime safeguards and persistence

The built-in Kairo agent retains workspace-confined file tools, symlink protection, command approvals, bounded model/tool loops, and verification/repair behavior. External agents use their own runtime safeguards. Codex uses its native collaboration mode (including Plan mode) and workspace-write sandbox, with human approval requests routed into Kairo. Kairo does not translate Codex Plan mode into its own planning workflow or launch Codex with permission or sandbox bypass flags.

The initial Codex bridge handles command and file-change approvals. Other server requests, including structured questions and additional permission grants, fail explicitly rather than being automatically approved. External-agent turn completion is not independent proof of verification: changed work is marked as requiring verification.

SQLite preserves chat history, runtime/model choices, Codex collaboration mode, and official external conversation IDs. Codex conversations resume after restarting Kairo when the saved rollout is available. Live processes are managed for the app's lifetime and are stopped on app exit; quitting does not leave a detached Kairo service running. Interrupted turns remain interrupted until the user sends another message.

## Development

```bash
pnpm check
pnpm test
```

The application is organized into domain, application, infrastructure, and desktop interface layers. The Electron renderer is isolated from Node.js and agent processes communicate over private stdio, without a network listener. Add native-chat agent adapters to the infrastructure registry by implementing discovery, official authentication, streamed turns, approvals, cancellation, and resume identity.
