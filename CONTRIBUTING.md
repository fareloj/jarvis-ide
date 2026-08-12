# Contributing

Thanks for taking a look. This document covers what you need to run the project and what a change
has to satisfy before it can be merged.

## Setup

```bash
git clone https://github.com/fareloj/jarvis-ide.git
cd jarvis-ide/app
npm install
npm start
```

Requirements are **Node.js 20+** and [Ollama](https://ollama.com) running locally. The Hybrid RAG
Engine stack is optional — without it, project RAG and cross-chat memory stay off and the rest of
the app works normally.

On Windows, `app/iniciar-jarvis.bat` does the dependency check and launch for you.

## Before opening a pull request

Run both, from `app/`:

```bash
npm run check   # syntax check across main, preload, backend and renderer
npm test        # unit suite
```

CI runs exactly these two on `windows-latest` with Node 20, from a clean `npm ci`. If they pass
locally on a fresh clone, they pass there.

## What a change has to respect

This app runs an AI agent with filesystem and shell access, so a few invariants are not negotiable:

- **The renderer never gets Node.js access or credentials.** Everything crosses through the preload
  `contextBridge` with an explicit contract.
- **Untrusted input stays untrusted.** File contents, web results, RAG passages and recalled
  conversation turns are data for the model to analyse, never instructions to obey. If you add a new
  source of external content, it needs the same framing.
- **Writes and execution require human approval.** The policy lives in the tool registry, not in a
  prompt — a model cannot talk its way past it.
- **Paths stay inside the workspace**, including against `..`, absolute paths, junctions and symlinks.
- **No test may depend on Ollama, Docker or an API key.** Stub the network instead; the CI runner has
  none of them.

## Tests

The suite uses the Node built-in test runner — no framework, no mocking library. Anything touching
the network is stubbed with a `global.fetch` replacement restored in `context.after`.

New behaviour needs a test. Bug fixes need a regression test that fails before the fix.

## Commits

Conventional Commits, one logical change per commit:

```text
feat(tools): add approval-gated file patches
fix(editor): escape HTML between syntax tokens
docs(readme): correct test count
```

Do not mix unrelated refactors, visual changes and features in the same commit.

## Dependencies

The project deliberately runs on very few dependencies. Before adding one, check whether the
standard library or an existing dependency already covers it. If it is genuinely needed, say in the
pull request why, and confirm its licence and maintenance status.

## Interface

Reuse the existing palette, fonts, icons and spacing tokens from `app/src/styles.css`. Do not add
placeholder screens or controls that look functional but are not wired to a real backend.
