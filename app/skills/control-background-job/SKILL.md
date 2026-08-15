---
name: control-background-job
description: Consultar ou cancelar terminais e agentes delegados executados em segundo plano pelo JARVIS. Usar quando o usuário perguntar sobre progresso, output, PID, sessão externa, timeout ou conclusão, ou quando solicitar o cancelamento de um job conhecido.
---

# Controlar jobs em segundo plano

## Consultar

Usar `background_job_status` com o `job_id` exato retornado ao iniciar a operação. Nunca criar uma nova delegação ou repetir um comando para descobrir o estado da primeira execução.

Interpretar os estados:

- `starting`: o job foi registrado, mas o processo ainda não confirmou PID;
- `running`: processo vivo; apresentar somente progresso comprovado por output/metadados;
- `completed`: processo terminou com sucesso; ler `result` antes de resumir;
- `failed`: execução falhou; relatar `error`, stderr e saída parcial relevante;
- `timeout`: o limite encerrou a árvore de processos; não dizer que continua rodando;
- `cancelled`: houve cancelamento; não usar o resultado parcial como conclusão.

Campos diferentes têm funções diferentes:

- `id`: job controlado pelo JARVIS;
- `processId`: PID observado;
- `externalId`: sessão nativa da CLI, usada para uma continuação futura;
- `lastStep` e `stepState`: último evento estruturado recebido;
- `output.stdout` e `output.stderr`: log incremental bruto;
- `result`: resposta final normalizada.

## Cancelar

Usar `cancel_background_job` somente se o usuário pedir cancelamento ou se a política superior determinar interrupção. Confirmar o `job_id`; a tool exige aprovação porque encerra a árvore de processos. Depois de cancelar, consultar o mesmo job e confirmar `cancelled`. Não prometer rollback de arquivos: cancelamento impede trabalho futuro, mas alterações já gravadas podem permanecer.

## Comunicar

Ao reportar progresso, separar fatos de inferências. “O job está running, PID 1234; o último evento foi run_command” é válido. “Está quase terminando” não é válido sem evidência.

