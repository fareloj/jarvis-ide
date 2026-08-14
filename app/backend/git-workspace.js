// Integracao Git do projeto aberto.
//
// A aba Diff mostrava um texto fixo. Aqui ela passa a ler o repositorio de
// verdade: branch, estado, arquivos alterados e o diff que o proprio Git
// produz. Tres regras moldam este modulo:
//
// 1. Nada de shell. Todo comando vai por execFile com argumentos em array, e
//    todo caminho vindo da interface e' confinado ao projeto antes de virar
//    argumento. `--` separa opcoes de caminhos para um arquivo chamado
//    `--force` nunca ser lido como flag.
// 2. Nenhuma escrita acontece sozinha. stage, unstage e commit existem como
//    funcoes chamadas por acao explicita do usuario na interface; o agente
//    nao recebe tool nenhuma daqui.
// 3. O diff sai como o Git escreveu. Nao normalizamos fim de linha nem
//    reencodamos: a saida e' lida em utf8 e entregue inteira.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const commandPolicy = require('./command-policy');

const MAX_BUFFER = 12_000_000;
const TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_DIFF_BYTES = 400_000;

// Estados que exigem aviso: um commit no meio de merge ou rebase e' outra
// operacao, com outro significado, e o usuario precisa saber onde esta'.
const ESTADOS_ESPECIAIS = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

class GitIndisponivel extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.code = 'GIT_INDISPONIVEL';
  }
}

function raizDoProjeto(projectPath) {
  const raiz = path.resolve(String(projectPath || ''));
  if (!projectPath || raiz === '.') throw new GitIndisponivel('Nenhum projeto aberto.');
  return raiz;
}

// Mesmo confinamento das tools de arquivo: um caminho que sai do projeto nao
// vira argumento de git, mesmo que a interface peca.
function caminhoConfinado(raiz, relativo) {
  const pedido = String(relativo || '').trim();
  if (!pedido) throw new Error('Informe o caminho do arquivo.');
  if (path.isAbsolute(pedido)) throw new Error('Use um caminho relativo ao projeto aberto.');
  const alvo = path.resolve(raiz, pedido);
  const relativoReal = path.relative(raiz, alvo);
  if (relativoReal.startsWith('..') || path.isAbsolute(relativoReal)) {
    throw new Error('O caminho sai do projeto aberto.');
  }
  return relativoReal.split(path.sep).join('/');
}

