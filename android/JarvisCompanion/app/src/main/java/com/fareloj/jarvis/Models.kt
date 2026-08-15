package com.fareloj.jarvis

import java.util.UUID

enum class MessageRole { USER, ASSISTANT }

data class ChatMessage(
    val id: String = UUID.randomUUID().toString(),
    val role: MessageRole,
    val content: String,
    val createdAt: Long = System.currentTimeMillis(),
)

data class Conversation(
    val id: String = UUID.randomUUID().toString(),
    val title: String = "Nova conversa",
    val model: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val updatedAt: Long = System.currentTimeMillis(),
)

data class CloudModel(
    val id: String,
    val label: String,
    val parameters: String?,
    val usageLevel: String,
    val multimodal: Boolean,
    val tools: Boolean,
    val thinking: Boolean,
)

data class QuotaInfo(
    val source: String = "unconfigured",
    val plan: String = "",
    val sessionPercent: Double? = null,
    val weeklyPercent: Double? = null,
    val message: String? = null,
)

data class ConnectionConfig(val serverUrl: String, val token: String)
