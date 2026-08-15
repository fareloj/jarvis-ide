const path = require('node:path');

const AGENTS = Object.freeze(['claude-code', 'codex', 'antigravity']);
const LABELS = Object.freeze({
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
});
const BINARIES = Object.freeze({ 'claude-code': 'claude', codex: 'codex', antigravity: 'agy' });

function assertAgent(agent) {
  if (!AGENTS.includes(agent)) throw new Error(`Agente de codificacao desconhecido: ${agent}`);
  return agent;
}

function optionalFlags(agent, { model, effort } = {}) {
  const args = [];
  if (model) args.push('--model', String(model));
  if (effort && agent !== 'codex') args.push('--effort', String(effort));
  return args;
}

function scopedPrompt(cwd, prompt) {
  return [
    `WORKSPACE OBRIGATORIO: ${path.resolve(cwd)}`,
    'Crie, leia e edite arquivos exclusivamente nesse workspace. Nao use pastas scratch externas.',
    'Antes de concluir, execute as verificacoes relevantes e relate evidencias reais.',
    '',
    String(prompt || '').trim(),
  ].join('\n');
}

function buildTaskInvocation(agent, {
  cwd, prompt, sessionId, timeoutMs = 1_800_000, model, effort = 'medium', mode = 'edit', outputFile,
} = {}) {
  assertAgent(agent);
  const text = scopedPrompt(cwd, prompt);
  if (!String(prompt || '').trim()) throw new Error('O prompt da delegação não pode ser vazio.');

  if (agent === 'claude-code') {
    const prefix = sessionId ? ['--resume', String(sessionId)] : [];
    return {
      binary: BINARIES[agent],
      args: [
        ...prefix, '-p', text, '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--permission-mode', mode === 'plan' ? 'plan' : 'acceptEdits',
        ...optionalFlags(agent, { model, effort }),
      ],
      format: 'stream-json',
    };
  }

  if (agent === 'codex') {
    if (!outputFile) throw new Error('Codex exige um arquivo temporario para a mensagem final.');
    const prefix = sessionId ? ['exec', 'resume', String(sessionId), text] : ['exec', text];
    return {
      binary: BINARIES[agent],
      args: [
        ...prefix, '--json', '--skip-git-repo-check', '--output-last-message', outputFile,
        ...(sessionId
          ? ['-c', `sandbox_mode="${mode === 'plan' ? 'read-only' : 'workspace-write'}"`]
          : ['--sandbox', mode === 'plan' ? 'read-only' : 'workspace-write']),
        ...(model ? ['--model', String(model)] : []),
      ],
      format: 'jsonl',
      outputFile,
    };
  }

  return {
    binary: BINARIES[agent],
    args: [
      ...(sessionId ? ['--conversation', String(sessionId)] : []),
      '-p', text, '--output-format', 'stream-json', '--add-dir', path.resolve(cwd),
      '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`, '--sandbox',
      '--mode', mode === 'plan' ? 'plan' : 'accept-edits',
      ...optionalFlags(agent, { model, effort }),
    ],
    format: 'stream-json',
  };
}

function reviewPrompt({ targetType = 'uncommitted', target, focus } = {}) {
  const scope = targetType === 'base' ? `o diff contra a branch ${target}`
    : targetType === 'commit' ? `o commit ${target}`
      : targetType === 'pull-request' ? `o pull request ${target}`
        : 'todas as alteracoes staged, unstaged e untracked';
  return [
    `Revise ${scope}.`,
    'Priorize bugs reais, seguranca, perda de dados, concorrencia, compatibilidade e testes ausentes.',
    'Nao altere arquivos. Cite caminhos e linhas; se nao houver achados, diga explicitamente.',
    focus ? `Foco adicional: ${focus}` : '',
  ].filter(Boolean).join('\n');
}

