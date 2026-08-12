@echo off
setlocal

rem ============================================================
rem  JARVIS - inicia a interface com o backend
rem
rem  O backend NAO e um processo separado: ele sobe dentro do
rem  processo principal do Electron (electron/main.js chama
rem  startBackend), numa porta local aleatoria. Por isso um
rem  unico "npm start" ja levanta interface + backend juntos.
rem ============================================================

title JARVIS
cd /d "%~dp0"

echo.
echo  ==============================
echo    J A R V I S
echo  ==============================
echo.

rem --- 1. Node.js ---------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado no PATH.
  echo         Instale em https://nodejs.org e tente de novo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo  [1/3] Node.js %NODEVER%

rem --- 2. Dependencias ----------------------------------------
if not exist "node_modules\" (
  echo  [2/3] Dependencias ausentes, instalando ^(pode demorar^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERRO] npm install falhou. Veja o log acima.
    pause
    exit /b 1
  )
) else (
  echo  [2/3] Dependencias OK
)

rem --- 3. Servico de embedding --------------------------------
rem A memoria semantica entre chats usa o Ollama do stack de RAG
rem (Hybrid RAG Engine) em 127.0.0.1:11435. Sem ele o chat funciona
rem normalmente, so nao lembra do que foi dito em outras conversas.
rem Outro endereco pode ser definido em JARVIS_EMBED_URL no .env.
curl -s -m 3 http://127.0.0.1:11435/api/tags >nul 2>&1
if errorlevel 1 (
  echo  [3/3] Memoria entre chats: DESATIVADA
  echo        Sem resposta do servico de embedding em 127.0.0.1:11435.
  echo        Suba o stack do Hybrid RAG Engine ^(docker compose up -d
  echo        na pasta dele^) para ligar a memoria. O chat funciona
  echo        normalmente sem isso.
) else (
  echo  [3/3] Memoria entre chats: ativa
)

echo.
echo  Abrindo o JARVIS... ^(feche esta janela para encerrar^)
echo.

call npm start
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo  [ERRO] O JARVIS encerrou com codigo %EXITCODE%. Log acima.
  pause
)

endlocal
