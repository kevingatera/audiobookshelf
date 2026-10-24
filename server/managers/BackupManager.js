const sqlite3 = require('sqlite3')
const Path = require('path')
const { randomUUID } = require('crypto')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')
const { dialectFor } = require('../utils/dialectAdapter')
const { dumpArgs, restoreArgs, runPostgresTool } = require('../utils/postgresTools')
const restoreMaintenance = require('../utils/restoreMaintenance')

const cron = require('../libs/nodeCron')
const fs = require('../libs/fsExtra')
const archiver = require('../libs/archiver')
const StreamZip = require('../libs/nodeStreamZip')
const fileUtils = require('../utils/fileUtils')

// Utils
const { getFileSize } = require('../utils/fileUtils')

const Backup = require('../objects/Backup')
const CacheManager = require('./CacheManager')
const NotificationManager = require('./NotificationManager')

const OTHER_CLIENTS_MESSAGE = 'Another client is connected to this database. Stop it, then restore again.'

class BackupManager {
  constructor() {
    this.ItemsMetadataPath = Path.join(global.MetadataPath, 'items')
    this.AuthorsMetadataPath = Path.join(global.MetadataPath, 'authors')

    this.scheduleTask = null

    this.backups = []
  }

  get backupPath() {
    return global.ServerSettings.backupPath
  }

  /** Archive entry name for the database in this server. */
  get currentBackupEntry() {
    return dialectFor(Database.sequelize).fileBased ? 'absdatabase.sqlite' : 'absdatabase.postgres.dump'
  }

  /** Dialect of the database a backup archive was made from, or null when the archive has no database entry. */
  static backupDialectOf(entries) {
    if (entries['absdatabase.postgres.dump']) return 'postgres'
    if (entries['absdatabase.sqlite']) return 'sqlite'
    return null
  }

  get backupPathEnvSet() {
    return !!process.env.BACKUP_PATH
  }

  get backupSchedule() {
    return global.ServerSettings.backupSchedule
  }

  get backupsToKeep() {
    return global.ServerSettings.backupsToKeep || 2
  }

  get maxBackupSize() {
    return global.ServerSettings.maxBackupSize || Infinity
  }

  async init() {
    try {
      const backupsDirExists = await fs.pathExists(this.backupPath)
      if (!backupsDirExists) {
        await fs.ensureDir(this.backupPath)
      }
    } catch (error) {
      Logger.error(`[BackupManager] Failed to ensure backup directory at "${this.backupPath}": ${error.message}`)
      throw new Error(`[BackupManager] Failed to ensure backup directory at "${this.backupPath}"`, { cause: error })
    }

    await this.loadBackups()
    this.scheduleCron()
  }

  /**
   * Reload backups after updating backup path
   */
  async reload() {
    Logger.info(`[BackupManager] Reloading backups with backup path "${this.backupPath}"`)
    this.backups = []
    await this.loadBackups()
    this.updateCronSchedule()
  }

  scheduleCron() {
    if (!this.backupSchedule) {
      Logger.info(`[BackupManager] Auto Backups are disabled`)
      return
    }
    try {
      var cronSchedule = this.backupSchedule
      this.scheduleTask = cron.schedule(cronSchedule, this.runBackup.bind(this))
    } catch (error) {
      Logger.error(`[BackupManager] Failed to schedule backup cron ${this.backupSchedule}`, error)
    }
  }

  updateCronSchedule() {
    if (this.scheduleTask && !this.backupSchedule) {
      Logger.info(`[BackupManager] Disabling backup schedule`)
      if (this.scheduleTask.stop) this.scheduleTask.stop()
      this.scheduleTask = null
    } else if (!this.scheduleTask && this.backupSchedule) {
      Logger.info(`[BackupManager] Starting backup schedule ${this.backupSchedule}`)
      this.scheduleCron()
    } else if (this.backupSchedule) {
      Logger.info(`[BackupManager] Restarting backup schedule ${this.backupSchedule}`)
      if (this.scheduleTask.stop) this.scheduleTask.stop()
      this.scheduleCron()
    }
  }

