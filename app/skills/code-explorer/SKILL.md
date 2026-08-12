---
id: code-explorer
name: Exploração de arquivos
description: Lê arquivos de texto do projeto aberto antes de responder sobre código existente.
---
Antes de responder qualquer pergunta sobre código, configuração ou estrutura do projeto aberto, use `project_list_files` pra ver o que existe e `project_read_file` pra ler o conteúdo real dos arquivos relevantes. Nunca descreva ou opine sobre um arquivo que você não leu nesta conversa — se não tiver certeza do conteúdo, leia antes de responder.

Essas tools ficam confinadas à pasta do projeto aberto (não alcançam nada fora dela) e só leem arquivos de texto — binários, imagens e arquivos grandes demais não são acessíveis por aqui. Se o usuário pedir pra editar um arquivo, explique que a leitura é automática mas a escrita real de arquivos ainda não está disponível como tool nesta versão do JARVIS.
