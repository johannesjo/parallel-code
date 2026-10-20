package com.parallelcode.phone

import java.util.concurrent.ConcurrentHashMap

/**
 * Desktops (by base URL) that answered 404 for one route, so polling stops asking them: an older
 * desktop lacks routes newer phones know. Only a 404 counts; other failures may pass.
 */
class MissingRoutes {
    private val missing: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun isMissing(baseUrl: String): Boolean = baseUrl in missing

    /** Note a reply's [status] from [baseUrl]. */
    fun record(baseUrl: String, status: Int) {
        if (status == 404) missing += baseUrl
    }

    /** Ask every desktop again, e.g. after one may have been updated. */
    fun clear() = missing.clear()
}
