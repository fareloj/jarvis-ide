(function exposeSessionStore(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JarvisSessionStore = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const SESSIONS_KEY = 'jarvis:sessions:v1';
  const ACTIVE_KEY = 'jarvis:active-session:v1';
  const MIGRATION_KEY = 'jarvis:sessions-migrated:v1';

  function safeParse(value, fallback) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function makeId() {
    const suffix = globalThis.crypto?.randomUUID?.()
      || `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `session-${Date.now()}-${suffix}`;
  }

  function titleFromMessages(messages) {
    const firstUser = messages.find((message) => message.role === 'user' && message.content.trim());
    if (!firstUser) return 'Nova conversa';
    const singleLine = firstUser.content.replace(/\s+/g, ' ').trim();
    return singleLine.length > 54 ? `${singleLine.slice(0, 51)}…` : singleLine;
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter((message) => message && ['user', 'assistant'].includes(message.role))
      .map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 80_000),
        time: String(message.time || ''),
      }))
      .slice(-80);
  }

  function createSessionStore(storage) {
    function readAll() {
      const sessions = safeParse(storage.getItem(SESSIONS_KEY), []);
      return Array.isArray(sessions) ? sessions : [];
    }

    function writeAll(sessions) {
      storage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 50)));
    }

    function get(id) {
      return readAll().find((session) => session.id === id) || null;
    }

    function save(session, { touch = true } = {}) {
      const now = new Date().toISOString();
      const messages = normalizeMessages(session.messages);
      const normalized = {
        id: session.id || makeId(),
        title: session.title && session.title !== 'Nova conversa'
          ? String(session.title).slice(0, 80)
          : titleFromMessages(messages),
        project: {
          name: String(session.project?.name || 'Projeto'),
          path: String(session.project?.path || ''),
        },
        model: String(session.model || 'gpt-oss:120b-cloud'),
        messages,
        archived: Boolean(session.archived),
        createdAt: session.createdAt || now,
        updatedAt: touch ? now : (session.updatedAt || now),
      };
      const sessions = readAll().filter((item) => item.id !== normalized.id);
      sessions.unshift(normalized);
      writeAll(sessions);
      return normalized;
    }

    function create({ project, model, messages = [], title } = {}) {
      const session = save({ id: makeId(), project, model, messages, title });
      storage.setItem(ACTIVE_KEY, session.id);
      return session;
    }

    function setActive(id) {
      const session = get(id);
      if (!session || session.archived) return null;
      storage.setItem(ACTIVE_KEY, id);
      return session;
    }

    function getActive() {
      return get(storage.getItem(ACTIVE_KEY));
    }

    function list({ includeArchived = false, projectPath } = {}) {
      return readAll()
        .filter((session) => includeArchived || !session.archived)
        .filter((session) => !projectPath || session.project?.path === projectPath)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    }

    function archive(id) {
      const session = get(id);
      if (!session) return false;
      save({ ...session, archived: true });
      if (storage.getItem(ACTIVE_KEY) === id) storage.removeItem(ACTIVE_KEY);
      return true;
    }

    function migrateLegacy({ fallbackProject, fallbackModel } = {}) {
      if (storage.getItem(MIGRATION_KEY)) return getActive();
      const messages = normalizeMessages(safeParse(storage.getItem('jarvis:messages'), []));
      const project = safeParse(storage.getItem('jarvis:project'), null) || fallbackProject;
      const model = storage.getItem('jarvis:model') || fallbackModel;
      const migrated = messages.length ? create({ project, model, messages }) : null;
      storage.removeItem('jarvis:messages');
      storage.setItem(MIGRATION_KEY, '1');
      return migrated;
    }

    return { archive, create, get, getActive, list, migrateLegacy, save, setActive };
  }

  return { createSessionStore, titleFromMessages };
}));
