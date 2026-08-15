const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-'));
process.env.JARVIS_COMMAND_AUDIT_PATH = path.join(auditRoot, 'audit.jsonl');
const policy = require('./command-policy');

const ehWindows = process.platform === 'win32';

test('classifica comandos pelo efeito, não pela aparência', () => {
  assert.equal(policy.classify('ls'), 'leitura');
  assert.equal(policy.classify('git status'), 'leitura');
  assert.equal(policy.classify('mkdir build'), 'escrita');
  assert.equal(policy.classify('npm install express'), 'rede');
  assert.equal(policy.classify('npm test'), 'execucao');
  assert.equal(policy.classify('rm -rf build'), 'destruicao');
  assert.equal(policy.classify('git reset --hard'), 'destruicao');
  assert.equal(policy.classify('git push origin main --force'), 'destruicao');
});

test('comando encadeado nunca entra na allowlist', () => {
  // O risco real: esconder algo destrutivo atrás de um prefixo inofensivo.
  const disfarces = [
    'ls; rm -rf .',
    'git status && git reset --hard',
    'echo oi | rm -rf .',
    'ls $(rm -rf .)',
    'ls `rm -rf .`',
  ];
  for (const cmd of disfarces) {
    assert.equal(policy.isSafeRead(cmd), false, `deveria recusar: ${cmd}`);
    assert.equal(policy.decide(cmd).exigeAprovacao, true, `deveria exigir aprovação: ${cmd}`);
  }
});

test('todo comando exige aprovação, inclusive leitura reconhecida', () => {
  // Enquanto nao houver prova de que caminhos e efeitos ficam dentro do
  // workspace, nem `ls` roda sozinho: o texto do comando nao prova o efeito.
  const comandos = [
    'ls', 'git status', 'git log --oneline', 'node --version', 'pwd',
    'cat C:/Users/alguem/.ssh/id_rsa',
    'rm -rf build', 'npm install left-pad', 'mkdir x', 'npm test',
  ];
  for (const cmd of comandos) {
    const d = policy.decide(cmd);
    assert.equal(d.exigeAprovacao, true, `deveria exigir aprovação: ${cmd}`);
  }
});

test('a allowlist continua descrita, mas desligada por padrão', () => {
  // isSafeRead segue valendo para rotular o comando; ligar a liberacao
  // automatica precisa ser um ato explicito, e nenhum chamador faz isso.
  assert.equal(policy.isSafeRead('git status'), true);
  assert.equal(policy.decide('git status').exigeAprovacao, true);
  assert.equal(policy.decide('git status', { allowSafeReads: true }).exigeAprovacao, false);
});

test('comando vazio ou gigante é recusado', () => {
  assert.equal(policy.decide('').permitido, false);
  assert.equal(policy.decide('   ').permitido, false);
  assert.equal(policy.decide('a'.repeat(9_000)).permitido, false);
});

