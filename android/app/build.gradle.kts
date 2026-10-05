plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.parallelcode.phone"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.parallelcode.phone"
        minSdk = 26
        targetSdk = 37
        // CI passes these from the android-v* release tag (see .github/workflows/android.yml).
        versionCode = providers.gradleProperty("versionCode").orNull?.toInt() ?: 1
        versionName = providers.gradleProperty("versionName").orNull ?: "0.1.0"
    }

    // Release signing comes from the environment, so the keystore never enters the repo. Without
    // it, release builds are unsigned.
    val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            // R8 drops unused code and resources; the libraries ship their own keep rules.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    // Look preset rows show a check mark on the selected theme.
    implementation("androidx.compose.material:material-icons-core")
    // Stop, history and mic buttons: these icons only ship in the extended set.
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:5.3.2")
    // Installs the baseline profiles Compose ships, so a sideloaded APK starts and scrolls
    // compiled rather than interpreted.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    // Scanner UI comes from Google Play services, so the app needs no camera permission.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    // android.jar only has stubs for org.json; unit tests need the real implementation.
    testImplementation("org.json:json:20260814")
}
