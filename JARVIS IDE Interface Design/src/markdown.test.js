const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

test('parser reconhece Markdown GFM e blocos de código com linguagem', () => {
  const markdown = [
    '# Resposta',
    '',
    '- primeiro item',
    '- segundo item com `código`',
    '',
    '```typescript',
    'const ready: boolean = true;',
    '```',
    '',
    '| Estado | Valor |',
    '| --- | --- |',
    '| JARVIS | pronto |',
  ].join('\n');

  const html = marked.parse(markdown, { gfm: true, breaks: true });
  assert.match(html, /<h1>Resposta<\/h1>/);
  assert.match(html, /<code>código<\/code>/);
  assert.match(html, /<pre><code class="language-typescript">/);
  assert.match(html, /<table>/);
});

test('renderer sanitiza HTML antes de inserir respostas', () => {
  const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(appSource, /DOMPurify\.sanitize\(parsed/);
  assert.match(appSource, /rel = 'noopener noreferrer'/);
});
