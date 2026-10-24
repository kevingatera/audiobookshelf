const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const EventEmitter = require('events')
const sqlite3 = require('sqlite3')

const BackupManager = require('../../../server/managers/BackupManager')
const Backup = require('../../../server/objects/Backup')
const Database = require('../../../server/Database')

const serverVersion = require('../../../package.json').version

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
  })
})
