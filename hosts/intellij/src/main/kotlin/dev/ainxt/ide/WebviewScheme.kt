// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.intellij.ui.jcef.JBCefApp
import org.cef.CefApp
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefCallback
import org.cef.callback.CefSchemeHandlerFactory
import org.cef.handler.CefResourceHandler
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Serves the bundled React UI (packaged under classpath `/webview`) over a
 * custom `http://ainxt/...` origin. Chromium blocks ES-module loading over
 * `file://`, so the shared Vite bundle (an ES module) must be served from an
 * http origin — this scheme handler does that from plugin resources, keeping a
 * single UI build shared with the VS Code extension.
 */
object WebviewScheme {
    const val HOST = "ainxt"
    const val INDEX_URL = "http://ainxt/index.html"

    /**
     * The exact origin the webview document runs on. Used as the explicit
     * `targetOrigin` for host → UI `postMessage` calls so payloads are never
     * broadcast to an arbitrary origin.
     */
    const val ORIGIN = "http://ainxt"

    private val registered = AtomicBoolean(false)

    /** Register the scheme handler once, after JCEF is initialized. */
    fun ensureRegistered() {
        if (!registered.compareAndSet(false, true)) return
        JBCefApp.getInstance() // guarantees JCEF is available/initialized
        CefApp.getInstance().registerSchemeHandlerFactory("http", HOST, Factory())
    }

    private class Factory : CefSchemeHandlerFactory {
        override fun create(
            browser: CefBrowser?,
            frame: CefFrame?,
            schemeName: String?,
            request: CefRequest?,
        ): CefResourceHandler? {
            val url = request?.url ?: return null
            val path = try { URI(url).path } catch (e: Exception) { "/" }
            val clean = if (path.isNullOrEmpty() || path == "/") "/index.html" else path
            // Defense-in-depth: reject any ".." segment before it reaches classpath
            // resource resolution, so this handler never depends on the classloader's
            // own path-traversal semantics (CWE-23).
            if (clean.contains("..")) return null
            return ResourceHandler("/webview$clean")
        }
    }

    /** Streams a single classpath resource as an HTTP 200 response. */
    private class ResourceHandler(private val resourcePath: String) : CefResourceHandler {
        private var data: ByteArray? = null
        private var mime: String = "application/octet-stream"
        private var offset = 0

        override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean {
            val bytes = javaClass.getResourceAsStream(resourcePath)?.use { it.readBytes() }
            if (bytes == null) {
                callback?.cancel()
                return false
            }
            data = bytes
            mime = mimeFor(resourcePath)
            callback?.Continue()
            return true
        }

        override fun getResponseHeaders(response: CefResponse?, responseLength: IntRef?, redirectUrl: StringRef?) {
            response?.mimeType = mime
            response?.status = 200
            // The document and these resources share the `http://ainxt` origin, so
            // module fetches need no cross-origin grant. Name that origin explicitly
            // instead of '*': a wildcard would let any other origin loaded in the
            // JCEF browser read the UI bundle, which undermines the same-origin
            // posture that postToUi's explicit targetOrigin relies on (CWE-942).
            response?.setHeaderByName("Access-Control-Allow-Origin", ORIGIN, true)
            responseLength?.set(data?.size ?: 0)
        }

        override fun readResponse(dataOut: ByteArray, bytesToRead: Int, bytesRead: IntRef, callback: CefCallback?): Boolean {
            val d = data ?: return false
            if (offset >= d.size) {
                bytesRead.set(0)
                return false
            }
            val n = minOf(bytesToRead, d.size - offset)
            System.arraycopy(d, offset, dataOut, 0, n)
            offset += n
            bytesRead.set(n)
            return true
        }

        override fun cancel() { /* no-op */ }

        private fun mimeFor(path: String): String = when {
            path.endsWith(".html") -> "text/html"
            path.endsWith(".js") -> "text/javascript"
            path.endsWith(".css") -> "text/css"
            path.endsWith(".png") -> "image/png"
            path.endsWith(".svg") -> "image/svg+xml"
            path.endsWith(".json") -> "application/json"
            path.endsWith(".woff2") -> "font/woff2"
            else -> "application/octet-stream"
        }
    }
}
