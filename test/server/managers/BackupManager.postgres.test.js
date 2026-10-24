const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Sequelize } = require('sequelize')
const archiver = require('../../../server/libs/archiver')
const StreamZip = require('../../../server/libs/nodeStreamZip')
const { bootPostgres, seedLibrary } = require('../database/pgFixtures')

// Round trip against a real Postgres. Needs ABS_TEST_POSTGRES_URL and PG_BIN_DIR. The client major must match the server (see the PR notes).
describe('BackupManager postgres round trip', function () {
  this.timeout(180000)
  let Database
  let restore
  let BackupManager
  let manager
  let seeded
  const workDirs = []

  const bookCount = async () => Database.bookModel.count()

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL || !process.env.PG_BIN_DIR) return this.skip()
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true)
    seeded = await seedLibrary(Database)
    BackupManager = require('../../../server/managers/BackupManager')
    manager = new BackupManager()
  })

  after(async function () {
    for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true })
    if (restore) await restore()
  })

  it('dumps the database and restores it after data is lost', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'roundtrip' })
    expect(fs.statSync(dumpPath).size).to.be.greaterThan(0)

    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    expect(await bookCount()).to.equal(before - 1)

    await Database.disconnect()
    try {
      await manager.restorePostgresDb(dumpPath)
    } finally {
      await Database.init(false)
    }
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(dumpPath)
  })

  it('keeps the original data when a restore fails', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'broken' })
    const broken = path.join(path.dirname(dumpPath), 'broken.dump')
    fs.writeFileSync(broken, fs.readFileSync(dumpPath).subarray(0, 200))
    fs.unlinkSync(dumpPath)

    await Database.disconnect()
    let failed = false
    try {
      await manager.restorePostgresDb(broken)
    } catch (error) {
      failed = true
    }
    expect(failed).to.equal(true)
    await Database.init(false)
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(broken)
  })

  // Writes a real zip with the app's archiver, the same way the backup job does: the dump and two metadata folders.
  async function writeArchive(dumpPath, { withDump = true } = {}) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-pg-archive-'))
    workDirs.push(workDir)
    const itemsDir = path.join(workDir, 'items')
    const authorsDir = path.join(workDir, 'authors')
    fs.mkdirSync(itemsDir)
    fs.mkdirSync(authorsDir)
    fs.writeFileSync(path.join(itemsDir, 'probe.json'), '{"probe":true}')
    fs.writeFileSync(path.join(authorsDir, 'probe.json'), '{"probe":true}')
    const file = path.join(workDir, 'backup.audiobookshelf')
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(file)
      const archive = archiver('zip', { zlib: { level: 1 } })
      output.on('close', resolve)
      archive.on('error', reject)
      archive.pipe(output)
      if (withDump) archive.file(dumpPath, { name: 'absdatabase.postgres.dump' })
      archive.directory(itemsDir, 'metadata-items')
      archive.directory(authorsDir, 'metadata-authors')
      archive.finalize()
    })
    const zip = new StreamZip.async({ file })
    return { zip, entries: await zip.entries() }
  }

  function fakeRes() {
    return {
      code: null,
      status(code) {
        this.code = code
        return this
      },
      send() {
        return this
      },
      sendStatus(code) {
        this.code = code
        return this
      }
    }
  }

  it('reports an archive without a dump before the database is touched', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'no-dump' })
    const { zip, entries } = await writeArchive(dumpPath, { withDump: false })
    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'no-dump' }, zip, entries, res)
    expect(res.code).to.equal(500)
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(dumpPath)
  })

  it('restores a real archive and places its metadata files', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'real-archive' })
    const { zip, entries } = await writeArchive(dumpPath)
    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'real' }, zip, entries, res)
    expect(res.code).to.equal(200)
    expect(await bookCount()).to.equal(before)
    expect(fs.existsSync(path.join(manager.ItemsMetadataPath, 'probe.json'))).to.equal(true)
    fs.unlinkSync(dumpPath)
  })

  it('refuses with 409 while another client is connected, and leaves its newer data alone', async function () {
    const dumpPath = await manager.backupPostgresDb({ id: 'busy' })
    const { zip, entries } = await writeArchive(dumpPath)
    const other = new Sequelize(process.env.ABS_TEST_POSTGRES_URL, { dialect: 'postgres', logging: false })
    try {
      await other.query('SELECT 1')
      await other.query("UPDATE books SET title = 'Written by a second instance' WHERE id = :id", { replacements: { id: seeded.bookIds[1] } })
      const res = fakeRes()
      await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'busy' }, zip, entries, res)
      expect(res.code).to.equal(409)
      const [row] = await Database.sequelize.query('SELECT title FROM books WHERE id = :id', { replacements: { id: seeded.bookIds[1] }, type: 'SELECT' })
      expect(row.title).to.equal('Written by a second instance')
    } finally {
      await other.close()
      fs.unlinkSync(dumpPath)
    }
  })

  it('reconnects and reports when placing metadata fails after the restore committed', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'after-restore' })
    const { zip, entries } = await writeArchive(dumpPath)
    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    const original = manager.placeStagedMetadata
    manager.placeStagedMetadata = async () => {
      throw new Error('disk full')
    }
    const res = fakeRes()
    try {
      await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'after' }, zip, entries, res)
    } finally {
      manager.placeStagedMetadata = original
    }
    expect(res.code).to.equal(500)
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(dumpPath)
  })
})
