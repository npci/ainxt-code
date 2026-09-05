// AiNxt IntelliJ/PyCharm plugin. Requires JDK 17.
//
// Build:   ./gradlew buildPlugin   -> build/distributions/ainxt-intellij-*.zip
//          (install via Settings → Plugins → ⚙ → Install Plugin from Disk…)
// Sandbox: ./gradlew runIde
//
// PREREQUISITE: build the shared React UI first so its dist/ exists —
//   (cd ../../vscode-acp/webview-ui && npm install && npm run build)
// The `syncWebview` task copies that dist into the plugin's resources so the
// SAME governed UI runs in both VS Code and JetBrains IDEs.
plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "dev.ainxt"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // JCEF is bundled in the platform; no extra plugin dependency needed.
        // PyCharm, IntelliJ, GoLand, etc. all share this platform base.
        //
        // Compile against a LOCAL installation when one is given. Two reasons:
        // the download is ~1 GB, and compiling against the IDE the plugin will
        // actually be loaded into catches API drift that a different edition
        // would hide. Falls back to the pinned IDEA Community otherwise.
        //   ./gradlew buildPlugin -PlocalIde=/Applications/PyCharm.app
        val localIde = providers.gradleProperty("localIde").orNull
        if (localIde != null) {
            local(localIde)
        } else {
            intellijIdeaCommunity("2025.1")
        }
    }
    // Gson is on the IntelliJ platform classpath at runtime.
    compileOnly("com.google.code.gson:gson:2.11.0")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            // Widest practical compatibility. Floor at 233 (2023.3) — the JCEF /
            // DiffManager / PasswordSafe APIs this plugin uses have been stable
            // since well before then. Empty untilBuild removes the upper bound so
            // 2025.x, 2026.x and every future build install without a re-release.
            sinceBuild = "233"
            untilBuild = provider { "" }
        }
    }
}

// Target 17 bytecode without demanding a JDK 17 *toolchain*: the only JVM on a
// JetBrains machine is often the IDE's own bundled runtime, which is 21. Newer
// compiler, older target — the plugin still loads in 2023.3, which ships JBR 17.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

// --- Shared UI bundle -------------------------------------------------------
// Copy the built React webview into a generated resources dir under /webview,
// served to the JCEF browser via the http://ainxt scheme handler.
// The webview source lives in vscode-acp/webview-ui/ (shared between VS Code
// and IntelliJ). Build it first with:
//   cd ../../vscode-acp/webview-ui && npm install && npm run build
// A plain File, resolved at configuration time. A Directory provider captured
// inside a task action is a "Gradle script object reference" and cannot be
// serialised into the configuration cache, which this project has enabled.
val webviewDistFile: File = layout.projectDirectory.dir("../../vscode-acp/webview-ui/dist").asFile

val syncWebview by tasks.registering(Copy::class) {
    val dist = webviewDistFile
    doFirst {
        if (!dist.exists()) {
            throw GradleException(
                "Shared UI not built: $dist is missing. Run " +
                "`(cd ../../vscode-acp/webview-ui && npm install && npm run build)` first.",
            )
        }
    }
    from(dist)
    into(layout.buildDirectory.dir("generated-webview/webview"))
}

sourceSets {
    named("main") {
        resources {
            srcDir(layout.buildDirectory.dir("generated-webview"))
        }
    }
}

tasks.named("processResources") {
    dependsOn(syncWebview)
}
