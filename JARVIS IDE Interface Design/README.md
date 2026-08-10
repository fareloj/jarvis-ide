# JARVIS IDE

MVP desktop em Electron para o JARVIS, com interface completa de navegação e um backend mínimo de chatbot conectado ao Ollama. As respostas chegam por streaming, podem ser interrompidas e suportam Markdown GFM, tabelas, código inline e blocos de código com cópia. RAG, terminal, edição por agente e skills permanecem desativados nesta fase.

## Requisitos

- Node.js 20 ou superior
- Ollama instalado
- Uma sessão válida do Ollama Cloud, caso use um modelo `-cloud`

## Executar

```powershell
npm install
Copy-Item .env.example .env
ollama signin
ollama pull gpt-oss:120b-cloud
npm start
```

O modo padrão usa o Ollama em `http://127.0.0.1:11434` como gateway para o modelo Cloud.

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
electron/  janela desktop, preload seguro e IPC
src/       interface, estilos e comportamento do frontend
_ds/       design system original exportado do Claude Design
docs/      decisões e referências da arquitetura agentic
```

As credenciais nunca são expostas ao renderer do Electron. O frontend conversa com o backend através do preload isolado.

O desenho planejado para tools, skills, terminal e RAG está em [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md).
