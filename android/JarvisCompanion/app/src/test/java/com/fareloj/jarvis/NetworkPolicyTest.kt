package com.fareloj.jarvis

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkPolicyTest {
    @Test fun `https remoto continua permitido`() {
        val result = validateServerEndpoint("https://jarvis.example.com/", allowLanHttp = false)
        assertNull(result.error)
        assertFalse(result.isLan)
        assertTrue(result.normalizedUrl == "https://jarvis.example.com")
    }

    @Test fun `http privado exige modo lan e porta`() {
        assertTrue(validateServerEndpoint("http://192.168.15.91:49200", true).isLan)
        assertTrue(validateServerEndpoint("http://10.0.0.2:49200", true).isLan)
        assertTrue(validateServerEndpoint("http://172.31.255.254:49200", true).isLan)
        assertFalse(validateServerEndpoint("http://192.168.15.91:49200", false).error.isNullOrBlank())
        assertFalse(validateServerEndpoint("http://192.168.15.91", true).error.isNullOrBlank())
    }

    @Test fun `http publico loopback e enderecos ambiguos sao recusados`() {
        listOf(
            "http://8.8.8.8:49200",
            "http://127.0.0.1:49200",
            "http://localhost:49200",
            "http://192.168.001.10:49200",
            "http://user@192.168.1.10:49200",
        ).forEach { assertFalse(validateServerEndpoint(it, true).error.isNullOrBlank()) }
    }
}
