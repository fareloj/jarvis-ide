---
name: delegate-coding-agent
description: Delegar uma tarefa de engenharia para Claude Code, Codex CLI ou Antigravity CLI com workspace, modo, esforço e timeout explícitos. Usar quando a tarefa exigir exploração e alteração de múltiplos arquivos, execução de testes ou um agente dedicado; não usar apenas para consultar progresso, ler um arquivo ou executar um único comando de terminal.
---

# Delegar uma tarefa de código

Usar `delegate_coding_task` somente depois de cumprir este protocolo.

## 1. Confirmar que delegação é adequada

Delegar quando houver uma tarefa autocontida que justifique outro agente: implementação multi-arquivo, refatoração, investigação com testes ou produção de um plano técnico. Não delegar para:

- perguntar como está um job: usar `background_job_status` com o `job_id` existente;
- continuar uma sessão concluída: usar `continue_coding_task` com o ID nativo;
- fazer revisão sem alterações: usar `review_coding_changes`;
- rodar um comando isolado: usar `terminal_run`.

Nunca iniciar uma segunda delegação para conferir a primeira.

## 2. Escolher o agente

- `antigravity`: preferir para tarefas autônomas longas, navegação, uso intensivo de tools e acompanhamento detalhado por eventos.
- `codex`: preferir para alterações de código focadas, execução de testes e trabalho disciplinado dentro do workspace.
- `claude-code`: preferir para refatorações amplas, arquitetura, análise contextual longa ou uso posterior de revisão especializada.

Se o usuário escolher o agente, respeitar a escolha. Não alegar capacidades que não foram observadas no output.

## 3. Construir um prompt autocontido

Incluir, nesta ordem:

1. objetivo verificável;
2. requisitos funcionais e restrições;
3. arquivos ou áreas relevantes, quando conhecidos;
4. comandos de teste, lint ou build esperados;
5. critérios objetivos de conclusão;
6. proibição de inventar resultados de testes.

Não mandar frases vagas como “faça funcionar” ou “termine o projeto”. Não pedir que o agente trabalhe fora do projeto; o backend acrescenta e protege o workspace.

## 4. Preencher a tool

- `agent`: usar exatamente `antigravity`, `codex` ou `claude-code`.
- `prompt`: enviar o briefing autocontido.
- `mode`: usar `plan` quando nenhuma edição for autorizada; usar `edit` para implementação.
- `effort`: usar `low` em tarefas mecânicas, `medium` por padrão e `high` para arquitetura, bugs difíceis ou revisão crítica.
- `model`: omitir para usar a configuração da CLI; informar apenas se o usuário ou a tarefa exigir um modelo específico.
- `timeout_seconds`: usar 300–900 para tarefas pequenas, 1800 por padrão e até 3600 para tarefas grandes.

## 5. Interpretar o retorno

Após aprovação, a tool deve retornar imediatamente um job com `id`, `status`, `processId`, `workspace` e, quando a CLI emitir, `externalId`.

- Só afirmar “iniciou” depois de receber `job.id` e estado `starting` ou `running`.
- Guardar o `job.id`; ele controla o processo atual.
- Guardar `externalId`; ele identifica a conversa nativa que poderá ser retomada depois.
- Não afirmar conclusão enquanto o job estiver `starting` ou `running`.
- Consultar progresso com `background_job_status`, sem duplicar a delegação.

Conclusão válida exige estado final e output real. Se terminar sem ID nativo, registrar essa limitação e não inventar um ID. Se houver timeout, cancelamento ou falha, informar o estado e a saída parcial; não declarar que os arquivos estão corretos sem verificá-los.