test('modo bypass bloqueia System32 no cwd e no texto do comando', () => {
  assert.throws(
    () => policy.assertBypassCommandAllowed('Write-Output ok', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')),
    /System32/i,
  );
  assert.throws(
    () => policy.assertBypassCommandAllowed('Get-Content "$env:windir\\System32\\drivers\\etc\\hosts"', os.tmpdir()),
    /System32/i,
  );
  assert.throws(
    () => policy.assertBypassCommandAllowed('Get-Content (Join-Path $env:windir System32)', os.tmpdir()),
    /System32/i,
  );
  assert.equal(policy.assertBypassCommandAllowed('npm test', os.tmpdir()), true);
});

test('o ambiente não herda segredos do processo', () => {
  process.env.JARVIS_TAVILY_API_KEY = 'tvly-segredo-de-teste';
  process.env.OLLAMA_API_KEY = 'chave-secreta';
  const env = policy.sanitizedEnv();

  assert.equal(env.JARVIS_TAVILY_API_KEY, undefined);
  assert.equal(env.OLLAMA_API_KEY, undefined);
  assert.ok(env.PATH || env.Path, 'PATH precisa sobreviver para o shell funcionar');

  delete process.env.JARVIS_TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
});

test('a delegação preserva o perfil do usuário e continua sem os segredos', () => {
  process.env.JARVIS_TAVILY_API_KEY = 'tvly-segredo-de-teste';
  process.env.OLLAMA_API_KEY = 'chave-secreta';
  process.env.JARVIS_BACKEND_TOKEN = 'token-do-backend';
  const original = process.env.APPDATA;
  process.env.APPDATA = original || 'C:\Users\teste\AppData\Roaming';

  const env = policy.delegateEnv();

  // Sem o perfil do usuário, a CLI já autenticada volta a pedir login.
  assert.ok(env.APPDATA, 'APPDATA precisa chegar à CLI delegada');
  assert.ok(env.PATH || env.Path, 'PATH precisa sobreviver');
  assert.equal(env.USERPROFILE, process.env.USERPROFILE);

  // Mas nenhum segredo do JARVIS acompanha a delegação.
  assert.equal(env.JARVIS_TAVILY_API_KEY, undefined);
  assert.equal(env.OLLAMA_API_KEY, undefined);
  assert.equal(env.JARVIS_BACKEND_TOKEN, undefined);
  for (const chave of Object.keys(env)) {
    assert.equal(/^(JARVIS_|OLLAMA_)/.test(chave), false, `variável indevida: ${chave}`);
  }

  delete process.env.JARVIS_TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.JARVIS_BACKEND_TOKEN;
  if (original === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = original;
});

test('credenciais sao redigidas antes de ir para a auditoria', async () => {
  const comandos = [
    'curl -H "Authorization: Bearer sk-abc123456789xyz" https://api.exemplo.com',
    'git clone https://daniel:MinhaSenha123@github.com/org/repo.git',
    'npm publish --token=npm_ABCDEFGHIJKLMNOPQRST',
    'setx JARVIS_TAVILY_API_KEY tvly-dev-9f8e7d6c5b4a',
  ];
  const segredos = ['sk-abc123456789xyz', 'MinhaSenha123', 'npm_ABCDEFGHIJKLMNOPQRST', 'tvly-dev-9f8e7d6c5b4a'];

  for (const comando of comandos) {
    await policy.appendAudit({
      quando: new Date().toISOString(),
      comando: policy.redactSecrets(comando),
      classe: 'rede',
      status: 'ok',
    });
  }

  // Lido do disco, como faria quem abrisse o arquivo de auditoria.
  const bruto = fs.readFileSync(process.env.JARVIS_COMMAND_AUDIT_PATH, 'utf8');
  for (const segredo of segredos) {
    assert.equal(bruto.includes(segredo), false, `segredo vazou para a auditoria: ${segredo}`);
  }
  assert.match(bruto, /REDIGIDO/);

  // O registro continua util: o comando segue identificavel sem o valor.
  const registros = await policy.readAudit();
  assert.match(registros.at(-1).comando, /^setx JARVIS_TAVILY_API_KEY/);
});

test('a redacao nao destroi comandos sem segredo', () => {
  for (const comando of ['git status', 'npm run build -- --mode=production', 'node scripts/deploy.js']) {
    assert.equal(policy.redactSecrets(comando), comando);
  }
});

test('a auditoria sobrevive à reinicialização', async () => {
  await policy.appendAudit({ quando: new Date().toISOString(), comando: 'git status', classe: 'leitura', status: 'ok' });
  // Releitura a partir do disco, como faria um processo recém-iniciado.
  const registros = await policy.readAudit();
  assert.ok(registros.length >= 1);
  assert.equal(registros.at(-1).comando, 'git status');
  assert.ok(fs.existsSync(process.env.JARVIS_COMMAND_AUDIT_PATH));
});

test('execução real registra auditoria com status e duração', { skip: !ehWindows }, async () => {
  const resultado = await policy.runCommand('Write-Output ola', { cwd: os.tmpdir(), timeoutMs: 20_000 });
  assert.equal(resultado.status, 'ok');
  assert.equal(resultado.exitCode, 0);
  assert.match(resultado.stdout, /ola/);

  const registros = await policy.readAudit();
  const ultimo = registros.at(-1);
  assert.equal(ultimo.status, 'ok');
  assert.equal(typeof ultimo.duracaoMs, 'number');
});

test('timeout encerra o processo e não deixa órfão', { skip: !ehWindows }, async () => {
  const inicio = Date.now();
  const resultado = await policy.runCommand('Start-Sleep -Seconds 30', { cwd: os.tmpdir(), timeoutMs: 2_000 });
  const decorrido = Date.now() - inicio;

  assert.equal(resultado.status, 'timeout');
  assert.ok(decorrido < 20_000, `deveria encerrar rápido, levou ${decorrido}ms`);
});

test('cancelamento encerra a árvore de processos', { skip: !ehWindows }, async () => {
  const controle = new AbortController();
  setTimeout(() => controle.abort(), 800);

  const inicio = Date.now();
  // O filho gera um neto: matar só o pai deixaria o neto rodando.
  const resultado = await policy.runCommand(
    'Start-Process powershell -ArgumentList "-Command","Start-Sleep -Seconds 30" -NoNewWindow; Start-Sleep -Seconds 30',
    { cwd: os.tmpdir(), timeoutMs: 25_000, signal: controle.signal },
  );
  const decorrido = Date.now() - inicio;

  assert.equal(resultado.status, 'cancelado');
  assert.ok(decorrido < 20_000, `cancelamento deveria ser rápido, levou ${decorrido}ms`);
});

test.after(() => fs.rmSync(auditRoot, { recursive: true, force: true }));
