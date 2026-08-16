# Compatibilidade dos agentes de código

Validação feita em 16 de agosto de 2026 contra a documentação oficial e
as CLIs instaladas na máquina de desenvolvimento:

- Claude Code `2.1.220`;
- Codex CLI `0.146.0`.

## Contrato usado pelo JARVIS

| Capacidade | Claude Code | Codex CLI | Como o JARVIS usa |
|---|---|---|---|
| Execução programática | `claude -p` | `codex exec` | processo filho gerenciado como job |
| Eventos | `stream-json` | JSONL com `--json` | parser incremental e metadados do job |
| Retomada | `--resume <id>` | `exec resume <id>` | `continue_coding_task` |
| Mensagem final | evento `result` | `--output-last-message` | resposta final anexada ao job |
| Workspace | diretório do processo e escopo do projeto | `-C <workspace>` | caminho absoluto validado pelo backend |
| Isolamento de edição | permissões `plan`/`acceptEdits` | sandbox `read-only`/`workspace-write` | modo escolhido pela tool |
| Esforço | `--effort` | `model_reasoning_effort` | parâmetro opcional da tool |

## Decisões de integração

O JARVIS executa as CLIs como processos filhos e administra PID, timeout,
cancelamento, stdout, stderr e ID de sessão. Isso é diferente do recurso nativo
`claude --bg`: a documentação do Claude informa que `--bg` não pode ser
combinado com `-p`, enquanto o JARVIS precisa do modo programático e do stream
JSON. Portanto, colocar o processo `-p` dentro da fila de jobs do JARVIS é a
integração correta para esta interface.

O Codex recebe `--ask-for-approval never` somente depois da aprovação explícita
da delegação no JARVIS. Isso evita um segundo prompt invisível no modo
não interativo, mas não remove o sandbox: planejamento continua `read-only` e
implementação continua `workspace-write`.

No Claude Code, `acceptEdits` permite edições no projeto, mas não equivale a
liberar qualquer comando. O sandbox nativo de Bash documentado pelo Claude exige
macOS, Linux ou WSL2; no Windows nativo, o JARVIS mantém a política segura e não
usa `bypassPermissions`. Consequência conhecida: um comando Bash que solicite
permissão adicional pode ser recusado numa execução não interativa. Para maior
autonomia com isolamento de SO, deve-se executar Claude Code em WSL2 ou integrar
um permission prompt MCP ao backend.

## Evidências reproduzíveis

```powershell
claude --version
claude --help
codex --version
codex exec --help
codex exec resume --help
npm test
```

Os testes de `coding-agent-cli` verificam os argumentos, o confinamento do Codex,
o encaminhamento de `effort`, a retomada nativa e os parsers de eventos. Eles não
executam chamadas pagas aos modelos.
