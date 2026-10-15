#!/usr/bin/env bash
# Run the :nav unit tests where the Android toolchain can't be fetched (the Claude Code cloud container blocks
# dl.google.com, which the root build needs for the Android Gradle plugin). :nav is pure Kotlin/JVM, so this builds
# its sources in a throwaway standalone Gradle project that uses only Maven Central and the Gradle plugin portal.
# Maven Central sometimes answers 429 in the cloud container: rerun, Gradle keeps what it already downloaded.
#   android/tools/nav-test-cloud.sh [gradle test args, e.g. --tests '*NavigatorTest*']
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/settings.gradle.kts" <<'EOF'
pluginManagement { repositories { gradlePluginPortal(); mavenCentral() } }
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = "navtest"
EOF
cat > "$work/build.gradle.kts" <<EOF
plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}
sourceSets {
    main { kotlin.srcDir("$here/nav/src/main/kotlin") }
    test { kotlin.srcDir("$here/nav/src/test/kotlin"); resources.srcDir("$here/nav/src/test/resources") }
}
dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
EOF
cd "$work" && gradle test --console=plain "$@"
