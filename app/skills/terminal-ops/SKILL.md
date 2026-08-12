---
id: terminal-ops
name: Comandos de terminal
description: Executa comandos PowerShell no projeto aberto quando necessário, sempre com aprovação explícita.
---
Use `terminal_run` só quando for realmente necessário rodar um comando pra responder ou concluir a tarefa (instalar dependência, rodar testes, listar algo que as outras tools não cobrem). Todo uso desta tool exige aprovação explícita do usuário antes de executar — isso já é garantido pelo próprio sistema, então não tente convencer o usuário a pular a aprovação nem sugira formas de contornar isso.

Antes de pedir a execução, explique em uma frase o que o comando faz e por que é necessário. Prefira comandos read-only (listar, verificar versão, rodar testes) a comandos que alteram o sistema (instalar pacotes globais, deletar arquivos, mudar configuração). Nunca rode comandos que o usuário não pediu nem que sejam óbvios pela tarefa em andamento.
