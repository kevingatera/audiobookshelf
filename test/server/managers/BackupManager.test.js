const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const EventEmitter = require('events')
const sqlite3 = require('sqlite3')
const archiver = require('../../../server/libs/archiver')

const BackupManager = require('../../../server/managers/BackupManager')
const Backup = require('../../../server/objects/Backup')
const Database = require('../../../server/Database')
const NotificationManager = require('../../../server/managers/NotificationManager')

const serverVersion = require('../../../package.json').version

/**
 * Writes a backup archive the way runBackup() does: a details entry plus whatever entries the test needs.
 * @param {string} dirPath
 * @param {{filename: string, id: string, key: string, entryNames?: string[]}} options
 */
function writeArchive(dirPath, { filename, id, key, entryNames = [] }) {
  const details = [id, key, Date.now(), serverVersion].join('\n')
  const filePath = Path.join(dirPath, filename)
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath)
    const archive = archiver('zip', { zlib: { level: 1 } })
    output.on('close', () => resolve(filePath))
    archive.on('error', reject)
    archive.pipe(output)
    for (const name of entryNames) {
      archive.append(`contents of ${name}`, { name })
    }
    archive.append(details, { name: 'details' })
    archive.finalize()
  })
}

describe('BackupManager', () => {
  let originalSequelize
  let originalDbPath
  let originalConfigPath
  let originalMetadataPath
  let originalServerSettings
  let tempDir
  let manager

  beforeEach(() => {
    originalSequelize = Database.sequelize
    originalDbPath = Database.dbPath
    originalConfigPath = global.ConfigPath
    originalMetadataPath = global.MetadataPath
    originalServerSettings = global.ServerSettings

    tempDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-backup-test-'))
    global.ConfigPath = tempDir
    global.MetadataPath = tempDir
    global.ServerSettings = { backupPath: tempDir, backupsToKeep: 5 }
    manager = new BackupManager()
  })

  afterEach(() => {
    Database.sequelize = originalSequelize
    Database.dbPath = originalDbPath
    global.ConfigPath = originalConfigPath
    global.MetadataPath = originalMetadataPath
    global.ServerSettings = originalServerSettings
    fs.rmSync(tempDir, { recursive: true, force: true })
    sinon.restore()
  })

  describe('backupSqliteDb', () => {
    it('rejects a backup when the database cannot be opened, without an uncaught error', async () => {
      Database.dbPath = '/nonexistent/absdatabase.sqlite'
      sinon.stub(sqlite3, 'Database').callsFake(function (_dbPath, callback) {
        const db = new EventEmitter()
        db.close = (closeCallback) => closeCallback()
        const error = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' })
        // sqlite3 reports a failed open to the callback, or as an 'error' event when there is no callback.
        process.nextTick(() => (typeof callback === 'function' ? callback(error) : db.emit('error', error)))
        return db
      })

      const backup = new Backup({ details: ['id', 'sqlite', Date.now(), serverVersion], fullPath: Path.join(tempDir, 'backup.audiobookshelf') })

      let error
      try {
        await manager.backupSqliteDb(backup)
      } catch (caughtError) {
        error = caughtError
      }

      expect(error).to.be.an('error')
      expect(error.code).to.equal('SQLITE_CANTOPEN')
    })

    it('settles a real SQLITE_CANTOPEN open failure without waiting for close', async function () {
      this.timeout(15000)
      // A path inside a directory that does not exist fails the real sqlite3 open.
      Database.dbPath = Path.join(tempDir, 'missing-directory', 'absdatabase.sqlite')

      const backup = new Backup({ details: ['id', 'sqlite', Date.now(), serverVersion], fullPath: Path.join(tempDir, 'backup.audiobookshelf') })

      let deadlineTimer
      const deadline = new Promise((resolve) => {
        deadlineTimer = setTimeout(() => resolve('deadline'), 5000)
      })

      const outcome = await Promise.race([
        manager.backupSqliteDb(backup).then(
          () => 'resolved',
          (error) => error
        ),
        deadline
      ])
      clearTimeout(deadlineTimer)

      expect(outcome, 'backupSqliteDb must settle within 5 s').to.not.equal('deadline')
      expect(outcome).to.be.an('error')
      expect(outcome.code).to.equal('SQLITE_CANTOPEN')
      expect(fs.existsSync(Path.join(tempDir, 'missing-directory'))).to.equal(false)
    })

    it('backs up a real sqlite database and closes the handle', async () => {
      Database.dbPath = Path.join(tempDir, 'library.sqlite')
      await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(Database.dbPath, (error) => {
          if (error) return reject(error)
          db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO probe (name) VALUES ('round9');", (execError) => {
            db.close(() => (execError ? reject(execError) : resolve()))
          })
        })
      })

      const backup = new Backup({ details: ['id', 'sqlite', Date.now(), serverVersion], fullPath: Path.join(tempDir, 'backup.audiobookshelf') })
      const dbFilePath = await manager.backupSqliteDb(backup)

      expect(dbFilePath).to.equal(Path.join(tempDir, `absdatabase.${backup.id}.sqlite`))
      expect(fs.existsSync(dbFilePath)).to.equal(true)

      const rows = await new Promise((resolve, reject) => {
        const copy = new sqlite3.Database(dbFilePath, (error) => {
          if (error) return reject(error)
          copy.all('SELECT name FROM probe', (queryError, result) => {
            copy.close(() => (queryError ? reject(queryError) : resolve(result)))
          })
        })
      })
      expect(rows).to.deep.equal([{ name: 'round9' }])
    })
  })

  describe('loadBackups', () => {
    it('skips archives with no database entry and archives with an unsupported one', async () => {
      await writeArchive(tempDir, { filename: '2026-01-01T0000.audiobookshelf', id: '2026-01-01T0000', key: 'sqlite', entryNames: ['absdatabase.sqlite', 'metadata-items/probe.json', 'metadata-authors/probe.json'] })
      await writeArchive(tempDir, { filename: '2026-01-02T0000.audiobookshelf', id: '2026-01-02T0000', key: 'sqlite', entryNames: ['metadata-items/probe.json'] })
      await writeArchive(tempDir, { filename: '2026-01-03T0000.audiobookshelf', id: '2026-01-03T0000', key: 'sqlite', entryNames: ['absdatabase.mysql', 'metadata-items/probe.json'] })

      await manager.loadBackups()

      expect(manager.backups.map((b) => b.id)).to.deep.equal(['2026-01-01T0000'])
    })

    it('still lists an archive made with a sqlite key', async () => {
      await writeArchive(tempDir, { filename: '2026-01-01T0000.audiobookshelf', id: '2026-01-01T0000', key: 'sqlite', entryNames: ['absdatabase.sqlite'] })

      await manager.loadBackups()

      expect(manager.backups).to.have.length(1)
      expect(manager.backups[0].key).to.equal('sqlite')
    })
  })

  describe('runBackup', () => {
    function stubBackupSteps() {
      const captured = {}
      sinon.stub(manager, 'backupSqliteDb').resolves(Path.join(tempDir, 'source.sqlite'))
      sinon.stub(manager, 'backupPostgresDb').resolves(Path.join(tempDir, 'source.dump'))
      sinon.stub(NotificationManager, 'onBackupCompleted')
      sinon.stub(manager, 'zipBackup').callsFake(async (sourcePath, backup, entryName) => {
        fs.writeFileSync(backup.fullPath, 'archive')
        captured.key = backup.key
        captured.entryName = entryName
        return true
      })
      return captured
    }

    it('writes the postgres dialect into the backup key', async () => {
      Database.sequelize = { getDialect: () => 'postgres' }
      const captured = stubBackupSteps()

      const success = await manager.runBackup()

      expect(success).to.equal(true)
      expect(captured.key).to.equal('postgres')
      expect(captured.entryName).to.equal('absdatabase.postgres.dump')
      expect(manager.backups[0].detailsString.split('\n')[1]).to.equal('postgres')
    })

    it('writes the sqlite dialect into the backup key', async () => {
      Database.sequelize = { getDialect: () => 'sqlite' }
      const captured = stubBackupSteps()

      const success = await manager.runBackup()

      expect(success).to.equal(true)
      expect(captured.key).to.equal('sqlite')
      expect(captured.entryName).to.equal('absdatabase.sqlite')
      expect(manager.backups[0].detailsString.split('\n')[1]).to.equal('sqlite')
    })
  })
})
