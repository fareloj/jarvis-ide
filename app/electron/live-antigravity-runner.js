const fs = require('node:fs/promises');
const path = require('node:path');
const { waitFor } = require('./e2e-runner');

const JOB_TIMEOUT_MS = 20 * 60_000;

async function snapshot(window, directory, name) {
  await window.capturePage().then((image) => fs.writeFile(path.join(directory, `${name}.png`), image.toPNG()));
}

async function submit(window, prompt) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`, true);
}

async function approveLatest(window) {
  await waitFor(window, `(() => {
    const cards = [...document.querySelectorAll('.approval-card')];
    const card = cards.at(-1);
    return Boolean(card?.querySelector('[data-approved="true"]'));
  })()`, { timeoutMs: 180_000, intervalMs: 250 });
  return window.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.approval-card')];
    const card = cards.at(-1);
    const summary = card?.textContent || '';
    card.querySelector('[data-approved="true"]').click();
    return summary;
  })()`, true);
}

async function waitForLatestJob(window) {
  await waitFor(window, `(() => {
    const card = [...document.querySelectorAll('.approval-card')].at(-1);
    return /conclu[ií]d|falhou|timeout|cancelad/i.test(card?.querySelector('.approval-actions')?.textContent || '');
  })()`, { timeoutMs: JOB_TIMEOUT_MS, intervalMs: 750 });
  await waitFor(window, `state.busy === false`, { timeoutMs: 240_000, intervalMs: 250 });
  return window.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.approval-card')].at(-1);
    const jobs = JSON.parse(localStorage.getItem('jarvis-background-jobs') || '{}');
    return {
      card: card?.textContent || '',
      messages: state.messages.map(({ role, content }) => ({ role, content })),
      jobs,
    };
  })()`, true);
}

function assertFinalToolResponse(jobSnapshot, phase) {
  const lastAssistant = [...(jobSnapshot.messages || [])].reverse().find((message) => message.role === 'assistant')?.content || '';
  if (!lastAssistant.trim()) throw new Error(`O JARVIS não respondeu depois da fase ${phase}.`);
  if (/background_job_status|vou consultar|irei consultar|vou acompanhar/i.test(lastAssistant)) {
    throw new Error(`O JARVIS prometeu acompanhamento depois do estado final na fase ${phase}: ${lastAssistant}`);
  }
  return lastAssistant;
}

function nativeConversationIds(jobSnapshot) {
  return [...new Set([...String(jobSnapshot.card || '').matchAll(/conversation_id\\?"?\s*:\s*\\?"([0-9a-f-]{36})/gi)].map((match) => match[1]))];
}

async function assertFile(projectPath, relative, patterns = []) {
  const target = path.join(projectPath, relative);
  const content = await fs.readFile(target, 'utf8');
  for (const pattern of patterns) {
    if (!pattern.test(content)) throw new Error(`${relative} não contém ${pattern}.`);
  }
  return { relative, bytes: Buffer.byteLength(content) };
}

async function runLiveAntigravityE2E(window, { projectPath, outputDirectory }) {
  const directory = path.resolve(outputDirectory);
  const report = {
    kind: 'live-antigravity',
    model: 'deepseek-v4-flash:cloud',
    startedAt: new Date().toISOString(),
    checks: [],
    phases: [],
    console: [],
  };
  const onConsole = (_event, level, message) => report.console.push({ level, message });
  window.webContents.on('console-message', onConsole);
  await fs.mkdir(directory, { recursive: true });

  try {
    await waitFor(window, `document.readyState === 'complete' && document.querySelector('#welcomeScreen')`);
    await window.webContents.executeJavaScript(`(() => {
      state.project = ${JSON.stringify({ name: 'jarvis-live-antigravity', path: projectPath })};
      state.model = 'deepseek-v4-flash:cloud';
      state.messages = [];
      state.toolsEnabled = true;
      state.conversationMemoryEnabled = false;
      state.ragCorpus = null;
      syncProjectLabels(); setModel(state.model); persist(); enterWorkspace(); renderSidebar();
    })()`, true);
    report.checks.push({ name: 'Electron abriu workspace descartável com DeepSeek V4 Flash', status: 'passed' });

    await submit(window, [
      'Use exclusivamente a tool delegate_coding_task com agent antigravity e effort high.',
      'Faça UMA ÚNICA chamada de delegate_coding_task contendo os dois projetos no mesmo prompt. Não divida em chamadas paralelas.',
      'Não crie arquivos diretamente e não use terminal_run.',
      'Delegue ao Antigravity a criação de dois projetos simples dentro do workspace aberto:',
      '1) mini-site com index.html, styles.css, app.js e README.md; deve mostrar um contador com botões incrementar e zerar.',
      '2) tiny-cli em Node.js, sem dependências, com package.json, cli.js e test.js; deve somar números passados na linha de comando e ter testes executáveis por npm test.',
      'Peça ao Antigravity para executar os testes do tiny-cli. Use timeout_seconds 900.',
    ].join('\n'));
    const firstApproval = await approveLatest(window);
    if (!/mini-site/i.test(firstApproval) || !/tiny-cli/i.test(firstApproval)) {
      throw new Error('A delegação aprovada não continha os dois projetos no mesmo prompt.');
    }
    report.phases.push({ phase: 'create', approval: firstApproval });
    await snapshot(window, directory, '01-create-approved');
    const firstJob = await waitForLatestJob(window);
    firstJob.finalAssistant = assertFinalToolResponse(firstJob, 'create');
    const initialNativeIds = nativeConversationIds(firstJob);
    if (initialNativeIds.length !== 1) throw new Error(`A criação não expôs um único conversation_id: ${initialNativeIds.join(', ')}`);
    report.phases[0].result = firstJob;
    await snapshot(window, directory, '02-create-completed');

    const created = await Promise.all([
      assertFile(projectPath, 'mini-site/index.html', [/contador/i]),
      assertFile(projectPath, 'mini-site/styles.css'),
      assertFile(projectPath, 'mini-site/app.js', [/increment/i, /reset|zerar/i]),
      assertFile(projectPath, 'mini-site/README.md'),
      assertFile(projectPath, 'tiny-cli/package.json', [/"test"/]),
      assertFile(projectPath, 'tiny-cli/cli.js'),
      assertFile(projectPath, 'tiny-cli/test.js'),
    ]);
    report.checks.push({ name: 'Antigravity criou os dois projetos no workspace correto', status: 'passed', files: created });

    await submit(window, [
      'Continue a mesma sessão nativa do Antigravity usando continue_coding_task, sem iniciar outra delegação.',
      `Use exatamente session_id ${initialNativeIds[0]}; esse é o externalId comprovado pelo evento init.`,
      'Use effort high e timeout_seconds 900.',
      'Modifique mini-site para adicionar alternância de tema claro/escuro com um botão id themeToggle e persistência em localStorage.',
      'Modifique tiny-cli para aceitar --json e imprimir um objeto JSON com os campos operation, values e result.',
      'Atualize os testes e os READMEs e execute npm test em tiny-cli.',
    ].join('\n'));
    const secondApproval = await approveLatest(window);
    report.phases.push({ phase: 'modify', approval: secondApproval });
    if (!/continue_coding_task/i.test(secondApproval)) throw new Error('O JARVIS não solicitou continuação da sessão nativa.');
    if (!secondApproval.includes(initialNativeIds[0])) throw new Error(`A continuação não usou o externalId nativo ${initialNativeIds[0]}.`);
    await snapshot(window, directory, '03-modify-approved');
    const secondJob = await waitForLatestJob(window);
    secondJob.finalAssistant = assertFinalToolResponse(secondJob, 'modify');
    const continuedNativeIds = nativeConversationIds(secondJob);
    if (continuedNativeIds.some((id) => id !== initialNativeIds[0])) {
      throw new Error(`O Antigravity abriu outra conversa: ${continuedNativeIds.join(', ')}.`);
    }
    report.phases[1].result = secondJob;
    await snapshot(window, directory, '04-modify-completed');

    const modified = await Promise.all([
      assertFile(projectPath, 'mini-site/index.html', [/themeToggle/]),
      assertFile(projectPath, 'mini-site/app.js', [/localStorage/, /theme/i]),
      assertFile(projectPath, 'tiny-cli/cli.js', [/--json/, /operation/, /values/, /result/]),
      assertFile(projectPath, 'tiny-cli/test.js', [/json/i]),
    ]);
    report.checks.push({ name: 'Mesma sessão do Antigravity modificou ambos os projetos', status: 'passed', files: modified });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || error.message;
    await snapshot(window, directory, 'live-antigravity-failure').catch(() => {});
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'live-antigravity-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    window.webContents.removeListener('console-message', onConsole);
  }
}

module.exports = { runLiveAntigravityE2E };
