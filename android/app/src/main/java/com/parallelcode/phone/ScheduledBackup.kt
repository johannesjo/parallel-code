package com.parallelcode.phone

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.provider.DocumentsContract
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/** The preferences a backup holds. The backup schedule itself is not among them: it is per phone. */
fun backupStores(context: Context): Map<String, SharedPreferences> =
    listOf(CredentialStore.PREFS_NAME, SettingsStore.PREFS_NAME, PromptHistoryStore.PREFS_NAME)
        .associateWith { context.getSharedPreferences(it, Context.MODE_PRIVATE) }

/** A file name for a backup taken now, e.g. parallel-code-backup-2026-10-04-1530.zip. */
fun backupFileName(encrypted: Boolean): String =
    BACKUP_FILE_PREFIX + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd-HHmm")) +
        if (encrypted) ".pcbackup" else ".zip"

fun backupMimeType(encrypted: Boolean) = if (encrypted) "application/octet-stream" else "application/zip"

private const val BACKUP_FILE_PREFIX = "parallel-code-backup-"

/** Start the app over, so every screen and the connection read the restored data. */
fun restartApp(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    context.startActivity(Intent.makeRestartActivityTask(launch.component))
    Runtime.getRuntime().exit(0)
}

/**
 * Automatic backups into a folder the user picked. The password is kept sealed by a key in the
 * Android Keystore, since the job has to encrypt with nobody there to type it.
 */
class BackupSchedule(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** The picked folder (a document tree URI), or null when automatic backups are off. */
    val folder: Uri? get() = prefs.getString(KEY_FOLDER, null)?.let(Uri::parse)

    val intervalDays: Int get() = prefs.getInt(KEY_INTERVAL_DAYS, 1)

    val hasPassword: Boolean get() = prefs.contains(KEY_PASSWORD)

    /** When the last automatic backup was written, in epoch millis; 0 when none has been. */
    val lastBackupAt: Long get() = prefs.getLong(KEY_LAST_AT, 0)

    /** Why the last attempt failed; null once one succeeds. */
    val lastError: String? get() = prefs.getString(KEY_LAST_ERROR, null)

    /** Back up into [folder] every [intervalDays] days, encrypted when [password] is given. */
    fun enable(folder: Uri, intervalDays: Int, password: String?) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        this.folder?.takeIf { it != folder }?.let { old ->
            runCatching { context.contentResolver.releasePersistableUriPermission(old, flags) }
        }
        context.contentResolver.takePersistableUriPermission(folder, flags)
        prefs.edit(commit = true) {
            putString(KEY_FOLDER, folder.toString())
            putInt(KEY_INTERVAL_DAYS, intervalDays)
            if (password.isNullOrEmpty()) remove(KEY_PASSWORD) else putString(KEY_PASSWORD, seal(password))
            remove(KEY_LAST_ERROR)
        }
        schedule()
    }

    fun setIntervalDays(days: Int) {
        prefs.edit(commit = true) { putInt(KEY_INTERVAL_DAYS, days) }
        schedule()
    }

    fun disable() {
        context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
        folder?.let {
            runCatching {
                context.contentResolver.releasePersistableUriPermission(
                    it,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                )
            }
        }
        prefs.edit(commit = true) { clear() }
        deleteKey()
    }

    /** Write a backup into the folder now and drop the oldest past [KEEP]. Blocking. */
    fun backUpNow() {
        val tree = folder ?: return
        try {
            val password = prefs.getString(KEY_PASSWORD, null)?.let { open(it) ?: throw BackupException(PASSWORD_LOST) }
            val encrypted = password != null
            val bytes = Backup.create(backupStores(context), password)
            val resolver = context.contentResolver
            val dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            val file = DocumentsContract.createDocument(resolver, dir, backupMimeType(encrypted), backupFileName(encrypted))
                ?: throw BackupException(FOLDER_LOST)
            (resolver.openOutputStream(file) ?: throw BackupException(FOLDER_LOST)).use { it.write(bytes) }
            prune(tree)
            prefs.edit(commit = true) {
                putLong(KEY_LAST_AT, System.currentTimeMillis())
                remove(KEY_LAST_ERROR)
            }
        } catch (e: BackupException) {
            recordError(e.message ?: FOLDER_LOST)
        } catch (e: SecurityException) {
            recordError(FOLDER_LOST)
        } catch (e: java.io.IOException) {
            recordError(FOLDER_LOST)
        } catch (e: IllegalArgumentException) {
            recordError(FOLDER_LOST)
        }
    }

    private fun recordError(message: String) = prefs.edit(commit = true) { putString(KEY_LAST_ERROR, message) }

    private fun schedule() {
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, BackupJobService::class.java))
            .setPeriodic(TimeUnit.DAYS.toMillis(intervalDays.toLong()))
            .setRequiresBatteryNotLow(true)
            .setPersisted(true)
            .build()
        context.getSystemService(JobScheduler::class.java).schedule(job)
    }

    /** Backups this app wrote are named by time, so name order is age order. */
    private fun prune(tree: Uri) {
        val resolver = context.contentResolver
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val ours = ArrayList<Pair<String, String>>()
        resolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.getString(1) ?: continue
                if (name.startsWith(BACKUP_FILE_PREFIX)) ours.add(cursor.getString(0) to name)
            }
        }
        ours.sortedByDescending { it.second }.drop(KEEP).forEach { (id, _) ->
            runCatching { DocumentsContract.deleteDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, id)) }
        }
    }

    private fun keystoreKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun deleteKey() {
        runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS) }
    }

    private fun seal(password: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(password.toByteArray()), Base64.NO_WRAP)
    }

    /** Null when the Keystore key is gone (cleared device credentials can wipe it). */
    private fun open(sealed: String): String? = runCatching {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, bytes, 0, 12))
        String(cipher.doFinal(bytes, 12, bytes.size - 12))
    }.getOrNull()

    companion object {
        private const val PREFS_NAME = "backupSchedule"
        private const val KEY_FOLDER = "folder"
        private const val KEY_INTERVAL_DAYS = "intervalDays"
        private const val KEY_PASSWORD = "password"
        private const val KEY_LAST_AT = "lastAt"
        private const val KEY_LAST_ERROR = "lastError"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "backup-password"
        private const val JOB_ID = 4201

        /** Automatic backups kept in the folder; older ones this app wrote are deleted. */
        const val KEEP = 10

        private const val FOLDER_LOST = "Couldn't write to the backup folder. Pick the folder again."
        private const val PASSWORD_LOST = "The saved backup password is no longer readable. Set it again."
    }
}

/** Runs [BackupSchedule.backUpNow] off the main thread when the schedule comes due. */
class BackupJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread(name = "scheduled-backup") {
            BackupSchedule(applicationContext).backUpNow()
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
