## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves. -->

## How it was verified

<!-- Commands run and their result. Manual checks, if the change touches Electron,
     the filesystem, the terminal or Git. -->

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] Manually exercised the affected flow

## Boundaries

<!-- Delete what does not apply. -->

- [ ] Does not give the renderer Node.js access or credentials
- [ ] Untrusted content (files, web, RAG, memory) stays framed as data, not instructions
- [ ] Writes and command execution still require approval
- [ ] Paths stay confined to the workspace
- [ ] No test depends on Ollama, Docker or an API key
- [ ] No new dependency, or the pull request explains why it is needed
