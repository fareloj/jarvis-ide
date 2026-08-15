package com.fareloj.jarvis

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class JarvisStore(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_companion", Context.MODE_PRIVATE)
    private val secure = SecureTokenStore(context)

    fun loadConfig(): ConnectionConfig? {
        val url = prefs.getString("server_url", null)?.trim().orEmpty()
        val token = secure.read().orEmpty()
        return if (url.isBlank() || token.isBlank()) null else ConnectionConfig(url, token)
    }

    fun saveConfig(config: ConnectionConfig) {
        prefs.edit { putString("server_url", config.serverUrl.trimEnd('/')) }
        secure.write(config.token)
    }

    fun clearConfig() {
        prefs.edit { remove("server_url") }
        secure.clear()
    }

    fun loadConversations(): List<Conversation> = runCatching {
        val array = JSONArray(prefs.getString("conversations", "[]"))
        buildList {
            for (index in 0 until array.length()) add(array.getJSONObject(index).toConversation())
        }.sortedByDescending { it.updatedAt }
    }.getOrDefault(emptyList())

    fun saveConversations(items: List<Conversation>) {
        val array = JSONArray()
        items.sortedByDescending { it.updatedAt }.take(100).forEach { array.put(it.toJson()) }
        prefs.edit { putString("conversations", array.toString()) }
    }

    private fun Conversation.toJson() = JSONObject().apply {
        put("id", id)
        put("title", title)
        put("model", model)
        put("updatedAt", updatedAt)
        put("messages", JSONArray().apply {
            messages.forEach { message ->
                put(JSONObject().apply {
                    put("id", message.id)
                    put("role", message.role.name)
                    put("content", message.content)
                    put("createdAt", message.createdAt)
                })
            }
        })
    }

    private fun JSONObject.toConversation(): Conversation {
        val messageArray = optJSONArray("messages") ?: JSONArray()
        val messages = buildList {
            for (index in 0 until messageArray.length()) {
                val item = messageArray.getJSONObject(index)
                add(ChatMessage(
                    id = item.getString("id"),
                    role = runCatching { MessageRole.valueOf(item.getString("role")) }.getOrDefault(MessageRole.USER),
                    content = item.optString("content"),
                    createdAt = item.optLong("createdAt"),
                ))
            }
        }
        return Conversation(
            id = getString("id"),
            title = optString("title", "Nova conversa"),
            model = optString("model"),
            messages = messages,
            updatedAt = optLong("updatedAt"),
        )
    }
}

private class SecureTokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_secure", Context.MODE_PRIVATE)
    private val alias = "jarvis-mobile-token"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    fun write(value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        prefs.edit {
            putString("token", Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP))
            putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        }
    }

    fun read(): String? = runCatching {
        val encrypted = Base64.decode(prefs.getString("token", null), Base64.NO_WRAP)
        val iv = Base64.decode(prefs.getString("iv", null), Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        }
        String(cipher.doFinal(encrypted))
    }.getOrNull()

    fun clear() = prefs.edit { clear() }
}
