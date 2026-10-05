plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.wire)
}

kotlin { jvmToolchain(17) }

// The vendored proto has no `package` line, which would put generated classes
// in the default package. Copy it with a package injected (wire encoding is
// unaffected: package only changes class names). The original in ../proto/ is
// never modified.
val protoWithPackage = tasks.register<Copy>("protoWithPackage") {
    from(rootDir.resolve("../proto/wa-1.33/messages.proto"))
    into(layout.buildDirectory.dir("wire-src"))
    filter { line ->
        if (line == "syntax = \"proto3\";") "$line\npackage app.workadventurer.proto;" else line
    }
}

wire {
    sourcePath {
        srcDir(layout.buildDirectory.dir("wire-src"))
        srcDir("src/wire-extra") // google/protobuf/field_mask.proto (not bundled with Wire)
    }
    kotlin {}
}

tasks.matching { it.name.startsWith("generate") && it.name.endsWith("Protos") }
    .configureEach { dependsOn(protoWithPackage) }

dependencies {
    api(libs.wire.runtime)
    api(libs.okhttp)
    api(libs.coroutines.core)
    implementation(libs.serialization.json)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coroutines.test)
}
