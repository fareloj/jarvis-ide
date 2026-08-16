const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const CONFIG_FILE = path.resolve(__dirname, '..', 'data', 'rag-service.json');
const ACTIONS = new Set(['start', 'stop', 'restart']);

async function readConfig() {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return {
    enginePath: String(process.env.JARVIS_RAG_ENGINE_PATH || stored.enginePath || '').trim(),
    endpoint: String(process.env.JARVIS_RAG_URL || stored.endpoint || 'http://127.0.0.1:8090').replace(/\/$/, ''),
  };
}

async function validateEnginePath(enginePath) {
  const resolved = path.resolve(String(enginePath || ''));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Selecione a pasta do Hybrid RAG Engine.');
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const candidate of composeFiles) {
    if (await fs.stat(path.join(resolved, candidate)).then((item) => item.isFile()).catch(() => false)) {
      return { enginePath: resolved, composeFile: candidate };
    }
  }
  throw new Error('A pasta escolhida não contém um arquivo Docker Compose.');
}

async function writeConfig({ enginePath, endpoint } = {}) {
  const current = await readConfig();
  const validated = enginePath ? await validateEnginePath(enginePath) : null;
  const next = {
    enginePath: validated?.enginePath || current.enginePath,
    endpoint: String(endpoint || current.endpoint || '').trim().replace(/\/$/, ''),
  };
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(next.endpoint)) {
    throw new Error('O endpoint do RAG deve permanecer local (localhost ou 127.0.0.1).');
  }
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  const temporary = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(temporary, CONFIG_FILE);
  return next;
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: options.timeout || 5_000,
      maxBuffer: 2_000_000,
      cwd: options.cwd,
      env: { ...process.env },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      error: error.killed ? 'Tempo limite excedido.' : error.message,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
    };
  }
}

async function status() {
  const config = await readConfig();
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  let compose = { ok: false, error: 'Engine não configurado.' };
  let containers = [];
  if (config.enginePath) {
    const validated = await validateEnginePath(config.enginePath).catch(() => null);
    if (validated && docker.ok) {
      compose = await run('docker', ['compose', 'ps', '--format', 'json'], { cwd: validated.enginePath });
      if (compose.ok && compose.stdout) {
        containers = compose.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        }).map((item) => ({
          name: item.Name || item.Service,
          service: item.Service,
          state: item.State,
          health: item.Health || '',
        }));
      }
    }
  }
  const gpu = await run('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu',
    '--format=csv,noheader,nounits',
  ], { timeout: 3_000 });
  return {
    config,
    docker: { available: docker.ok, version: docker.stdout, error: docker.error || docker.stderr },
    compose: { available: compose.ok, error: compose.error || compose.stderr },
    containers,
    gpu: { available: gpu.ok, summary: gpu.stdout, error: gpu.error || gpu.stderr },
  };
}

async function control(action, { confirmed = false } = {}) {
  if (!ACTIONS.has(action)) throw new Error('Ação de serviço inválida.');
  if (!confirmed) throw new Error('Confirmação explícita obrigatória para alterar os serviços do RAG.');
  const config = await readConfig();
  const validated = await validateEnginePath(config.enginePath);
  const args = action === 'start' ? ['compose', 'up', '-d']
    : action === 'stop' ? ['compose', 'stop']
      : ['compose', 'restart'];
  const result = await run('docker', args, { cwd: validated.enginePath, timeout: 180_000 });
  if (!result.ok) throw new Error(result.stderr || result.error || `Falha ao executar ${action}.`);
  return { action, ...result, status: await status() };
}

module.exports = { control, readConfig, status, validateEnginePath, writeConfig };
