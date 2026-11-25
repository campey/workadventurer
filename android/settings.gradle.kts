pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google(); mavenCentral()
        // livekit-android's audio routing library is only published on JitPack; nothing else is taken from there.
        maven("https://jitpack.io") { content { includeGroup("com.github.davidliu") } }
    }
}
rootProject.name = "workadventure-app"
include(":protocol")
include(":nav")
include(":voice")
include(":wa-cli")
include(":app")
