const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const git = require('./git-workspace');

const execFileAsync = promisify(execFile);

// Repositório real em pasta temporária: o valor deste módulo está em falar com
// o Git de verdade, então simular a saída dele provaria pouco.
async function repositorioTemporario() {
  const bruto = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-git-'));
  const raiz = await fs.realpath(bruto);
  await execFileAsync('git', ['init', '--initial-branch=principal'], { cwd: raiz });
  await execFileAsync('git', ['config', 'user.email', 'teste@jarvis.local'], { cwd: raiz });
  await execFileAsync('git', ['config', 'user.name', 'Teste JARVIS'], { cwd: raiz });
  return raiz;
}

async function commitInicial(raiz) {
  await fs.writeFile(path.join(raiz, 'inicial.txt'), 'base\n', 'utf8');
  await execFileAsync('git', ['add', '--', 'inicial.txt'], { cwd: raiz });
  await execFileAsync('git', ['commit', '-m', 'inicial'], { cwd: raiz });
}

test('pasta sem repositório recebe mensagem clara em vez de erro', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-sem-git-'));
  const status = await git.status(raiz);
  assert.equal(status.repositorio, false);
  assert.match(status.motivo, /git init/i);
  await fs.rm(raiz, { recursive: true, force: true });
});

test('subpasta de monorepo mostra e commita somente o workspace aberto', async () => {
  const raiz = await repositorioTemporario();
  await fs.mkdir(path.join(raiz, 'app'));
  await fs.writeFile(path.join(raiz, 'app', 'dentro.txt'), 'base\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'fora.txt'), 'base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: raiz });
  await execFileAsync('git', ['commit', '-m', 'base do monorepo'], { cwd: raiz });

  const workspace = path.join(raiz, 'app');
  await fs.writeFile(path.join(workspace, 'dentro.txt'), 'alterado\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'fora.txt'), 'alterado fora\n', 'utf8');

  const status = await git.status(workspace);
  assert.equal(status.subpastaDeRepositorio, true);
  assert.deepEqual(status.naoPreparados.map((item) => item.path), ['dentro.txt']);

  await git.stage(workspace, ['dentro.txt']);
  await execFileAsync('git', ['add', '--', 'fora.txt'], { cwd: raiz });
  await assert.rejects(
    git.commit(workspace, 'fix: altera somente o app'),
    /fora do projeto aberto/i,
    'o commit nao pode incluir silenciosamente o index de outra pasta',
  );

  await execFileAsync('git', ['restore', '--staged', '--', 'fora.txt'], { cwd: raiz });
  const resultado = await git.commit(workspace, 'fix: altera somente o app');
  assert.deepEqual(resultado.arquivos, ['dentro.txt']);
  const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: raiz });
  assert.deepEqual(stdout.trim().split('\n'), ['app/dentro.txt']);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('status mostra branch e classifica modificado, novo e removido', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);

  await fs.writeFile(path.join(raiz, 'inicial.txt'), 'base alterada\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'novo.txt'), 'conteúdo novo\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'some.txt'), 'vai sumir\n', 'utf8');
  await execFileAsync('git', ['add', '--', 'some.txt'], { cwd: raiz });
  await execFileAsync('git', ['commit', '-m', 'some'], { cwd: raiz });
  await fs.rm(path.join(raiz, 'some.txt'));

  const status = await git.status(raiz);
  assert.equal(status.repositorio, true);
  assert.equal(status.branch, 'principal');
  assert.equal(status.limpo, false);

  const modificado = status.naoPreparados.find((item) => item.path === 'inicial.txt');
  const removido = status.naoPreparados.find((item) => item.path === 'some.txt');
  const novo = status.naoRastreados.find((item) => item.path === 'novo.txt');
  assert.equal(modificado.estado, 'modificado');
  assert.equal(removido.estado, 'removido');
  assert.ok(novo, 'arquivo novo aparece como não rastreado');

  await fs.rm(raiz, { recursive: true, force: true });
});

test('stage e unstage mexem apenas nos arquivos selecionados', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);
  await fs.writeFile(path.join(raiz, 'um.txt'), 'um\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'dois.txt'), 'dois\n', 'utf8');

  const preparado = await git.stage(raiz, ['um.txt']);
  assert.deepEqual(preparado.staged.map((item) => item.path), ['um.txt']);
  assert.deepEqual(preparado.naoRastreados.map((item) => item.path), ['dois.txt'], 'o não selecionado fica de fora');

  const desfeito = await git.unstage(raiz, ['um.txt']);
  assert.deepEqual(desfeito.staged, []);
  assert.deepEqual(
    desfeito.naoRastreados.map((item) => item.path).sort(),
    ['dois.txt', 'um.txt'],
    'unstage devolve o arquivo ao estado anterior',
  );

  await fs.rm(raiz, { recursive: true, force: true });
});

