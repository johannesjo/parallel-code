package com.parallelcode.phone

import android.content.SharedPreferences

/** Each review session owns these stores. They never open Android's persisted preferences. */
class DemoSettings {
    private val stores = listOf(CredentialStore.PREFS_NAME, SettingsStore.PREFS_NAME, PromptHistoryStore.PREFS_NAME)
        .associateWith { MemoryPreferences() }
    val settings = SettingsStore(stores.getValue(SettingsStore.PREFS_NAME))
    val credentials = CredentialStore(stores.getValue(CredentialStore.PREFS_NAME))
    val history = PromptHistoryStore(stores.getValue(PromptHistoryStore.PREFS_NAME))

    var backup: ByteArray? = null
        private set
    var automaticBackups = false
    var intervalDays = 7
    var checkUpdates = false

    init {
        credentials.saveLink(ConnectionLink(SECONDARY_URL, "demo-view-laptop"))
        credentials.savePairedToken("demo-paired-laptop")
        credentials.rename(SECONDARY_URL, "Sample laptop")
        credentials.saveLink(ConnectionLink(PRIMARY_URL, "demo-view-workstation"))
        credentials.savePairedToken("demo-paired-workstation")
        credentials.rename(PRIMARY_URL, "Review workstation")
        history.record("demo-review", "Show the sample changes")
    }

    fun createBackup(password: String?) {
        backup = Backup.create(stores, password)
    }

    fun restoreBackup(password: String?) {
        Backup.restore(backup ?: throw BackupException("Create a demo backup first."), password, stores)
    }

    companion object {
        const val PRIMARY_URL = "https://workstation.demo.invalid"
        const val SECONDARY_URL = "https://laptop.demo.invalid"
    }
}

/** Context-free preferences for disposable demo sessions, including the real backup codec. */
internal class MemoryPreferences : SharedPreferences {
    private val values = mutableMapOf<String, Any>()
    @Synchronized
    override fun getAll(): Map<String, *> = values.mapValues { (_, value) -> if (value is Set<*>) value.toSet() else value }
    @Synchronized
    override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    @Synchronized
    override fun getStringSet(key: String?, defValues: Set<String>?): Set<String>? =
        (values[key] as? Set<String>)?.toSet() ?: defValues
    @Synchronized
    override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
    @Synchronized
    override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
    @Synchronized
    override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
    @Synchronized
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    @Synchronized
    override fun contains(key: String?): Boolean = values.containsKey(key)
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val pending = mutableMapOf<String, Any?>()
        private var clearing = false
        private fun put(key: String?, value: Any?): SharedPreferences.Editor = apply { if (key != null) pending[key] = value }
        override fun putString(key: String?, value: String?) = put(key, value)
        override fun putStringSet(key: String?, values: Set<String>?) = put(key, values?.toSet())
        override fun putInt(key: String?, value: Int) = put(key, value)
        override fun putLong(key: String?, value: Long) = put(key, value)
        override fun putFloat(key: String?, value: Float) = put(key, value)
        override fun putBoolean(key: String?, value: Boolean) = put(key, value)
        override fun remove(key: String?) = put(key, null)
        override fun clear(): SharedPreferences.Editor = apply { clearing = true }
        override fun commit(): Boolean = synchronized(this@MemoryPreferences) {
            if (clearing) values.clear()
            pending.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
            pending.clear()
            clearing = false
            true
        }
        override fun apply() { commit() }
    }
}
