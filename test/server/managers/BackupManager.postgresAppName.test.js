const { expect } = require('chai')
const fs = require('fs')
const { bootPostgres, seedLibrary, writeArchive, fakeRes, removeTempDirs } = require('../database/pgFixtures')

// DATABASE_URL carries its own application_name. Sequelize copies URL query parameters over its dialect options,
// so this process must still tag its pooled connections with its own name. Needs ABS_TEST_POSTGRES_URL and PG_BIN_DIR.
describe('BackupManager postgres restore with application_name in DATABASE_URL', function () {
  this.timeout(180000)
  let Database
  let restore
  let seeded
  let manager
  let BackupManager

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL || !process.env.PG_BIN_DIR) return this.skip()
    const url = new URL(process.env.ABS_TEST_POSTGRES_URL)
    url.searchParams.set('application_name', 'other-app')
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true, url.toString())
    seeded = await seedLibrary(Database)
    BackupManager = require('../../../server/managers/BackupManager')
    manager = new BackupManager()
  })

  after(async function () {
    removeTempDirs()
    if (restore) await restore()
  })

  // Two statements that overlap make the pool open two connections. Each one reports its pid and application_name.
  async function twoPooledConnections() {
    const probe = () =>
      Database.sequelize.query('SELECT pg_sleep(0.3) AS slept, pg_backend_pid() AS pid, (SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS app', {
        type: 'SELECT'
      })
    return Promise.all([probe(), probe()])
  }

  it('tags the pooled connections with this process, not the name in the URL', async function () {
    const { POSTGRES_APPLICATION_NAME } = require('../../../server/utils/dialectAdapter')
    const rows = await twoPooledConnections()
    expect(rows[0][0].pid).to.not.equal(rows[1][0].pid)
    for (const [row] of rows) expect(row.app).to.equal(POSTGRES_APPLICATION_NAME)
  })

  it('restores while two of its own pooled connections are open', async function () {
    await twoPooledConnections()
    const before = await Database.bookModel.count()
    const dumpPath = await manager.backupPostgresDb({ id: 'named-app' })
    const { zip, entries } = await writeArchive(dumpPath)
    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'named' }, zip, entries, res)
    fs.unlinkSync(dumpPath)
    expect(res.code).to.equal(200)
    expect(await Database.bookModel.count()).to.equal(before)
  })
})
