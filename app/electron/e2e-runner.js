const fs = require('node:fs/promises');
const path = require('node:path');

async function waitFor(window, expression, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout aguardando: ${expression}`);
}

async function runElectronE2E(window, { projectPath, outputDirectory }) {
  const report = { startedAt: new Date().toISOString(), checks: [], console: [] };
  const check = (name, details = {}) => report.checks.push({ name, status: 'passed', ...details });
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const onConsole = (_event, level, message) => report.console.push({ level, message });
  window.webContents.on('console-message', onConsole);
  try {
    await waitFor(window, `document.readyState === 'complete' && document.querySelector('#welcomeScreen')`);
    await window.webContents.executeJavaScript(`(() => {
      state.project = ${JSON.stringify({ name: 'jarvis-e2e-project', path: projectPath })};
      state.messages = [];
      state.toolsEnabled = true;
      state.ragCorpus = 'jarvis-e2e';
      syncProjectLabels(); persist(); enterWorkspace(); renderSidebar();
    })()`, true);
    await waitFor(window, `!document.querySelector('#workspace').classList.contains('hidden')`);
    check('workspace opens with deterministic project');

    for (const view of ['files', 'rag', 'settings', 'chat']) {
      await window.webContents.executeJavaScript(`document.querySelector('.activity-rail [data-nav="${view}"]').click()`, true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const active = await window.webContents.executeJavaScript(`document.querySelector('.activity-rail [data-nav="${view}"]').classList.contains('active')`, true);
      if (!active) throw new Error(`A navegaÃ§Ã£o ${view} nÃ£o ficou ativa.`);
      check(`navigation:${view}`);
    }

    const memory = await window.webContents.executeJavaScript(`window.jarvis.memory.save({
      projectPath: ${JSON.stringify(projectPath)}, title: 'E2E memory', content: 'persisted by Electron smoke test', kind: 'context', scope: 'project'
    })`, true);
    if (!memory?.memory?.id) throw new Error('A memÃ³ria E2E nÃ£o foi persistida.');
    check('memory write through preload IPC', { id: memory.memory.id });

    const skills = await window.webContents.executeJavaScript('window.jarvis.skills.list()', true);
    if (!Array.isArray(skills?.skills) || !skills.skills.length) throw new Error('O catÃ¡logo de skills nÃ£o carregou.');
    check('skills catalog through preload IPC', { count: skills.skills.length });

    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#chatInput');
      input.value = 'Crie o arquivo e2e-created.txt com o conteÃºdo validado.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`, true);
    await waitFor(window, `document.querySelector('.approval-card [data-approved="true"]')`, { timeoutMs: 15_000 });
    check('agent requests write approval');
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#quotaPopover')?.classList.add('hidden');
      document.querySelector('#quotaBackdrop')?.classList.add('hidden');
      const approvals = [...document.querySelectorAll('.approval-card [data-approved="true"]')];
      approvals.at(-1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`, true);
    await waitFor(window, `[...document.querySelectorAll('.approval-card')].at(-1).classList.contains('approved')`, { timeoutMs: 5_000 });
    await waitFor(window, `document.querySelector('#chatFeed').textContent.includes('E2E concluÃ­do')`, { timeoutMs: 15_000 });
    if ((await fs.readFile(path.join(projectPath, 'e2e-created.txt'), 'utf8')).trim() !== 'validado') throw new Error('O arquivo aprovado nÃ£o corresponde ao plano.');
    check('approved agentic write completes end-to-end');

    const editOpened = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-edit-message]');
      if (!button) return false;
      button.click();
      return Boolean(document.querySelector('.message-edit-form textarea'));
    })()`, true);
    if (!editOpened) throw new Error('A ediÃ§Ã£o de mensagem nÃ£o abriu.');
    check('message edit control opens');

    const accessibility = await window.webContents.executeJavaScript(`(() => {
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      const unnamed = [...document.querySelectorAll('button')].filter((button) => !((button.textContent || '').trim() || button.getAttribute('aria-label') || button.title)).length;
      return { duplicateIds: [...new Set(duplicates)], unnamedButtons: unnamed };
    })()`, true);
    if (accessibility.duplicateIds.length || accessibility.unnamedButtons) throw new Error(`Falha bÃ¡sica de acessibilidade: ${JSON.stringify(accessibility)}`);
    check('basic accessibility invariants');

    await window.capturePage().then((image) => fs.writeFile(path.join(directory, 'electron-e2e.png'), image.toPNG()));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || error.message;
    await window.capturePage().then((image) => fs.writeFile(path.join(directory, 'electron-e2e-failure.png'), image.toPNG())).catch(() => {});
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'electron-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    window.webContents.removeListener('console-message', onConsole);
  }
}

module.exports = { runElectronE2E, waitFor };
