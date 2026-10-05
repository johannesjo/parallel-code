package com.parallelcode.phone

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/** The "Connect Phone" QR code on the desktop: `http://host:port/?token=<view-only token>`. */
data class ConnectionLink(val baseUrl: String, val token: String) {
    val webSocketUrl: String
        get() = "ws" + baseUrl.removePrefix("http") + "/ws"

    companion object {
        // The server rejects longer tokens in its WebSocket auth message.
        private const val MAX_TOKEN_LENGTH = 200

        fun parse(raw: String): ConnectionLink? {
            val uri = try {
                URI(raw.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val authority = uri.rawAuthority?.takeIf { uri.host != null } ?: return null
            val token = uri.rawQuery
                ?.split('&')
                ?.firstNotNullOfOrNull { part ->
                    val (key, value) = part.split('=', limit = 2).let { it[0] to it.getOrNull(1) }
                    value?.takeIf { key == "token" }
                }
                ?.let { URLDecoder.decode(it, "UTF-8") }
                ?.takeIf { it.isNotEmpty() && it.length <= MAX_TOKEN_LENGTH }
                ?: return null
            return ConnectionLink("$scheme://$authority", token)
        }
    }
}
