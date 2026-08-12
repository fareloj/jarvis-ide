// Escrita e patch estruturados para o agente.
//
// Substitui o caminho antigo (pedir ao modelo que rode PowerShell ou delegue
// a um CLI externo) por uma operacao verificavel: o plano e' calculado sem
// tocar no disco, aprovado com o diff exato a' vista, e so' entao aplicado.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES_PER_OPERATION = 20;
const BACKUP_ROOT = path.resolve(
  process.env.JARVIS_BACKUP_PATH || path.join(__dirname, '..', 'data', 'backups'),
);

// Mesma lista da leitura, mais os formatos que o agente costuma gerar.
const WRITABLE_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.conf', '.cpp', '.cs', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.less', '.md', '.mjs', '.php', '.py', '.rb',
  '.rs', '.scss', '.sh', '.sql', '.svelte', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml',
  '.yaml', '.yml',
]);
const WRITABLE_FILENAMES = new Set([
  'dockerfile', 'makefile', '.editorconfig', '.gitignore', '.npmrc', '.gitattributes',
]);

function isWritableName(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return WRITABLE_FILENAMES.has(name) || WRITABLE_EXTENSIONS.has(path.extname(name));
}

/**
 * Confina o caminho ao workspace resolvendo links de verdade.
 *
 * path.resolve sozinho barra `..` e caminho absoluto, mas nao enxerga
 * symlink nem junction: um link criado dentro do projeto apontando para
 * C:\Windows passaria na checagem textual. Aqui resolvemos o ancestral
 * existente mais profundo com realpath e comparamos o resultado real.
 */
async function resolveWritableTarget(projectPath, relativePath) {
  const raiz = path.resolve(String(projectPath || ''));
  if (!raiz || raiz === '.') throw new Error('Nenhum projeto aberto para escrita.');
  const pedido = String(relativePath || '').trim();
  if (!pedido) throw new Error('Informe o caminho do arquivo.');
  if (path.isAbsolute(pedido)) throw new Error('Use um caminho relativo ao projeto aberto.');

  const alvo = path.resolve(raiz, pedido);
  const relativo = path.relative(raiz, alvo);
  if (relativo.startsWith('..') || path.isAbsolute(relativo)) {
    throw new Error('O caminho sai do projeto aberto.');
  }

  const raizReal = await fs.realpath(raiz);

  // Sobe ate' achar um ancestral que exista: o proprio arquivo pode ainda
  // nao ter sido criado, mas o diretorio que o contem precisa ser real.
  let existente = alvo;
  const criados = [];
  for (;;) {
    try {
      await fs.stat(existente);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      criados.push(path.basename(existente));
      const pai = path.dirname(existente);
      if (pai === existente) throw new Error('Caminho inválido.');
      existente = pai;
    }
  }

  const existenteReal = await fs.realpath(existente);
  const dentro = existenteReal === raizReal
    || existenteReal.startsWith(raizReal + path.sep);
  if (!dentro) {
    throw new Error('O caminho aponta para fora do projeto através de um link.');
  }

  if (!isWritableName(alvo)) {
    throw new Error(`Extensão não permitida para escrita: ${path.basename(alvo)}`);
  }

  return { raiz: raizReal, alvo: path.join(existenteReal, ...criados.reverse()), relativo };
}

function hashOf(conteudo) {
  return crypto.createHash('sha256').update(conteudo ?? '', 'utf8').digest('hex');
}

// Escrita atomica: grava num temporario ao lado do destino e troca por
// rename. fs.writeFile direto trunca o arquivo antes de escrever — uma queda
// de energia, um erro de disco ou o proprio processo morrendo no meio deixam
// o arquivo do usuario truncado ou vazio. Com rename, quem le ve' o conteudo
// antigo inteiro ou o novo inteiro, nunca um estado intermediario. O
// temporario fica no mesmo diretorio para que o rename seja no mesmo volume.
async function writeAtomic(alvo, conteudo) {
  const temporario = path.join(
    path.dirname(alvo),
    `.jarvis-tmp-${crypto.randomBytes(8).toString('hex')}`,
  );
  try {
    await fs.writeFile(temporario, conteudo, 'utf8');
    await fs.rename(temporario, alvo);
  } catch (error) {
    await fs.rm(temporario, { force: true });
    throw error;
  }
}

