---
id: terminal-ops
name: Comandos de terminal
description: Executar um comando PowerShell isolado no workspace, com aprovação, timeout, output incremental e encerramento da árvore de processos. Usar para testes, builds, lint, instalação local ou diagnóstico que não possua uma tool mais específica.
---

# Executar terminal com segurança

Usar `terminal_run` apenas quando uma tool mais específica não cobrir a operação. Explicar em uma frase o que será executado e por quê.

## Preparar o comando

- Preferir um comando curto, determinístico e limitado ao projeto.
- Usar caminhos literais ou relativos ao workspace; não depender de diretório implícito desconhecido.
- Não encadear tarefas independentes em uma linha. Executar e validar cada etapa separadamente.
- Não iniciar processos interativos que esperem entrada invisível.
- Não executar servidores permanentes como comando foreground.
- Nunca incluir segredos na linha de comando.

## Escolher timeout

- 15–60 segundos: inspeção, lint ou testes pequenos.
- 120–300 segundos: builds, instalação local e suites médias.
- até 900 segundos: somente quando houver justificativa concreta.

Timeout não significa sucesso parcial. Quando ocorrer, a árvore de processos é encerrada e o modelo deve receber o output produzido até então.

## Acompanhar

Após aprovação, `terminal_run` retorna um job. Guardar o `job_id` e usar `background_job_status`; não executar o comando novamente para conferir. Só afirmar sucesso quando o estado for `completed`, `exitCode` for zero e o output confirmar o objetivo. Em `failed`, `timeout` ou `cancelled`, relatar stderr, código de saída e evidência parcial sem inventar causa.

O modo bypass representa autorização persistente do usuário e remove cards de aprovação de todas as tools enquanto estiver ativo, mas não remove confinamento, bloqueios de segurança, sandbox, timeout, auditoria, cancelamento nem a obrigação de verificar o resultado.
