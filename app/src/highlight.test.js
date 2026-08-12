const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Carrega as funções reais do app.js (código de navegador, sem exports) para
// testar o realce de sintaxe sem duplicar a implementação no teste.
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador não encontrado em app.js: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `fim não encontrado em app.js: ${endMarker}`);
  return source.slice(start, end);
}

// A IIFE isola as declarações: sem ela o `function escapeHtml` do app.js
// colide com o const desta linha, que vive no mesmo escopo do módulo.
// eslint-disable-next-line no-eval
const { highlightCode } = eval(`(function () {\n${[
  extract('function escapeHtml(value) {', '\nfunction shortModel'),
  extract('const SYNTAX_KEYWORDS = new Set([', '\nfunction renderTreeLevel'),
].join('\n')}\nreturn { escapeHtml, highlightCode };\n})()`);

// Regressão de uma XSS real: o highlighter usava String.replace, que só passa
// pelo callback os trechos casados pelo regex. Tudo entre os tokens — `<`, `>`
// e aspas — ia cru para o innerHTML do visualizador, então abrir um arquivo
// malicioso no Explorador executava script no renderer (que tem a ponte
// window.jarvis: leitura de arquivos, tools, cookie de quota).
test('realce de sintaxe nunca deixa HTML cru chegar ao innerHTML', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '</code></pre><script>alert(1)</script>',
    'const x = 1; // <iframe src="javascript:alert(1)">',
  ];

  for (const payload of payloads) {
    const html = highlightCode(payload, 'arquivo.js');
    // Remove os spans que o próprio realce cria; o que sobrar não pode ter tag.
    const semRealce = html.replace(/<span class="tok-[a-z]+">|<\/span>/g, '');
    assert.doesNotMatch(semRealce, /<[a-zA-Z/!]/, `HTML cru vazou para: ${payload}\nsaída: ${html}`);
    assert.ok(!html.includes('<script'), `tag script sobreviveu em: ${payload}`);
  }
});

test('extensão sem realce também é escapada', () => {
  const html = highlightCode('<script>alert(1)</script>', 'leia-me.desconhecido');
  assert.equal(html, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('realce continua funcionando para código legítimo', () => {
  const html = highlightCode('const total = 42; // soma\nconst nome = "jarvis";', 'exemplo.js');
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-number">42<\/span>/);
  assert.match(html, /<span class="tok-comment">\/\/ soma<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;jarvis&quot;<\/span>/);
});

test('texto entre tokens é preservado sem perder conteúdo', () => {
  // Um bug de escaneamento manual seria engolir ou duplicar trechos.
  const original = 'a + b === c && d;';
  const html = highlightCode(original, 'exemplo.js');
  const textoPuro = html
    .replace(/<span class="tok-[a-z]+">|<\/span>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
  assert.equal(textoPuro, original);
});
