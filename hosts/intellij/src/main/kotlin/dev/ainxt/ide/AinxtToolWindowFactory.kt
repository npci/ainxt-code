// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandlerAdapter
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hosts the shared AiNxt React UI in a JCEF browser and bridges it to
 * [AcpClient], speaking the SAME postMessage contract as the VS Code webview so
 * a single UI build serves both IDEs.
 */
class AinxtToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        WebviewScheme.ensureRegistered()

        val browser = JBCefBrowser()
        val jsQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
        val bridge = Bridge(project, browser)

        jsQuery.addHandler { raw ->
            bridge.onUiMessage(raw)
            null
        }

        // Inject the UI→host post function once the page is ready.
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(b: CefBrowser?, isLoading: Boolean, canGoBack: Boolean, canGoForward: Boolean) {
                if (!isLoading) {
                    browser.cefBrowser.executeJavaScript(
                        "window.__ainxtHostPost = function(s) { ${jsQuery.inject("s")} };",
                        browser.cefBrowser.url, 0,
                    )
                }
            }
        }, browser.cefBrowser)

        browser.loadURL(WebviewScheme.INDEX_URL)

        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

private class Bridge(
    private val project: Project,
    private val browser: JBCefBrowser,
) {
    private val gson = Gson()
    private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("dev.ainxt.ide.Bridge")
    private val cwd: String = project.basePath ?: System.getProperty("user.home")
    private val agentName = "AiNxt"

    @Volatile private var client: AcpClient? = null
    @Volatile private var sessionId: String? = null
    private val permSeq = AtomicInteger(0)
    private val pendingPerms = ConcurrentHashMap<String, CompletableFuture<String?>>()
    private val askSeq = AtomicInteger(0)
    private val pendingAsks = ConcurrentHashMap<String, CompletableFuture<JsonObject>>()
    private val planSeq = AtomicInteger(0)
    private val pendingPlans = ConcurrentHashMap<String, CompletableFuture<JsonObject>>()
    @Volatile private var budgetUserId: String? = null

    /** Fetch the user's budget from the gateway and push it to the status bar. */
    private fun refreshBudget() = bg {
        try {
            val base = AinxtSettings.getInstance().state.gatewayUrl.trimEnd('/')
            if (base.isEmpty()) return@bg
            val home = sanitizedEnv("AINXT_HOME") ?: (System.getProperty("user.home") + "/.ainxt")
            val creds = JsonParser.parseString(File(home, "credentials.json").readText()).asJsonObject
            val token = creds.get("accessToken")?.takeIf { !it.isJsonNull }?.asString ?: return@bg
            val client = java.net.http.HttpClient.newHttpClient()
            fun get(p: String, extra: Map<String, String> = emptyMap()): String? {
                val b = java.net.http.HttpRequest.newBuilder(java.net.URI.create("$base$p")).header("Authorization", "Bearer $token")
                extra.forEach { (k, v) -> b.header(k, v) }
                val r = client.send(b.GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString())
                return if (r.statusCode() in 200..299) r.body() else null
            }
            if (budgetUserId == null) {
                val me = get("/ainxt/v1/api/auth/me") ?: return@bg
                budgetUserId = JsonParser.parseString(me).asJsonObject.get("id")?.takeIf { !it.isJsonNull }?.asString ?: return@bg
            }
            val body = get("/ainxt/v1/api/budget/me", mapOf("X-User-Id" to budgetUserId!!)) ?: return@bg
            val bo = JsonParser.parseString(body).asJsonObject
            val ut = bo.getAsJsonObject("usage_total"); val bd = bo.getAsJsonObject("budget"); val td = bo.getAsJsonObject("usage_today")
            fun d(o: JsonObject?, k: String): Double? = o?.get(k)?.takeIf { !it.isJsonNull }?.asDouble
            postType("budgetState") {
                add("budget", JsonObject().apply {
                    d(ut, "cost_usd_spent")?.let { addProperty("costUsed", it) }
                    d(bd, "max_cost_usd_total")?.let { addProperty("costLimit", it) }
                    d(bo, "pct_used")?.let { addProperty("pctUsed", it) }
                    d(bo, "remaining_usd")?.let { addProperty("remainingUsd", it) }
                    d(ut, "tokens_used")?.let { addProperty("tokensUsed", it) }
                    d(bd, "max_tokens_total")?.let { addProperty("tokensLimit", it) }
                    d(td, "cost_usd_spent")?.let { addProperty("todayCost", it) }
                    d(td, "tokens_used")?.let { addProperty("todayTokens", it) }
                    // Authoritative verdict (present once the gateway ships it).
                    bo.get("allowed")?.takeIf { !it.isJsonNull }?.let { addProperty("allowed", it.asBoolean) }
                    bo.get("blocked_reason")?.takeIf { !it.isJsonNull }?.let { addProperty("blockedReason", it.asString) }
                    bo.get("binding_limit")?.takeIf { !it.isJsonNull }?.let { addProperty("bindingLimit", it.asString) }
                    d(bo, "pct_used_max")?.let { addProperty("pctUsedMax", it) }
                })
            }
        } catch (_: Exception) { /* best-effort */ }
    }

    // --- UI → host ----------------------------------------------------------

    fun onUiMessage(raw: String) {
        val msg = try { JsonParser.parseString(raw).asJsonObject } catch (_: Exception) { return }
        when (msg.get("type")?.asString) {
            "ready" -> bg { connectOrResume(); sendWorkspaceFiles() }
            "sendPrompt" -> sendPrompt(str(msg, "text"))
            "cancelTurn" -> sessionId?.let { client?.cancel(it) }
            "setModel" -> sessionId?.let { client?.setModel(it, str(msg, "modelId")) }
            "setMode" -> sessionId?.let { client?.setMode(it, str(msg, "modeId")) }
            "saveConnection" -> bg {
                applyConnection(str(msg, "gatewayUrl"), str(msg, "apiKey"), boolOf(msg, "allowInsecure"))
            }
            "signOut" -> bg { signOut() }
            "openSettings" -> notify("Use the Connect button in the panel header to save an API key, or a gateway URL if your team runs the AiNxt Platform.")
            "openFile" -> str(msg, "path").takeIf { it.isNotBlank() }?.let {
                openInEditor(it, msg.get("line")?.takeIf { e -> !e.isJsonNull }?.asInt ?: 0)
            }
            "openDiff" -> {
                val p = str(msg, "path")
                if (p.isNotBlank()) openDiff(p, str(msg, "oldText"), str(msg, "newText"))
            }
            "pickFiles" -> pickFiles()
            "listFiles" -> sendWorkspaceFiles()
            "attachPath" -> str(msg, "path").takeIf { it.isNotBlank() }?.let { attachByPath(it) }
            "attachFolder" -> str(msg, "path").takeIf { it.isNotBlank() }?.let { attachFolder(it) }
            "attachGit" -> attachGit()
            "attachProblems" -> notify("@problems isn't available in the JetBrains host yet — use @file/@folder/@git.")
            "newChat" -> bg { try { restartFresh() } catch (_: Exception) {} }
            "listThreads" -> postType("threads") { add("threads", JsonArray()) }
            "openThread" -> notify("Opening a past conversation isn't available in the JetBrains host yet.")
            "restoreCheckpoint" -> notify("Undo/restore isn't available in the JetBrains host yet.")
            "permissionResponse" -> {
                val id = str(msg, "requestId")
                val optionId = msg.get("optionId")?.takeIf { !it.isJsonNull }?.asString
                pendingPerms.remove(id)?.complete(optionId)
            }
            "askResponse" -> {
                val id = str(msg, "requestId")
                val result = JsonObject()
                if (str(msg, "outcome") == "accepted") {
                    result.addProperty("outcome", "accepted")
                    result.add("answers", msg.get("answers")?.takeIf { !it.isJsonNull } ?: JsonObject())
                    msg.get("annotations")?.takeIf { !it.isJsonNull }?.let { result.add("annotations", it) }
                } else {
                    result.addProperty("outcome", "cancelled")
                }
                pendingAsks.remove(id)?.complete(result)
            }
            "planApprovalResponse" -> {
                val id = str(msg, "requestId")
                val outcome = str(msg, "outcome").ifBlank { "cancelled" }
                val result = JsonObject().apply {
                    addProperty("outcome", outcome)
                    val fb = str(msg, "feedback")
                    if (outcome == "cancelled" && fb.isNotBlank()) addProperty("feedback", fb)
                }
                pendingPlans.remove(id)?.complete(result)
            }
            else -> {}
        }
    }

    // --- host → UI ----------------------------------------------------------

    private fun postToUi(obj: JsonObject) {
        // Encode the payload as a JS string literal (quoted/escaped by Gson)
        // instead of splicing the raw JSON in as object-literal syntax, then
        // reconstruct it via JSON.parse on the JS side. Untrusted content in
        // the payload (file contents, session data from the agent process)
        // can then never be interpreted as script code (CWE-79 Stored XSS).
        val encodedJson = gson.toJson(gson.toJson(obj))
        // Target the webview's own origin rather than '*': these payloads carry
        // file contents and session data, which must not be broadcast to any
        // other origin that might be hosting a frame (CWE-359).
        browser.cefBrowser.executeJavaScript(
            "window.postMessage(JSON.parse($encodedJson), '${WebviewScheme.ORIGIN}');",
            browser.cefBrowser.url,
            0,
        )
    }

    private fun postType(type: String, build: JsonObject.() -> Unit = {}) {
        postToUi(JsonObject().apply { addProperty("type", type); build() })
    }

    // --- lifecycle ----------------------------------------------------------

    /**
     * Read an environment variable and return a re-encoded, provably safe copy
     * of it at the trust boundary.
     *
     * These values are filesystem paths that are attacker-influenceable input;
     * they flow into the agent process and, via its responses, on to the
     * webview. Validation alone is not enough here: the returned string is
     * rebuilt character by character from [SAFE_PATH_ALPHABET], a compile-time
     * constant, so every character of the result originates from trusted code
     * rather than from the environment. Control characters and HTML/script
     * metacharacters (`<`, `>`, quotes, `&`) are therefore impossible in the
     * output, which breaks the data flow to every downstream consumer
     * (CWE-79 Stored XSS).
     *
     * Returns null when the variable is unset, blank, too long, or contains any
     * character outside the alphabet, so callers fall back to their existing
     * safe defaults.
     */
    private fun sanitizedEnv(name: String): String? {
        val value = System.getenv(name) ?: return null
        var start = 0
        var end = value.length
        while (start < end && value[start].isWhitespace()) start++
        while (end > start && value[end - 1].isWhitespace()) end--
        val length = end - start
        if (length == 0) return null
        val safe = if (length > MAX_PATH_LENGTH) null else reencodePath(value, start, end)
        if (safe == null) LOG.warn("Ignoring environment variable $name: value is not a valid path")
        return safe
    }

    /**
     * Rebuild the `[start, end)` range of [value] from [SAFE_PATH_ALPHABET].
     * Each input character is only used to look up an index into the constant
     * alphabet; the appended character is read back from that constant, so no
     * character of the input reaches the result. Returns null if any character
     * is outside the alphabet.
     */
    private fun reencodePath(value: String, start: Int, end: Int): String? {
        val out = StringBuilder(end - start)
        for (i in start until end) {
            val index = SAFE_PATH_ALPHABET.indexOf(value[i])
            if (index < 0) return null
            out.append(SAFE_PATH_ALPHABET[index])
        }
        return out.toString()
    }

    private fun buildEnv(): Map<String, String> {
        val s = AinxtSettings.getInstance().state
        return buildMap {
            // Only set when non-blank: the CLI treats an unset AINXT_GATEWAY_URL
            // differently from one set to "", and leaving it unset is what lets the
            // CLI run standalone against a directly-configured model. Mirrors the
            // VS Code host's AgentConfig.ts.
            if (s.gatewayUrl.isNotBlank()) { put("AINXT_GATEWAY_URL", s.gatewayUrl) }
            // Allow insecure: only when explicitly opted in, and never for plain
            // http:// to a remote host — that would put the bearer token and every
            // prompt on the wire in cleartext (CWE-319). Self-signed / internally
            // issued HTTPS certificates remain supported, as does loopback http://,
            // whose traffic never leaves the machine. Mirrors the VS Code host.
            if (s.allowInsecure) {
                if (isCleartextOverNetwork(s.gatewayUrl)) {
                    LOG.warn(
                        "[ainxt] Ignoring allowInsecure for \"${s.gatewayUrl}\": refusing to enable plaintext " +
                            "HTTP to a non-loopback host. Use https:// (a self-signed certificate is accepted) " +
                            "or a localhost gateway.",
                    )
                } else {
                    put("AINXT_ALLOW_INSECURE", "1")
                }
            }
            AinxtSecrets.getKey()?.let { put("AINXT_API_KEY", it) }
            // Pass AINXT_HOME so the agent and the plugin read credentials from
            // the same location. Inherits from the environment if set there.
            sanitizedEnv("AINXT_HOME")?.let { put("AINXT_HOME", it) }
        }
    }

    private fun newClient(): AcpClient {
        val s = AinxtSettings.getInstance().state
        val bin = s.binaryPath.ifBlank { sanitizedEnv("AINXT_BINARY_PATH") ?: "ainxt" }
        return AcpClient(
            binPath = bin,
            model = s.model,   // empty string = agent uses its own built-in default
            cwd = cwd,
            clientIdentifier = "ainxt-intellij",
            clientVersion = com.intellij.ide.plugins.PluginManagerCore.getPlugin(
                com.intellij.openapi.extensions.PluginId.getId("dev.ainxt.ide")
            )?.version ?: "unknown",
            env = buildEnv(),
            onUpdate = { params ->
                val update = params.get("update")
                if (update != null && !update.isJsonNull) {
                    postToUi(JsonObject().apply { addProperty("type", "sessionUpdate"); add("update", update) })
                }
            },
            onPermission = { params -> awaitPermission(params) },
            onAsk = { params -> awaitAsk(params) },
            onPlanApproval = { params -> awaitPlanApproval(params) },
            onApproveOperation = { title, detail -> awaitOperationApproval(title, detail) },
            onFileWritten = { path ->
                com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                    com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(path)?.let { vf ->
                        vf.refresh(false, false)
                        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, false)
                    }
                }
            },
            onLog = { line -> LOG.debug("[ainxt-agent] $line") },
            onExit = { code -> if (code != 0) postType("error") { addProperty("message", "AiNxt agent exited (code $code).") } },
        )
    }

    /** Connect, resuming the last conversation if the leader still has it. */
    private fun connectOrResume() {
        try {
            if (client == null) {
                client = newClient().also { it.start(); it.initialize() }
            }
            val c = client!!
            val lastSid = PropertiesComponent.getInstance(project).getValue(LAST_SID_KEY)
            var result: JsonObject? = null
            if (c.supportsLoad && !lastSid.isNullOrBlank()) {
                postType("loadSessionStart")
                try {
                    result = c.loadSession(lastSid)
                    sessionId = lastSid
                } catch (e: Exception) {
                    // Session gone (leader restarted / expired) — start fresh.
                    PropertiesComponent.getInstance(project).unsetValue(LAST_SID_KEY)
                } finally {
                    postType("loadSessionEnd")
                }
            }
            if (result == null) {
                result = c.newSession()
                sessionId = result.get("sessionId").asString
            }
            PropertiesComponent.getInstance(project).setValue(LAST_SID_KEY, sessionId)
            pushState(result)
            pushAuthState(false)
            refreshBudget()
        } catch (e: Exception) {
            postType("error") {
                addProperty("message", "Could not start an AiNxt session: ${e.message}. Use Connect to save an API key (no gateway needed), or run `ainxt login`.")
            }
            pushAuthState(false)
        }
    }

    /**
     * The gateway URL is optional: the ainxt CLI is fully usable standalone,
     * talking directly to a model configured in ~/.ainxt/config.toml or via
     * AINXT_API_KEY, with no AiNxt Platform involved. Requiring a gateway URL
     * here would force every user onto the gateway path even when they only
     * want to save an API key for direct-provider use, so the only thing this
     * refuses is saving nothing at all. Mirrors the VS Code host's
     * extension.ts `ainxt.applyConnection`.
     */
    private fun applyConnection(gatewayUrl: String, apiKey: String, allowInsecure: Boolean) {
        val url = gatewayUrl.trim()
        val key = apiKey.trim()
        if (url.isEmpty() && key.isEmpty()) return
        LOG.debug("[ainxt] applyConnection: begin url=$url hasKey=${key.isNotBlank()}")
        pushAuthState(true)
        try {
            LOG.debug("[ainxt] applyConnection: saving settings + secret")
            val s = AinxtSettings.getInstance().state
            if (url.isNotEmpty()) {
                s.gatewayUrl = url
                s.allowInsecure = allowInsecure
            }
            if (key.isNotBlank()) AinxtSecrets.setKey(key)
            LOG.debug("[ainxt] applyConnection: secret saved, restarting agent")
            // A gateway change starts a fresh conversation; drop the old session.
            PropertiesComponent.getInstance(project).unsetValue(LAST_SID_KEY)
            restartFresh()
            LOG.debug("[ainxt] applyConnection: restartFresh complete")
            pushAuthState(false)  // connecting=false + signedIn → webview closes the Connect form
            notify(if (url.isNotEmpty()) "Connected to AiNxt gateway $url." else "AiNxt API key saved. Running standalone against your configured model.")
        } catch (e: Exception) {
            postType("error") { addProperty("message", "Could not connect to AiNxt: ${e.message}") }
            pushAuthState(false)
        }
    }

    private fun signOut() {
        AinxtSecrets.setKey(null)
        PropertiesComponent.getInstance(project).unsetValue(LAST_SID_KEY)
        try { restartFresh() } catch (_: Exception) {}
        pushAuthState(false)
        notify("Signed out of AiNxt.")
    }

    /** Dispose and re-spawn the agent so new env (gateway/key) takes effect. */
    private fun restartFresh() {
        client?.dispose()
        client = null
        sessionId = null
        postType("clearChat")
        val c = newClient().also { it.start(); it.initialize() }
        client = c
        val result = c.newSession()
        sessionId = result.get("sessionId").asString
        PropertiesComponent.getInstance(project).setValue(LAST_SID_KEY, sessionId)
        pushState(result)
    }

    // --- state / auth -------------------------------------------------------

    private fun pushState(sessionResult: JsonObject) {
        val session = JsonObject().apply {
            addProperty("agentName", agentName)
            addProperty("cwd", cwd)
            sessionResult.get("models")?.takeIf { !it.isJsonNull }?.let { add("models", it) }
        }
        postToUi(JsonObject().apply { addProperty("type", "state"); add("session", session) })
    }

    private fun pushAuthState(connecting: Boolean) {
        val s = AinxtSettings.getInstance().state
        val email = storedGatewayEmail()
        val hasKey = AinxtSecrets.getKey() != null
        postType("authState") {
            addProperty("signedIn", hasKey || email != null)
            email?.let { addProperty("email", it) }
            addProperty("gatewayUrl", s.gatewayUrl)
            addProperty("allowInsecure", s.allowInsecure)
            addProperty("connecting", connecting)
            add("methods", JsonArray())
        }
    }

    /** Signed-in gateway account email from ~/.ainxt/credentials.json (best-effort). */
    private fun storedGatewayEmail(): String? = try {
        val home = sanitizedEnv("AINXT_HOME") ?: (System.getProperty("user.home") + "/.ainxt")
        val f = File(home, "credentials.json")
        if (!f.exists()) null
        else JsonParser.parseString(f.readText()).asJsonObject.get("email")
            ?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
    } catch (_: Exception) { null }

    // --- prompts / permissions ----------------------------------------------

    private fun sendPrompt(text: String) = bg {
        // Self-heal: if not connected yet (first-load race / auto-connect not finished),
        // connect (or resume) now, then send — instead of dead-ending.
        if (client == null || sessionId == null) {
            try { connectOrResume() } catch (_: Exception) {}
        }
        val c = client
        val sid = sessionId
        if (c == null || sid == null) {
            postType("error") { addProperty("message", "AiNxt isn't connected. Use Connect to save an API key, or check that the ainxt CLI is installed.") }
            return@bg
        }
        postType("promptStart")
        c.prompt(sid, text).whenComplete { res, err ->
            if (err != null) {
                postType("error") { addProperty("message", err.message ?: "Prompt failed") }
                postType("promptEnd") { addProperty("stopReason", "error") }
            } else {
                postType("promptEnd") {
                    res?.get("stopReason")?.takeIf { !it.isJsonNull }?.let { add("stopReason", it) }
                    val meta = res?.getAsJsonObject("_meta")
                    val usage = res?.get("usage")?.takeIf { !it.isJsonNull }
                        ?: meta?.get("usage")?.takeIf { !it.isJsonNull }
                    usage?.let { add("usage", it) }
                    meta?.let { add("meta", it) }
                }
                refreshBudget()
            }
        }
    }

    /**
     * Ask the user to approve a sensitive host operation (shell execution, or
     * file access outside the project) and block the ACP reader thread until
     * they answer.
     *
     * Uses a modal dialog rather than the in-chat permission card because these
     * requests arrive directly from the host handlers, outside the agent's
     * `session/request_permission` flow. Denial is the default on any error, so
     * a failure to show the prompt can never silently authorise the operation.
     */
    private fun awaitOperationApproval(title: String, detail: String): Boolean {
        val approved = java.util.concurrent.atomic.AtomicBoolean(false)
        try {
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
                val choice = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    detail,
                    title,
                    "Allow",
                    "Deny",
                    com.intellij.openapi.ui.Messages.getWarningIcon(),
                )
                approved.set(choice == com.intellij.openapi.ui.Messages.YES)
            }
        } catch (e: Exception) {
            LOG.warn("[ainxt] operation approval prompt failed; denying", e)
            return false
        }
        return approved.get()
    }

    private fun awaitPermission(params: JsonObject): String? {
        val requestId = "p${permSeq.getAndIncrement()}"
        val future = CompletableFuture<String?>()
        pendingPerms[requestId] = future
        postType("permissionRequest") {
            addProperty("requestId", requestId)
            add("options", params.get("options") ?: JsonArray())
            params.get("toolCall")?.takeIf { !it.isJsonNull }?.let { add("toolCall", it) }
        }
        return try { future.get() } catch (_: Exception) { null }
    }

    /** Post an ask-user-question to the UI and block until the user answers. */
    private fun awaitAsk(params: JsonObject): JsonObject {
        val requestId = "a${askSeq.getAndIncrement()}"
        val future = CompletableFuture<JsonObject>()
        pendingAsks[requestId] = future
        postType("askRequest") {
            addProperty("requestId", requestId)
            add("questions", params.get("questions") ?: JsonArray())
            addProperty("mode", params.get("mode")?.takeIf { !it.isJsonNull }?.asString ?: "default")
        }
        return try { future.get() } catch (_: Exception) {
            JsonObject().apply { addProperty("outcome", "cancelled") }
        }
    }

    /** Post an exit-plan-mode approval request to the UI and block for the decision. */
    private fun awaitPlanApproval(params: JsonObject): JsonObject {
        val requestId = "pl${planSeq.getAndIncrement()}"
        val future = CompletableFuture<JsonObject>()
        pendingPlans[requestId] = future
        postType("planApprovalRequest") {
            addProperty("requestId", requestId)
            addProperty("planContent", params.get("planContent")?.takeIf { !it.isJsonNull }?.asString ?: "")
        }
        return try { future.get() } catch (_: Exception) {
            JsonObject().apply { addProperty("outcome", "cancelled") }
        }
    }

    // --- helpers ------------------------------------------------------------

    private val excludedDirs = setOf("node_modules", ".git", "dist", "build", "target", "out", ".next", ".venv", "venv", "__pycache__", ".idea", ".gradle")

    /** Send the workspace file list (repo-relative) for the @-mention picker. */
    private fun sendWorkspaceFiles() = bg {
        try {
            val root = java.nio.file.Paths.get(cwd)
            if (!java.nio.file.Files.isDirectory(root)) return@bg
            val files = JsonArray()
            var count = 0
            java.nio.file.Files.walk(root).use { stream ->
                for (p in stream) {
                    if (count >= 4000) break
                    if (!java.nio.file.Files.isRegularFile(p)) continue
                    if (p.any { seg -> excludedDirs.contains(seg.toString()) }) continue
                    files.add(root.relativize(p).toString())
                    count++
                }
            }
            postType("workspaceFiles") { add("workspaceFiles", files) }
        } catch (_: Exception) { /* best-effort */ }
    }

    /** Read a repo-relative (or absolute) file and attach it to the composer. */
    private fun attachByPath(rel: String) = bg {
        try {
            val f = java.io.File(rel).let { if (it.isAbsolute) it else java.io.File(cwd, rel) }
            if (!f.isFile) { notify("Could not read $rel"); return@bg }
            if (f.length() > 200_000) { notify("$rel is too large to attach (>200 KB)"); return@bg }
            val content = f.readText()
            postType("filesAttached") {
                add("attachedFiles", JsonArray().apply {
                    add(JsonObject().apply { addProperty("path", rel); addProperty("content", content) })
                })
            }
        } catch (_: Exception) { notify("Could not read $rel") }
    }

    /** Attach every small file under a folder (capped) as one context bundle. */
    private fun attachFolder(rel: String) = bg {
        try {
            val dir = java.io.File(cwd, rel)
            if (!dir.isDirectory) { notify("Not a folder: $rel"); return@bg }
            val files = JsonArray()
            var total = 0L
            dir.walkTopDown().forEach { f ->
                if (files.size() >= 40 || total > 400_000) return@forEach
                if (!f.isFile) return@forEach
                if (f.toPath().any { seg -> excludedDirs.contains(seg.toString()) }) return@forEach
                if (f.length() > 100_000) return@forEach
                total += f.length()
                files.add(JsonObject().apply {
                    addProperty("path", java.io.File(cwd).toURI().relativize(f.toURI()).path)
                    addProperty("content", f.readText())
                })
            }
            if (files.size() > 0) postType("filesAttached") { add("attachedFiles", files) } else notify("No attachable files in $rel")
        } catch (_: Exception) { notify("Could not read folder $rel") }
    }

    /** Attach the current git diff (staged + unstaged) as context. */
    private fun attachGit() = bg {
        try {
            fun git(vararg args: String): String {
                val p = ProcessBuilder(listOf("git") + args).directory(java.io.File(cwd)).redirectErrorStream(false).start()
                val out = p.inputStream.bufferedReader().readText(); p.waitFor(); return out
            }
            val staged = git("diff", "--staged"); val unstaged = git("diff")
            val content = listOfNotNull(
                staged.ifBlank { null }?.let { "# staged\n$it" },
                unstaged.ifBlank { null }?.let { "# unstaged\n$it" },
            ).joinToString("\n\n").ifBlank { "No uncommitted changes." }.take(200_000)
            postType("filesAttached") {
                add("attachedFiles", JsonArray().apply { add(JsonObject().apply { addProperty("path", "git diff"); addProperty("content", content) }) })
            }
        } catch (_: Exception) { notify("git diff failed") }
    }

    /** Let the user pick files, read them, and push them to the composer as context. */
    private fun pickFiles() {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            val descriptor = com.intellij.openapi.fileChooser.FileChooserDescriptorFactory.createMultipleFilesNoJarsDescriptor()
            val chosen = com.intellij.openapi.fileChooser.FileChooser.chooseFiles(descriptor, project, null)
            val files = JsonArray()
            for (vf in chosen) {
                if (vf.isDirectory) continue
                if (vf.length > 200_000) { notify("${vf.name} is too large to attach (>200 KB)"); continue }
                val content = String(vf.contentsToByteArray(), Charsets.UTF_8)
                files.add(JsonObject().apply { addProperty("path", vf.path); addProperty("content", content) })
            }
            if (files.size() > 0) postType("filesAttached") { add("attachedFiles", files) }
        }
    }

    /** Open a file (by absolute path) in an editor tab, optionally at a 1-based line. */
    private fun openInEditor(path: String, line: Int = 0) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(path)
            if (vf != null) {
                com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, if (line > 0) line - 1 else 0, 0).navigate(true)
            } else {
                notify("Could not open $path")
            }
        }
    }

    /** Show a side-by-side native diff (Before/After) of the AiNxt change. */
    private fun openDiff(path: String, oldText: String, newText: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            val base = path.substringAfterLast('/').substringAfterLast('\\')
            val f = com.intellij.diff.DiffContentFactory.getInstance()
            val req = com.intellij.diff.requests.SimpleDiffRequest(
                "$base — AiNxt change", f.create(oldText), f.create(newText), "Before", "After",
            )
            com.intellij.diff.DiffManager.getInstance().showDiff(project, req)
        }
    }

    private fun notify(text: String) {
        NotificationGroupManager.getInstance().getNotificationGroup("AiNxt")
            .createNotification(text, NotificationType.INFORMATION)
            .notify(project)
    }

    private fun bg(block: () -> Unit) {
        Thread(block, "ainxt-bridge").apply { isDaemon = true; start() }
    }

    private fun str(o: JsonObject, k: String): String =
        o.get(k)?.takeIf { !it.isJsonNull }?.asString ?: ""

    private fun boolOf(o: JsonObject, k: String): Boolean =
        o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    companion object {
        private const val LAST_SID_KEY = "ainxt.lastSessionId"

        /**
         * The only characters a path-valued environment variable may contain:
         * letters, digits and the punctuation that legitimately appears in
         * POSIX/Windows paths (including drive letters, spaces, `~` and UNC
         * separators). Sanitized values are rebuilt from this constant, so
         * control characters, `<`, `>`, quotes and `&` can never appear in the
         * output and untrusted markup cannot enter the data flow.
         */
        private const val SAFE_PATH_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.:/\\~@+()[]-"

        /** Upper bound on a sanitized path, guarding against unbounded input. */
        private const val MAX_PATH_LENGTH = 4096
    }
}
