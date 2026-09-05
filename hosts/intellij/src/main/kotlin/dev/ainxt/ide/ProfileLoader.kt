// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.intellij.openapi.diagnostic.logger

/**
 * Loads `*.ainxtprofile.json` files from the plugin's classpath (`/profiles/`).
 *
 * Two profiles are bundled by default: `standalone.ainxtprofile.json` (no
 * gateway — the CLI talks directly to a model you configure) and
 * `oss.ainxtprofile.json` (a self-hosted AiNxt Platform gateway, for teams that
 * run one). Add your own by dropping a `*.ainxtprofile.json` into `/profiles/`
 * and naming it in `/profiles/index.txt` -- no code change, and no organisation
 * is named here.
 *
 * Profiles are NOT secrets. They contain only gateway URLs, model IDs, and flags.
 * The API key is never stored in a profile — it lives in PasswordSafe.
 *
 * Priority order (profiles sit at the bottom — they only pre-fill settings):
 *   1. Environment variable  (AINXT_GATEWAY_URL, AINXT_API_KEY, …)
 *   2. AinxtSettings (ainxt.xml) — written by this loader or by the user
 *   3. In-panel Connect form
 *   4. Profile default / code default
 */
object ProfileLoader {

    private val log = logger<ProfileLoader>()
    private val gson = Gson()

    data class AinxtProfile(
        @SerializedName("profile")     val profile: String = "",
        @SerializedName("displayName") val displayName: String = "",
        @SerializedName("description") val description: String = "",
        @SerializedName("gatewayUrl")  val gatewayUrl: String = "",
        @SerializedName("model")       val model: String = "",
        @SerializedName("allowInsecure") val allowInsecure: Boolean = false,
        @SerializedName("binaryPath")  val binaryPath: String = "",
        @SerializedName("notes")       val notes: List<String> = emptyList(),
    )

    /**
     * Filenames listed in `/profiles/index.txt`, one per line.
     *
     * Falls back to the single bundled default if the index is missing or
     * unreadable, so a packaging mistake degrades to "the default profile works"
     * rather than "no profiles at all, silently".
     */
    private fun loadProfileIndex(): List<String> {
        val fallback = listOf("standalone.ainxtprofile.json", "oss.ainxtprofile.json")
        return try {
            val stream = ProfileLoader::class.java.getResourceAsStream("/profiles/index.txt")
                ?: return fallback
            val names = stream.use { input ->
                input.reader().readLines()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() && !it.startsWith("#") }
            }
            if (names.isEmpty()) fallback else names
        } catch (e: Exception) {
            log.warn("Failed to read /profiles/index.txt, using the default profile: ${e.message}")
            fallback
        }
    }

    fun listProfiles(): List<AinxtProfile> {
        // Read the filenames from an index rather than hardcoding them.  The
        // previous list named a specific organisation's deployment inside a
        // publicly distributed plugin, and adding a profile required editing
        // this file.  Enumerating a directory inside a packaged jar is not
        // portable, hence an index rather than a scan.
        val profileNames = loadProfileIndex()
        val profiles = profileNames.mapNotNull { name ->
            try {
                val stream = ProfileLoader::class.java.getResourceAsStream("/profiles/$name")
                    ?: return@mapNotNull null
                stream.use { gson.fromJson(it.reader(), AinxtProfile::class.java) }
            } catch (e: Exception) {
                log.warn("Failed to load profile $name: ${e.message}")
                null
            }
        }
        // Gateway-free (standalone) profiles first — that is the recommended
        // default for anyone not running the AiNxt Platform.
        return profiles.sortedBy { if (it.gatewayUrl.isBlank()) 0 else 1 }
    }

    /**
     * Apply a profile to [AinxtSettings].
     * Writes gatewayUrl, model, allowInsecure, and binaryPath (if non-empty).
     * Never touches the API key — that is always set via PasswordSafe / `ainxt login`.
     */
    fun applyProfile(profile: AinxtProfile) {
        val s = AinxtSettings.getInstance().state
        s.gatewayUrl    = profile.gatewayUrl
        s.model         = profile.model
        s.allowInsecure = profile.allowInsecure
        if (profile.binaryPath.isNotBlank()) {
            s.binaryPath = profile.binaryPath
        }
        log.info("AiNxt profile '${profile.displayName}' applied — gateway: ${profile.gatewayUrl}")
    }
}
