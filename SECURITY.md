# Security Policy

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/fareloj/jarvis-ide/security/advisories/new) rather
than opening a public issue.

Useful things to include: what an attacker can achieve, the steps to reproduce it, and which version
or commit you tested. A proof of concept helps a lot.

This is a personal project without a paid maintenance commitment, so there is no guaranteed response
window — but security reports are read and taken seriously.

## Scope

JARVIS runs an AI agent with filesystem and shell access on your machine, so the interesting attack
surface is the boundary between untrusted content and privileged operations. Reports that matter
most:

- **Sandbox escape** — a path reaching outside the open workspace through `..`, absolute paths,
  junctions or symlinks.
- **Approval bypass** — any way to write files or execute commands without the human approval step,
  or where the approved operation differs from the applied one.
- **Renderer privilege escalation** — content that becomes executable script in the renderer, which
  would reach the `window.jarvis` bridge.
- **Prompt injection with real consequences** — content in a file, web result, RAG passage or
  recalled conversation that makes the agent take a privileged action on its own.
- **Secret disclosure** — API keys, the Ollama session cookie or chat transcripts leaking into logs,
  error messages, committed files or the model context.

## Out of scope

- The model producing wrong or low-quality answers.
- Anything requiring the attacker to already control the machine or the user account.
- Vulnerabilities in Ollama, Docker or the Hybrid RAG Engine — report those upstream.
- Missing hardening with no demonstrable impact.

## Design decisions worth knowing

These are deliberate, not oversights:

- **The backend binds to localhost** on a random port inside the Electron process. It is not exposed
  to the network.
- **Reads are not gated.** Listing and reading files inside the open workspace happens without
  asking, by design. Writes, terminal execution and agent delegation always stop for approval.
- **Delegated agents run with their own permission flags relaxed** (for example
  `--permission-mode acceptEdits`). The gate is JARVIS's own approval before the delegation starts,
  not a second prompt inside the child agent.
- **Conversation memory is stored unencrypted** on disk. Credentials matching known patterns are
  redacted before writing, but that redaction is best-effort, not a guarantee.

## Supported versions

The project is in early development. Only the current `main` receives fixes.
