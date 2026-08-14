const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {
  searchProjectText,
  planSearchReplace,
  applySearchReplace,
  matchPattern,
  buildSearchRegex,
} = require('./search-engine');

test('matchPattern filtra caminhos por extensão e glob', () => {
  assert.equal(matchPattern('src/app.js', '*.js'), true);
  assert.equal(matchPattern('src/app.ts', '*.js'), false);
  assert.equal(matchPattern('backend/routes/api.js', '*.js'), true);
  assert.equal(matchPattern('docs/README.md', '*.md, *.txt'), true);
  assert.equal(matchPattern('docs/README.md', '*.txt'), false);
  assert.equal(matchPattern('src/components/Button.jsx', 'src/**'), true);
  assert.equal(matchPattern('public/index.html', 'src/**'), false);
});

test('buildSearchRegex constrói expressões com flags apropriadas', () => {
  const r1 = buildSearchRegex('teste', { isRegex: false, isCaseSensitive: false, isWholeWord: false });
  assert.equal(r1.flags, 'gi');
  assert.ok(r1.test('TESTE'));

  const r2 = buildSearchRegex('teste', { isRegex: false, isCaseSensitive: true, isWholeWord: false });
  assert.equal(r2.flags, 'g');
  assert.equal(r2.test('TESTE'), false);

  const r3 = buildSearchRegex('palavra', { isRegex: false, isWholeWord: true });
  assert.ok(r3.test('uma palavra aqui'));
  assert.equal(r3.test('uma palavreado aqui'), false);

  const r4 = buildSearchRegex('f[a-z]+o', { isRegex: true });
  assert.ok(r4.test('fluxo'));
});

test('busca textual encontra texto, arquivo e linha corretos em subpastas', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-search-test-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  await fs.mkdir(path.join(tempDir, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(tempDir, '.git', 'hooks'), { recursive: true });

  await fs.writeFile(
    path.join(tempDir, 'src', 'app.js'),
    '// Arquivo principal\nconst message = "Olá JARVIS";\nconsole.log(message);\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(tempDir, 'src', 'components', 'Header.js'),
    'export function Header() {\n  return "JARVIS Header";\n}\n',
    'utf8'
  );
  // Arquivos em node_modules e .git devem ser ignorados
  await fs.writeFile(
    path.join(tempDir, 'node_modules', 'pkg', 'index.js'),
    'const hidden = "JARVIS escondido";',
    'utf8'
  );
  await fs.writeFile(
    path.join(tempDir, '.git', 'hooks', 'hook.sh'),
    '# JARVIS hook',
    'utf8'
  );

  const result = await searchProjectText({
    projectPath: tempDir,
    query: 'JARVIS',
  });

  assert.equal(result.totalMatches, 2);
  assert.equal(result.fileCount, 2);
  assert.equal(result.truncated, false);

  const paths = result.results.map((r) => r.path);
  assert.ok(paths.includes('src/app.js'));
  assert.ok(paths.includes('src/components/Header.js'));
  assert.ok(!paths.some((p) => p.includes('node_modules')));
  assert.ok(!paths.some((p) => p.includes('.git')));

  const appMatch = result.results.find((r) => r.path === 'src/app.js');
  assert.equal(appMatch.line, 2);
  assert.equal(appMatch.matchText, 'JARVIS');
  assert.ok(appMatch.lineContent.includes('const message = "Olá JARVIS";'));
});

test('busca respeita limites e trunca quando atinge maxResults', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-search-limit-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  const lines = Array.from({ length: 50 }, (_, i) => `item_${i} = TOKEN_ALVO;`).join('\n');
  await fs.writeFile(path.join(tempDir, 'test.js'), lines, 'utf8');

  const result = await searchProjectText({
    projectPath: tempDir,
    query: 'TOKEN_ALVO',
    maxResults: 10,
  });

  assert.equal(result.totalMatches, 10);
  assert.equal(result.results.length, 10);
  assert.equal(result.truncated, true);
});

test('substituição planeja patch com preview e aplica transacionalmente em múltiplos arquivos', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-replace-test-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'src', 'file1.js'), 'const nome = "antigo_valor";\n', 'utf8');
  await fs.writeFile(path.join(tempDir, 'src', 'file2.js'), 'let config = "antigo_valor";\n', 'utf8');

  // 1. Planeja substituição (não altera o disco)
  const plan = await planSearchReplace({
    projectPath: tempDir,
    query: 'antigo_valor',
    replacement: 'novo_valor',
  });

  assert.equal(plan.fileCount, 2);
  assert.equal(plan.totalMatches, 2);
  assert.ok(plan.diff.includes('-const nome = "antigo_valor";'));
  assert.ok(plan.diff.includes('+const nome = "novo_valor";'));

  // Confirma que os arquivos ainda têm o conteúdo antigo
  assert.equal(await fs.readFile(path.join(tempDir, 'src', 'file1.js'), 'utf8'), 'const nome = "antigo_valor";\n');

  // 2. Aplica o patch transacionalmente
  const applied = await applySearchReplace(plan.planos);
  assert.equal(applied.length, 2);

  // Confirma que os arquivos foram atualizados no disco
  assert.equal(await fs.readFile(path.join(tempDir, 'src', 'file1.js'), 'utf8'), 'const nome = "novo_valor";\n');
  assert.equal(await fs.readFile(path.join(tempDir, 'src', 'file2.js'), 'utf8'), 'let config = "novo_valor";\n');
});

test('substituição com regex suporta grupos de captura', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-regex-replace-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  await fs.writeFile(path.join(tempDir, 'sample.js'), 'const id = "user_12345";\n', 'utf8');

  const plan = await planSearchReplace({
    projectPath: tempDir,
    query: 'user_(\\d+)',
    replacement: 'account_$1',
    isRegex: true,
  });

  assert.equal(plan.fileCount, 1);
  assert.ok(plan.diff.includes('+const id = "account_12345";'));

  await applySearchReplace(plan.planos);
  assert.equal(await fs.readFile(path.join(tempDir, 'sample.js'), 'utf8'), 'const id = "account_12345";\n');
});
