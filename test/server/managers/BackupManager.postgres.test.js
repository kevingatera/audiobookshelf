const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const { Sequelize } = require('sequelize')
const { bootPostgres, seedLibrary, writeArchive, fakeRes, removeTempDirs } = require('../database/pgFixtures')

// Round trip against a real Postgres. Needs ABS_TEST_POSTGRES_URL and PG_BIN_DIR. The client major must match the server (see the PR notes).
describe('BackupManager postgres round trip', function () {
  this.timeout(180000)
  let Database
  let restore
  let BackupManager
  let manager
  let seeded

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
    removeTempDirs()
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
