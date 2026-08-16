const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const roots = ['backend', 'src'];
const testFiles = roots.flatMap((root) =>
  readdirSync(join(__dirname, '..', root), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => join(root, entry.name)),
).sort();

if (testFiles.length === 0) {
  console.error('Nenhum arquivo de teste foi encontrado em backend/ ou src/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: join(__dirname, '..'),
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
