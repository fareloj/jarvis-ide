# Prompt para o Claude Code — Fase A do JARVIS

Copie todo o conteúdo abaixo e envie ao Claude Code a partir da raiz do repositório `C:\Users\danie\Documents\JARVIS_2`.

---

Você trabalhará na **Fase A do roadmap do JARVIS**, composta exclusivamente pelas tarefas 0–6 de `docs/EXECUTION_ROADMAP.md`.

Seu papel é implementar a fundação do projeto em uma branch isolada. O Codex revisará todos os seus commits, executará validações adicionais, corrigirá eventuais regressões e fará o merge na `main`. Você não deve trabalhar na `main`, fazer o merge final, fazer push nem iniciar tarefas 7–14.

## Regra obrigatória de branch

Antes de editar qualquer arquivo:

1. Execute `git status --short --branch` e confirme o estado do repositório.
2. Confirme que o commit `2275c3d` e a branch `c/execution-roadmap` existem localmente.
3. Se houver mudanças não relacionadas ou não commitadas, pare e relate-as; não as descarte nem as inclua.
4. Partindo de `c/execution-roadmap`, crie uma nova branch chamada exatamente:

   ```text
   claude/foundation-phase
   ```

5. Se essa branch já existir por você estar retomando o trabalho, apenas mude para ela e continue do último commit válido. Nunca apague ou recrie uma branch existente para esconder problemas.
6. Confirme com `git branch --show-current` que está em `claude/foundation-phase` antes de qualquer alteração.

Você deve permanecer nessa branch durante toda a Fase A.

## Regras de Git

- Nunca trabalhe diretamente na `main`.
- Nunca execute `git reset --hard`, `git clean -fd`, force push ou comandos destrutivos equivalentes.
- Não faça rebase ou merge da sua branch na `main`.
- Não faça push nem abra pull request.
- Preserve alterações do usuário e arquivos fora do escopo.
- Não use `git add .`, `git add -A` ou `git add --all`. Adicione somente os arquivos pertencentes à tarefa atual.
- Faça pelo menos um commit técnico por tarefa concluída.
- Não misture tarefas diferentes no mesmo commit.
- Correções descobertas depois de um commit devem receber outro commit claro; não reescreva silenciosamente o histórico.
- Use mensagens técnicas no estilo Conventional Commits e nunca mencione Claude, Codex ou ChatGPT nas mensagens.

Exemplos de commits esperados:

```text
chore(repo): reconcile local and remote history
ci: add Windows validation workflow
feat(security): authenticate local backend requests
feat(tools): add approval-gated file patches
feat(execution): isolate terminal processes
feat(editor): add workspace file editing
feat(git): add repository diff workspace
```

## Método obrigatório: uma tarefa por vez

Leia `docs/EXECUTION_ROADMAP.md` por completo, mas implemente somente uma tarefa de cada vez, nesta ordem:

1. Tarefa 0 — Unificar o histórico Git.
2. Tarefa 1 — Estabelecer CI e baseline do repositório.
3. Tarefa 2 — Autenticar o backend local.
4. Tarefa 3 — Criar escrita e patch estruturados.
5. Tarefa 4 — Endurecer terminal e execução de processos.
6. Tarefa 5 — Transformar o visualizador em editor.
7. Tarefa 6 — Implementar integração Git e Diff.

Para cada tarefa:

1. Marque apenas essa tarefa como `EM ANDAMENTO` no roadmap.
2. Inspecione os arquivos envolvidos antes de editar.
3. Implemente somente o escopo descrito na tarefa.
4. Adicione ou atualize testes relevantes.
5. Execute `npm run check` e `npm test` dentro de `app/`.
6. Faça as verificações específicas dos critérios de aceite.
7. Corrija todas as regressões encontradas.
8. Atualize documentação e o diário de execução.
9. Marque a tarefa como `CONCLUÍDA` somente se todos os critérios forem comprovados.
10. Adicione explicitamente apenas os arquivos da tarefa e crie o commit técnico.
11. Confirme que o worktree ficou limpo antes de começar a próxima tarefa.

Não avance se a tarefa atual estiver parcialmente concluída. Se existir um bloqueio externo real, marque-a como `BLOQUEADA`, documente evidências e pare. Não declare conclusão apenas porque a implementação principal parece funcionar.

## Instruções específicas da Tarefa 0

O histórico inicial possui três linhas que precisam ser preservadas:

