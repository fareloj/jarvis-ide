# Skills

Markdown instruction files loaded per conversation. Each lives in its own folder as `SKILL.md`,
with YAML frontmatter (`id`, `name`, `description`) followed by the instruction body.

## Provenance

**Part of this project** (MIT, same as the rest of the repo):

| Skill | Purpose |
|---|---|
| `rag-research` | Retrieve project evidence before answering |
| `project-memory` | Consult persistent project decisions |
| `web-research` | Search the web, treat results as untrusted |
| `code-explorer` | Read real files before describing code |
| `terminal-ops` | Run commands with protected or user-enabled bypass mode |

**Imported from a third party** — the remaining 22 skills come from
[tiagopgr/skills-ia](https://github.com/tiagopgr/skills-ia) (category *Código*), converted to this
project's `SKILL.md` format. They keep the original `**Tags:**` footer, which is how you can tell
them apart.

> [!IMPORTANT]
> At the time of import, `tiagopgr/skills-ia` had **no license file**, which under default copyright
> means no redistribution rights were granted. The MIT license of this repository covers the code
> and the five skills listed above — it does **not** extend to the imported files, which remain the
> work of their original author.
>
> If you are packaging or forking this project, either drop those 22 folders or check the upstream
> repository for a license added after the fact.

## Writing a skill

```markdown
---
id: my-skill
name: Human readable name
description: One line, shown in Settings.
---
Instructions for the model. Written as guidance, not as rigid script.
```

Drop it in `app/skills/<id>/SKILL.md` and it appears in Settings on the next launch. Active skills
are injected as system context; inactive ones cost nothing.
