package com.parallelcode.phone

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Runs the look generator in `--check` mode against the checked-in
 * LookPalettes.kt, so the phone's palettes cannot fall behind src/lib/look.ts or
 * src/styles.css after a desktop theme is renamed, recolored or added.
 *
 * Skipped when the repository root is not reachable (a bare Gradle project, or a
 * test run from an unpacked source jar); the Kotlin tests in LookPalettesTest
 * still cover the values themselves.
 */
class LookPresetsGeneratedTest {

    @Test
    fun generatedPalettesAreUpToDateWithTheDesktop() {
        val repoRoot = findRepoRoot() ?: return
        val generator = File(repoRoot, "scripts/generate-android-looks.mjs")
        assumeTrue("generator script is missing at ${generator.path}", generator.isFile)

        val process =
            ProcessBuilder("node", generator.absolutePath, "--check")
                .directory(repoRoot)
                .redirectErrorStream(true)
                .start()

        val output = process.inputStream.bufferedReader().readText()
        val finished = process.waitFor(2, java.util.concurrent.TimeUnit.MINUTES)
        assertTrue("generator did not finish", finished)

        assertTrue(
            "LookPalettes.kt is out of date with src/lib/look.ts or src/styles.css.\n" +
                "Run: npm run generate:android-looks\n\n$output",
            process.exitValue() == 0,
        )
    }

    /**
     * Walks up from the working directory looking for the generated file, so the
     * test works whether Gradle runs from android/ or the repository root.
     */
    private fun findRepoRoot(): File? {
        // File(".") resolves against user.dir, so this avoids the nullable system property.
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            if (File(dir, "scripts/generate-android-looks.mjs").isFile) return dir
            dir = dir.parentFile
        }
        return null
    }
}
