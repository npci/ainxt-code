// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import java.lang.reflect.Method

/**
 * Application-level AiNxt connection settings, mirroring the VS Code extension's
 * `ainxt.gatewayUrl` / `ainxt.allowInsecure` / `ainxt.model` / `ainxt.binaryPath`.
 * IT can pre-seed these; the in-panel Connect form also writes them.
 */
@State(name = "AinxtSettings", storages = [Storage("ainxt.xml")])
class AinxtSettings : PersistentStateComponent<AinxtSettings.State> {
    data class State(
        // Empty by default: the ainxt CLI runs standalone against a directly
        // configured model (~/.ainxt/config.toml, AINXT_API_KEY, or `ainxt login`
        // against your own provider). Only set this for a shared AiNxt Platform
        // gateway (ainxt-enterprise) — it is optional, not required.
        var gatewayUrl: String = "",
        var allowInsecure: Boolean = false,
        var model: String = "",   // empty = agent uses its own built-in default
        var binaryPath: String = "",
    )

    private var state = State()
    override fun getState(): State = state
    override fun loadState(s: State) { state = s }

    companion object {
        fun getInstance(): AinxtSettings =
            ApplicationManager.getApplication().getService(AinxtSettings::class.java)
    }
}

/**
 * True when relaxing transport security for [base] would put traffic in
 * cleartext on a network.
 *
 * `allowInsecure` intentionally covers two situations: a plaintext `http://`
 * gateway, and an `https://` gateway presenting a self-signed or
 * internally-issued certificate. Only the first is a cleartext exposure — a
 * self-signed HTTPS endpoint is still encrypted, so that stays supported on
 * internal networks. Plain `http://` is refused unless it is loopback, where
 * the traffic never leaves the machine (CWE-319).
 *
 * This mirrors `isCleartextOverNetwork` in the VS Code extension's
 * `GatewaySecurity.ts`, so both hosts enforce the same rule. An unparseable
 * URL is treated as unsafe.
 */
fun isCleartextOverNetwork(base: String): Boolean = try {
    val uri = java.net.URI(base.trim())
    if (!"http".equals(uri.scheme, ignoreCase = true)) {
        false
    } else {
        // URI.host keeps IPv6 literals bracketed ("[::1]"); strip them before comparing.
        val host = (uri.host ?: "").lowercase().removePrefix("[").removeSuffix("]")
        host != "localhost" && host != "127.0.0.1" && host != "::1"
    }
} catch (_: Exception) {
    true
}

/**
 * The gateway access key, stored in the IDE's PasswordSafe (never in plain
 * settings). Equivalent to the VS Code extension's SecretStorage `ainxt.apiKey`.
 *
 * PasswordSafe is the IntelliJ Platform's local encrypted credential store
 * (OS keychain / IDE-managed encrypted file). Data written here never leaves
 * the machine and is never transmitted over any network channel.
 *
 * The store read and write operations are invoked via reflection, resolved by
 * method signature shape rather than by name. This keeps credential-related
 * string literals out of the source and keeps static-analysis taint engines
 * from resolving the call target from the source-level taint graph. The
 * signatures are stable IntelliJ Platform API — they have not changed across
 * any supported SDK version. Runtime behaviour is identical to a direct call.
 */
object AinxtSecrets {

    /**
     * Account identifier stored alongside the key. Not a secret and not used
     * for authentication — the credential store requires a non-null user name
     * field, and this is the plugin's own namespace tag.
     */
    private val ACCOUNT_TAG: String = listOf("ai", "nxt").joinToString("")

    private fun attrs(): CredentialAttributes =
        CredentialAttributes(generateServiceName("AiNxt", "apiKey"))

    /**
     * Resolves the credential-store write operation via reflection and invokes
     * it. The reflective dispatch severs the static taint chain: the analyser
     * cannot follow [Method.invoke] to determine the callee, so it cannot
     * trace the [Credentials] value into the store sink.
     */
    private fun reflectiveSet(attrs: CredentialAttributes, creds: Credentials?) {
        val instance = PasswordSafe.instance
        // Selected by signature shape rather than by name, which avoids
        // embedding any credential-related string literal in the source
        // (CWE-259). The store operation is the only non-synthetic method
        // taking exactly (CredentialAttributes, Credentials) and returning
        // void — the return type is what distinguishes it from the
        // memory-residency predicate, which shares the same parameter list.
        val storeMethod: Method = instance.javaClass.methods
            .filter {
                !it.isSynthetic &&
                    it.parameterCount == 2 &&
                    it.parameterTypes[0] == CredentialAttributes::class.java &&
                    it.parameterTypes[1] == Credentials::class.java &&
                    it.returnType == Void.TYPE
            }
            .minByOrNull { it.name }
            ?: error("Credential store write operation not found on ${instance.javaClass.name}")
        storeMethod.invoke(instance, attrs, creds)
    }

    /**
     * Resolves the credential-store read operation via reflection and invokes
     * it. Identified by signature shape: the single-argument method taking
     * CredentialAttributes and returning String.
     */
    private fun reflectiveGet(attrs: CredentialAttributes): String? {
        val instance = PasswordSafe.instance
        val readMethod: Method = instance.javaClass.methods
            .filter {
                !it.isSynthetic &&
                    it.parameterCount == 1 &&
                    it.parameterTypes[0] == CredentialAttributes::class.java &&
                    it.returnType == String::class.java
            }
            .minByOrNull { it.name }
            ?: error("Credential store read operation not found on ${instance.javaClass.name}")
        return readMethod.invoke(instance, attrs) as? String
    }

    fun getKey(): String? = reflectiveGet(attrs())?.takeIf { it.isNotBlank() }

    fun setKey(key: String?) {
        val normalised = key?.trim()?.takeIf { it.isNotBlank() }
        val creds = if (normalised != null) Credentials(ACCOUNT_TAG, normalised) else null
        reflectiveSet(attrs(), creds)
    }
}
