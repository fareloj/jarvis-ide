# Roteiro de execução do JARVIS

Este documento transforma as pendências do projeto em tarefas sequenciais. A regra é simples: **execute somente uma tarefa por vez**. A próxima tarefa só começa depois que a atual cumprir todos os critérios de aceite, passar nos testes e receber um commit próprio.

## Divisão de responsabilidade

O trabalho foi dividido em duas fases sequenciais para impedir que Codex e Claude Code editem a mesma base simultaneamente:

- **Fase A — Claude Code:** tarefas 0 a 6, trabalhando exclusivamente na branch `claude/foundation-phase`.
- **Gate de integração — Codex:** revisão completa dos commits do Claude, execução dos testes, correções necessárias e merge validado na `main`.
- **Fase B — Codex:** tarefas 7 a 14, iniciadas somente depois que a Fase A estiver integrada e estável.

O Claude não deve trabalhar diretamente na `main`, fazer push, abrir PR ou realizar o merge final. O Codex é responsável por validar a entrega completa da Fase A e integrá-la. O prompt operacional do Claude está em [`CLAUDE_CODE_FOUNDATION_PROMPT.md`](CLAUDE_CODE_FOUNDATION_PROMPT.md).

## Protocolo de trabalho

Para cada tarefa:

1. Leia o objetivo, o escopo e os critérios de aceite.
2. Marque a tarefa como `EM ANDAMENTO` na tabela de progresso.
3. Implemente apenas o que pertence à tarefa atual.
4. Execute os testes indicados e faça uma verificação manual proporcional ao risco.
5. Atualize a documentação afetada.
6. Registre decisões ou limitações no diário de execução.
7. Crie um commit técnico e marque a tarefa como `CONCLUÍDA`.
8. Só então avance para a tarefa seguinte.

Além disso, cada agente deve permanecer na branch atribuída à sua fase. Um commit deve representar uma tarefa ou uma correção coesa e nunca misturar duas tarefas do roadmap.

Não misture refatorações oportunistas, mudanças visuais e funcionalidades não relacionadas. Se surgir um problema fora do escopo, registre-o em “Pendências descobertas” e continue a tarefa atual.

## Estado geral

| Ordem | Tarefa | Responsável | Fase | Estado | Dependência |
|---:|---|---|---|---|---|
| 0 | Unificar o histórico Git | Claude Code | A | CONCLUÍDA | — |
| 1 | Estabelecer CI e baseline do repositório | Claude Code | A | CONCLUÍDA | 0 |
| 2 | Autenticar o backend local | Claude Code | A | CONCLUÍDA | 1 |
| 3 | Criar escrita e patch estruturados | Claude Code | A | CONCLUÍDA | 2 |
| 4 | Endurecer terminal e execução de processos | Claude Code | A | PENDENTE | 3 |
| 5 | Transformar o visualizador em editor | Claude Code | A | PENDENTE | 3–4 |
| 6 | Implementar integração Git e Diff | Claude Code | A | PENDENTE | 5 |
| Gate | Revisar e integrar a Fase A na `main` | Codex | Integração | PENDENTE | 0–6 |
| 7 | Implementar terminal interativo PTY | Codex | B | PENDENTE | Gate |
| 8 | Implementar Problems e busca global | Codex | B | PENDENTE | 7 |
| 9 | Robustecer o runtime agentic | Codex | B | PENDENTE | 7–8 |
| 10 | Completar o sistema de skills | Codex | B | PENDENTE | 9 |
| 11 | Melhorar ciclo de vida do RAG | Codex | B | PENDENTE | 9 |
| 12 | Completar gerenciamento de memória | Codex | B | PENDENTE | 11 |
| 13 | Criar testes end-to-end do Electron | Codex | B | PENDENTE | 7–12 |
| 14 | Empacotar e publicar o aplicativo | Codex | B | PENDENTE | 13 |

Estados permitidos: `PENDENTE`, `EM ANDAMENTO`, `BLOQUEADA` e `CONCLUÍDA`.

---

## Fase A — Claude Code

