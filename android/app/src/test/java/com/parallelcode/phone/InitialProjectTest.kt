package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class InitialProjectTest {

    private val projects = listOf(
        MobileProject("a", "A", null),
        MobileProject("b", "B", null, lastUsed = true),
        MobileProject("c", "C", null),
    )

    @Test
    fun keepsTheCurrentChoiceWhileItIsListed() {
        assertEquals("c", initialProjectId(projects, current = "c", remembered = "a"))
    }

    @Test
    fun startsOnTheProjectThisPhoneLastUsed() {
        assertEquals("a", initialProjectId(projects, current = "", remembered = "a"))
    }

    @Test
    fun fallsBackToTheDesktopsLastUsedProjectThenTheFirst() {
        assertEquals("b", initialProjectId(projects, current = "", remembered = "gone"))
        assertEquals("a", initialProjectId(projects.map { it.copy(lastUsed = false) }, current = "", remembered = null))
    }

    @Test
    fun isEmptyWithoutProjects() {
        assertEquals("", initialProjectId(emptyList(), current = "a", remembered = "a"))
    }
}
