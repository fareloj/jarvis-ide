package com.fareloj.jarvis

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class JarvisUiState(
    val configured: Boolean = false,
    val connecting: Boolean = false,
    val connected: Boolean = false,
    val conversations: List<Conversation> = emptyList(),
    val currentId: String? = null,
    val models: List<CloudModel> = emptyList(),
    val selectedModel: String = "",
    val quota: QuotaInfo = QuotaInfo(),
    val generating: Boolean = false,
    val researchEnabled: Boolean = true,
    val editingMessageId: String? = null,
    val lanMode: Boolean = false,
    val error: String? = null,
)

class JarvisViewModel(application: Application) : AndroidViewModel(application) {
    private val store = JarvisStore(application)
    private var api: JarvisApi? = null
    var state by mutableStateOf(JarvisUiState(conversations = store.loadConversations()))
        private set

    init {
        store.loadConfig()?.let { config ->
            api = JarvisApi(config)
            state = state.copy(configured = true, connecting = true, lanMode = config.serverUrl.startsWith("http://"))
            connectAndLoad()
        }
    }

    val current: Conversation?
        get() = state.conversations.firstOrNull { it.id == state.currentId }

    fun connect(serverUrl: String, token: String) {
        val normalized = serverUrl.trim().trimEnd('/')
        val endpoint = validateServerEndpoint(normalized, BuildConfig.ALLOW_LAN_HTTP)
        if (endpoint.error != null) {
            state = state.copy(error = endpoint.error)
            return
        }
        if (token.trim().length < 32) {
            state = state.copy(error = "O token deve ter pelo menos 32 caracteres.")
            return
        }
        val config = ConnectionConfig(endpoint.normalizedUrl!!, token.trim())
        api = JarvisApi(config)
        state = state.copy(configured = true, connecting = true, lanMode = endpoint.isLan, error = null)
        viewModelScope.launch {
            runCatching { api!!.health() }.onSuccess { healthy ->
                if (!healthy) throw IllegalStateException("Gateway não confirmou saúde.")
                store.saveConfig(config)
                state = state.copy(connecting = false, connected = true)
                loadMetadata()
            }.onFailure { failure ->
                api = null
                state = state.copy(configured = false, connecting = false, connected = false, error = failure.message)
            }
        }
    }

    private fun connectAndLoad() = viewModelScope.launch {
        runCatching { api?.health() == true }.onSuccess { healthy ->
            state = state.copy(connecting = false, connected = healthy, error = if (healthy) null else "PC indisponível.")
            if (healthy) loadMetadata()
        }.onFailure { state = state.copy(connecting = false, connected = false, error = it.message) }
    }

    fun retry() {
        if (api == null) return
        state = state.copy(connecting = true, error = null)
        connectAndLoad()
    }

    private suspend fun loadMetadata() {
        val client = api ?: return
        val models = runCatching { client.models() }.getOrElse { emptyList() }
        val quota = runCatching { client.quota() }.getOrElse { QuotaInfo(source = "error", message = it.message) }
        val selected = state.selectedModel.takeIf { id -> models.any { it.id == id } }
            ?: models.firstOrNull()?.id.orEmpty()
        state = state.copy(models = models, selectedModel = selected, quota = quota)
    }

    fun logout() {
        api?.cancel()
        api = null
        store.clearConfig()
        state = state.copy(configured = false, connected = false, connecting = false, generating = false)
    }

    fun newChat() {
        val chat = Conversation(model = state.selectedModel)
        updateChats(listOf(chat) + state.conversations, chat.id)
    }

    fun selectChat(id: String) { state = state.copy(currentId = id, editingMessageId = null) }

    fun deleteChat(id: String) {
        val remaining = state.conversations.filterNot { it.id == id }
        updateChats(remaining, if (state.currentId == id) remaining.firstOrNull()?.id else state.currentId)
    }

    fun selectModel(id: String) {
        state = state.copy(selectedModel = id)
        current?.let { replaceConversation(it.copy(model = id, updatedAt = System.currentTimeMillis())) }
    }

    fun toggleResearch() { state = state.copy(researchEnabled = !state.researchEnabled) }

    fun beginEdit(message: ChatMessage) {
        if (message.role == MessageRole.USER && !state.generating) state = state.copy(editingMessageId = message.id)
    }

    fun cancelEdit() { state = state.copy(editingMessageId = null) }

    fun deleteMessage(messageId: String) {
        val chat = current ?: return
        if (state.generating) return
        replaceConversation(chat.copy(messages = chat.messages.filterNot { it.id == messageId }, updatedAt = System.currentTimeMillis()))
    }

    fun send(text: String) {
        val content = text.trim()
        if (content.isBlank() || state.generating || !state.connected) return
        var chat = current ?: Conversation(model = state.selectedModel)
        val editIndex = state.editingMessageId?.let { id -> chat.messages.indexOfFirst { it.id == id } } ?: -1
        val base = if (editIndex >= 0) chat.messages.take(editIndex) else chat.messages
        val user = ChatMessage(role = MessageRole.USER, content = content)
        val assistant = ChatMessage(role = MessageRole.ASSISTANT, content = "")
        val title = if (base.isEmpty()) content.replace('\n', ' ').take(48) else chat.title
        chat = chat.copy(
            title = title,
            model = state.selectedModel,
            messages = base + user + assistant,
            updatedAt = System.currentTimeMillis(),
        )
        if (current == null) updateChats(listOf(chat) + state.conversations, chat.id) else replaceConversation(chat)
        state = state.copy(generating = true, editingMessageId = null, error = null)

        viewModelScope.launch {
            val targetId = chat.id
            val assistantId = assistant.id
            runCatching {
                api?.streamChat(chat, state.selectedModel, state.researchEnabled) { delta ->
                    withContext(Dispatchers.Main) { appendDelta(targetId, assistantId, delta) }
                } ?: error("Gateway desconectado.")
            }.onFailure { failure ->
                withContext(Dispatchers.Main) {
                    val latest = state.conversations.firstOrNull { it.id == targetId }
                    val emptyAssistant = latest?.messages?.firstOrNull { it.id == assistantId }?.content.isNullOrBlank()
                    if (emptyAssistant) appendDelta(targetId, assistantId, "Não consegui responder: ${failure.message}")
                    state = state.copy(error = failure.message)
                }
            }
            state = state.copy(generating = false)
        }
    }

    fun stop() {
        api?.cancel()
        state = state.copy(generating = false)
    }

    private fun appendDelta(chatId: String, messageId: String, delta: String) {
        val chat = state.conversations.firstOrNull { it.id == chatId } ?: return
        replaceConversation(chat.copy(
            messages = chat.messages.map { if (it.id == messageId) it.copy(content = it.content + delta) else it },
            updatedAt = System.currentTimeMillis(),
        ))
    }

    private fun replaceConversation(chat: Conversation) {
        updateChats(state.conversations.map { if (it.id == chat.id) chat else it }, state.currentId ?: chat.id)
    }

    private fun updateChats(chats: List<Conversation>, currentId: String?) {
        val sorted = chats.sortedByDescending { it.updatedAt }
        state = state.copy(conversations = sorted, currentId = currentId)
        store.saveConversations(sorted)
    }
}
