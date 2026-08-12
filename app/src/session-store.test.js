const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore, titleFromMessages } = require('./session-store');

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('sessões são criadas, atualizadas e reabertas', () => {
  const storage = new MemoryStorage();
  const store = createSessionStore(storage);
  const created = store.create({
    project: { name: 'orion', path: 'C:/orion' },
    model: 'gpt-oss:120b-cloud',
  });
  const saved = store.save({
    ...created,
    messages: [{ role: 'user', content: 'Corrija o login', time: '10:00' }],
  });

  assert.equal(store.getActive().id, created.id);
  assert.equal(saved.title, 'Corrija o login');
  assert.equal(store.list()[0].messages.length, 1);
});

test('migração preserva o histórico legado uma única vez', () => {
  const storage = new MemoryStorage({
    'jarvis:messages': JSON.stringify([{ role: 'user', content: 'Histórico antigo', time: '09:00' }]),
    'jarvis:model': 'qwen3-coder:480b-cloud',
    'jarvis:project': JSON.stringify({ name: 'atlas', path: 'C:/atlas' }),
  });
  const store = createSessionStore(storage);
  const migrated = store.migrateLegacy();

  assert.equal(migrated.title, 'Histórico antigo');
  assert.equal(migrated.project.name, 'atlas');
  assert.equal(storage.getItem('jarvis:messages'), null);
  assert.deepEqual(store.migrateLegacy(), migrated);
});

test('título usa a primeira mensagem e limita o comprimento', () => {
  const title = titleFromMessages([{ role: 'user', content: 'a'.repeat(70) }]);
  assert.equal(title.length, 52);
  assert.ok(title.endsWith('…'));
});

test('remove apaga a conversa de vez, diferente de archive', () => {
  const storage = new MemoryStorage();
  const store = createSessionStore(storage);
  const a = store.create({ project: { name: 'P', path: '/p' }, model: 'm', messages: [] });
  const b = store.create({ project: { name: 'P', path: '/p' }, model: 'm', messages: [] });

  assert.equal(store.remove(a.id), true);
  assert.equal(store.get(a.id), null, 'a conversa nao pode sobrar no armazenamento');
  assert.equal(store.list({ includeArchived: true }).length, 1);
  assert.equal(store.remove('nao-existe'), false);

  // Apagar a conversa ativa precisa limpar o ponteiro de ativa.
  assert.equal(store.getActive().id, b.id);
  store.remove(b.id);
  assert.equal(store.getActive(), null);
});

test('titleGenerated sobrevive ao salvar de novo', () => {
  const storage = new MemoryStorage();
  const store = createSessionStore(storage);
  const sessao = store.create({ project: { name: 'P', path: '/p' }, model: 'm', messages: [] });
  store.save({ ...sessao, title: 'Plano de migração', titleGenerated: true });

  const relido = store.get(sessao.id);
  assert.equal(relido.title, 'Plano de migração');
  assert.equal(relido.titleGenerated, true, 'sem isso o modelo renomearia a conversa a cada mensagem');
});