async function readIfExists(alvo) {
  try {
    return await fs.readFile(alvo, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Diff unificado por linhas via LCS. Escrito aqui em vez de trazer uma
// dependencia: sao ~40 linhas e o formato precisa casar exatamente com o
// conteudo aplicado, que e' um criterio de aceite.
function unifiedDiff(antes, depois, rotulo) {
  const a = antes === null ? [] : antes.split('\n');
  const b = depois.split('\n');
  const tabela = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      tabela[i][j] = a[i] === b[j] ? tabela[i + 1][j + 1] + 1 : Math.max(tabela[i + 1][j], tabela[i][j + 1]);
    }
  }

  const linhas = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { linhas.push(` ${a[i]}`); i += 1; j += 1; }
    else if (tabela[i + 1][j] >= tabela[i][j + 1]) { linhas.push(`-${a[i]}`); i += 1; }
    else { linhas.push(`+${b[j]}`); j += 1; }
  }
  while (i < a.length) { linhas.push(`-${a[i]}`); i += 1; }
  while (j < b.length) { linhas.push(`+${b[j]}`); j += 1; }

  const adicionadas = linhas.filter((l) => l.startsWith('+')).length;
  const removidas = linhas.filter((l) => l.startsWith('-')).length;
  const cabecalho = antes === null ? `--- /dev/null\n+++ ${rotulo}` : `--- ${rotulo}\n+++ ${rotulo}`;
  return { texto: `${cabecalho}\n${linhas.join('\n')}`, adicionadas, removidas };
}

/**
 * Calcula o efeito de uma escrita SEM tocar no disco. O retorno alimenta a
 * tela de aprovacao; nada muda enquanto o usuario nao aprovar.
 */
async function planWrite({ projectPath, path: caminho, content, baseHash } = {}) {
  const { raiz, alvo, relativo } = await resolveWritableTarget(projectPath, caminho);
  const novo = String(content ?? '');
  if (Buffer.byteLength(novo, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`Conteúdo acima do limite de ${MAX_FILE_BYTES / 1_000_000} MB.`);
  }

  const atual = await readIfExists(alvo);
  const hashAtual = atual === null ? null : hashOf(atual);

  // Sem isto, dois agentes (ou o usuario no editor) sobrescreveriam um ao
  // outro em silencio. Com o hash base, a segunda escrita vira conflito.
  if (baseHash !== undefined && baseHash !== null && baseHash !== hashAtual) {
    const erro = new Error('O arquivo mudou depois que esta alteração foi proposta.');
    erro.code = 'CONFLITO';
    erro.hashAtual = hashAtual;
    throw erro;
  }

  const diff = unifiedDiff(atual, novo, relativo);
  return {
    tipo: atual === null ? 'criar' : 'atualizar',
    path: relativo,
    raiz,
    alvo,
    conteudo: novo,
    hashBase: hashAtual,
    hashNovo: hashOf(novo),
    diff: diff.texto,
    adicionadas: diff.adicionadas,
    removidas: diff.removidas,
    inalterado: atual === novo,
  };
}

