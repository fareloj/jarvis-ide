const crypto = require('node:crypto');
const rag = require('./rag-client');
const { stageProject } = require('./workspace-indexer');

const jobs = new Map();
const MAX_JOBS = 50;

function snapshot(job) {
  return JSON.parse(JSON.stringify(job));
}

function prune() {
  const completed = [...jobs.values()]
    .filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status))
    .sort((left, right) => String(left.finishedAt).localeCompare(String(right.finishedAt)));
  while (jobs.size > MAX_JOBS && completed.length) jobs.delete(completed.shift().id);
}

function start({ projectPath } = {}) {
  if (!String(projectPath || '').trim()) throw new Error('Abra um projeto antes de indexar.');
  const existing = [...jobs.values()].find((job) => job.projectPath === projectPath && job.status === 'running');
  if (existing) {
    existing.rerunRequested = true;
    existing.updatedAt = new Date().toISOString();
    return snapshot(existing);
  }
  const job = {
    id: crypto.randomUUID(),
    projectPath,
    status: 'running',
    phase: 'staging',
    percent: 0,
    cancellationRequested: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: [],
  };
  jobs.set(job.id, job);
  void execute(job);
  prune();
  return snapshot(job);
}

async function execute(job) {
  try {
    const staged = await stageProject(job.projectPath);
    job.staged = staged;
    job.percent = 10;
    job.phase = 'ingest';
    job.updatedAt = new Date().toISOString();
    if (job.cancellationRequested) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      return;
    }
    const indexed = await rag.indexCorpus(staged, {
      onProgress(progress) {
        job.phase = progress.step;
        job.percent = 10 + Math.round(progress.percent * 0.9);
        job.updatedAt = new Date().toISOString();
        if (job.cancellationRequested) job.cancellationState = 'finalizing_consistent_indexes';
      },
    });
    job.indexed = indexed;
    job.status = job.cancellationRequested ? 'cancelled' : 'completed';
    job.percent = 100;
    job.phase = job.status;
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    const failedPhase = job.phase;
    job.status = 'failed';
    job.phase = 'failed';
    job.errors.push({ phase: failedPhase, message: error.message });
    job.finishedAt = new Date().toISOString();
  } finally {
    job.updatedAt = new Date().toISOString();
    if (job.rerunRequested && job.status !== 'failed') {
      job.rerunRequested = false;
      const followUp = start({ projectPath: job.projectPath });
      job.followUpJobId = followUp.id;
    }
  }
}

function get(id) {
  const job = jobs.get(String(id || ''));
  return job ? snapshot(job) : null;
}

function cancel(id) {
  const job = jobs.get(String(id || ''));
  if (!job || job.status !== 'running') return null;
  job.cancellationRequested = true;
  job.updatedAt = new Date().toISOString();
  return snapshot(job);
}

module.exports = { cancel, get, start };
