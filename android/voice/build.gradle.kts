plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

kotlin { jvmToolchain(17) }

android {
    namespace = "app.workadventurer.voice"
    compileSdk = 34

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api(libs.webrtc)
    api(project(":protocol"))
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
    androidTestImplementation(libs.kotlin.test)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.rules)
}