// Registra como desfazer a escrita ANTES de aplicá-la. Atualização guarda
// uma cópia do conteúdo anterior; criação guarda apenas o hash que sera'
// gravado, porque desfazer uma criacao e' apagar o arquivo — e so' podemos
// apagar se ninguem tiver escrito nele depois.
async function backup(plano) {
  await fs.mkdir(BACKUP_ROOT, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  if (plano.hashBase !== null) {
    await fs.copyFile(plano.alvo, path.join(BACKUP_ROOT, `${id}.bak`));
  }
  await fs.writeFile(
    path.join(BACKUP_ROOT, `${id}.json`),
    JSON.stringify({
      id,
      tipo: plano.tipo,
      path: plano.path,
      raiz: plano.raiz,
      alvo: plano.alvo,
      hashBase: plano.hashBase,
      hashAplicado: plano.hashNovo,
    }, null, 2),
    'utf8',
  );
  return id;
}

// Depois de apagar um arquivo criado, remove os diretorios que a criacao
// trouxe junto. rmdir falha em pasta nao vazia, entao a subida para sozinha
// no primeiro diretorio que ainda tem conteudo.
async function removerDiretoriosVazios(alvo, raiz) {
  let atual = path.dirname(alvo);
  while (atual.startsWith(raiz + path.sep)) {
    try {
      await fs.rmdir(atual);
    } catch {
      return;
    }
    atual = path.dirname(atual);
  }
}

/**
 * Revalida o caminho do plano no instante da gravacao.
 *
 * A checagem feita no planejamento envelhece: entre aprovar e gravar, um
 * diretorio do caminho pode virar junction ou symlink apontando para fora do
 * workspace (no Windows, criar junction nao exige privilegio de administrador).
 * O plano guarda a raiz real; aqui refazemos a resolucao e exigimos que o
 * destino continue sendo exatamente o mesmo arquivo aprovado.
 */
async function revalidateTarget(plano) {
  const { alvo } = await resolveWritableTarget(plano.raiz, plano.path);
  if (alvo !== plano.alvo) {
    const erro = new Error('O caminho aprovado mudou de destino antes da gravação.');
    erro.code = 'CAMINHO_ALTERADO';
    throw erro;
  }
  return alvo;
}

/**
 * Aplica um plano ja' aprovado. Revalida caminho e hash imediatamente antes
 * de escrever: entre a aprovacao e o clique, o arquivo pode ter mudado.
 */
async function applyWrite(plano) {
  await revalidateTarget(plano);
  const atual = await readIfExists(plano.alvo);
  const hashAtual = atual === null ? null : hashOf(atual);
  if (hashAtual !== plano.hashBase) {
    const erro = new Error('O arquivo mudou entre a aprovação e a gravação.');
    erro.code = 'CONFLITO';
    throw erro;
  }

  const backupId = await backup(plano);
  await fs.mkdir(path.dirname(plano.alvo), { recursive: true });
  await writeAtomic(plano.alvo, plano.conteudo);
  return { path: plano.path, tipo: plano.tipo, backupId, hash: plano.hashNovo };
}

/**
 * Desfaz uma escrita aplicada.
 *
 * Atualizacao volta ao conteudo salvo no backup. Criacao e' desfeita
 * apagando o arquivo, mas somente se o conteudo em disco ainda for
 * exatamente o que foi gravado: se alguem editou depois, apagar destruiria
 * trabalho que nunca fez parte desta operacao.
 */
async function undoWrite(backupId) {
  const meta = JSON.parse(await fs.readFile(path.join(BACKUP_ROOT, `${backupId}.json`), 'utf8'));

  if (meta.tipo === 'criar') {
    const atual = await readIfExists(meta.alvo);
    if (atual === null) return { path: meta.path, restaurado: true, removido: false };
    if (hashOf(atual) !== meta.hashAplicado) {
      const erro = new Error('O arquivo criado mudou depois da gravação; desfazer apagaria conteúdo novo.');
      erro.code = 'CONFLITO';
      throw erro;
    }
    await fs.unlink(meta.alvo);
    if (meta.raiz) await removerDiretoriosVazios(meta.alvo, meta.raiz);
    return { path: meta.path, restaurado: true, removido: true };
  }

  const conteudo = await fs.readFile(path.join(BACKUP_ROOT, `${backupId}.bak`), 'utf8');
  await writeAtomic(meta.alvo, conteudo);
  return { path: meta.path, restaurado: true, removido: false };
}

/** Varias escritas numa operacao so'. Planeja todas antes de aplicar qualquer uma. */
async function planPatch({ projectPath, files = [] } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Nenhum arquivo informado.');
  if (files.length > MAX_FILES_PER_OPERATION) {
    throw new Error(`Máximo de ${MAX_FILES_PER_OPERATION} arquivos por operação.`);
  }
  const planos = [];
  for (const arquivo of files) {
    planos.push(await planWrite({ projectPath, ...arquivo }));
  }
  return {
    planos,
    diff: planos.map((p) => p.diff).join('\n\n'),
    resumo: planos.map((p) => `${p.tipo} ${p.path} (+${p.adicionadas}/-${p.removidas})`),
  };
}

/**
 * Aplica um patch de varios arquivos como uma operacao unica.
 *
 * Aplicar em laco deixava o projeto num estado que o usuario nunca aprovou:
 * se o terceiro arquivo falhasse (conflito de hash, junction trocada, disco
 * cheio), os dois primeiros ficavam gravados e a metade da mudanca virava o
 * novo estado do repositorio. Aqui qualquer falha desfaz tudo o que ja' foi
 * gravado nesta operacao, na ordem inversa.
 */
async function applyPatch(planos) {
  const aplicados = [];
  try {
    for (const plano of planos) aplicados.push(await applyWrite(plano));
    return aplicados;
  } catch (error) {
    const revertidos = [];
    const naoRevertidos = [];
    for (const aplicado of [...aplicados].reverse()) {
      try {
        await undoWrite(aplicado.backupId);
        revertidos.push(aplicado.path);
      } catch (falha) {
        // Reverter tambem pode falhar (arquivo editado por terceiro no meio
        // do caminho). Nao engolimos: o usuario precisa saber o que sobrou.
        naoRevertidos.push(`${aplicado.path} (${falha.message})`);
      }
    }
    error.revertidos = revertidos;
    error.naoRevertidos = naoRevertidos;
    error.message = [
      error.message,
      revertidos.length ? `Alterações desfeitas: ${revertidos.join(', ')}.` : 'Nenhum arquivo chegou a ser alterado.',
      naoRevertidos.length ? `Não foi possível desfazer: ${naoRevertidos.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    throw error;
  }
}

module.exports = {
  BACKUP_ROOT,
  MAX_FILES_PER_OPERATION,
  MAX_FILE_BYTES,
  applyPatch,
  applyWrite,
  hashOf,
  revalidateTarget,
  planPatch,
  planWrite,
  resolveWritableTarget,
  undoWrite,
  unifiedDiff,
  writeAtomic,
};
