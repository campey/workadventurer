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
        versionCode = 1
        versionName = "0.1.0"
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
