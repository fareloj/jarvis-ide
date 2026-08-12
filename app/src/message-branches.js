(function exposeMessageBranches(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JarvisMessageBranches = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  function cloneMessages(messages) {
    return (Array.isArray(messages) ? messages : []).map((message) => ({
      ...message,
      ...(Array.isArray(message.attachmentsMeta)
        ? { attachmentsMeta: message.attachmentsMeta.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(Array.isArray(message.images) ? { images: [...message.images] } : {}),
    }));
  }

  function cloneBranches(branches) {
    return Object.fromEntries(Object.entries(branches || {}).map(([id, group]) => [id, {
      active: Number(group.active) || 0,
      variants: (group.variants || []).map((variant) => ({ messages: cloneMessages(variant.messages) })),
    }]));
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.()
      || `branch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function sync(messages, branches) {
    const nextBranches = cloneBranches(branches);
    for (const [id, group] of Object.entries(nextBranches)) {
      const anchorIndex = messages.findIndex((message) => message.branchId === id);
      if (anchorIndex < 0 || !group.variants.length) continue;
      const active = Math.max(0, Math.min(group.variants.length - 1, Number(group.active) || 0));
      group.active = active;
      group.variants[active] = { messages: cloneMessages(messages.slice(anchorIndex)) };
    }
    return nextBranches;
  }

  function contentAfterEdit(message, editedText) {
    const previousDisplay = String(message.displayContent ?? message.content ?? '');
    const previousContent = String(message.content || '');
    if (previousDisplay && previousContent.endsWith(previousDisplay)) {
      return `${previousContent.slice(0, -previousDisplay.length)}${editedText}`;
    }
    if (message.attachmentsMeta?.length && previousContent) return `${previousContent}\n\n${editedText}`;
    return editedText;
  }

  function edit(messages, branches, messageIndex, editedText, time) {
    const text = String(editedText || '').trim();
    const currentMessages = cloneMessages(messages);
    const message = currentMessages[messageIndex];
    if (!message || message.role !== 'user') throw new Error('Só mensagens do usuário podem ser editadas.');
    if (!text) throw new Error('A mensagem editada não pode ficar vazia.');

    let nextBranches = sync(currentMessages, branches);
    const branchId = message.branchId || makeId();
    if (!message.branchId) {
      message.branchId = branchId;
      currentMessages[messageIndex] = message;
      nextBranches[branchId] = {
        active: 0,
        variants: [{ messages: cloneMessages(currentMessages.slice(messageIndex)) }],
      };
    }

    const group = nextBranches[branchId];
    if (!group) throw new Error('As versões desta mensagem não puderam ser carregadas.');
    const editedMessage = {
      ...message,
      branchId,
      content: contentAfterEdit(message, text),
      displayContent: text,
      time: time || message.time,
    };
    const variant = { messages: [editedMessage] };
    group.variants.push(variant);
    group.active = group.variants.length - 1;

    return {
      branchId,
      branches: nextBranches,
      messages: [...cloneMessages(currentMessages.slice(0, messageIndex)), ...cloneMessages(variant.messages)],
    };
  }

  function switchVariant(messages, branches, branchId, targetIndex) {
    const synced = sync(messages, branches);
    const group = synced[branchId];
    if (!group?.variants?.length) throw new Error('Versão de mensagem inexistente.');
    const target = Math.max(0, Math.min(group.variants.length - 1, Number(targetIndex) || 0));
    const anchorIndex = messages.findIndex((message) => message.branchId === branchId);
    if (anchorIndex < 0) throw new Error('A mensagem desta versão não está na conversa atual.');
    group.active = target;
    const nextMessages = [
      ...cloneMessages(messages.slice(0, anchorIndex)),
      ...cloneMessages(group.variants[target].messages),
    ];

    // Se a variante restaurada contém edições posteriores, alinha os seus
    // seletores ao texto que efetivamente voltou para a tela.
    for (const [id, nested] of Object.entries(synced)) {
      const activeMessage = nextMessages.find((message) => message.branchId === id);
      if (!activeMessage) continue;
      const match = nested.variants.findIndex((variant) => (
        variant.messages?.[0]?.content === activeMessage.content
      ));
      if (match >= 0) nested.active = match;
    }
    return { branches: synced, messages: nextMessages };
  }

  function infoFor(message, branches) {
    const group = message?.branchId ? branches?.[message.branchId] : null;
    if (!group || group.variants?.length < 2) return null;
    return { id: message.branchId, active: group.active, total: group.variants.length };
  }

  return { cloneMessages, edit, infoFor, switchVariant, sync };
}));