O Claude executa as tarefas 0–6 em ordem, na branch `claude/foundation-phase`. Ao concluir a Tarefa 6, deve parar e entregar o relatório solicitado no prompt operacional. Ele não inicia tarefas da Fase B.

## Tarefa 0 — Unificar o histórico Git

### Objetivo

Produzir uma branch que preserve a correção do README remoto, a edição de mensagens local e a arquitetura de revisão contínua de skills.

### Escopo

- Inspecionar `origin/main`, `main` local e `c/continuous-skill-review`.
- Incorporar o commit remoto `4b706dc` sem perder `7673b5b`, `9778a52` e `b770a9b`.
- Resolver conflitos de README, `package.json`, interface e documentação.
- Manter a branch de origem recuperável até a validação final.
- Publicar por PR ou integrar à `main` somente após autorização explícita.

### Critérios de aceite

- [x] Os quatro commits ou seus efeitos estão presentes na branch integrada.
- [x] `npm run check` passa.
- [x] Os 60 testes da versão com curadoria passam.
- [x] Edição de mensagem continua preservando versões.
- [x] Revisão contínua continua exigindo aprovação.
- [x] O Git não mostra arquivos não rastreados ou alterações acidentais.

---

## Tarefa 1 — Estabelecer CI e baseline do repositório

### Objetivo

Fazer cada alteração futura passar por uma verificação automática reproduzível.

### Escopo

- Criar GitHub Actions para Windows com Node.js 20.
- Executar instalação limpa, syntax check e testes.
- Adicionar cobertura básica sem tornar o build dependente de serviços externos.
- Corrigir no README o número real de testes.
- Adicionar `CONTRIBUTING.md`, `SECURITY.md` e templates mínimos de issue/PR.

### Critérios de aceite

- [x] Workflow executa em push e pull request.
- [x] O workflow passa em uma cópia limpa do repositório.
- [x] Nenhum teste exige Ollama, Docker ou chave externa.
- [x] README e badges refletem o estado real.
- [x] Falha de teste impede a aprovação do workflow.

---

## Tarefa 2 — Autenticar o backend local

### Objetivo

Impedir que outro processo local chame as rotas privadas do JARVIS apenas descobrindo a porta.

### Escopo

- Gerar um token efêmero e criptograficamente aleatório ao iniciar o Electron.
- Entregar o token ao backend sem expô-lo ao conteúdo do chat.
- Exigir autenticação em todas as rotas, exceto um health check mínimo se necessário.
- Restringir origem, método, tamanho de payload e cabeçalhos.
- Redigir o token de logs e mensagens de erro.

### Critérios de aceite

- [x] Requisição sem token recebe `401` ou `403`.
- [x] Requisição autenticada pelo processo principal funciona.
- [x] O renderer não consegue ler segredos não previstos pelo preload.
- [x] Existe teste de acesso autorizado, não autorizado e token inválido.
- [x] O token muda a cada inicialização.

---

## Tarefa 3 — Criar escrita e patch estruturados

### Objetivo

Permitir que o agente altere arquivos sem depender de PowerShell ou de um CLI externo.

### Escopo

- Criar `project_write_file` e `project_apply_patch`.
- Confinar todos os caminhos ao workspace aberto.
- Exigir aprovação para escrita.
- Mostrar diff antes da aprovação.
- Usar hash base para detectar edição concorrente.
- Criar backup recuperável ou operação de desfazer.
- Limitar tamanho, extensões e quantidade de arquivos por operação.

### Critérios de aceite

- [x] Path traversal e links simbólicos para fora são recusados.
- [x] Nenhum arquivo muda antes da aprovação.
- [x] Alteração concorrente gera conflito em vez de sobrescrita.
- [x] Diff exibido corresponde exatamente ao conteúdo aplicado.
- [x] Criar, atualizar, recusar e desfazer possuem testes.

---

## Tarefa 4 — Endurecer terminal e execução de processos

### Objetivo

Substituir “PowerShell iniciado no workspace” por uma fronteira de execução verificável.

### Escopo

