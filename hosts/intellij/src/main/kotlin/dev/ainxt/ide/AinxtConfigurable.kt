// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
package dev.ainxt.ide

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.panel
import javax.swing.JComponent

/**
 * IntelliJ Settings panel — Settings → Tools → AiNxt.
 *
 * Single-codebase strategy (internal + OSS):
 *   All configuration is exposed here. No values are hardcoded.
 *   Each profile names the gateway it targets; you point yours wherever it runs.
 *   The plugin binary is identical — only the configured values differ.
 *   The same plugin binary serves both — only the values differ.
 *
 * Priority order (highest first):
 *   1. Environment variable (AINXT_GATEWAY_URL, AINXT_API_KEY, AINXT_HOME, …)
 *   2. This Settings panel (persisted to ainxt.xml via AinxtSettings)
 *   3. In-panel Connect form (writes to AinxtSettings)
 *   4. Code default (empty gateway/model — standalone against a
 *      directly-configured model; the AiNxt Platform gateway is optional)
 */
class AinxtConfigurable : Configurable {

    private var panel: DialogPanel? = null

    // Field references — populated in createComponent()
    private val gatewayUrlField = JBTextField()
    private val apiKeyField = JBPasswordField()
    private val modelField = JBTextField()
    private val binaryPathField = JBTextField()
    private val allowInsecureBox = JBCheckBox("Allow insecure (http:// or self-signed) — only for trusted internal gateways")

    override fun getDisplayName(): String = "AiNxt"

    override fun createComponent(): JComponent {
        val p = panel {
            row {
                button("Load Configuration Profile…") {
                    val profiles = ProfileLoader.listProfiles()
                    if (profiles.isEmpty()) {
                        Messages.showInfoMessage(
                            "No profile files found. Expected *.ainxtprofile.json files bundled in the plugin.",
                            "AiNxt Profiles"
                        )
                        return@button
                    }
                    val options = profiles.map { it.displayName }.toTypedArray()
                    val choice = Messages.showChooseDialog(
                        "Select a deployment profile to pre-fill your settings.\nYou can still edit the values before clicking Apply.",
                        "Load AiNxt Configuration Profile",
                        options,
                        options.firstOrNull(),
                        Messages.getQuestionIcon()
                    )
                    if (choice >= 0) {
                        val profile = profiles[choice]
                        ProfileLoader.applyProfile(profile)
                        // Refresh fields from the newly written settings
                        reset()
                        Messages.showInfoMessage(
                            "Profile \"${profile.displayName}\" loaded.\n" +
                                (if (profile.gatewayUrl.isNotBlank()) "Gateway: ${profile.gatewayUrl}" else "No gateway — standalone mode.") +
                                if (profile.model.isNotBlank()) "\nModel: ${profile.model}" else "",
                            "Profile Loaded"
                        )
                    }
                }.comment("Pre-fill settings from a bundled deployment profile.")
            }
            group("Connection") {
                row("Gateway URL:") {
                    cell(gatewayUrlField)
                        .resizableColumn()
                        .comment("Optional — only for a shared AiNxt Platform gateway. Leave empty to run standalone against a model configured below or in ~/.ainxt/config.toml. Also configurable via AINXT_GATEWAY_URL environment variable.")
                }
                row("API Key:") {
                    cell(apiKeyField)
                        .resizableColumn()
                        .comment("Stored in the IDE PasswordSafe. Leave blank to use credentials from `ainxt login` (~/.ainxt/credentials.json), or a per-model key from ~/.ainxt/config.toml.")
                }
                row { cell(allowInsecureBox) }
            }
            group("Agent") {
                row("Model:") {
                    cell(modelField)
                        .resizableColumn()
                        .comment("LLM model ID. Leave empty to use the agent's built-in default. Examples: claude-sonnet-4-6, gpt-4o, local:llama3.1:8b")
                }
                row("Binary path:") {
                    cell(binaryPathField)
                        .resizableColumn()
                        .comment("Full path to the ainxt CLI binary. Leave empty to use 'ainxt' from PATH. Also configurable via AINXT_BINARY_PATH environment variable.")
                }
            }
        }
        panel = p
        reset()
        return p
    }

    override fun isModified(): Boolean {
        val s = AinxtSettings.getInstance().state
        return gatewayUrlField.text != s.gatewayUrl ||
            modelField.text != s.model ||
            binaryPathField.text != s.binaryPath ||
            allowInsecureBox.isSelected != s.allowInsecure
        // API key is not compared here — it lives in PasswordSafe, not State
    }

    override fun apply() {
        val s = AinxtSettings.getInstance().state
        s.gatewayUrl = gatewayUrlField.text.trim()
        s.model = modelField.text.trim()
        s.binaryPath = binaryPathField.text.trim()
        s.allowInsecure = allowInsecureBox.isSelected

        val key = String(apiKeyField.password).trim()
        if (key.isNotEmpty()) {
            AinxtSecrets.setKey(key)
            apiKeyField.text = ""   // clear after saving — don't leave it in the field
        }
    }

    override fun reset() {
        val s = AinxtSettings.getInstance().state
        gatewayUrlField.text = s.gatewayUrl
        modelField.text = s.model
        binaryPathField.text = s.binaryPath
        allowInsecureBox.isSelected = s.allowInsecure
        apiKeyField.text = ""   // never pre-fill the key field
    }

    override fun disposeUIResources() {
        panel = null
    }
}