  async uploadBackup(req, res) {
    const backupFile = req.files.file
    if (Path.extname(backupFile.name) !== '.audiobookshelf') {
      Logger.error(`[BackupManager] Invalid backup file uploaded "${backupFile.name}"`)
      return res.status(500).send('Invalid backup file')
    }

    const tempPath = Path.join(this.backupPath, fileUtils.sanitizeFilename(backupFile.name))
    const success = await backupFile
      .mv(tempPath)
      .then(() => true)
      .catch((error) => {
        Logger.error('[BackupManager] Failed to move backup file', tempPath, error)
        return false
      })
    if (!success) {
      return res.status(500).send('Failed to move backup file into backups directory')
    }

    const zip = new StreamZip.async({ file: tempPath })
    let entries
    try {
      entries = await zip.entries()
    } catch (error) {
      // Not a valid zip file
      Logger.error('[BackupManager] Failed to read backup file - backup might not be a valid .zip file', tempPath, error)
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(400).send('Failed to read backup file - backup might not be a valid .zip file')
    }
    const uploadedDialect = BackupManager.backupDialectOf(entries)
    if (!uploadedDialect) {
      Logger.error(`[BackupManager] Invalid backup with no database file - might be a backup created on an old Audiobookshelf server.`)
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(500).send('Invalid backup with no absdatabase.sqlite file - might be a backup created on an old Audiobookshelf server.')
    }
    const currentDialect = dialectFor(Database.sequelize).fileBased ? 'sqlite' : 'postgres'
    if (uploadedDialect !== currentDialect) {
      Logger.error(`[BackupManager] Backup uses ${uploadedDialect}, this server uses ${currentDialect}`)
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(400).send(`This backup was made with the ${uploadedDialect} database. This server uses ${currentDialect}.`)
    }

    const detailsEntry = entries['details']
    if (!detailsEntry) {
      Logger.error('[BackupManager] Invalid backup - missing details entry')
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(400).send('Invalid backup file - missing details entry')
    }
    if (detailsEntry.size > 1024 * 1024) {
      Logger.error(`[BackupManager] Backup details entry too large: ${detailsEntry.size} bytes`)
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(400).send('Invalid backup file - details entry too large')
    }

    const data = await zip.entryData('details')
    const details = data.toString('utf8').split('\n')

    const backup = new Backup({ details, fullPath: tempPath })

    if (!backup.serverVersion) {
      Logger.error(`[BackupManager] Invalid backup with no server version - might be a backup created before version 2.0.0`)
      await zip.close().catch(() => {})
      await fs.remove(tempPath).catch((err) => Logger.error(`[BackupManager] Failed to remove rejected backup file "${tempPath}"`, err))
      return res.status(500).send('Invalid backup. Might be a backup created before version 2.0.0.')
    }

    await zip.close().catch(() => {})

    backup.fileSize = await getFileSize(backup.fullPath)

    const existingBackupIndex = this.backups.findIndex((b) => b.id === backup.id)
    if (existingBackupIndex >= 0) {
      Logger.warn(`[BackupManager] Backup already exists with id ${backup.id} - overwriting`)
      this.backups.splice(existingBackupIndex, 1, backup)
    } else {
      this.backups.push(backup)
    }

    res.json({
      backups: this.backups.map((b) => b.toJSON())
    })
  }

  async requestCreateBackup(res) {
    var backupSuccess = await this.runBackup()
    if (backupSuccess) {
      res.json({
        backups: this.backups.map((b) => b.toJSON())
      })
    } else {
      res.sendStatus(500)
    }
  }

