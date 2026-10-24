const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const { bootPostgres, seedLibrary } = require('../database/pgFixtures')

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

  // Stands in for the StreamZip archive the handler reads. Entries listed in failOn throw.
  function fakeZip(dumpPath, failOn = null) {
    return {
      extract: async (name, dest) => {
        if (name === failOn) throw new Error(`cannot read ${name}`)
        if (name === 'absdatabase.postgres.dump') {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.copyFileSync(dumpPath, dest)
          return
        }
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'placeholder.json'), '{}')
      },
      close: async () => {}
    }
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

  it('reports an unreadable metadata entry before the database is touched', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'bad-archive' })
    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'bad' }, fakeZip(dumpPath, 'metadata-items/'), {}, res)
    expect(res.code).to.equal(500)
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(dumpPath)
  })

  it('reconnects and reports when placing metadata fails after the restore committed', async function () {
    const before = await bookCount()
    const dumpPath = await manager.backupPostgresDb({ id: 'after-restore' })
    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    const original = manager.placeStagedMetadata
    manager.placeStagedMetadata = async () => {
      throw new Error('disk full')
    }
    const res = fakeRes()
    try {
      await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'after' }, fakeZip(dumpPath), {}, res)
    } finally {
      manager.placeStagedMetadata = original
    }
    expect(res.code).to.equal(500)
    expect(await bookCount()).to.equal(before)
    fs.unlinkSync(dumpPath)
  })
})
