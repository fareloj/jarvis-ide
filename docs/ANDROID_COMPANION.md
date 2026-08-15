# JARVIS Companion para Android

O Companion é um cliente leve. O celular renderiza a interface, mantém seus chats e envia mensagens; Ollama Cloud, quota, RAG, memória semântica e pesquisa continuam no PC.

## Fronteira de segurança

```text
Android ── HTTPS/Tailscale ──> Mobile Gateway (127.0.0.1:49200)
                                     │ token interno efêmero
                                     ▼
                              Backend do JARVIS
                               │      │       │
                            Ollama   RAG   Memória
```

- O gateway escuta somente em `127.0.0.1`.
- Tailscale Serve fornece HTTPS e restringe a conexão à tailnet.
- O app também exige um token JARVIS aleatório, armazenado no Android Keystore.
- Cookie e API key do Ollama nunca saem do PC.
- A API móvel não publica terminal, Git, arquivos, skills nem aprovações.
- O modelo recebe somente `web_search` e `rag_search`; valores enviados pelo celular não ampliam essa allowlist.
- Não use Tailscale Funnel, encaminhamento de porta no roteador ou bind em `0.0.0.0`.

## 1. Instalar e conectar o Tailscale

No Windows, instale o Tailscale e entre com sua conta. No Android, instale o aplicativo Tailscale e entre na mesma tailnet.

Confirme no Windows:

```powershell
tailscale status
```

## 2. Criar o token móvel

Na pasta `app`, gere um token:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Adicione ao `.env` do JARVIS:

```dotenv
JARVIS_MOBILE_ENABLED=1
JARVIS_MOBILE_PORT=49200
JARVIS_MOBILE_TOKEN=COLE_O_TOKEN_GERADO
JARVIS_MOBILE_PROJECT_PATH=C:\caminho\do\projeto-usado-como-contexto
# JARVIS_MOBILE_CORPUS=corpus-opcional-do-rag
```

Reinicie o Electron. O terminal deve registrar:

```text
Gateway móvel rodando em http://127.0.0.1:49200
```

## 3. Publicar somente na tailnet

No Windows:

```powershell
tailscale serve --bg 49200
tailscale serve status
```

O comando mostra uma URL semelhante a:

```text
https://nome-do-pc.sua-tailnet.ts.net
```

Essa é a URL informada na tela de login do Companion. Não acrescente `/v1`.

Para remover o acesso:

```powershell
tailscale serve --https=443 off
```

Também revogue o aparelho trocando `JARVIS_MOBILE_TOKEN` no `.env` e reiniciando o JARVIS.

## 4. Instalar o APK

O APK debug é gerado em:

```text
android/JarvisCompanion/app/build/outputs/apk/debug/app-debug.apk
```

Com depuração USB e o aparelho conectado:

```powershell
cd android\JarvisCompanion
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Também é possível abrir `android/JarvisCompanion` no Android Studio e executar no aparelho.

## 5. Login do aplicativo

Informe:

- URL: endereço HTTPS exibido pelo `tailscale serve status`;
- token: valor de `JARVIS_MOBILE_TOKEN`.

O login Ollama não acontece no Android. O JARVIS usa a sessão já autenticada no PC e entrega ao Companion catálogo de modelos e quota sem expor a credencial.

## Comandos de desenvolvimento

```powershell
cd android\JarvisCompanion
.\gradlew.bat :app:assembleDebug
```

O projeto usa API 37, AGP 9.3, Gradle 9.7 e Kotlin/Compose 2.3.21. O `minSdk` é 26, compatível com Android 8 ou superior.

## Endpoints móveis

| Método | Rota | Finalidade |
|---|---|---|
| `GET` | `/v1/health` | validar autenticação e disponibilidade |
| `GET` | `/v1/models` | catálogo cloud filtrado pelo PC |
| `GET` | `/v1/quota` | quota Ollama já sincronizada no desktop |
| `POST` | `/v1/chat/stream` | chat NDJSON com memória, RAG e pesquisa |

Todas as rotas exigem `Authorization: Bearer <JARVIS_MOBILE_TOKEN>`.
