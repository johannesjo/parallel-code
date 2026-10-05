package com.parallelcode.phone

import android.content.SharedPreferences

/** Simple in-memory fake of Android SharedPreferences for unit tests. */
internal class FakeSharedPreferences : SharedPreferences {
    private val map = mutableMapOf<String, Any>()

    override fun getAll(): Map<String, *> = map
    override fun getString(key: String?, defValue: String?): String? = (map[key] as? String) ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: Set<String>?): Set<String>? =
        (map[key] as? Set<String>) ?: defValues
    override fun getInt(key: String?, defValue: Int): Int = (map[key] as? Int) ?: defValue
    override fun getLong(key: String?, defValue: Long): Long = (map[key] as? Long) ?: defValue
    override fun getFloat(key: String?, defValue: Float): Float = (map[key] as? Float) ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = (map[key] as? Boolean) ?: defValue
    override fun contains(key: String?): Boolean = map.containsKey(key)
    override fun edit(): SharedPreferences.Editor = FakeEditor(map)
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}

    private class FakeEditor(private val backingMap: MutableMap<String, Any>) : SharedPreferences.Editor {
        private val pending = mutableMapOf<String, Any?>()
        private var clearPending = false

        override fun putString(key: String?, value: String?): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = value
        }
        override fun putStringSet(key: String?, values: Set<String>?): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = values
        }
        override fun putInt(key: String?, value: Int): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = value
        }
        override fun putLong(key: String?, value: Long): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = value
        }
        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = value
        }
        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = value
        }
        override fun remove(key: String?): SharedPreferences.Editor = apply {
            if (key != null) pending[key] = null
        }
        override fun clear(): SharedPreferences.Editor = apply {
            clearPending = true
        }
        override fun commit(): Boolean {
            apply()
            return true
        }
        override fun apply() {
            if (clearPending) backingMap.clear()
            for ((k, v) in pending) {
                if (v == null) backingMap.remove(k) else backingMap[k] = v
            }
            pending.clear()
            clearPending = false
        }
    }
}
