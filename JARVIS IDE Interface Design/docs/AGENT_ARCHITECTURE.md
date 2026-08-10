# Arquitetura agentic do JARVIS

Este documento registra referências e decisões para as próximas fases do JARVIS. O MVP atual continua sendo apenas um chatbot; terminal, RAG, tools e skills permanecem desativados até que seus contratos e limites de segurança existam.

## Referências estudadas

### OpenClaw

- Usa um Gateway local e duradouro como plano de controle para sessões, tools, eventos e clientes.
- Separa requests, responses e eventos de streaming com IDs de execução.
- Mantém runtime, transporte de modelos, sessões e definições de tools em módulos distintos.
- Skills são instruções Markdown com precedência e escopo; allowlist de skill não substitui sandbox nem política de execução.
- Catálogos grandes de tools são pesquisáveis e carregados sob demanda, evitando enviar todos os schemas ao modelo.
- Execuções sensíveis continuam passando por política, aprovação, hooks e logs, mesmo quando a tool foi descoberta dinamicamente.

Fontes oficiais: [repositório](https://github.com/openclaw/openclaw), [arquitetura do Gateway](https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md), [runtime](https://github.com/openclaw/openclaw/blob/main/docs/agent-runtime-architecture.md), [skills](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md) e [Tool Search](https://github.com/openclaw/openclaw/blob/main/docs/tools/tool-search.md).

### Hermes Agent

- Executa o mesmo núcleo em CLI, gateway, TUI e Electron, sem colocar lógica agentic dentro de cada interface.
- Trata o core como uma “cintura estreita”: capacidades novas devem preferir comando + skill, plugin ou MCP antes de virar tool central.
- Mantém o prompt da conversa estável para preservar cache e previsibilidade.
- Diferencia configuração comum de credenciais e recomenda validação ponta a ponta nos limites de segurança.
- Skills pesadas ou específicas são opcionais, reduzindo ruído e ambiguidade para o modelo.

Fontes oficiais: [repositório](https://github.com/NousResearch/hermes-agent), [guia de arquitetura](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md) e [catálogo de skills opcionais](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/optional-skills-catalog.md).

### Muse Code

O nome é ambíguo nas fontes públicas encontradas. Há material recente sobre um agente de código da Meta, mas não foi identificado um repositório oficial aberto com a implementação do harness. Há também um projeto independente chamado Muse voltado a versionamento semântico, que não deve ser confundido com o agente da Meta.

Do material oficial da Meta sobre Muse Spark, são relevantes: planejamento, condicionamento por objetivo, delegação, compactação de contexto, uso de scripts quando automação é mais eficiente e validação visual do resultado. Esses conceitos serão tratados como princípios de produto, não como arquitetura copiada de um repositório indisponível.

Fonte oficial disponível: [Muse Spark 1.1](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/).

## Arquitetura proposta

```text
Electron Renderer
  └─ API segura do preload
      └─ JARVIS Gateway (processo principal/local)
          ├─ Session Manager
          ├─ Model Provider (Ollama inicialmente)
          ├─ Agent Runtime
          │   ├─ Context Builder
          │   ├─ Tool Registry + Policy
          │   ├─ Approval Queue
          │   └─ Event Stream
          ├─ Project Index Adapter (Hybrid RAG Engine)
          └─ Execution Adapters
              ├─ terminal local/sandbox
              ├─ Codex CLI
              ├─ Claude Code
              └─ Antigravity CLI
```

O renderer nunca acessa diretamente shell, filesystem, credenciais ou Ollama. Ele envia comandos tipados ao Gateway e recebe eventos tipados. O Gateway é o único ponto que conhece sessões, políticas, cancelamento e auditoria.

## Contratos mínimos

Cada execução recebe um `runId`. Os eventos devem usar um envelope estável:

```json
{
  "runId": "uuid",
  "type": "message.delta | message.done | tool.requested | tool.running | tool.result | approval.required | run.failed | run.cancelled",
  "timestamp": "ISO-8601",
  "payload": {}
}
```

Uma tool deve declarar ao menos:

```json
{
  "name": "terminal.exec",
  "description": "Executa um comando aprovado no workspace.",
  "inputSchema": {},
  "risk": "read | write | execute | network | destructive",
  "approval": "never | policy | always",
  "scope": ["workspace"],
  "timeoutMs": 30000
}
```

## Skills

- Formato inicial: diretório com `SKILL.md` e frontmatter.
- Escopos: bundled, usuário e workspace; workspace tem maior precedência.
- O índice mostra apenas nome e descrição. O conteúdo completo é carregado quando a skill for selecionada.
- A skill ensina um procedimento, mas não concede acesso. Tools, sandbox e aprovação continuam sendo controles independentes.
- Skills de terceiros devem exibir origem, versão, permissões esperadas e arquivos executáveis antes da instalação.
- A primeira versão não deve permitir código executável dentro da skill; scripts só entram depois de existir isolamento e revisão explícita.

## Segurança e execução

- Toda execução começa limitada ao workspace aberto.
- Leitura, escrita, execução, rede e ações destrutivas são riscos distintos.
- Comandos fora de uma allowlist exigem aprovação; ações destrutivas exigem aprovação sempre.
- Segredos não entram no prompt, nos logs nem no ambiente de subprocessos por padrão.
- Conteúdo do RAG, páginas e respostas de tools é entrada não confiável e nunca altera políticas.
- Cancelamento deve encerrar a chamada do modelo e, futuramente, a árvore do processo executado.
- Cada tool call registra parâmetros saneados, decisão de política, duração e resultado.

## Sequência de implementação

1. Chat com streaming, cancelamento, IDs de execução e reconexão.
2. Sessões persistentes e protocolo de eventos independente do renderer.
3. Registro de tools somente leitura (`project.list`, `project.read`, `search`).
4. Aprovação e auditoria antes de qualquer escrita ou terminal.
5. Terminal isolado e adaptadores de CLI.
6. Integração do Hybrid RAG Engine por adapter, sem acoplá-lo ao loop do agente.
7. Loader de skills com escopo, precedência e carregamento progressivo.

## Decisões que ficam adiadas

- Multiagentes e subagentes.
- Skills auto-geradas ou auto-modificáveis.
- Marketplace de plugins.
- Execução remota e sincronização entre dispositivos.
- Tool Search completo; no início, um catálogo pequeno e explícito é mais seguro.
