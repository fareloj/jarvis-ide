---
name: inspect-coding-agent
description: Diagnosticar uma instalação de Claude Code, Codex CLI ou Antigravity CLI e listar versões, modelos, agentes, MCPs, plugins, features ou changelog disponíveis. Usar antes de alegar que uma capacidade está instalada, ao investigar falhas de autenticação/configuração ou ao escolher recursos suportados pela versão local.
---

# Inspecionar uma CLI de agente

Usar `inspect_coding_agent` para observação; não usar `terminal_run` para comandos de descoberta já cobertos por esta tool.

## Escolher capacidade suportada

| Capacidade | Claude Code | Codex | Antigravity |
|---|---:|---:|---:|
| `version` | sim | sim | sim |
| `doctor` | sim | sim, JSON | não |
| `models` | não | sim, experimental | sim |
| `agents` | sim, inclui background | não | sim |
| `mcp` | sim | sim, JSON | não por subcomando headless |
| `plugins` | sim | sim, JSON | sim |
| `features` | não | sim | não |
| `changelog` | não | não | sim |

Não chamar uma combinação marcada como não suportada. Se o usuário pedir algo equivalente, escolher outra capacidade ou explicar a limitação.

## Procedimento

1. Escolher `agent` e uma única `capability`.
2. Usar timeout curto: 15 segundos para versão/listas locais; 30–60 para doctor, modelos ou recursos que consultem rede.
3. Após aprovação, guardar o `job_id` e consultar o resultado se ainda estiver rodando.
4. Tratar stdout como observação da instalação atual, não como regra universal.

Não expor tokens, cookies, chaves ou variáveis de autenticação. Se um comando falhar por versão antiga, relatar a versão observada e sugerir atualização; não executar atualização automaticamente.

