package com.fareloj.jarvis

import java.net.URI

data class EndpointValidation(
    val normalizedUrl: String? = null,
    val isLan: Boolean = false,
    val error: String? = null,
)

fun validateServerEndpoint(raw: String, allowLanHttp: Boolean): EndpointValidation {
    val normalized = raw.trim().trimEnd('/')
    val uri = runCatching { URI(normalized) }.getOrNull()
        ?: return EndpointValidation(error = "A URL informada é inválida.")
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (host.isNullOrBlank() || uri.userInfo != null || uri.query != null || uri.fragment != null) {
        return EndpointValidation(error = "Use apenas o endereço base do JARVIS, sem login, parâmetros ou fragmentos.")
    }
    if (scheme == "https" && host !in setOf("localhost", "127.0.0.1")) {
        return EndpointValidation(normalizedUrl = normalized)
    }
    if (scheme == "http" && allowLanHttp && isPrivateIpv4(host) && uri.port in 1..65535) {
        return EndpointValidation(normalizedUrl = normalized, isLan = true)
    }
    return EndpointValidation(error = if (allowLanHttp) {
        "Use HTTPS ou HTTP com IP privado e porta, por exemplo http://192.168.1.10:49200."
    } else {
        "Esta versão exige uma URL HTTPS."
    })
}

fun isPrivateIpv4(host: String): Boolean {
    val parts = host.split('.')
    if (parts.size != 4) return false
    val octets = parts.map { part ->
        if (part.isEmpty() || part.length > 3 || (part.length > 1 && part.startsWith('0'))) return false
        part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
    }
    return octets[0] == 10 ||
        (octets[0] == 172 && octets[1] in 16..31) ||
        (octets[0] == 192 && octets[1] == 168)
}
