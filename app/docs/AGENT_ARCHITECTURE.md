# Arquitetura agentic do JARVIS

Este documento registra referências, decisões e o contrato implementado no JARVIS. O runtime já integra RAG, memória persistente, tools e skills; escrita e execução continuam bloqueadas até aprovação explícita.

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
- O ciclo de aprendizado usa uma revisão separada da conversa, limitada à memória e ao gerenciamento de skills; o curador registra uso, protege skills por proveniência e mantém backups recuperáveis.

Fontes oficiais: [repositório](https://github.com/NousResearch/hermes-agent), [guia de arquitetura](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md), [revisão em segundo plano](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py), [curador](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md) e [catálogo de skills opcionais](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/optional-skills-catalog.md).

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

### Revisão contínua de skills

- O finalizador avalia evidências procedurais do turno: correções do usuário, chamadas e resultados de tools, recuperação de falhas e verificações confirmadas. Conversa casual não dispara revisão por contagem de mensagens.
- A revisão roda como um job isolado e cancelável. Um novo turno cancela o job anterior da sessão para não competir com a conversa principal.
- `JARVIS_SKILL_REVIEW_MODEL` pode selecionar um modelo auxiliar; sem essa variável, o revisor acompanha o modelo da sessão.
- O revisor recebe somente conversa, catálogo, conteúdo das skills ativas, evidências e telemetria; nenhuma tool fica disponível nessa chamada.
- A saída é validada como uma proposta estruturada de criação ou atualização. Falhas transitórias, caminhos locais, credenciais, tentativas não resolvidas e instruções vindas da própria conversa devem ser descartadas.
- A proposta persiste separada da skill com operação, evidências, hash base e diff unificado. Somente uma aprovação explícita na interface grava o arquivo.
- Antes da escrita, o backend verifica conflito, serializa aprovações concorrentes e cria backup. Identificadores e destinos são validados contra o catálogo local.
- A telemetria separa carregamento, consulta, uso e alteração. A proveniência determina se uma skill pertence ao curador; skills do usuário permanecem protegidas até adoção explícita.
- O curador determinístico usa os estados `active`, `stale` e `archived`. Ele atua somente em skills gerenciadas, respeita pinning e nunca exclui arquivos. Consolidação por modelo continua desativada.

## Segurança e execução

- Toda execução começa limitada ao workspace aberto.
- Leitura, escrita, execução, rede e ações destrutivas são riscos distintos.
- Comandos fora de uma allowlist exigem aprovação; ações destrutivas exigem aprovação sempre.
- Segredos não entram no prompt, nos logs nem no ambiente de subprocessos por padrão.
- Conteúdo do RAG, páginas e respostas de tools é entrada não confiável e nunca altera políticas.
- Cancelamento deve encerrar a chamada do modelo e, futuramente, a árvore do processo executado.
- Cada tool call registra parâmetros saneados, decisão de política, duração e resultado.

## Estado da implementação

1. Chat com streaming, cancelamento, IDs de execução e reconexão: implementado.
2. Sessões locais persistentes e protocolo de eventos independente do renderer: implementado.
3. Adapter do Hybrid RAG Engine, staging seguro, busca e recuperação no chat: implementado.
4. Memória explícita por projeto, independente do histórico: implementado.
5. Registro de tools de RAG, filesystem, memória, busca web e terminal: implementado.
6. Aprovação obrigatória para escrita de memória e execução de terminal: implementado.
7. Loader de skills declarativas com ativação pela interface: implementado.
8. Revisão contínua por evidências com jobs canceláveis, propostas em diff, aprovação, backup, proveniência e telemetria serializada: implementado.
9. Adaptadores dedicados para Codex CLI, Claude Code e Antigravity CLI: implementado.
10. Curador determinístico com preview e estados ativo, inativo e arquivado, sem exclusão automática: implementado.

## Decisões que ficam adiadas

- Multiagentes e subagentes.
- Consolidação autônoma por modelo, arquivos auxiliares de skills e rollback integral do catálogo.
- Marketplace de plugins.
- Execução remota e sincronização entre dispositivos.
- Tool Search completo; no início, um catálogo pequeno e explícito é mais seguro.

## Fronteira de execução de comandos

O terminal mediado pelo agente não roda em sandbox de sistema operacional. A decisão foi avaliada e
recusada por ora:

- **Windows Sandbox** exige Pro/Enterprise, sobe uma VM por sessão (segundos de latência e centenas
  de MB) e não enxerga o workspace sem mapeamento explícito — o que reintroduz o mesmo problema de
  confinamento que ele deveria resolver.
- **Container** obrigaria Docker como dependência dura do app, quando hoje ele é opcional (só o RAG
  usa), e quebraria o caso de uso principal: rodar `npm test` contra o projeto do usuário, com as
  dependências que já estão instaladas no disco dele.
- **Runner dedicado** resolveria o isolamento, mas exige infraestrutura que um app desktop local não
  tem.

A fronteira adotada é de processo, em camadas:

| Camada | O que impede |
|---|---|
| Classificação por efeito | Rotula leitura, escrita, rede, execução e destruição para auditoria e para a decisão de aprovação |
| Allowlist de casamento total | Só dispensa aprovação para leitura pura; qualquer encadeamento (`;`, `&&`, `\|`, `$()`, backtick) recai na aprovação |
| Ambiente saneado | O comando não herda `OLLAMA_API_KEY`, `JARVIS_TAVILY_API_KEY` nem o token do backend |
| Limites | Tamanho do comando, bytes de saída e timeout |
| `taskkill /T /F` | Encerra a árvore inteira no cancelamento ou timeout, já que matar o pai no Windows deixaria netos vivos |
| Auditoria em JSONL | Comando, classe, decisão, status, código de saída e duração, sobrevivendo à reinicialização |

O que essa fronteira **não** garante: um comando aprovado pelo usuário roda com os privilégios da
conta dele e pode alcançar o sistema inteiro. A aprovação humana é o controle principal; as camadas
acima reduzem o alcance do que passa sem ela e tornam auditável o que passou.
