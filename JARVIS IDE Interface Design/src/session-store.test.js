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