  /**
   *
   * @param {import('./ApiCacheManager')} apiCacheManager
   * @param {Backup} backup
   * @param {import('express').Response} res
   */
  async requestApplyBackup(apiCacheManager, backup, res) {
    Logger.info(`[BackupManager] Applying backup at "${backup.fullPath}"`)

    const zip = new StreamZip.async({ file: backup.fullPath })

    const entries = await zip.entries()

    const backupDialect = BackupManager.backupDialectOf(entries)
    const currentDialect = dialectFor(Database.sequelize).fileBased ? 'sqlite' : 'postgres'
    if (backupDialect === 'postgres' && currentDialect === 'postgres') {
      return this.requestApplyPostgresBackup(apiCacheManager, backup, zip, entries, res)
    }
    if (backupDialect !== currentDialect) {
      await zip.close()
      return res.status(400).send(`This backup was made with the ${backupDialect || 'unknown'} database. This server uses ${currentDialect}.`)
    }

    // Ensure backup has an absdatabase.sqlite file
    if (!Object.keys(entries).includes('absdatabase.sqlite')) {
      Logger.error(`[BackupManager] Cannot apply old backup ${backup.fullPath}`)
      await zip.close()
      return res.status(500).send('Invalid backup file. Does not include absdatabase.sqlite. This might be from an older Audiobookshelf server.')
    }

    await Database.disconnect()

    const dbPath = Path.join(global.ConfigPath, 'absdatabase.sqlite')
    const tempDbPath = Path.join(global.ConfigPath, 'absdatabase-temp.sqlite')

    // Extract backup sqlite file to temporary path
    await zip.extract('absdatabase.sqlite', tempDbPath)
    Logger.info(`[BackupManager] Extracted backup sqlite db to temp path ${tempDbPath}`)

    // Verify extract - Abandon backup if sqlite file did not extract
    if (!(await fs.pathExists(tempDbPath))) {
      Logger.error(`[BackupManager] Sqlite file not found after extract - abandon backup apply and reconnect db`)
      await zip.close()
      await Database.reconnect()
      return res.status(500).send('Failed to extract sqlite db from backup')
    }

    // Attempt to remove existing db file
    try {
      await fs.remove(dbPath)
    } catch (error) {
      // Abandon backup and remove extracted sqlite file if unable to remove existing db file
      Logger.error(`[BackupManager] Unable to overwrite existing db file - abandon backup apply and reconnect db`, error)
      await fs.remove(tempDbPath)
      await zip.close()
      await Database.reconnect()
      return res.status(500).send(`Failed to overwrite sqlite db: ${error?.message || 'Unknown Error'}`)
    }

    // Rename temp db
    await fs.move(tempDbPath, dbPath)
    Logger.info(`[BackupManager] Saved backup sqlite file at "${dbPath}"`)

    // Extract /metadata/items and /metadata/authors folders
    await fs.ensureDir(this.ItemsMetadataPath)
    await zip.extract('metadata-items/', this.ItemsMetadataPath)
    await fs.ensureDir(this.AuthorsMetadataPath)
    await zip.extract('metadata-authors/', this.AuthorsMetadataPath)
    await zip.close()

    // Reconnect db
    await Database.reconnect()

    // Reset api cache, set hooks again
    await apiCacheManager.reset()

    // Clear metadata cache
    await CacheManager.purgeAll()

    res.sendStatus(200)

    // Triggers browser refresh for all clients
    SocketAuthority.emitter('backup_applied')
  }

  async requestApplyPostgresBackup(apiCacheManager, backup, zip, entries, res) {
    // Each request stages in its own folder, so a request that is refused cannot remove the dump of one that is running.
    const stagingPath = Path.join(global.ConfigPath, `absdatabase-restore-${randomUUID()}`)
    const dumpPath = Path.join(stagingPath, 'absdatabase.postgres.dump')
    let result
    try {
      result = await this.applyPostgresBackup(apiCacheManager, backup, zip, stagingPath, dumpPath)
    } finally {
      await zip.close().catch(() => {})
      await fs.remove(stagingPath).catch((err) => Logger.error(`[BackupManager] Failed to remove restore staging folder`, err))
    }
    if (result.status !== 200) return res.status(result.status).send(result.message)

    res.sendStatus(200)
    SocketAuthority.emitter('backup_applied')
  }

