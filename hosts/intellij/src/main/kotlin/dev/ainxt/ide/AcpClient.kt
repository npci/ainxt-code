// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * JVM ACP client for the ainxt agent — the IntelliJ counterpart of the VS Code
 * host. Spawns `ainxt agent -m <model> stdio` in LEADER mode (the session lives
 * in the persistent leader daemon, so conversations survive IDE reloads) and
 * speaks newline-delimited JSON-RPC 2.0 (ACP protocolVersion 1).
 *
 * Dependency-light (Gson only, on the platform classpath).
 */
class AcpClient(
    private val binPath: String,
    private val model: String,
    private val cwd: String,
    private val clientIdentifier: String,
    private val clientVersion: String,
    private val env: Map<String, String> = emptyMap(),
    /** Raw `session/update` params (`{sessionId, update}`) as JSON. */
    private val onUpdate: (JsonObject) -> Unit,
    /** `session/request_permission` params → chosen optionId, or null to cancel. */
    private val onPermission: (JsonObject) -> String?,
    /** `ainxt.dev/ask_user_question` params → result object (outcome/answers/…). */
    private val onAsk: (JsonObject) -> JsonObject = { JsonObject().apply { addProperty("outcome", "cancelled") } },
    /** `ainxt.dev/exit_plan_mode` params → result object (outcome approved/cancelled/abandoned). */
    private val onPlanApproval: (JsonObject) -> JsonObject = { JsonObject().apply { addProperty("outcome", "cancelled") } },
    /** Called after the agent writes a file (path), so the host can refresh VFS + open it. */
    private val onFileWritten: (String) -> Unit = {},
    /**
     * Ask the user to approve a sensitive host operation that the agent requested
     * directly (shell execution, or file access outside the open project).
     *
     * Receives a short title and the detail to show, and returns true to proceed.
     * Defaults to denying, so an embedder that does not wire a prompt is safe by
     * default rather than silently permissive.
     */
    private val onApproveOperation: (title: String, detail: String) -> Boolean = { _, _ -> false },
    private val onLog: (String) -> Unit = {},
    private val onExit: (Int) -> Unit = {},
) {
    private val gson = Gson()
    private val log = com.intellij.openapi.diagnostic.Logger.getInstance(AcpClient::class.java)
    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
    private var process: Process? = null
    private var writer: OutputStreamWriter? = null

    // Thread references kept so dispose() can interrupt them and release their
    // stream resources promptly, rather than waiting for the OS to close the
    // process streams (P1-2 / resource leak on plugin unload).
    private var stdoutThread: Thread? = null
    private var stderrThread: Thread? = null
    private var waitThread: Thread? = null

    /** From the initialize response — whether the agent supports session/load. */
    @Volatile var supportsLoad: Boolean = false
        private set

    fun start() {
        // Build args dynamically: --no-leader is always required.
        // -m <model> is only added when model is non-empty; empty = agent default.
        val args = if (model.isNotBlank())
            listOf(binPath, "agent", "--no-leader", "-m", model, "stdio")
        else
            listOf(binPath, "agent", "--no-leader", "stdio")
        log.debug("[ainxt-acp] spawning: ${args.joinToString(" ")} (cwd=$cwd, env keys=${env.keys})")
        val pb = ProcessBuilder(args)
        pb.directory(java.io.File(cwd))
        pb.environment().putAll(env)
        val proc = pb.start()
        process = proc
        writer = OutputStreamWriter(proc.outputStream, Charsets.UTF_8)

        // Store thread references so dispose() can interrupt them promptly.
        // All three are daemon threads so they never prevent JVM/IDE shutdown,
        // but storing the references lets us close the underlying streams and
        // release the pending-futures map without waiting for the OS to drain
        // the process pipes (P1-2).
        stdoutThread = Thread({ readLoop(proc.inputStream.bufferedReader()) }, "ainxt-acp-stdout").apply {
            isDaemon = true; start()
        }
        stderrThread = Thread({
            BufferedReader(InputStreamReader(proc.errorStream, Charsets.UTF_8)).forEachLine {
                onLog("[agent-stderr] $it")
            }
        }, "ainxt-acp-stderr").apply { isDaemon = true; start() }

        waitThread = Thread({
            val code = proc.waitFor()
            pending.values.forEach { it.completeExceptionally(RuntimeException("agent exited (code $code)")) }
            pending.clear()
            onExit(code)
        }, "ainxt-acp-wait").apply { isDaemon = true; start() }
    }

    fun initialize(): JsonObject {
        val params = JsonObject().apply {
            addProperty("protocolVersion", 1)
            add("clientCapabilities", JsonObject().apply {
                add("fs", JsonObject().apply {
                    addProperty("readTextFile", true)
                    addProperty("writeTextFile", true)
                })
                addProperty("terminal", true)
            })
            add("_meta", JsonObject().apply {
                addProperty("clientIdentifier", clientIdentifier)
                addProperty("clientVersion", clientVersion)
            })
        }
        val res = request("initialize", params).get(30, TimeUnit.SECONDS)
        supportsLoad = res.getAsJsonObject("agentCapabilities")
            ?.get("loadSession")?.let { !it.isJsonNull && it.asBoolean } ?: false
        return res
    }

    /** Returns the full session/new result (sessionId + models + modes + _meta). */
    fun newSession(): JsonObject {
        val params = JsonObject().apply {
            addProperty("cwd", cwd)
            add("mcpServers", JsonArray())
        }
        return request("session/new", params).get(30, TimeUnit.SECONDS)
    }

    /** Loads (resumes) an existing session, replaying history via session/update. */
    fun loadSession(sessionId: String): JsonObject {
        val params = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("cwd", cwd)
            add("mcpServers", JsonArray())
        }
        return request("session/load", params).get(30, TimeUnit.SECONDS)
    }

    fun prompt(sessionId: String, text: String): CompletableFuture<JsonObject> {
        val block = JsonObject().apply { addProperty("type", "text"); addProperty("text", text) }
        val arr = JsonArray().apply { add(block) }
        val params = JsonObject().apply { addProperty("sessionId", sessionId); add("prompt", arr) }
        return request("session/prompt", params)
    }

    fun cancel(sessionId: String) {
        notify("session/cancel", JsonObject().apply { addProperty("sessionId", sessionId) })
    }

    fun setModel(sessionId: String, modelId: String) {
        request("session/set_model", JsonObject().apply {
            addProperty("sessionId", sessionId); addProperty("modelId", modelId)
        })
    }

    fun setMode(sessionId: String, modeId: String) {
        request("session/set_mode", JsonObject().apply {
            addProperty("sessionId", sessionId); addProperty("modeId", modeId)
        })
    }

    fun dispose() {
        // 1. Close the writer first — this sends EOF to the agent's stdin,
        //    giving it a chance to shut down cleanly before we destroy it.
        try { writer?.close() } catch (_: Exception) {}

        // 2. Destroy the process. This closes the OS-level pipe file descriptors,
        //    which causes the stdout/stderr reader threads to reach EOF and exit
        //    their forEachLine loops naturally. The interrupt below is a belt-and-
        //    suspenders measure for threads that may be blocked on a slow read.
        try { process?.destroy() } catch (_: Exception) {}

        // 3. Interrupt the I/O threads so they release their BufferedReader
        //    references promptly rather than waiting for the next read() to
        //    return. This is the fix for the resource leak identified in P1-2:
        //    without the interrupt, a thread blocked in readLine() holds the
        //    stream open until the OS reclaims the process, which on some JVMs
        //    can be seconds after destroy() returns.
        stdoutThread?.interrupt()
        stderrThread?.interrupt()
        waitThread?.interrupt()

        // 4. Fail any in-flight requests immediately so callers don't hang.
        pending.values.forEach {
            it.completeExceptionally(RuntimeException("AcpClient disposed"))
        }
        pending.clear()
    }

    // --- wire ---------------------------------------------------------------

    private fun request(method: String, params: JsonObject): CompletableFuture<JsonObject> {
        val id = nextId.getAndIncrement()
        log.debug("[ainxt-acp] → request id=$id method=$method")
        val future = CompletableFuture<JsonObject>()
        pending[id] = future
        write(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            addProperty("method", method)
            add("params", params)
        })
        return future
    }

    private fun notify(method: String, params: JsonObject) {
        write(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        })
    }

    @Synchronized
    private fun write(msg: JsonObject) {
        writer?.apply { write(gson.toJson(msg)); write("\n"); flush() }
    }

    private fun readLoop(reader: BufferedReader) {
        reader.forEachLine { line ->
            val t = line.trim()
            if (t.isEmpty()) return@forEachLine
            val msg = try {
                JsonParser.parseString(t).asJsonObject
            } catch (_: Exception) {
                onLog("[agent-nonjson] $t"); return@forEachLine
            }
            val hasId = msg.has("id") && !msg.get("id").isJsonNull
            val hasMethod = msg.has("method")
            // Log only the message envelope (method + id) — never log content/params
            val logMethod = if (hasMethod) msg.get("method").asString else "(response)"
            val logId = if (hasId) msg.get("id").asString else "-"
            log.debug("[ainxt-acp] ← method=$logMethod id=$logId")

            when {
                hasMethod && hasId -> handleServerRequest(msg)
                hasMethod -> handleNotification(msg)
                hasId -> {
                    val id = msg.get("id").asInt
                    val f = pending.remove(id) ?: return@forEachLine
                    if (msg.has("error") && !msg.get("error").isJsonNull) {
                        val em = msg.getAsJsonObject("error").get("message")?.asString ?: "rpc error"
                        f.completeExceptionally(RuntimeException(em))
                    } else {
                        f.complete(msg.getAsJsonObject("result") ?: JsonObject())
                    }
                }
            }
        }
    }

    private fun handleNotification(msg: JsonObject) {
        // `_`-prefix is the leader-proxy variant. `ainxt.dev/session_notification`
        // is the fine-grained live-progress rail; its params are {sessionId, update}
        // just like session/update, so route both through onUpdate.
        when (msg.get("method")?.asString?.removePrefix("_")) {
            "session/update", "ainxt.dev/session_notification" ->
                (msg.get("params") as? JsonObject)?.let(onUpdate)
            else -> {}
        }
    }

    private fun handleServerRequest(msg: JsonObject) {
        val id = msg.get("id")
        // In leader mode the method may arrive prefixed with `_`.
        val method = msg.get("method")?.asString?.removePrefix("_")
        when (method) {
            "session/request_permission" -> {
                val chosen = onPermission(msg.getAsJsonObject("params"))
                val outcome = JsonObject().apply {
                    if (chosen != null) {
                        addProperty("outcome", "selected"); addProperty("optionId", chosen)
                    } else {
                        addProperty("outcome", "cancelled")
                    }
                }
                writeResult(id, JsonObject().apply { add("outcome", outcome) })
            }
            "ainxt.dev/ask_user_question" -> {
                // Unwrap the leader-proxy nesting if the real call is one level down.
                val raw = msg.getAsJsonObject("params")
                val p = when {
                    raw == null -> JsonObject()
                    raw.has("questions") -> raw
                    raw.getAsJsonObject("params")?.has("questions") == true -> raw.getAsJsonObject("params")
                    raw.getAsJsonObject("request")?.has("questions") == true -> raw.getAsJsonObject("request")
                    else -> raw
                }
                writeResult(id, onAsk(p))
            }
            "ainxt.dev/exit_plan_mode" -> {
                val raw = msg.getAsJsonObject("params")
                val p = when {
                    raw == null -> JsonObject()
                    raw.has("planContent") || raw.has("toolCallId") -> raw
                    raw.getAsJsonObject("params") != null -> raw.getAsJsonObject("params")
                    raw.getAsJsonObject("request") != null -> raw.getAsJsonObject("request")
                    else -> raw
                }
                writeResult(id, onPlanApproval(p))
            }
            "fs/read_text_file" -> {
                val p = msg.getAsJsonObject("params")
                val path = p.get("path")?.takeIf { !it.isJsonNull }?.asString ?: ""
                // Reading a file outside the open project is not something the
                // agent may do unilaterally: ask the user first (CWE-23).
                if (!isInsideWorkspace(path) &&
                    !onApproveOperation(
                        "Read file outside project?",
                        "The agent wants to read:\n${canonicalOf(path)}\n\n" +
                            "This is outside the open project ($cwd).",
                    )
                ) {
                    log.warn("[ainxt-acp] ⛔ fs/read_text_file denied by user — \"$path\"")
                    writeError(id, "read denied: path is outside the project and was not approved")
                    return
                }
                try {
                    // Use IntelliJ VFS so we read the live editor buffer (including
                    // unsaved changes) rather than the stale on-disk content.
                    val vfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                    val vFile = vfs.refreshAndFindFileByPath(path)
                        ?: throw java.io.FileNotFoundException("File not found in VFS: $path")
                    var content = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
                        .getDocument(vFile)?.text                    // live editor buffer
                        ?: String(vFile.contentsToByteArray(), vFile.charset) // on-disk fallback
                    val line = p.get("line")?.takeIf { !it.isJsonNull }?.asInt
                    val limit = p.get("limit")?.takeIf { !it.isJsonNull }?.asInt
                    if (line != null && line > 0) {
                        val lines = content.split("\n")
                        val start = (line - 1).coerceIn(0, lines.size)
                        val end = if (limit != null) (start + limit).coerceAtMost(lines.size) else lines.size
                        content = lines.subList(start, end).joinToString("\n")
                    }
                    writeResult(id, JsonObject().apply { addProperty("content", content) })
                } catch (e: Exception) {
                    log.warn("[ainxt-acp] fs/read_text_file failed: $path — ${e.message}")
                    writeError(id, "read failed: ${e.message}")
                }
            }
            "fs/write_text_file" -> {
                val p = msg.getAsJsonObject("params")
                val path = p.get("path")?.takeIf { !it.isJsonNull }?.asString ?: ""
                val content = p.get("content")?.takeIf { !it.isJsonNull }?.asString ?: ""
                // Writing outside the open project can overwrite arbitrary files
                // (shell profiles, SSH config, …) — require explicit approval (CWE-23).
                if (!isInsideWorkspace(path) &&
                    !onApproveOperation(
                        "Write file outside project?",
                        "The agent wants to write:\n${canonicalOf(path)}\n\n" +
                            "This is outside the open project ($cwd).",
                    )
                ) {
                    log.warn("[ainxt-acp] ⛔ fs/write_text_file denied by user — \"$path\"")
                    writeError(id, "write denied: path is outside the project and was not approved")
                    return
                }
                try {
                    // Ensure parent directories exist on disk first.
                    java.io.File(path).parentFile?.mkdirs()
                    // Write via VFS inside a write action so IntelliJ's change-tracking,
                    // undo history, and file-watcher notifications all fire correctly.
                    val vfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                    com.intellij.openapi.application.ApplicationManager.getApplication()
                        .invokeAndWait {
                            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(null) {
                                val vFile = vfs.refreshAndFindFileByPath(path)
                                    ?: vfs.refreshAndFindFileByPath(
                                        java.io.File(path).also { it.createNewFile() }.canonicalPath
                                    )!!
                                vFile.setBinaryContent(content.toByteArray(vFile.charset))
                            }
                        }
                    vfs.refreshAndFindFileByPath(path)?.refresh(false, false)
                    onFileWritten(path)
                    writeResult(id, JsonObject())
                } catch (e: Exception) {
                    log.warn("[ainxt-acp] fs/write_text_file failed: $path — ${e.message}")
                    writeError(id, "write failed: ${e.message}")
                }
            }
            "terminal/execute" -> {
                // Execute a shell command and return its combined stdout+stderr output.
                // Runs in a daemon thread so the ACP read loop is not blocked.
                val p = msg.getAsJsonObject("params")
                val command = p.get("command")?.takeIf { !it.isJsonNull }?.asString ?: ""
                val workDir = p.get("cwd")?.takeIf { !it.isJsonNull }?.asString ?: cwd
                Thread({
                    try {
                        // The command is executed verbatim by the system shell, so it
                        // must never run on the agent's say-so alone — ask the user
                        // first (CWE-77). Prompting inside this thread keeps the ACP
                        // read loop responsive while the dialog is open.
                        if (!onApproveOperation(
                                "Run shell command?",
                                "The agent wants to run:\n$command\n\nWorking directory: $workDir",
                            )
                        ) {
                            log.warn("[ainxt-acp] ⛔ terminal/execute denied by user")
                            writeError(id, "command denied: not approved by the user")
                            return@Thread
                        }
                        // Log only the executable name — never log the full command (may contain secrets)
                        val executable = command.trim().split(Regex("\\s+")).firstOrNull() ?: "(empty)"
                        log.debug("[ainxt-acp] terminal/execute: $executable … (cwd=$workDir)")
                        val isWindows = System.getProperty("os.name").lowercase().contains("win")
                        val shell = if (isWindows) listOf("cmd.exe", "/c", command)
                                    else listOf("/bin/sh", "-c", command)
                        val proc = ProcessBuilder(shell)
                            .directory(java.io.File(workDir))
                            .redirectErrorStream(true)   // merge stderr into stdout
                            .start()
                        val output = proc.inputStream.bufferedReader().readText()
                        val exitCode = proc.waitFor()
                        writeResult(id, JsonObject().apply {
                            addProperty("output", output)
                            addProperty("exitCode", exitCode)
                        })
                        onLog("[terminal] exit=$exitCode cmd=$command")
                    } catch (e: Exception) {
                        log.warn("[ainxt-acp] terminal/execute failed: ${e.message}")
                        writeError(id, "terminal execute failed: ${e.message}")
                    }
                }, "ainxt-terminal-exec").apply { isDaemon = true; start() }
            }
            else -> {
                // Answer anything else so the agent doesn't block.
                write(JsonObject().apply {
                    addProperty("jsonrpc", "2.0"); add("id", id)
                    add("error", JsonObject().apply {
                        addProperty("code", -32601)
                        addProperty("message", "not supported by AiNxt IntelliJ host")
                    })
                })
            }
        }
    }

    /**
     * Resolve a path to its canonical form so that `..` segments, symlinks and
     * relative paths cannot be used to disguise a location outside the project.
     * Falls back to the absolute path when the file does not exist yet (writes).
     */
    private fun canonicalOf(path: String): String = try {
        java.io.File(path).canonicalPath
    } catch (_: Exception) {
        java.io.File(path).absolutePath
    }

    /**
     * True when [path] resolves to a location inside the session's working
     * directory. Compared on canonical paths with a trailing separator, so a
     * sibling directory sharing a name prefix (`/work/project-secrets` next to
     * `/work/project`) is correctly treated as outside (CWE-23).
     */
    private fun isInsideWorkspace(path: String): Boolean {
        if (path.isBlank()) return false
        return try {
            val base = java.io.File(cwd).canonicalFile
            var candidate: java.io.File? = java.io.File(canonicalOf(path))
            while (candidate != null) {
                if (candidate == base) return true
                candidate = candidate.parentFile
            }
            false
        } catch (_: Exception) {
            false
        }
    }

    private fun writeResult(id: com.google.gson.JsonElement?, result: JsonObject) {
        write(JsonObject().apply {
            addProperty("jsonrpc", "2.0"); add("id", id); add("result", result)
        })
    }

    private fun writeError(id: com.google.gson.JsonElement?, message: String) {
        write(JsonObject().apply {
            addProperty("jsonrpc", "2.0"); add("id", id)
            add("error", JsonObject().apply { addProperty("code", -32603); addProperty("message", message) })
        })
    }
}
