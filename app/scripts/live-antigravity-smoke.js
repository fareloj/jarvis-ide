const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-live-antigravity-'));
  const projectPath = path.join(root, 'workspace');
  const outputDirectory = path.join(root, 'artifacts');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Workspace do teste real JARVIS + Antigravity\n', 'utf8');

  let electron;
  try {
    electron = process.env.JARVIS_ELECTRON_PATH || require('electron');
  } catch (error) {
    throw new Error(`Runtime do Electron indisponível: ${error.message}`);
  }

  const child = spawn(electron, [`--user-data-dir=${path.join(root, 'user-data')}`, '.'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      JARVIS_E2E_PROJECT: projectPath,
      JARVIS_E2E_OUTPUT: outputDirectory,
      JARVIS_LIVE_ANTIGRAVITY: '1',
      JARVIS_OLLAMA_MODEL: 'deepseek-v4-flash:cloud',
      JARVIS_MOBILE_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { logs += chunk; process.stderr.write(chunk); });
  const timeout = setTimeout(() => {
    if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], () => {});
    else child.kill('SIGKILL');
  }, 30 * 60_000);
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timeout);

  const reportPath = path.join(outputDirectory, 'live-antigravity-report.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8').catch(() => '{"status":"missing"}'));
  console.log(`Workspace preservado: ${projectPath}`);
  console.log(`Artefatos preservados: ${outputDirectory}`);
  if (exitCode !== 0 || report.status !== 'passed') {
    console.error(logs.slice(-30_000));
    process.exitCode = 1;
    return;
  }
  console.log(`Live Antigravity E2E passed (${report.checks.length} checks).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