- Classificar comandos por leitura, escrita, rede, execução e destruição.
- Adicionar política/allowlist para operações de baixo risco.
- Exigir aprovação específica para ações sensíveis.
- Limitar filesystem, ambiente, duração, saída e processos filhos.
- Encerrar a árvore de processos no cancelamento ou timeout.
- Persistir auditoria saneada: comando, decisão, duração, status e código de saída.
- Avaliar Windows Sandbox, container ou runner dedicado; documentar a escolha.

### Critérios de aceite

- [ ] Um comando não consegue escapar silenciosamente do escopo autorizado.
- [ ] Cancelar encerra também processos filhos.
- [ ] Timeout não deixa processo órfão.
- [ ] Segredos de ambiente não são herdados por padrão.
- [ ] Auditoria sobrevive à reinicialização.
- [ ] Testes cobrem escape, timeout, recusa e cancelamento.

---

## Tarefa 5 — Transformar o visualizador em editor

### Objetivo

Permitir edição real de arquivos com a mesma linguagem visual atual.

### Escopo

- Escolher e integrar Monaco ou CodeMirror.
- Abrir múltiplos arquivos em abas.
- Detectar estado alterado, salvar, salvar como e fechar com confirmação.
- Detectar mudanças externas no disco.
- Suportar arquivos Markdown e linguagens já reconhecidas pelo visualizador.
- Reutilizar a operação segura de escrita da Tarefa 3.

### Critérios de aceite

- [ ] Editar e salvar altera o arquivo correto.
- [ ] Aba modificada apresenta indicador visual.
- [ ] Fechar com mudanças não salvas pede confirmação.
- [ ] Mudança externa gera aviso de conflito.
- [ ] Arquivos grandes e binários recebem tratamento seguro.
- [ ] Atalhos básicos funcionam no Windows.

---

## Tarefa 6 — Implementar integração Git e Diff

### Objetivo

Transformar a aba Diff em uma visão real das alterações do projeto.

### Escopo

- Mostrar branch, status e arquivos alterados.
- Exibir diff unificado e lado a lado.
- Atualizar automaticamente depois de writes e delegações.
- Permitir stage, unstage e commit somente por ação explícita do usuário.
- Não implementar push ou PR automático nesta tarefa.

### Critérios de aceite

- [ ] Arquivos modificados, novos e removidos aparecem corretamente.
- [ ] O diff preserva codificação e finais de linha.
- [ ] Stage e unstage operam apenas nos arquivos selecionados.
- [ ] Commit apresenta o escopo exato antes da confirmação.
- [ ] Repositório inexistente ou em estado de merge possui mensagem clara.

---

## Gate de integração — Codex

Antes da Tarefa 7, o Codex deve:

1. inspecionar todos os commits da branch `claude/foundation-phase`;
2. comparar cada implementação com os critérios de aceite das tarefas 0–6;
3. revisar especialmente autenticação, path traversal, symlinks, processos filhos, segredos e aprovação concorrente;
4. executar syntax check, testes unitários, testes de integração e verificações manuais do Electron;
5. corrigir regressões na branch de integração com commits separados;
6. atualizar o roadmap e o diário de execução;
7. fazer o merge validado na `main`;
8. confirmar que a `main` está limpa e estável antes de começar a Fase B.

## Fase B — Codex

As tarefas abaixo pertencem ao Codex e só começam depois da conclusão do gate de integração.

## Tarefa 7 — Implementar terminal interativo PTY

### Objetivo

Disponibilizar um terminal de usuário real, separado do terminal mediado pelo agente.

### Escopo

- Integrar `node-pty` e xterm.js.
- Criar, redimensionar, reiniciar e encerrar sessões.
- Diferenciar visualmente terminal do usuário e execuções do agente.
- Não permitir que o modelo escreva diretamente no PTY do usuário.
- Preservar a política segura da Tarefa 4 para comandos agentic.

### Critérios de aceite

- [ ] Prompt interativo aceita entrada, cores e resize.
- [ ] Fechar o projeto encerra os processos relacionados.
- [ ] O agente não ganha acesso implícito à sessão interativa.
- [ ] Saídas muito grandes não congelam o renderer.
- [ ] Cancelamento e encerramento são testados.

---

