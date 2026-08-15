package com.fareloj.jarvis

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class JarvisApi(private val config: ConnectionConfig) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    @Volatile private var activeCall: Call? = null

    private fun request(path: String) = Request.Builder()
        .url("${config.serverUrl.trimEnd('/')}$path")
        .header("Authorization", "Bearer ${config.token}")

    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        client.newCall(request("/v1/health").get().build()).execute().use { response ->
            response.isSuccessful && JSONObject(response.body.string()).optBoolean("ok")
        }
    }

    suspend fun models(): List<CloudModel> = withContext(Dispatchers.IO) {
        client.newCall(request("/v1/models").get().build()).execute().use { response ->
            if (!response.isSuccessful) throw apiError(response.code, response.body.string())
            val array = JSONObject(response.body.string()).optJSONArray("models") ?: JSONArray()
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(CloudModel(
                        id = item.getString("id"),
                        label = item.optString("label", item.getString("id")),
                        parameters = item.optString("parametros").takeIf { it.isNotBlank() && it != "null" },
                        usageLevel = item.optString("nivelDeUso", "medium"),
                        multimodal = item.optBoolean("multimodal"),
                        tools = item.optBoolean("tools"),
                        thinking = item.optBoolean("thinking"),
                    ))
                }
            }
        }
    }

    suspend fun quota(): QuotaInfo = withContext(Dispatchers.IO) {
        client.newCall(request("/v1/quota").get().build()).execute().use { response ->
            if (!response.isSuccessful) throw apiError(response.code, response.body.string())
            val json = JSONObject(response.body.string())
            QuotaInfo(
                source = json.optString("source", "unconfigured"),
                plan = json.optString("plan"),
                sessionPercent = json.optJSONObject("session")?.optDouble("usedPercent"),
                weeklyPercent = json.optJSONObject("weekly")?.optDouble("usedPercent"),
                message = json.optString("message").takeIf { it.isNotBlank() },
            )
        }
    }

    suspend fun streamChat(
        conversation: Conversation,
        model: String,
        researchEnabled: Boolean,
        onDelta: suspend (String) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val messages = JSONArray().apply {
            conversation.messages.filter { it.content.isNotBlank() }.forEach { message ->
                put(JSONObject().apply {
                    put("role", if (message.role == MessageRole.USER) "user" else "assistant")
                    put("content", message.content)
                })
            }
        }
        val payload = JSONObject().apply {
            put("runId", "mobile-${java.util.UUID.randomUUID()}")
            put("sessionId", conversation.id)
            put("sessionTitle", conversation.title)
            put("model", model)
            put("researchEnabled", researchEnabled)
            put("messages", messages)
        }
        val call = client.newCall(request("/v1/chat/stream")
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build())
        activeCall = call
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw apiError(response.code, response.body.string())
                val source = response.body.source()
                while (!source.exhausted()) {
                    val line = source.readUtf8Line()?.trim().orEmpty()
                    if (line.isBlank()) continue
                    val event = runCatching { JSONObject(line) }.getOrNull() ?: continue
                    when (event.optString("type")) {
                        "message.delta" -> onDelta(event.optJSONObject("payload")?.optString("content").orEmpty())
                        "run.failed" -> throw IOException(event.optJSONObject("payload")?.optString("error") ?: "A geração falhou.")
                    }
                }
            }
        } finally {
            activeCall = null
        }
    }

    fun cancel() { activeCall?.cancel() }

    private fun apiError(code: Int, body: String?): IOException {
        val message = runCatching { JSONObject(body.orEmpty()).optString("error") }.getOrNull()
        return IOException(message?.takeIf { it.isNotBlank() } ?: "JARVIS respondeu HTTP $code.")
    }
}
