---
name: review-with-coding-agent
description: Revisar alterações locais, uma branch base, um commit ou um pull request usando Claude Code, Codex CLI ou Antigravity CLI sem implementar correções. Usar para code review, red team, avaliação pré-merge, investigação de regressões e validação independente de trabalho produzido por outro agente.
---

# Revisar alterações com outro agente

Usar `review_coding_changes` como operação read-only. Não pedir correções no mesmo prompt; primeiro obter e avaliar os achados.

## Escolher escopo

- `uncommitted`: staged, unstaged e arquivos novos do workspace.
- `base`: diferenças entre a branch atual e a branch informada em `target`, normalmente `main`.
- `commit`: alterações introduzidas pelo SHA informado em `target`.
- `pull-request`: PR informado em `target`; preferir Claude com `ultra: true` quando disponível.

`target` é obrigatório para `base`, `commit` e `pull-request`. Não inventar branch, SHA ou número de PR. O Codex local não aceita `pull-request` diretamente; escolher Claude/Antigravity ou mudar o escopo com autorização.

## Escolher agente

- `codex`: preferir para `uncommitted`, `base` ou `commit`, pois possui comando de review dedicado.
- `claude-code`: preferir para revisão ampla; `ultra: true` usa revisão multiagente remota e pode consumir mais tempo/quota.
- `antigravity`: usar quando o review exigir exploração por tools ou quando o usuário o escolher.

Evitar que o mesmo agente seja o único revisor do próprio trabalho quando houver outro agente disponível.

## Definir foco

Em `focus`, indicar apenas riscos adicionais relevantes. A revisão já deve priorizar bugs, segurança, perda de dados, concorrência, compatibilidade e testes. Exemplos: “processos órfãos no Windows”, “path traversal”, “idempotência após retomada”.

## Avaliar resultado

Um achado válido deve explicar impacto, condição que dispara o problema e localização verificável. Não tratar sugestões de estilo como bloqueantes. Não afirmar que o review passou só porque o processo encerrou com código zero; ler os achados. Se não houver achados, relatar que o agente não encontrou problemas no escopo, sem prometer ausência absoluta de bugs.

Depois do review, só implementar correções se o usuário tiver autorizado mudanças. Reexecutar testes e, quando apropriado, uma nova revisão independente.