## Tarefa 8 — Implementar Problems e busca global

### Objetivo

Adicionar ferramentas mínimas de navegação e diagnóstico esperadas em uma IDE.

### Escopo

- Busca textual global com ignore de `.git`, dependências e binários.
- Substituição com preview e aprovação.
- Painel Problems para testes, lint e compiladores configurados.
- Links de resultado abrem arquivo e linha no editor.
- Evitar depender inicialmente de um Language Server completo.

### Critérios de aceite

- [ ] Busca encontra texto, arquivo e linha corretos.
- [ ] Substituição nunca grava sem preview.
- [ ] Problems abre a localização correta.
- [ ] Resultados antigos são invalidados quando o arquivo muda.
- [ ] Projetos grandes não bloqueiam a interface.

---

## Tarefa 9 — Robustecer o runtime agentic

### Objetivo

Fazer tarefas longas sobreviverem a contexto grande, falhas transitórias e reinicializações.

### Escopo

- Substituir o limite fixo de rodadas por orçamento configurável.
- Adicionar orçamento de tokens/contexto e compactação.
- Persistir checkpoint de tarefa, chamadas de tools e resultados.
- Implementar retry apenas para falhas seguras e transitórias.
- Permitir cancelar modelo e árvore de processos.
- Transmitir saída incremental de Codex, Claude e Antigravity.
- Adicionar fila de jobs em segundo plano e relatório final.

### Critérios de aceite

- [ ] Conversa longa compacta contexto sem perder requisitos ativos.
- [ ] Reiniciar o aplicativo não corrompe o histórico da tarefa.
- [ ] Retry não repete escrita ou comando destrutivo.
- [ ] Delegação mostra progresso e pode ser cancelada.
- [ ] Limites de tempo, tokens e tools ficam visíveis ao usuário.

---

## Tarefa 10 — Completar o sistema de skills

### Objetivo

Evoluir a revisão contínua já implementada para um sistema completo e auditável.

### Escopo

- Integrar definitivamente a branch de revisão contínua.
- Carregar skills progressivamente por catálogo e `skill_view`.
- Suportar `references/`, `templates/`, `scripts/` e `assets/` com limites próprios.
- Mostrar histórico, diff, proveniência, pinning, adoção e rollback.
- Exportar e importar skills.
- Manter consolidação por modelo desabilitada até existir validação suficiente.

### Critérios de aceite

- [ ] Skills do usuário nunca são administradas sem adoção explícita.
- [ ] Toda escrita continua exigindo aprovação.
- [ ] Revisor cancelado não contamina a conversa principal.
- [ ] Rollback restaura todos os arquivos da alteração.
- [ ] Skills arquivadas deixam de entrar no contexto.

---

## Tarefa 11 — Melhorar ciclo de vida do RAG

### Objetivo

Transformar a integração externa em uma experiência operacional controlada pela interface.

### Escopo

- Configurar caminho e endpoint sem depender de `D:\gpt`.
- Detectar Docker, container, GPU, embedder e reranker.
- Iniciar, parar e reiniciar os serviços com confirmação.
- Fazer indexação incremental por hash.
- Remover do corpus arquivos excluídos.
- Mostrar progresso, cancelamento, erros por arquivo e última indexação.
- Abrir a fonte recuperada no editor.

### Critérios de aceite

- [ ] Projeto novo configura o engine sem editar código.
- [ ] Reindexar arquivo inalterado não duplica chunks.
- [ ] Excluir arquivo remove seus chunks.
- [ ] Cancelamento deixa o corpus consistente.
- [ ] Interface mostra uso efetivo de GPU e fallback.

---

## Tarefa 12 — Completar gerenciamento de memória

### Objetivo

Dar ao usuário controle integral sobre o que o agente lembra.

### Escopo

- Buscar, editar, excluir e exportar memórias explícitas.
- Mostrar memórias semânticas recuperadas em cada resposta.
- Exibir similaridade e motivo da recuperação.
- Configurar retenção, limite e deduplicação.
- Separar preferência global, projeto, sessão e decisão técnica.
- Criar operação de limpeza com preview.

### Critérios de aceite

