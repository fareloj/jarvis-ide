const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateEnginePath } = require('./rag-service-manager');

test('configuração do engine exige pasta com Docker Compose', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-rag-engine-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => validateEnginePath(root), /Docker Compose/);
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
  const result = await validateEnginePath(root);
  assert.equal(result.enginePath, root);
  assert.equal(result.composeFile, 'docker-compose.yml');
});
