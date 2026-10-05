plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin { jvmToolchain(17) }

application { mainClass.set("app.workadventurer.cli.MainKt") }

dependencies { implementation(project(":protocol")) }