- [ ] Usuário consegue localizar e apagar qualquer memória.
- [ ] Memória apagada não reaparece em outra conversa.
- [ ] Escopos não vazam entre projetos.
- [ ] Credenciais continuam redigidas.
- [ ] Limpeza e exportação possuem testes de integridade.

---

## Tarefa 13 — Criar testes end-to-end do Electron

### Objetivo

Validar os fluxos reais que testes unitários não cobrem.

### Escopo

- Adicionar Playwright para Electron ou ferramenta equivalente.
- Simular Ollama, RAG e busca web localmente.
- Cobrir chat, streaming, aprovação, edição, arquivos, RAG, memória e skills.
- Executar smoke test no Windows via CI.
- Adicionar verificações básicas de acessibilidade e regressão visual.

### Critérios de aceite

- [ ] Fluxo principal roda sem serviços externos.
- [ ] Falhas produzem screenshot e logs úteis.
- [ ] Aprovação e recusa são exercitadas.
- [ ] Pelo menos uma tarefa agentic completa é testada ponta a ponta.
- [ ] CI continua dentro de um tempo aceitável.

---

## Tarefa 14 — Empacotar e publicar o aplicativo

### Objetivo

Produzir uma versão instalável, atualizável e reproduzível.

### Escopo

- Configurar Electron Builder ou Forge.
- Criar ícones e metadados finais.
- Gerar instalador Windows e build portátil.
- Configurar assinatura quando houver certificado.
- Criar workflow de release por tag.
- Gerar checksum, changelog e artefatos.
- Planejar atualização automática sem instalar silenciosamente.

### Critérios de aceite

- [ ] Instalação funciona em uma máquina Windows limpa.
- [ ] Desinstalação não remove projetos do usuário.
- [ ] Dados locais sobrevivem à atualização.
- [ ] Build publicado corresponde ao commit/tag informado.
- [ ] Checksums e notas de versão acompanham os artefatos.

---

## Pendências descobertas

Registre aqui problemas encontrados durante uma tarefa sem interromper o escopo atual.

| Data | Origem | Pendência | Prioridade | Tarefa sugerida |
|---|---|---|---|---|
| 2026-08-12 | Tarefa 2 | `backend:health` falha com `ECONNRESET` na primeira chamada após o boot: o renderer consulta antes de o servidor estar escutando. Pré-existente (aparece em logs anteriores à autenticação) e sem impacto funcional — a próxima checagem sucede. | Baixa | 9 (runtime/retry) |

## Diário de execução

| Data | Tarefa | Resultado | Testes | Commit | Observações |
|---|---:|---|---|---|---|
| 2026-08-12 | 3 | `project_write_file` e `project_apply_patch` com plano congelado | 75/75 (9 novos) | `feat(tools): add approval-gated file patches` | Symlink barrado por realpath; junction criada de verdade no teste. |
| 2026-08-12 | 2 | Backend autenticado por token efêmero | 66/66 (6 novos de auth) | `feat(security): authenticate local backend requests` | Verificação manual: rota privada 401, health 200, token ausente dos logs. |
| 2026-08-12 | 1 | CI Windows/Node 20 + documentos de contribuição | `ci` simulado em clone limpo: 60/60 | `ci: add Windows validation workflow` | Validado com `npm ci` real em clone novo. README corrigido de 46 para 60 testes. |
| 2026-08-12 | 0 | Histórico unificado em `claude/foundation-phase` | `check` OK, 60/60 | merges `origin/main` + `c/continuous-skill-review` | Sem conflitos: a linha do roadmap só continha commits de documentação desde o ancestral `7673b5b`. |

## Definição de conclusão do roadmap

O roadmap estará concluído quando:

- todas as tarefas estiverem marcadas como `CONCLUÍDA`;
- a branch principal estiver sincronizada e protegida por CI;
- o agente puder ler, editar, testar e apresentar diff com fronteiras de segurança verificáveis;
- RAG, memória e skills tiverem gerenciamento completo pela interface;
- existir um instalador Windows validado em máquina limpa;
- documentação, testes e release apontarem para o mesmo commit.
