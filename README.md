# Kairo

Kairo is a desktop coding agent for local repositories. It helps you inspect a project, plan or implement changes, review edits, and verify the result.

The desktop app combines a local workspace, a bounded agent loop, approval controls, resumable conversations, and an integrated file and diff review surface.

## What it does

- Opens local project folders and keeps separate resumable chats for each workspace.
- Builds a language-neutral repository snapshot and selects relevant files for each model request.
- Reads and searches inside the workspace; agent edits and shell commands follow Kairo's configured approval rules.
- Recommends project checks after changes and records whether the latest eligible verification passed.
- Shows task progress, tool activity, approval requests, changed files, and working-tree diffs.
- Supports Gemini, Groq, Mistral, and OpenRouter, with optional Jev safety and model routing.

## Agent safeguards

Kairo confines file tools to the opened workspace and rejects symlink escapes. Shell commands run from the workspace and require approval. Agent loops, tool calls, retries, and verification repairs are bounded. Kairo does not treat a model's completion message as proof that a task passed; changed work must have successful verification evidence.

Repository snapshots store derived metadata rather than source contents. Session conversations and tool results are persisted in the local SQLite state store so chats can be resumed. Task traces retain operation metadata for review.

## Run the desktop app from source

Requirements: macOS, Node.js 24.21+, pnpm, and a provider API key. The current desktop app uses the macOS Keychain for credentials and is run from the project checkout.

```bash
git clone https://github.com/thefrikidude/kairo.git
cd kairo
pnpm install
pnpm desktop:dev
```

Use **Open project** to select a workspace, then add a provider key in Model settings. Kairo validates the key and stores it in the macOS Keychain.

Build and preview the local desktop bundle with:

```bash
pnpm desktop:build
pnpm desktop:preview
```

Installers, signing, and release distribution are not configured yet.

## Development

```bash
pnpm check
pnpm test
```

The application is organized into domain, application, infrastructure, and desktop interface layers. The Electron renderer is isolated from Node.js; this does not add an OS-level sandbox for approved shell commands.

## Direction

1. Keep the single-agent loop dependable with stronger recovery, verification, and useful traces.
2. Add evidence-backed verification adapters for more languages and ecosystems.
3. Improve the desktop workspace for efficient file review and human steering.
4. Expand realistic repository evaluations and measure reliability, cost, and latency.
