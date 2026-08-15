---
name: continue-coding-agent
description: Retomar uma conversa concluída ou interrompida do Claude Code, Codex CLI ou Antigravity CLI preservando seu contexto nativo. Usar quando houver um session_id, thread_id ou conversation_id válido e for necessário corrigir, complementar ou prosseguir o trabalho; não usar para acompanhar um processo ainda em execução.
---

# Continuar uma sessão de agente

Usar `continue_coding_task` somente depois deste protocolo.

## Distinguir job de sessão

- `job_id` identifica o processo controlado pelo JARVIS. Usar em `background_job_status` ou `cancel_background_job`.
- `session_id` da tool representa o identificador nativo da CLI: `conversation_id` do Antigravity, `thread_id` do Codex ou `session_id` do Claude.

Nunca passar um `job_id` como `session_id`. Nunca continuar uma sessão enquanto o job original estiver `starting` ou `running`; consultar o job primeiro.

## Pré-condições

1. Confirmar qual agente criou a sessão.
2. Obter o ID nativo do resultado ou do campo `externalId` do job.
3. Confirmar que o job anterior terminou, falhou, expirou ou foi cancelado.
4. Formular apenas o delta: correção solicitada, próximo passo ou nova evidência. Não reenviar toda a tarefa sem necessidade.

Se o ID estiver ausente, não adivinhar. Iniciar nova delegação apenas com autorização explícita e explicar que o contexto nativo não poderá ser recuperado.

## Preencher a tool

- `agent`: usar o mesmo agente da sessão original.
- `session_id`: copiar exatamente o ID nativo, sem prefixos do JARVIS.
- `prompt`: indicar o que mudou, o que falta e como validar.
- `mode`: usar `plan` para análise sem edição e `edit` para continuar implementando.
- `effort`: omitir quando não for conhecido. No Antigravity, não usar `medium`; escolher `low` ou `high` apenas quando necessário. Manter `model` anterior quando conhecido e usar 1800 segundos como timeout padrão.

## Interpretar o retorno

A continuação cria um novo `job_id`, mas preserva o ID de sessão da CLI. Acompanhar o novo job normalmente. Considerar sucesso somente quando o job terminar e o resultado responder à instrução nova. Se a CLI disser que a sessão não existe ou pertence a outro workspace, não repetir em loop: informar a incompatibilidade e pedir autorização antes de começar uma sessão nova.