function executarGit(raiz, args, { permitirSaidaUm = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: raiz,
      // Sem os segredos do JARVIS, mas com o perfil do usuario: e' de la' que
      // o Git le' user.name, user.email e credenciais ja' configuradas.
      env: commandPolicy.delegateEnv(),
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    }, (erro, stdout, stderr) => {
      // `git diff` sai com 1 quando ha' diferencas: e' resultado, nao falha.
      if (erro && !(permitirSaidaUm && erro.code === 1)) {
        if (erro.code === 'ENOENT') {
          reject(new GitIndisponivel('O Git não está instalado ou não está no PATH deste computador.'));
          return;
        }
        const detalhe = String(stderr || erro.message || '').trim();
        reject(Object.assign(new Error(detalhe || 'Falha ao executar o Git.'), { stderr: detalhe }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function estadoEspecial(gitDir) {
  for (const [arquivo, estado] of ESTADOS_ESPECIAIS) {
    try {
      await fs.stat(path.join(gitDir, arquivo));
      return estado;
    } catch {
      // ausente: segue para o proximo
    }
  }
  return null;
}

const ROTULOS = {
  M: 'modificado', A: 'adicionado', D: 'removido', R: 'renomeado', C: 'copiado', U: 'em conflito',
};

function descrever(codigo) {
  return ROTULOS[codigo] || 'alterado';
}

function prefixoDoWorkspace(topo, workspace) {
  return path.relative(topo, workspace).split(path.sep).join('/');
}

function caminhoNoWorkspace(caminho, prefixo) {
  if (!prefixo) return caminho;
  const inicio = `${prefixo}/`;
  return caminho.startsWith(inicio) ? caminho.slice(inicio.length) : null;
}

function restringirAoWorkspace(analisado, prefixo) {
  const restringir = (itens) => itens.flatMap((item) => {
    const caminho = caminhoNoWorkspace(item.path, prefixo);
    if (caminho === null) return [];
    const origem = item.origem ? caminhoNoWorkspace(item.origem, prefixo) : item.origem;
    return [{ ...item, path: caminho, origem }];
  });
  return {
    ...analisado,
    staged: restringir(analisado.staged),
    naoPreparados: restringir(analisado.naoPreparados),
    naoRastreados: restringir(analisado.naoRastreados),
    conflitos: restringir(analisado.conflitos),
  };
}

// porcelain=v2 -z: registros separados por NUL. O formato v2 e' o unico que
// distingue com seguranca renomeacao, conflito e o estado de index x arvore
// sem depender de aspas e escapes no caminho.
function interpretarStatus(bruto) {
  const campos = bruto.split('\0');
  const info = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0 };
  const staged = [];
  const naoPreparados = [];
  const naoRastreados = [];
  const conflitos = [];

  for (let i = 0; i < campos.length; i += 1) {
    const linha = campos[i];
    if (!linha) continue;

    if (linha.startsWith('# branch.head ')) { info.branch = linha.slice(14); continue; }
    if (linha.startsWith('# branch.oid ')) { info.oid = linha.slice(13); continue; }
    if (linha.startsWith('# branch.upstream ')) { info.upstream = linha.slice(18); continue; }
    if (linha.startsWith('# branch.ab ')) {
      const [frente, tras] = linha.slice(12).split(' ');
      info.ahead = Number(frente) || 0;
      info.behind = Math.abs(Number(tras) || 0);
      continue;
    }
    if (linha.startsWith('#')) continue;

    const tipo = linha[0];
    if (tipo === '?') { naoRastreados.push({ path: linha.slice(2), estado: 'novo' }); continue; }
    if (tipo === '!') continue;

    if (tipo === 'u') {
      const partes = linha.split(' ');
      conflitos.push({ path: partes.slice(10).join(' '), estado: 'em conflito' });
      continue;
    }

    if (tipo === '1' || tipo === '2') {
      const partes = linha.split(' ');
      const xy = partes[1];
      const caminho = tipo === '1'
        ? partes.slice(8).join(' ')
        : partes.slice(9).join(' ');
      // Em renomeacao (tipo 2) o caminho de origem vem no campo seguinte.
      const origem = tipo === '2' ? campos[i + 1] : null;
      if (tipo === '2') i += 1;

      if (xy[0] !== '.') staged.push({ path: caminho, estado: descrever(xy[0]), origem });
      if (xy[1] !== '.') naoPreparados.push({ path: caminho, estado: descrever(xy[1]), origem });
      continue;
    }
  }

  return { info, staged, naoPreparados, naoRastreados, conflitos };
}

/** Branch, estado e arquivos alterados do projeto aberto. */
async function status(projectPath) {
  const raiz = raizDoProjeto(projectPath);

  let topo;
  try {
    const { stdout } = await executarGit(raiz, ['rev-parse', '--show-toplevel']);
    topo = stdout.trim();
  } catch (erro) {
    if (erro.code === 'GIT_INDISPONIVEL') throw erro;
    return {
      repositorio: false,
      motivo: 'Esta pasta não é um repositório Git. Rode `git init` para acompanhar as alterações aqui.',
    };
  }

  const { stdout: gitDirBruto } = await executarGit(raiz, ['rev-parse', '--absolute-git-dir']);
  const { stdout: statusBruto } = await executarGit(
    raiz,
    ['status', '--porcelain=v2', '--branch', '-z', '--', '.'],
  );
  const prefixo = prefixoDoWorkspace(path.resolve(topo), raiz);
  const analisado = restringirAoWorkspace(interpretarStatus(statusBruto), prefixo);
  const estado = await estadoEspecial(gitDirBruto.trim());

  // HEAD sem commit nenhum: `branch.oid` vem como "(initial)". Unstage por
  // `restore --staged` precisa de HEAD, entao o chamador tem de saber disso.
  const semCommits = !analisado.info.oid || analisado.info.oid === '(initial)';

  return {
    repositorio: true,
    raiz: path.resolve(topo),
    // Abrir uma subpasta de um repositorio maior e' legitimo, mas o status
    // passa a ser o do repositorio inteiro: a interface avisa.
    subpastaDeRepositorio: path.resolve(topo) !== raiz,
    branch: analisado.info.branch === '(detached)' ? 'HEAD desanexado' : analisado.info.branch,
    upstream: analisado.info.upstream,
    ahead: analisado.info.ahead,
    behind: analisado.info.behind,
    semCommits,
    estado,
    staged: analisado.staged,
    naoPreparados: analisado.naoPreparados,
    naoRastreados: analisado.naoRastreados,
    conflitos: analisado.conflitos,
    limpo: !analisado.staged.length && !analisado.naoPreparados.length
      && !analisado.naoRastreados.length && !analisado.conflitos.length,
  };
}

/**
 * Diff de um arquivo, exatamente como o Git escreve.
 *
 * Nao passamos por normalizacao: a saida e' devolvida inteira, com os fins de
 * linha que o Git emitiu. As conversoes de `core.autocrlf` do repositorio
 * continuam valendo, porque e' esse o diff que o usuario ve' no terminal.
 */
async function diff(projectPath, { path: relativo, staged = false, untracked = false } = {}) {
  const raiz = raizDoProjeto(projectPath);
  const alvo = caminhoConfinado(raiz, relativo);

  if (untracked) {
    // Arquivo novo nao tem lado anterior no Git; --no-index compara com
    // /dev/null e produz o mesmo formato dos demais diffs.
    const completo = path.resolve(raiz, alvo);
    const stat = await fs.stat(completo);
    if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
      return { path: alvo, diff: '', grande: true, tamanho: stat.size };
    }
    const { stdout } = await executarGit(
      raiz,
      ['diff', '--no-color', '--no-index', '--', '/dev/null', alvo],
      { permitirSaidaUm: true },
    );
    return { path: alvo, diff: stdout, novo: true };
  }

  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', alvo);
  const { stdout } = await executarGit(raiz, args, { permitirSaidaUm: true });
  return { path: alvo, diff: stdout, staged };
}

/** Prepara para commit apenas os caminhos informados. */
async function stage(projectPath, paths = []) {
  const raiz = raizDoProjeto(projectPath);
  const alvos = (Array.isArray(paths) ? paths : []).map((item) => caminhoConfinado(raiz, item));
  if (!alvos.length) throw new Error('Selecione ao menos um arquivo.');
  await executarGit(raiz, ['add', '--', ...alvos]);
  return status(projectPath);
}

/** Tira do index apenas os caminhos informados. */
async function unstage(projectPath, paths = []) {
  const raiz = raizDoProjeto(projectPath);
  const alvos = (Array.isArray(paths) ? paths : []).map((item) => caminhoConfinado(raiz, item));
  if (!alvos.length) throw new Error('Selecione ao menos um arquivo.');

  // Sem nenhum commit ainda nao existe HEAD para restaurar: `rm --cached`
  // devolve o arquivo ao estado de nao rastreado, que e' o equivalente.
  const atual = await status(projectPath);
  if (atual.semCommits) await executarGit(raiz, ['rm', '--cached', '-r', '--', ...alvos]);
  else await executarGit(raiz, ['restore', '--staged', '--', ...alvos]);
  return status(projectPath);
}

/** O que exatamente entra no commit, para a interface confirmar antes. */
async function escopoDoCommit(projectPath) {
  const atual = await status(projectPath);
  return {
    arquivos: atual.staged || [],
    branch: atual.branch,
    estado: atual.estado,
    conflitos: atual.conflitos || [],
  };
}

/** Cria o commit com o que ja' esta' preparado. Nunca faz push. */
async function commit(projectPath, message) {
  const raiz = raizDoProjeto(projectPath);
  const texto = String(message || '').trim();
  if (!texto) throw new Error('Escreva uma mensagem de commit.');

  const escopo = await escopoDoCommit(projectPath);
  if (escopo.conflitos.length) {
    throw new Error('Resolva os conflitos antes de commitar.');
  }
  if (!escopo.arquivos.length) {
    throw new Error('Nenhum arquivo preparado. Selecione o que deve entrar no commit.');
  }

  // Um commit inclui todo o index do repositorio. Se o workspace aberto for
  // apenas uma subpasta, recuse qualquer arquivo preparado fora dela para a
  // confirmacao da interface continuar descrevendo o escopo real.
  const { stdout: topoBruto } = await executarGit(raiz, ['rev-parse', '--show-toplevel']);
  const topo = path.resolve(topoBruto.trim());
  const prefixo = prefixoDoWorkspace(topo, raiz);
  if (prefixo) {
    const { stdout: completoBruto } = await executarGit(
      topo,
      ['status', '--porcelain=v2', '--branch', '-z'],
    );
    const completo = interpretarStatus(completoBruto);
    const fora = completo.staged.filter((item) => caminhoNoWorkspace(item.path, prefixo) === null);
    if (fora.length) {
      throw new Error(
        `Existem ${fora.length} arquivo(s) preparado(s) fora do projeto aberto. `
        + 'Retire-os do stage ou abra a raiz do repositorio antes de commitar.',
      );
    }
  }

  // -m com o texto como argumento separado: nada e' interpretado por shell.
  const { stdout } = await executarGit(raiz, ['commit', '-m', texto]);
  const { stdout: sha } = await executarGit(raiz, ['rev-parse', '--short', 'HEAD']);
  return {
    sha: sha.trim(),
    arquivos: escopo.arquivos.map((item) => item.path),
    saida: stdout.trim(),
    status: await status(projectPath),
  };
}

module.exports = {
  GitIndisponivel,
  caminhoConfinado,
  commit,
  diff,
  escopoDoCommit,
  interpretarStatus,
  restringirAoWorkspace,
  stage,
  status,
  unstage,
};
