const test = require('node:test');
const assert = require('node:assert/strict');
const branches = require('./message-branches');

test('editar cria uma nova versão sem levar a pergunta e resposta antigas', () => {
  const original = [
    { role: 'user', content: 'Contexto anterior', time: '1' },
    { role: 'assistant', content: 'Resposta anterior', time: '2' },
    { role: 'user', content: 'Pergunta original', displayContent: 'Pergunta original', time: '3' },
    { role: 'assistant', content: 'Resposta original', time: '4' },
    { role: 'user', content: 'Continuação antiga', time: '5' },
  ];
  const edited = branches.edit(original, {}, 2, 'Pergunta editada', '6');
  assert.deepEqual(edited.messages.map((message) => message.content), [
    'Contexto anterior', 'Resposta anterior', 'Pergunta editada',
  ]);
  assert.equal(edited.branches[edited.branchId].variants.length, 2);
  assert.equal(edited.branches[edited.branchId].active, 1);
});

test('setas restauram todo o histórico correspondente a cada versão', () => {
  const original = [
    { role: 'user', content: 'Pergunta A' },
    { role: 'assistant', content: 'Resposta A' },
  ];
  const edited = branches.edit(original, {}, 0, 'Pergunta B');
  const withAnswer = [...edited.messages, { role: 'assistant', content: 'Resposta B' }];
  const synced = branches.sync(withAnswer, edited.branches);
  const restored = branches.switchVariant(withAnswer, synced, edited.branchId, 0);
  assert.deepEqual(restored.messages.map((message) => message.content), ['Pergunta A', 'Resposta A']);
  const again = branches.switchVariant(restored.messages, restored.branches, edited.branchId, 1);
  assert.deepEqual(again.messages.map((message) => message.content), ['Pergunta B', 'Resposta B']);
});

test('edição preserva o bloco de anexo e troca somente o texto digitado', () => {
  const message = {
    role: 'user',
    content: '[Anexo: a.txt]\n```\nconteúdo\n```\n\nPergunta antiga',
    displayContent: 'Pergunta antiga',
    attachmentsMeta: [{ name: 'a.txt', kind: 'text' }],
  };
  const edited = branches.edit([message], {}, 0, 'Pergunta nova');
  assert.match(edited.messages[0].content, /\[Anexo: a\.txt\]/);
  assert.ok(edited.messages[0].content.endsWith('Pergunta nova'));
});
