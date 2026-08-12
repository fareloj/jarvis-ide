const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backupRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backup-'));
process.env.JARVIS_BACKUP_PATH = backupRoot;
const fileWrite = require('./file-write');
const { requestTool, resolveApproval } = require('./tool-registry');

async function projetoTemporario() {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-write-'));
  return fs.realpath(raiz); // no Windows o tmpdir costuma ser um caminho curto (8.3)
}

test('recusa path traversal, caminho absoluto e extensão não permitida', async () => {
  const raiz = await projetoTemporario();

  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: '../fora.txt', content: 'x' }),
    /sai do projeto/i,
  );
  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: 'a/../../fora.txt', content: 'x' }),
    /sai do projeto/i,
  );
  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: 'C:/Windows/system32/x.txt', content: 'x' }),
    /caminho relativo/i,
  );
  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: 'programa.exe', content: 'x' }),
    /Extensão não permitida/i,
  );

  await fs.rm(raiz, { recursive: true, force: true });
});

test('recusa symlink que aponta para fora do projeto', async (context) => {
  const raiz = await projetoTemporario();
  const fora = await projetoTemporario();
  await fs.writeFile(path.join(fora, 'alvo.txt'), 'segredo', 'utf8');

  let criouLink = true;
  try {
    // No Windows, criar link simbólico costuma exigir privilégio; o teste
    // se adapta em vez de falhar por causa do ambiente.
    await fs.symlink(fora, path.join(raiz, 'atalho'), 'junction');
  } catch {
    criouLink = false;
  }
  if (!criouLink) {
    context.skip('sem permissão para criar junction neste ambiente');
    return;
  }

  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: 'atalho/alvo.txt', content: 'invadido' }),
    /fora do projeto através de um link/i,
  );
  assert.equal(await fs.readFile(path.join(fora, 'alvo.txt'), 'utf8'), 'segredo', 'o arquivo externo não pode ser tocado');

  await fs.rm(raiz, { recursive: true, force: true });
  await fs.rm(fora, { recursive: true, force: true });
});

test('junction criada entre o plano e a gravação bloqueia a escrita', async (context) => {
  const raiz = await projetoTemporario();
  const fora = await projetoTemporario();
  await fs.mkdir(path.join(raiz, 'src'));
  // Mesmo conteúdo dos dois lados: só a revalidação de caminho pode barrar,
  // porque a checagem de hash passaria sem notar a troca de destino.
  await fs.writeFile(path.join(raiz, 'src', 'alvo.js'), 'base\n', 'utf8');
  await fs.writeFile(path.join(fora, 'alvo.js'), 'base\n', 'utf8');

  const plano = await fileWrite.planWrite({ projectPath: raiz, path: 'src/alvo.js', content: 'gravado\n' });

  // O diretório aprovado vira um link para fora do projeto depois do plano.
  await fs.rm(path.join(raiz, 'src'), { recursive: true, force: true });
  let criouLink = true;
  try {
    await fs.symlink(fora, path.join(raiz, 'src'), 'junction');
  } catch {
    criouLink = false;
  }
  if (!criouLink) {
    context.skip('sem permissão para criar junction neste ambiente');
    return;
  }

  await assert.rejects(fileWrite.applyWrite(plano), /link|mudou de destino/i);
  assert.equal(await fs.readFile(path.join(fora, 'alvo.js'), 'utf8'), 'base\n', 'o arquivo externo não pode ser tocado');

  await fs.rm(path.join(raiz, 'src'), { recursive: true, force: true });
  await fs.rm(raiz, { recursive: true, force: true });
  await fs.rm(fora, { recursive: true, force: true });
});

test('planejar não altera o disco; o diff corresponde ao que será gravado', async () => {
  const raiz = await projetoTemporario();
  const arquivo = path.join(raiz, 'nota.md');
  await fs.writeFile(arquivo, 'linha um\nlinha dois\n', 'utf8');

  const plano = await fileWrite.planWrite({
    projectPath: raiz, path: 'nota.md', content: 'linha um\nlinha nova\n',
  });

  assert.equal(await fs.readFile(arquivo, 'utf8'), 'linha um\nlinha dois\n', 'planejar não pode gravar');
  assert.equal(plano.tipo, 'atualizar');
  assert.match(plano.diff, /-linha dois/);
  assert.match(plano.diff, /\+linha nova/);
  assert.equal(plano.adicionadas, 1);
  assert.equal(plano.removidas, 1);

  await fileWrite.applyWrite(plano);
  const gravado = await fs.readFile(arquivo, 'utf8');
  assert.equal(gravado, plano.conteudo, 'o conteúdo aplicado é exatamente o do plano');
  assert.equal(fileWrite.hashOf(gravado), plano.hashNovo);

  await fs.rm(raiz, { recursive: true, force: true });
});