  /**
   * Restores the Postgres database from a staged archive. Never throws.
   *
   * Order: stage the archive, open the maintenance window (HTTP and sockets get 503), take the exclusive database lock,
   * disconnect this instance's pool, count other sessions, then pg_restore. The count is the last check before
   * pg_restore. On every path the pool is reconnected if it was closed, the lock is released and the window closes.
   * @returns {Promise<{status: number, message?: string}>}
   */
  async applyPostgresBackup(apiCacheManager, backup, zip, stagingPath, dumpPath) {
    if (!restoreMaintenance.begin()) return { status: 409, message: 'A restore is already running on this instance.' }

    const lock = Database.restoreLock
    let exclusive = false
    let disconnected = false
    try {
      try {
        await this.stagePostgresBackup(zip, stagingPath, dumpPath)
      } catch (error) {
        Logger.error(`[BackupManager] Failed to apply postgres backup`, error)
        return { status: 500, message: `Failed to apply postgres backup: ${error?.message || 'Unknown Error'}` }
      }

      // Fails while any other running instance holds the shared lock.
      if (!(await lock.tryExclusive())) {
        Logger.warn(`[BackupManager] Refusing postgres restore while another instance of this app is running on the database`)
        return { status: 409, message: OTHER_CLIENTS_MESSAGE }
      }
      exclusive = true

      await Database.disconnect()
      disconnected = true
      await lock.confirmExclusive()

      const others = await lock.countOtherSessions()
      if (others > 0) {
        Logger.warn(`[BackupManager] Refusing postgres restore while ${others} other database session(s) are open`)
        return { status: 409, message: OTHER_CLIENTS_MESSAGE }
      }

      lock.assertExclusive()
      await this.restorePostgresDb(dumpPath)
      lock.assertExclusive()
      Logger.info(`[BackupManager] Restored postgres database from backup "${backup.filename}"`)

      await this.placeStagedMetadata(stagingPath)
      await Database.reconnect()
      disconnected = false
      await apiCacheManager.reset()
      await CacheManager.purgeAll()
      return { status: 200 }
    } catch (error) {
      Logger.error(`[BackupManager] Failed to apply postgres backup`, error)
      return { status: 500, message: `Failed to apply postgres backup: ${error?.message || 'Unknown Error'}` }
    } finally {
      if (disconnected) await Database.reconnect().catch((err) => Logger.error(`[BackupManager] Failed to reconnect after a failed postgres restore`, err))
      if (exclusive) await lock.releaseExclusive().catch((err) => Logger.error(`[BackupManager] Failed to release the database restore lock`, err))
      restoreMaintenance.end()
    }
  }

  /**
   * Extracts the dump and the metadata folders into the staging folder. Fails when the archive has no dump.
   * Nothing outside the staging folder is touched.
   */
  async stagePostgresBackup(zip, stagingPath, dumpPath) {
    await fs.remove(stagingPath)
    await fs.ensureDir(stagingPath)
    const itemsStagingPath = Path.join(stagingPath, 'metadata-items')
    const authorsStagingPath = Path.join(stagingPath, 'metadata-authors')
    await fs.ensureDir(itemsStagingPath)
    await fs.ensureDir(authorsStagingPath)
    await zip.extract('absdatabase.postgres.dump', dumpPath)
    await zip.extract('metadata-items/', itemsStagingPath)
    await zip.extract('metadata-authors/', authorsStagingPath)
    // node-stream-zip resolves without writing when the entry is missing, so check the file itself.
    if (!(await fs.pathExists(dumpPath))) throw new Error('Backup archive has no database dump')
  }

  /**
   * Copies the staged metadata folders into the metadata paths. Missing folders are skipped.
   * @param {string} stagingPath
   */
  async placeStagedMetadata(stagingPath) {
    const folders = [
      [Path.join(stagingPath, 'metadata-items'), this.ItemsMetadataPath],
      [Path.join(stagingPath, 'metadata-authors'), this.AuthorsMetadataPath]
    ]
    for (const [source, destination] of folders) {
      if (!(await fs.pathExists(source))) continue
      await fs.ensureDir(destination)
      await fs.copy(source, destination, { overwrite: true })
    }
  }

  async loadBackups() {
    try {
      const filesInDir = await fs.readdir(this.backupPath)

      for (let i = 0; i < filesInDir.length; i++) {
        const filename = filesInDir[i]
        if (filename.endsWith('.audiobookshelf')) {
          const fullFilePath = Path.join(this.backupPath, filename)

          let zip = null
          let data = null
          try {
            zip = new StreamZip.async({ file: fullFilePath })
            const entries = await zip.entries()

            const detailsEntry = entries['details']
            if (!detailsEntry) {
              Logger.error(`[BackupManager] Backup "${fullFilePath}" missing details entry - skipping`)
              await zip.close().catch(() => {})
              continue
            }
            if (detailsEntry.size > 1024 * 1024) {
              Logger.error(`[BackupManager] Backup "${fullFilePath}" details entry too large (${detailsEntry.size} bytes) - skipping`)
              await zip.close().catch(() => {})
              continue
            }

            data = await zip.entryData('details')
          } catch (error) {
            Logger.error(`[BackupManager] Failed to unzip backup "${fullFilePath}"`, error)
            if (zip) await zip.close().catch(() => {})
            continue
          }

          const details = data.toString('utf8').split('\n')

          const backup = new Backup({ details, fullPath: fullFilePath })

          if (!backup.serverVersion) {
            // Backups before v2
            Logger.error(`[BackupManager] Old unsupported backup was found "${backup.filename}"`)
          } else if (!backup.key) {
            // Backups before sqlite migration
            Logger.warn(`[BackupManager] Old unsupported backup was found "${backup.filename}" (pre sqlite migration)`)
          }

          backup.fileSize = await getFileSize(backup.fullPath)
          const existingBackupWithId = this.backups.find((b) => b.id === backup.id)
          if (existingBackupWithId) {
            Logger.warn(`[BackupManager] Backup already loaded with id ${backup.id} - ignoring`)
          } else {
            this.backups.push(backup)
          }

          Logger.debug(`[BackupManager] Backup found "${backup.id}"`)
          await zip.close()
        }
      }
      Logger.info(`[BackupManager] ${this.backups.length} Backups Found`)
    } catch (error) {
      Logger.error('[BackupManager] Failed to load backups', error)
    }
  }