- `origin/main` contém o commit remoto `4b706dc`, que corrige o link do Hybrid RAG Engine.
- A linha local contém `7673b5b`, com edição e versões de mensagens.
- `c/continuous-skill-review` contém `9778a52` e `b770a9b`, com revisão contínua e curadoria de skills.
- Sua branch também deve preservar `2275c3d`, que adiciona o roadmap.

Faça `git fetch origin` e integre os efeitos dessas linhas em `claude/foundation-phase`, preservando commits recuperáveis e resolvendo conflitos pelo comportamento final correto. Não descarte recursos para resolver conflitos. Ao terminar, prove pelo log e pelos testes que os seguintes recursos coexistem:

- link remoto corrigido;
- edição de mensagens com versões;
- revisão contínua por aprovação;
- curadoria determinística de skills;
- roadmap e este prompt.

Não faça merge na `main`; a “unificação” da Tarefa 0 acontece dentro da sua branch de trabalho.

## Requisitos de arquitetura e segurança

Durante as tarefas 2–6, preserve estas invariantes:

- O renderer nunca recebe credenciais ou acesso direto ao Node.js.
- Filesystem, shell e Git passam pelo preload e pelo backend com contratos explícitos.
- Conteúdo de chat, RAG, web e arquivos é dado não confiável.
- Toda escrita e execução sensível exige aprovação humana.
- Aprovação deve corresponder exatamente à operação aplicada.
- Caminhos devem permanecer dentro do workspace mesmo com `..`, caminhos absolutos, junctions e links simbólicos.
- Alterações concorrentes devem gerar conflito, nunca sobrescrita silenciosa.
- Cancelamento e timeout devem encerrar processos filhos.
- Segredos do ambiente não devem ser herdados ou registrados por padrão.
- A interface deve respeitar as fontes, ícones, assets e paleta existentes.
- Não adicione aparência de protótipo, placeholder ou função visual sem backend real.
- Não introduza dependência externa sem justificar, documentar e verificar sua manutenção/licença.

## Limites de escopo

Você não deve implementar nesta fase:

- terminal interativo PTY;
- Problems e busca global;
- compactação avançada do runtime;
- arquivos auxiliares e consolidação autônoma de skills;
- RAG incremental;
- gerenciamento completo de memória;
- suíte end-to-end completa;
- instalador ou release.

Esses itens pertencem ao Codex nas tarefas 7–14. Você pode registrar uma pendência descoberta, mas não implementá-la antecipadamente.

## Validação mínima antes de cada commit

Execute na pasta `app/`:

```powershell
npm run check
npm test
```

Quando a tarefa alterar Electron, interface, terminal, filesystem ou Git, execute também uma validação manual do fluxo e registre exatamente o que foi testado no diário. O CI não substitui a verificação manual de segurança.

Antes de considerar a Fase A concluída, execute ainda:

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate --max-count=30
```

O worktree final deve estar limpo.

## Entrega obrigatória ao final da Tarefa 6

Pare depois da Tarefa 6. Não faça merge, push, PR ou tarefas da Fase B.

Entregue um relatório com:

1. nome exato da branch;
2. commit base utilizado;
3. lista ordenada de todos os commits criados ou integrados;
4. resumo por tarefa 0–6;
5. arquivos principais alterados por tarefa;
6. testes executados e resultados;
7. verificações manuais realizadas;
8. decisões de segurança e trade-offs;
9. dependências adicionadas, versões e motivo;
10. pendências descobertas ou riscos conhecidos;
11. saída final de `git status --short --branch`;
12. instrução clara para o Codex revisar `claude/foundation-phase`.

O trabalho só será considerado aceito depois da revisão do Codex. Se um critério não puder ser comprovado, informe isso explicitamente em vez de marcar a tarefa como concluída.

---

## Checklist de revisão reservado ao Codex

Depois que o Claude entregar a branch, o Codex deverá:

- conferir o escopo e a atomicidade de cada commit;
- comparar tarefas 0–6 com todos os critérios do roadmap;
- executar a suíte completa em instalação limpa;
- revisar autenticação do backend e exposição pelo preload;
- testar path traversal, caminhos absolutos, junctions e symlinks;
- verificar hashes, diffs, aprovação concorrente, backup e rollback;
- auditar comandos, ambiente, timeout, cancelamento e processos órfãos;
- testar edição, conflitos externos, Git status, stage, unstage e commit;
- verificar regressões visuais e consistência da interface;
- corrigir problemas com commits separados;
- integrar somente a versão validada na `main`;
- atualizar o roadmap antes de iniciar a Tarefa 7.