test('o diff preserva acentuação e finais de linha CRLF', async () => {
  const raiz = await repositorioTemporario();
  // core.autocrlf desligado no repositório de teste: sem isso o Git
  // normalizaria as quebras e o teste não provaria nada sobre CRLF.
  await execFileAsync('git', ['config', 'core.autocrlf', 'false'], { cwd: raiz });

  await fs.writeFile(path.join(raiz, 'crlf.txt'), 'primeira linha\r\nsegunda linha\r\n', 'utf8');
  await execFileAsync('git', ['add', '--', 'crlf.txt'], { cwd: raiz });
  await execFileAsync('git', ['commit', '-m', 'crlf'], { cwd: raiz });

  await fs.writeFile(path.join(raiz, 'crlf.txt'), 'primeira linha\r\nsegunda linha modificada com ação\r\n', 'utf8');

  const resultado = await git.diff(raiz, { path: 'crlf.txt' });
  assert.match(resultado.diff, /segunda linha modificada com ação/, 'a acentuação chega intacta');
  assert.ok(resultado.diff.includes('\r\n'), 'o CR do arquivo sobrevive no diff');
  assert.ok(
    resultado.diff.split('\n').some((linha) => linha.startsWith('-primeira') === false),
    'a linha inalterada não vira remoção',
  );

  await fs.rm(raiz, { recursive: true, force: true });
});

test('arquivo novo tem diff completo mesmo sem lado anterior no Git', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);
  await fs.writeFile(path.join(raiz, 'novo.md'), '# título\n\ncorpo\n', 'utf8');

  const resultado = await git.diff(raiz, { path: 'novo.md', untracked: true });
  assert.equal(resultado.novo, true);
  assert.match(resultado.diff, /\+# título/);
  assert.match(resultado.diff, /\+corpo/);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('commit usa exatamente o escopo preparado e nunca o resto', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);
  await fs.writeFile(path.join(raiz, 'entra.txt'), 'entra\n', 'utf8');
  await fs.writeFile(path.join(raiz, 'fica-fora.txt'), 'fora\n', 'utf8');
  await git.stage(raiz, ['entra.txt']);

  const escopo = await git.escopoDoCommit(raiz);
  assert.deepEqual(escopo.arquivos.map((item) => item.path), ['entra.txt']);

  const resultado = await git.commit(raiz, 'feat: adiciona entra');
  assert.deepEqual(resultado.arquivos, ['entra.txt']);
  assert.ok(resultado.sha);

  const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: raiz });
  assert.deepEqual(stdout.trim().split('\n'), ['entra.txt'], 'o commit contém só o que foi preparado');
  assert.deepEqual(resultado.status.naoRastreados.map((item) => item.path), ['fica-fora.txt']);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('commit sem escopo, sem mensagem ou com conflito é recusado', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);

  await assert.rejects(git.commit(raiz, '   '), /mensagem de commit/i);
  await assert.rejects(git.commit(raiz, 'mensagem válida'), /Nenhum arquivo preparado/i);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('estado de merge é reportado para a interface avisar', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);

  await execFileAsync('git', ['checkout', '-b', 'lateral'], { cwd: raiz });
  await fs.writeFile(path.join(raiz, 'inicial.txt'), 'versão lateral\n', 'utf8');
  await execFileAsync('git', ['commit', '-am', 'lateral'], { cwd: raiz });
  await execFileAsync('git', ['checkout', 'principal'], { cwd: raiz });
  await fs.writeFile(path.join(raiz, 'inicial.txt'), 'versão principal\n', 'utf8');
  await execFileAsync('git', ['commit', '-am', 'principal'], { cwd: raiz });

  // Merge conflitante de propósito: o Git para no meio e deixa MERGE_HEAD.
  await execFileAsync('git', ['merge', 'lateral'], { cwd: raiz }).catch(() => {});

  const status = await git.status(raiz);
  assert.equal(status.estado, 'merge');
  assert.ok(status.conflitos.length >= 1, 'o arquivo em conflito aparece na lista');
  await assert.rejects(git.commit(raiz, 'tentando commitar no meio do merge'), /conflitos/i);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('caminhos fora do projeto nunca viram argumento do Git', async () => {
  const raiz = await repositorioTemporario();
  await commitInicial(raiz);

  assert.throws(() => git.caminhoConfinado(raiz, '../fora.txt'), /sai do projeto/i);
  assert.throws(() => git.caminhoConfinado(raiz, 'C:/Windows/system32/x.txt'), /caminho relativo/i);
  await assert.rejects(git.stage(raiz, ['../fora.txt']), /sai do projeto/i);
  await assert.rejects(git.diff(raiz, { path: '../fora.txt' }), /sai do projeto/i);
  await assert.rejects(git.stage(raiz, []), /ao menos um arquivo/i);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('repositório recém-criado, ainda sem commits, não quebra o painel', async () => {
  const raiz = await repositorioTemporario();
  await fs.writeFile(path.join(raiz, 'primeiro.txt'), 'primeiro\n', 'utf8');

  const status = await git.status(raiz);
  assert.equal(status.repositorio, true);
  assert.equal(status.semCommits, true);

  // Sem HEAD, `restore --staged` falharia; o unstage precisa do outro caminho.
  await git.stage(raiz, ['primeiro.txt']);
  const depois = await git.unstage(raiz, ['primeiro.txt']);
  assert.deepEqual(depois.naoRastreados.map((item) => item.path), ['primeiro.txt']);

  await fs.rm(raiz, { recursive: true, force: true });
});