  async runBackup() {
    if (restoreMaintenance.active) {
      Logger.warn(`[BackupManager] Skipping backup while a postgres restore runs`)
      return false
    }
    // Check if Metadata Path is inside Config Path (otherwise there will be an infinite loop as the archiver tries to zip itself)
    Logger.info(`[BackupManager] Running Backup`)
    const newBackup = new Backup()
    newBackup.setData(this.backupPath)

    await fs.ensureDir(this.AuthorsMetadataPath)

    // Create the database copy: a sqlite file, or a pg_dump custom-format archive on postgres
    const isFileDatabase = dialectFor(Database.sequelize).fileBased
    const sqliteBackupPath = await (isFileDatabase ? this.backupSqliteDb(newBackup) : this.backupPostgresDb(newBackup)).catch((error) => {
      Logger.error(`[BackupManager] Failed to backup ${isFileDatabase ? 'sqlite' : 'postgres'} db`, error)
      const errorMsg = error?.message || error || 'Unknown Error'
      NotificationManager.onBackupFailed(errorMsg)
      return false
    })

    if (!sqliteBackupPath) {
      return false
    }

    // Zip the database copy, /metadata/items, and /metadata/authors folders
    const zipResult = await this.zipBackup(sqliteBackupPath, newBackup, this.currentBackupEntry).catch((error) => {
      Logger.error(`[BackupManager] Backup Failed ${error}`)
      const errorMsg = error?.message || error || 'Unknown Error'
      NotificationManager.onBackupFailed(errorMsg)
      return false
    })

    // Remove sqlite backup
    await fs.remove(sqliteBackupPath)

    if (!zipResult) return false

    Logger.info(`[BackupManager] Backup successful ${newBackup.id}`)

    newBackup.fileSize = await getFileSize(newBackup.fullPath)

    const existingIndex = this.backups.findIndex((b) => b.id === newBackup.id)
    if (existingIndex >= 0) {
      this.backups.splice(existingIndex, 1, newBackup)
    } else {
      this.backups.push(newBackup)
    }

    // Check remove oldest backup
    const removeOldest = this.backups.length > this.backupsToKeep
    if (removeOldest) {
      this.backups.sort((a, b) => a.createdAt - b.createdAt)

      const oldBackup = this.backups.shift()
      Logger.debug(`[BackupManager] Removing old backup ${oldBackup.id}`)
      this.removeBackup(oldBackup)
    }

    // Notification for backup successfully completed
    NotificationManager.onBackupCompleted(newBackup, this.backups.length, removeOldest)

    return true
  }

  async removeBackup(backup) {
    try {
      Logger.debug(`[BackupManager] Removing Backup "${backup.fullPath}"`)
      await fs.remove(backup.fullPath)
      this.backups = this.backups.filter((b) => b.id !== backup.id)
      Logger.info(`[BackupManager] Backup "${backup.id}" Removed`)
    } catch (error) {
      Logger.error(`[BackupManager] Failed to remove backup`, error)
    }
  }

  /**
   * Dumps the Postgres database to a custom-format archive with pg_dump.
   * @param {Backup} backup
   * @returns {Promise<string>} path of the dump file
   */
  async backupPostgresDb(backup) {
    const dumpFilePath = Path.join(global.ConfigPath, `absdatabase.${backup.id}.postgres.dump`)
    await runPostgresTool({ name: 'pg_dump', args: dumpArgs(process.env.DATABASE_URL, dumpFilePath), databaseUrl: process.env.DATABASE_URL })
    return dumpFilePath
  }

