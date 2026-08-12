const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Mesmo padrão dos outros testes de frontend: carrega as funções reais do
// app.js (código de navegador, sem exports) em vez de duplicar a lógica.
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const inicio = source.indexOf('function timeLabel');
const fim = source.indexOf('function persist');
assert.ok(inicio !== -1 && fim > inicio, 'não localizei o bloco de datas em app.js');

// eslint-disable-next-line no-eval
const { timeLabel, messageStamp, currentDateContext } = eval(
  `(function () {\n${source.slice(inicio, fim)}\nreturn { timeLabel, messageStamp, currentDateContext };\n})()`,
);

const REFERENCIA = new Date(2026, 7, 11, 22, 15); // 11/08/2026 22:15 (mês é 0-indexado)

test('carimbo da mensagem traz data e hora, não só a hora', () => {
  const carimbo = messageStamp(REFERENCIA);
  assert.match(carimbo, /11\/08\/2026/, 'faltou a data');
  assert.match(carimbo, /22:15/, 'faltou a hora');
});

test('o log continua só com a hora, sem poluir com data', () => {
  assert.equal(timeLabel(REFERENCIA), '22:15');
});

test('contexto de data informa o dia atual por extenso', () => {
  const contexto = currentDateContext(REFERENCIA);
  assert.match(contexto, /11 de agosto de 2026/);
  assert.match(contexto, /22:15/);
  assert.match(contexto, /terça-feira/);
});

test('contexto de data instrui a ancorar a pesquisa na data atual', () => {
  const contexto = currentDateContext(REFERENCIA);
  assert.match(contexto, /ancore a busca nesta data/i);
  assert.match(contexto, /inclua o ano atual/i);
  assert.match(contexto, /conhecimento interno foi congelado/i);
});

test('a data é calculada na hora do envio, não fixada no carregamento', () => {
  // Se fosse const de módulo, o app aberto virando a madrugada mandaria
  // a data de ontem para o modelo.
  const ontem = currentDateContext(new Date(2026, 7, 10, 23, 59));
  const hoje = currentDateContext(new Date(2026, 7, 11, 0, 1));
  assert.match(ontem, /10 de agosto de 2026/);
  assert.match(hoje, /11 de agosto de 2026/);
  assert.notEqual(ontem, hoje);
});

test('contexto impede tratar o desconhecido como invencao da fonte', () => {
  // Regressao de um caso real: o modelo pesquisou, encontrou "MiniMax M3" e
  // "Claude Fable 5" — ambos reais, o primeiro sendo ele mesmo — e descartou
  // os dois como alucinacao da fonte, enquanto apresentava a propria memoria
  // desatualizada como o cenario atual.
  const contexto = currentDateContext(REFERENCIA);
  assert.match(contexto, /NÃO CONHECER ALGO NÃO PROVA QUE NÃO EXISTE/);
  assert.match(contexto, /não chame algo de alucinação só porque lhe é estranho/i);
  assert.match(contexto, /não consegui confirmar/i);
  assert.match(contexto, /incluindo o seu próprio/i);
  assert.match(contexto, /nunca apresente a sua memória interna/i);
});
