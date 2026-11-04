package com.parallelcode.phone

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Runs the look and project icon generators in `--check` mode against the
 * checked-in LookPalettes.kt and ProjectIcons.kt, so the phone's palettes and
 * icons cannot fall behind the desktop after a theme or icon is renamed,
 * recolored or added.
 *
 * Skipped when the repository root is not reachable (a bare Gradle project, or a
 * test run from an unpacked source jar); the Kotlin tests in LookPalettesTest
 * still cover the values themselves.
 */
class LookPresetsGeneratedTest {

    @Test
    fun generatedPalettesAreUpToDateWithTheDesktop() {
        assertGeneratorPasses(
            "scripts/generate-android-looks.mjs",
            "LookPalettes.kt is out of date with src/lib/look.ts or src/styles.css.\n" +
                "Run: npm run generate:android-looks",
        )
    }

    @Test
    fun generatedProjectIconsAreUpToDateWithTheDesktop() {
        assertGeneratorPasses(
            "scripts/generate-android-project-icons.mjs",
            "ProjectIcons.kt is out of date with src/lib/project-icon-paths.ts.\n" +
                "Run: npm run generate:android-icons",
        )
    }

    private fun assertGeneratorPasses(script: String, failure: String) {
        val repoRoot = findRepoRoot() ?: return
        val generator = File(repoRoot, script)
        assumeTrue("generator script is missing at ${generator.path}", generator.isFile)

        val process =
            ProcessBuilder("node", generator.absolutePath, "--check")
                .directory(repoRoot)
                .redirectErrorStream(true)
                .start()

        val output = process.inputStream.bufferedReader().readText()
        val finished = process.waitFor(2, java.util.concurrent.TimeUnit.MINUTES)
        assertTrue("generator did not finish", finished)
        assertTrue("$failure\n\n$output", process.exitValue() == 0)
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