  /**
   * Replaces the Postgres database with a custom-format dump, inside one transaction.
   * @param {string} dumpFilePath
   */
  async restorePostgresDb(dumpFilePath) {
    await runPostgresTool({ name: 'pg_restore', args: restoreArgs(process.env.DATABASE_URL, dumpFilePath), databaseUrl: process.env.DATABASE_URL })
  }

  /**
   * @see https://github.com/TryGhost/node-sqlite3/pull/1116
   * @param {Backup} backup
   */
  backupSqliteDb(backup) {
    const dbFilePath = Path.join(global.ConfigPath, `absdatabase.${backup.id}.sqlite`)
    return new Promise((resolve, reject) => {
      let db
      let sqliteBackup
      let settled = false

      const finish = (error, result) => {
        if (settled) return
        settled = true
        if (db) {
          db.close(() => {
            if (error) reject(error)
            else resolve(result)
          })
        } else if (error) {
          reject(error)
        } else {
          resolve(result)
        }
      }

      const pollBackup = async () => {
        // Max time ~2 mins
        for (let i = 0; i < 240; i++) {
          if (sqliteBackup.completed) {
            return finish(null, dbFilePath)
          } else if (sqliteBackup.failed) {
            return finish(sqliteBackup.message || 'Unknown failure reason')
          }
          await new Promise((r) => setTimeout(r, 500))
        }

        Logger.error(`[BackupManager] Backup sqlite timed out`)
        finish('Backup timed out')
      }

      const startBackup = () => {
        try {
          sqliteBackup = db.backup(dbFilePath)
          sqliteBackup.step(-1)
          sqliteBackup.finish()
          pollBackup().catch(finish)
        } catch (error) {
          finish(error)
        }
      }

      // Open with a callback and keep an error listener: a failed open with neither kills the process.
      db = new sqlite3.Database(Database.dbPath, (error) => {
        if (error) return finish(error)
        startBackup()
      })
      db.on('error', finish)
    })
  }

  zipBackup(sqliteBackupPath, backup, entryName = 'absdatabase.sqlite') {
    return new Promise((resolve, reject) => {
      // create a file to stream archive data to
      const output = fs.createWriteStream(backup.fullPath)
      const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
      })

      // listen for all archive data to be written
      // 'close' event is fired only when a file descriptor is involved
      output.on('close', () => {
        Logger.info('[BackupManager]', archive.pointer() + ' total bytes')
        resolve(true)
      })

      // This event is fired when the data source is drained no matter what was the data source.
      // It is not part of this library but rather from the NodeJS Stream API.
      // @see: https://nodejs.org/api/stream.html#stream_event_end
      output.on('end', () => {
        Logger.debug('Data has been drained')
      })

      output.on('finish', () => {
        Logger.debug('Write Stream Finished')
      })

      output.on('error', (err) => {
        Logger.debug('Write Stream Error', err)
        reject(err)
      })

      // good practice to catch warnings (ie stat failures and other non-blocking errors)
      archive.on('warning', function (err) {
        if (err.code === 'ENOENT') {
          // log warning
          Logger.warn(`[BackupManager] Archiver warning: ${err.message}`)
        } else {
          // throw error
          Logger.error(`[BackupManager] Archiver error: ${err.message}`)
          // throw err
          reject(err)
        }
      })
      archive.on('error', function (err) {
        Logger.error(`[BackupManager] Archiver error: ${err.message}`)
        reject(err)
      })
      archive.on('progress', ({ fs: fsobj }) => {
        if (this.maxBackupSize !== Infinity) {
          const maxBackupSizeInBytes = this.maxBackupSize * 1000 * 1000 * 1000
          if (fsobj.processedBytes > maxBackupSizeInBytes) {
            Logger.error(`[BackupManager] Archiver is too large - aborting to prevent endless loop, Bytes Processed: ${fsobj.processedBytes}`)
            archive.abort()
            setTimeout(() => {
              this.removeBackup(backup)
              output.destroy('Backup too large') // Promise is reject in write stream error evt
            }, 500)
          }
        }
      })

      // pipe archive data to the file
      archive.pipe(output)

      archive.file(sqliteBackupPath, { name: entryName })
      archive.directory(this.ItemsMetadataPath, 'metadata-items')
      archive.directory(this.AuthorsMetadataPath, 'metadata-authors')

      archive.append(backup.detailsString, { name: 'details' })

      archive.finalize()
    })
  }
}
module.exports = BackupManager
