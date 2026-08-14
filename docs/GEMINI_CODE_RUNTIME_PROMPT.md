# Prompt para o Gemini — Fase B do JARVIS

Envie todo o conteúdo abaixo ao Gemini a partir da raiz do repositório `C:\Users\danie\Documents\JARVIS_2`, somente depois de confirmar que a `main` contém a Fase A validada e quaisquer mudanças do seletor de modelos que devam acompanhá-la.

---

Você trabalhará exclusivamente nas **Tarefas 7–9** de `docs/EXECUTION_ROADMAP.md`. Não implemente tarefas 10 ou posteriores.

Seu trabalho será revisado pelo Codex. Passar nessa revisão exige evidência executada; descrição, intenção ou código aparentemente correto não substituem testes.

## Branch obrigatória

Antes de editar qualquer arquivo:

1. Execute `git status --short --branch`.
2. Confirme que está partindo da `main` limpa e atualizada.
3. Se houver qualquer alteração não commitada, pare e relate sem descartar, sobrescrever ou incluir essa alteração.
4. Crie e use a branch `gemini/runtime-phase`.
5. Confirme com `git branch --show-current` antes da primeira edição.

Nunca trabalhe diretamente na `main`. Não faça merge, rebase, push ou pull request. Não use `git reset --hard`, `git clean`, force push, `git add .`, `git add -A` ou equivalentes.

## Uma tarefa por vez

Implemente nesta ordem:

1. Tarefa 7 — terminal interativo PTY.
2. Tarefa 8 — Problems e busca global.
3. Tarefa 9 — runtime agentic robusto.

Para cada tarefa:

1. Leia novamente o objetivo, escopo e todos os critérios de aceite.
2. Marque somente a tarefa atual como `EM ANDAMENTO`.
3. Inspecione o código e os testes existentes antes de alterar arquivos.
4. Implemente somente o escopo da tarefa atual.
5. Crie testes automatizados positivos, negativos, de limite e de regressão.
6. Execute todas as validações obrigatórias descritas abaixo.
7. Corrija qualquer falha e repita a suíte completa.
8. Faça validação manual real quando a tarefa tocar Electron, UI, PTY ou processos.
9. Registre no diário os comandos executados, quantidade de testes, resultado e fluxo manual verificado.
10. Marque `CONCLUÍDA` apenas depois de comprovar cada critério.
11. Adicione somente os arquivos da tarefa e faça um commit técnico separado.
12. Confirme que o worktree está limpo antes de avançar.

Não misture tarefas em um commit. Use Conventional Commits e nunca mencione Gemini, Claude, Codex ou ChatGPT na mensagem.

## Regra absoluta de validação

Você deve **executar** os testes. Não escreva “os testes devem passar”, “não foi possível executar, mas está correto”, “validação recomendada” ou qualquer afirmação equivalente.

Dentro de `app/`, antes de cada commit, execute obrigatoriamente:

```powershell
npm run check
npm test
```

Também execute os testes específicos da tarefa isoladamente, para que falhas não fiquem escondidas na saída da suíte completa. Use o arquivo real criado para a tarefa, por exemplo:

```powershell
node --test backend/ARQUIVO-DA-TAREFA.test.js
```

Depois execute, na raiz do repositório:

```powershell
git diff --check
git status --short --branch
git diff --stat main...HEAD
git log --oneline --decorate --max-count=20
```

Para cada comando, registre no relatório:

- comando exato;
- exit code;
- total de testes aprovados, falhos, ignorados e cancelados;
- resumo de qualquer warning;
- correção realizada se houve falha;
- nova execução que comprovou a correção.

É proibido silenciar falhas com `|| true`, alterar um teste só para aceitar comportamento incorreto, remover cobertura, usar `skip`, aumentar timeout sem investigar ou mockar justamente o comportamento que deveria ser provado.

Se um comando não puder ser executado por limitação externa, a tarefa fica `BLOQUEADA`. Preserve as mudanças, documente o erro exato e pare. Não faça commit de conclusão e não avance à próxima tarefa.

## Validação manual obrigatória

Testes unitários não substituem validação do aplicativo real.

### Tarefa 7

Abra o Electron e prove:

- entrada interativa, ANSI/cores e redimensionamento do PTY;
- terminal do usuário visualmente distinto da execução agentic;
- renderer responsivo sob saída extensa com limite de buffer;
- fechamento, reinício e cancelamento encerram a árvore de processos;
- o modelo não consegue escrever no PTY do usuário por nenhuma tool ou IPC.

Além do fluxo visual, use processos filhos reais nos testes de cancelamento e encerramento. Verificar apenas o processo pai não é suficiente.

### Tarefa 8

Em um projeto temporário real, prove:

- busca retorna arquivo, linha e coluna corretos;
- `.git`, dependências, binários e arquivos fora do workspace são ignorados;
- resultado abre exatamente a linha no Monaco;
- substituição mostra preview e não grava antes da aprovação;
- edição concorrente invalida resultado/preview antigo;
- busca grande não bloqueia o renderer e pode ser cancelada;
- Problems abre a localização e remove diagnóstico obsoleto.

### Tarefa 9

Com um provedor simulado determinístico e processos reais quando aplicável, prove:

- compactação preserva requisitos ativos e não transforma conteúdo não confiável em instrução;
- checkpoint sobrevive ao reinício e não duplica tool calls concluídas;
- retry ocorre somente em leitura/falha transitória segura;
- escrita, aprovação e comando destrutivo nunca são repetidos automaticamente;
- cancelamento chega ao modelo e encerra toda a árvore delegada;
- progresso incremental de cada CLI é exibido sem esperar o processo terminar;
- limites de tokens, tempo e tools aparecem na interface;
- job em segundo plano termina com relatório persistido e recuperável.

Não faça chamadas pagas aos modelos cloud nos testes automatizados. Use fixtures e servidor simulado; se fizer um smoke test cloud manual, registre modelo, objetivo e resultado sem expor credenciais.

## Invariantes que não podem regredir

- O renderer não recebe Node.js direto, token do backend nem chaves de API.
- IPC e backend validam entrada; conteúdo de modelo, web, RAG e arquivos é não confiável.
- Escrita e execução sensível continuam dependentes de aprovação humana exata.
- Paths permanecem confinados mesmo com `..`, absolutos, symlink, junction e monorepo aberto por subpasta.
- Timeout/cancelamento encerram a árvore, não apenas o processo pai.
- Logs, checkpoints, erros e auditoria não persistem segredos.
- Operações Git e filesystem nunca incluem arquivos fora do workspace por acidente.
- A interface mantém fontes, ícones, assets, paleta e acabamento atuais.
- Não deixe botões cenográficos, placeholders, flags temporárias, portas de depuração ou menções de beta.

## Entrega após a Tarefa 9

Pare. Não inicie a Tarefa 10 e não integre na `main`.

Entregue:

1. branch e HEAD exatos;
2. base usada;
3. commits ordenados por tarefa;
4. arquivos alterados por tarefa;
5. critérios de aceite com evidência correspondente;
6. todos os comandos de validação e seus resultados;
7. validações manuais realizadas no Electron;
8. testes adversariais e de processo real;
9. dependências adicionadas, versões, licença e justificativa;
10. riscos e pendências sem esconder limitações;
11. saída final de `git status --short --branch`;
12. instrução para o Codex revisar `gemini/runtime-phase`.

O trabalho só será aceito após o Codex repetir os testes, revisar segurança e fazer o merge.
