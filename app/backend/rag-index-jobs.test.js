const test = require('node:test');
const assert = require('node:assert/strict');

async function waitFor(get, id, predicate, timeout = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const job = get(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job timeout');
}

test('job de RAG publica progresso e resultado final', async () => {
  const indexer = require('./workspace-indexer');
  const rag = require('./rag-client');
  const originalStage = indexer.stageProject;
  const originalIndex = rag.indexCorpus;
  indexer.stageProject = async () => ({ corpus: 'demo', containerPath: '/jarvis-workspace/demo', fileCount: 2 });
  rag.indexCorpus = async (staged, options) => {
    options.onProgress({ step: 'embed', percent: 50 });
    return { corpus: staged.corpus, embed: { embedded: 2 } };
  };
  delete require.cache[require.resolve('./rag-index-jobs')];
  const jobs = require('./rag-index-jobs');
  try {
    const started = jobs.start({ projectPath: 'C:\\demo' });
    const completed = await waitFor(jobs.get, started.id, (job) => job.status !== 'running');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.percent, 100);
    assert.equal(completed.indexed.embed.embedded, 2);
  } finally {
    indexer.stageProject = originalStage;
    rag.indexCorpus = originalIndex;
  }
});

test('mudança durante indexação agenda uma segunda passagem', async () => {
  const indexer = require('./workspace-indexer');
  const rag = require('./rag-client');
  const originalStage = indexer.stageProject;
  const originalIndex = rag.indexCorpus;
  let release;
  let runs = 0;
  indexer.stageProject = async () => ({ corpus: 'demo', containerPath: '/jarvis-workspace/demo', fileCount: 1 });
  rag.indexCorpus = async () => {
    runs += 1;
    if (runs === 1) await new Promise((resolve) => { release = resolve; });
    return { corpus: 'demo' };
  };
  delete require.cache[require.resolve('./rag-index-jobs')];
  const jobs = require('./rag-index-jobs');
  try {
    const first = jobs.start({ projectPath: 'C:\\demo-rerun' });
    await waitFor(jobs.get, first.id, () => typeof release === 'function');
    jobs.start({ projectPath: 'C:\\demo-rerun' });
    release();
    const completed = await waitFor(jobs.get, first.id, (job) => Boolean(job.followUpJobId));
    await waitFor(jobs.get, completed.followUpJobId, (job) => job.status === 'completed');
    assert.equal(runs, 2);
  } finally {
    indexer.stageProject = originalStage;
    rag.indexCorpus = originalIndex;
  }
});
