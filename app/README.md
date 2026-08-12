# JARVIS IDE

Aplicativo desktop em Electron para o JARVIS, com Ollama Cloud para conversa e um Hybrid RAG Engine local acelerado por GPU. As respostas chegam por streaming e suportam Markdown GFM; conversas, memórias e notas persistem localmente. O agente pode pesquisar o RAG, ler arquivos confinados ao projeto e usar skills declarativas. Escrita de memória e terminal exigem aprovação explícita na interface.

As mensagens do usuário podem ser editadas para regenerar a conversa a partir daquele ponto. O histórico anterior à edição é preservado como uma versão separada e pode ser alternado pelos controles `‹ 1/2 ›`, inclusive após reiniciar o aplicativo.

## Requisitos

- Node.js 20 ou superior
- Ollama instalado
- Uma sessão válida do Ollama Cloud, caso use um modelo `-cloud`
- Docker Desktop com suporte NVIDIA para embeddings e reranking locais
- O repositório `hybrid-rag-engine` disponível (o ambiente atual usa `D:\gpt`)

## Executar

```powershell
npm install
Copy-Item .env.example .env
ollama signin
ollama pull gpt-oss:120b-cloud
npm start
```

Modelos disponíveis no seletor:

```text
gpt-oss:120b-cloud
gpt-oss:20b-cloud
qwen3-coder:480b-cloud
nemotron-3-super
nemotron-3-ultra:cloud
nemotron-3-nano:30b-cloud
minimax-m3:cloud
```

Os modelos Cloud exigem login e acesso habilitado na conta Ollama. `nemotron-3-super` usa a instalação local configurada no Ollama.

O modo padrão usa o Ollama em `http://127.0.0.1:11434` como gateway para o modelo Cloud.

## Busca web

O agente pode chamar `web_search` para buscar fontes atuais e receber título, URL e resumo. Por padrão, a busca usa o feed RSS do Bing sem chave. Para usar a API do Brave Search, altere o `.env`:

```text
JARVIS_WEB_SEARCH_PROVIDER=brave
JARVIS_BRAVE_SEARCH_API_KEY=sua-chave
```

Os resultados são tratados como conteúdo externo não confiável; o modelo deve citar as URLs usadas e não executar instruções encontradas nas páginas.

## Aprendizado contínuo

O JARVIS revisa a conversa a cada três respostas e pode propor a criação ou atualização de uma skill. A revisão roda separada do chat, sem tools, e nunca altera arquivos automaticamente. Em **Configurações → Aprendizado contínuo**, é possível comparar o `SKILL.md` atual com o proposto, aplicar ou descartar a mudança e executar uma revisão manual.

As propostas e estatísticas de uso persistem na pasta de dados do aplicativo. Antes de aplicar uma atualização, o JARVIS confirma que a skill não mudou desde a proposta e salva um backup da versão anterior.

Para iniciar o RAG usando o Compose do engine e o override do JARVIS:

```powershell
$env:JARVIS_RAG_STAGING_PATH=(Resolve-Path '.\data\rag-workspace').Path
docker compose -f 'D:\gpt\docker-compose.yml' -f '.\docker\rag.compose.override.yml' up -d
```

O override publica o Ollama de embeddings em `11435`, monta apenas o staging de arquivos como leitura e ativa GPU no embedder e no reranker. O chatbot continua usando `11434`.

Para chamar o Ollama Cloud diretamente, altere `.env`:

```text
JARVIS_OLLAMA_HOST=https://ollama.com
JARVIS_OLLAMA_MODEL=gpt-oss:120b
OLLAMA_API_KEY=sua-chave
```

## Verificação

```powershell
npm run check
npm test
```

## Estrutura

```text
backend/   servidor HTTP local e ponte para Ollama
docker/    override seguro do Hybrid RAG Engine
electron/  janela desktop, preload seguro e IPC
skills/    skills declarativas carregadas pelo runtime
src/       interface, estilos e comportamento do frontend
_ds/       design system original exportado do Claude Design
docs/      decisões e referências da arquitetura agentic
```

As credenciais nunca são expostas ao renderer do Electron. O frontend conversa com o backend através do preload isolado.

Os contratos de tools, skills, aprovação, memória e RAG estão em [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md).