function buildReviewInvocation(agent, options = {}) {
  assertAgent(agent);
  const { cwd, targetType = 'uncommitted', target, timeoutMs = 1_800_000, outputFile } = options;
  if (['base', 'commit', 'pull-request'].includes(targetType) && !String(target || '').trim()) {
    throw new Error(`O alvo e obrigatorio para uma revisao do tipo ${targetType}.`);
  }
  if (agent === 'codex') {
    const selector = targetType === 'base' ? ['--base', String(target)]
      : targetType === 'commit' ? ['--commit', String(target)] : ['--uncommitted'];
    if (targetType === 'pull-request') throw new Error('Codex review local nao aceita pull request como alvo direto.');
    return {
      binary: BINARIES[agent],
      args: ['review', ...selector, ...(options.focus ? [String(options.focus)] : [])],
      format: 'text',
    };
  }
  if (agent === 'claude-code' && options.ultra === true && targetType !== 'uncommitted') {
    return {
      binary: BINARIES[agent],
      args: ['ultrareview', String(target), '--json', '--timeout', String(Math.ceil(timeoutMs / 60_000))],
      format: 'json',
    };
  }
  return buildTaskInvocation(agent, {
    cwd, prompt: reviewPrompt(options), timeoutMs, model: options.model,
    effort: options.effort || 'high', mode: 'plan', outputFile,
  });
}

function buildInspectionInvocation(agent, capability) {
  assertAgent(agent);
  const commands = {
    version: { 'claude-code': ['--version'], codex: ['--version'], antigravity: ['--version'] },
    doctor: { 'claude-code': ['doctor'], codex: ['doctor', '--json'] },
    models: { codex: ['debug', 'models'], antigravity: ['models'] },
    agents: { 'claude-code': ['agents', '--json', '--all'], antigravity: ['agent'] },
    mcp: { 'claude-code': ['mcp', 'list'], codex: ['mcp', 'list', '--json'] },
    plugins: { 'claude-code': ['plugin', 'list'], codex: ['plugin', 'list', '--json'], antigravity: ['plugin', 'list'] },
    features: { codex: ['features', 'list'] },
    changelog: { antigravity: ['changelog'] },
  };
  const args = commands[capability]?.[agent];
  if (!args) throw new Error(`${LABELS[agent]} nao oferece a inspecao ${capability} por essa CLI.`);
  return { binary: BINARIES[agent], args, format: args.includes('--json') ? 'json' : 'text' };
}

function createEventParser(agent, onMetadata = () => {}) {
  assertAgent(agent);
  let buffer = '';
  let sessionId = null;
  let finalText = '';
  let finalStatus = null;
  let lastStep = null;

  const accept = (event) => {
    if (agent === 'antigravity') {
      if (event.event === 'init') {
        sessionId = event.conversation_id || event.init?.conversation_id || sessionId;
        onMetadata({ externalId: sessionId, workspace: event.init?.cwd, event: 'init' });
      } else if (event.event === 'step_update') {
        sessionId = event.step_update?.conversation_id || sessionId;
        lastStep = event.step_update?.tool_name || event.step_update?.step_type || lastStep;
        onMetadata({ externalId: sessionId, lastStep, stepState: event.step_update?.state, event: 'step_update' });
      } else if (event.event === 'result') {
        const result = event.result || {};
        sessionId = result.conversation_id || sessionId;
        finalText = String(result.response || '');
        finalStatus = result.status || null;
        onMetadata({ externalId: sessionId, event: 'result' });
      }
      return;
    }

    if (agent === 'claude-code') {
      sessionId = event.session_id || sessionId;
      if (event.type === 'assistant') lastStep = 'assistant';
      if (event.type === 'result') {
        finalText = String(event.result || '');
        finalStatus = event.is_error ? 'ERROR' : 'SUCCESS';
      }
      onMetadata({ externalId: sessionId, lastStep: event.type || lastStep, event: event.type || 'event' });
      return;
    }

    if (event.type === 'thread.started') sessionId = event.thread_id || sessionId;
    if (event.type === 'item.started' || event.type === 'item.completed') {
      lastStep = event.item?.type || event.type;
    }
    if (event.type === 'turn.completed') finalStatus = 'SUCCESS';
    if (event.type === 'turn.failed' || event.type === 'error') finalStatus = 'ERROR';
    onMetadata({ externalId: sessionId, lastStep, stepState: event.type, event: event.type || 'event' });
  };

  return {
    push(chunk) {
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { accept(JSON.parse(line)); } catch { /* raw output remains available to the job */ }
      }
    },
    finish() {
      if (buffer.trim()) {
        try { accept(JSON.parse(buffer)); } catch { /* handled by caller through raw output */ }
      }
      buffer = '';
      return { sessionId, finalText: finalText.trim(), finalStatus, lastStep };
    },
  };
}

module.exports = {
  AGENTS, BINARIES, LABELS, assertAgent, buildInspectionInvocation, buildReviewInvocation,
  buildTaskInvocation, createEventParser, reviewPrompt, scopedPrompt,
};
