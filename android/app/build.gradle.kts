plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

kotlin { jvmToolchain(17) }

android {
    namespace = "app.workadventurer.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.workadventurer"
        minSdk = 26
        targetSdk = 34
        // The release workflow passes the tag (android-v0.2.0 -> 0.2.0) and the run number; local builds keep 1 / 0.1.0.
        versionCode = (System.getenv("ANDROID_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ANDROID_VERSION_NAME") ?: "0.1.0"
    }

    // One debug key for everyone (this Mac, the cloud container, any session), so a debug APK built anywhere installs over
    // one built anywhere else and keeps the app's data. It signs nothing that ships: it is public in the repo.
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    // Releases are signed with the same shared debug key for now (see above), so a release APK installs over a debug
    // build and the other way round. A real release key (from CI secrets) replaces this when the app goes to a store.
    buildTypes {
        getByName("release") { signingConfig = signingConfigs.getByName("debug") }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":protocol"))
    implementation(project(":nav"))
    implementation(project(":voice"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.navigation.compose)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
}