test('criar arquivo novo é reportado como criação', async () => {
  const raiz = await projetoTemporario();
  const plano = await fileWrite.planWrite({ projectPath: raiz, path: 'src/novo.js', content: 'export default 1;\n' });
  assert.equal(plano.tipo, 'criar');
  assert.equal(plano.hashBase, null);
  assert.match(plano.diff, /--- \/dev\/null/);

  await fileWrite.applyWrite(plano);
  assert.equal(await fs.readFile(path.join(raiz, 'src', 'novo.js'), 'utf8'), 'export default 1;\n');
  await fs.rm(raiz, { recursive: true, force: true });
});

test('alteração concorrente vira conflito em vez de sobrescrita', async () => {
  const raiz = await projetoTemporario();
  const arquivo = path.join(raiz, 'config.json');
  await fs.writeFile(arquivo, '{"a":1}', 'utf8');

  const plano = await fileWrite.planWrite({ projectPath: raiz, path: 'config.json', content: '{"a":2}' });

  // Alguém edita o arquivo entre o plano e a gravação.
  await fs.writeFile(arquivo, '{"a":99}', 'utf8');

  await assert.rejects(fileWrite.applyWrite(plano), /mudou entre a aprovação e a gravação/i);
  assert.equal(await fs.readFile(arquivo, 'utf8'), '{"a":99}', 'a edição de terceiro é preservada');

  // O mesmo vale no planejamento, quando o chamador informa o hash base.
  await assert.rejects(
    fileWrite.planWrite({ projectPath: raiz, path: 'config.json', content: '{"a":3}', baseHash: plano.hashBase }),
    /mudou depois que esta alteração foi proposta/i,
  );

  await fs.rm(raiz, { recursive: true, force: true });
});

test('desfazer restaura o conteúdo anterior', async () => {
  const raiz = await projetoTemporario();
  const arquivo = path.join(raiz, 'texto.txt');
  await fs.writeFile(arquivo, 'original', 'utf8');

  const plano = await fileWrite.planWrite({ projectPath: raiz, path: 'texto.txt', content: 'alterado' });
  const aplicado = await fileWrite.applyWrite(plano);
  assert.equal(await fs.readFile(arquivo, 'utf8'), 'alterado');

  await fileWrite.undoWrite(aplicado.backupId);
  assert.equal(await fs.readFile(arquivo, 'utf8'), 'original');

  await fs.rm(raiz, { recursive: true, force: true });
});

test('patch limita a quantidade de arquivos por operação', async () => {
  const raiz = await projetoTemporario();
  const demais = Array.from({ length: fileWrite.MAX_FILES_PER_OPERATION + 1 }, (_, i) => ({
    path: `arquivo-${i}.txt`, content: 'x',
  }));
  await assert.rejects(fileWrite.planPatch({ projectPath: raiz, files: demais }), /Máximo de/i);
  await fs.rm(raiz, { recursive: true, force: true });
});

test('a tool de escrita exige aprovação e nada muda quando recusada', async () => {
  const raiz = await projetoTemporario();
  const arquivo = path.join(raiz, 'app.js');
  await fs.writeFile(arquivo, 'const a = 1;\n', 'utf8');

  const pedido = await requestTool(
    'project_write_file',
    { path: 'app.js', content: 'const a = 2;\n' },
    { projectPath: raiz },
  );
  assert.equal(pedido.status, 'approval_required');
  assert.ok(pedido.approval.diff, 'a aprovação precisa mostrar o diff');
  assert.match(pedido.approval.diff, /\+const a = 2;/);
  assert.equal(await fs.readFile(arquivo, 'utf8'), 'const a = 1;\n', 'nada muda antes da aprovação');

  const recusado = await resolveApproval(pedido.approval.id, false);
  assert.equal(recusado.status, 'denied');
  assert.equal(await fs.readFile(arquivo, 'utf8'), 'const a = 1;\n', 'recusar não pode gravar');

  const outro = await requestTool(
    'project_write_file',
    { path: 'app.js', content: 'const a = 3;\n' },
    { projectPath: raiz },
  );
  const aprovado = await resolveApproval(outro.approval.id, true);
  assert.equal(aprovado.status, 'completed');
  assert.equal(await fs.readFile(arquivo, 'utf8'), 'const a = 3;\n');

  await fs.rm(raiz, { recursive: true, force: true });
});

test('chamar a tool de escrita sem aprovação é recusado', async () => {
  const raiz = await projetoTemporario();
  const { runTool } = require('./tool-registry');
  await assert.rejects(
    runTool('project_write_file', { path: 'x.txt', content: 'y' }, { projectPath: raiz }),
    /exige aprovação/i,
  );
  await fs.rm(raiz, { recursive: true, force: true });
});

test.after(() => fsSync.rmSync(backupRoot, { recursive: true, force: true }));
