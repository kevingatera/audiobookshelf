const { expect } = require('chai')
const { randomUUID } = require('crypto')
const fs = require('fs')
const { Client } = require('pg')
const { bootPostgres, seedLibrary, writeArchive, fakeRes, removeTempDirs } = require('../database/pgFixtures')

// Restore guards on a real Postgres. Needs ABS_TEST_POSTGRES_URL (a disposable server; its user must be able to create roles and databases)
// and PG_BIN_DIR. The app connects as an ordinary role that owns a scratch database, and the other sessions use a second ordinary role.
// Postgres hides fields of other roles' sessions from an ordinary role, so the superuser cannot reproduce those cases.
describe('BackupManager postgres restore guards', function () {
  this.timeout(120000)
  let Database
  let BackupManager
  let manager
  let seeded
  let restore
  let admin
  let names
  let passwords
  let appUrl
  const sessions = []

  const token = () => randomUUID().replace(/-/g, '').slice(0, 16)
  const bookCount = async () => Database.bookModel.count()

  function urlFor(user, password, database, appName) {
    const url = new URL(process.env.ABS_TEST_POSTGRES_URL)
    url.username = user
    url.password = password
    url.pathname = `/${database}`
    if (appName) url.searchParams.set('application_name', appName)
    return url.toString()
  }

  async function sessionAs(appName) {
    const client = new Client({ connectionString: urlFor(names.other, passwords.other, names.db, appName) })
    await client.connect()
    sessions.push(client)
    return client
  }

  async function bookTitle(id) {
    const [row] = await Database.sequelize.query('SELECT title FROM books WHERE id = :id', { replacements: { id }, type: 'SELECT' })
    return row.title
  }

  // Lets the other role write to the app's tables. Restores drop the tables, so this runs again before each test that needs it.
  async function grantOtherRole() {
    await Database.sequelize.query(`GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA public TO "${names.other}"`)
  }

  async function applyArchive(zip, entries) {
    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'guard' }, zip, entries, res)
    return res
  }

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL || !process.env.PG_BIN_DIR) return this.skip()
    const suffix = token()
    names = { db: `abs_guard_${suffix}`, app: `abs_guard_app_${suffix}`, other: `abs_guard_other_${suffix}` }
    passwords = { app: token(), other: token() }
    admin = new Client({ connectionString: process.env.ABS_TEST_POSTGRES_URL })
    await admin.connect()
    await admin.query(`CREATE ROLE "${names.app}" LOGIN PASSWORD '${passwords.app}' NOSUPERUSER`)
    await admin.query(`CREATE ROLE "${names.other}" LOGIN PASSWORD '${passwords.other}' NOSUPERUSER`)
    await admin.query(`CREATE DATABASE "${names.db}" OWNER "${names.app}"`)

    appUrl = urlFor(names.app, passwords.app, names.db)
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true, appUrl)
    seeded = await seedLibrary(Database)
    BackupManager = require('../../../server/managers/BackupManager')
    manager = new BackupManager()
  })

  after(async function () {
    removeTempDirs()
    for (const session of sessions) await session.end().catch(() => {})
    if (restore) await restore()
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [names.db]).catch(() => {})
      await admin.query(`DROP DATABASE IF EXISTS "${names.db}"`).catch(() => {})
      await admin.query(`DROP ROLE IF EXISTS "${names.app}"`).catch(() => {})
      await admin.query(`DROP ROLE IF EXISTS "${names.other}"`).catch(() => {})
      await admin.end()
    }
  })

  for (const [label, appName] of [
    ['an untagged session', undefined],
    ['a session tagged by an unrelated tool', 'unrelated-tool']
  ]) {
    it(`refuses with 409 and keeps newer data while ${label} from another ordinary role is connected`, async function () {
      await grantOtherRole()
      const dumpPath = await manager.backupPostgresDb({ id: token() })
      const { zip, entries } = await writeArchive(dumpPath)
      const bookId = seeded.bookIds[1]
      const other = await sessionAs(appName)
      await other.query(`UPDATE books SET title = 'Written by a second instance' WHERE id = $1`, [bookId])
      const res = await applyArchive(zip, entries)
      await other.end()
      fs.unlinkSync(dumpPath)
      expect(res.code).to.equal(409)
      expect(await bookTitle(bookId)).to.equal('Written by a second instance')
    })
  }

  it('refuses a client that connects during extraction, and keeps the newer data it writes', async function () {
    await grantOtherRole()
    const dumpPath = await manager.backupPostgresDb({ id: token() })
    const { zip, entries } = await writeArchive(dumpPath)
    const bookId = seeded.bookIds[2]

    // The late client connects after the restore started. It writes inside an open transaction, so pg_restore would block on it.
    let late = null
    let committed = false
    const commitLate = async () => {
      if (late && !committed) {
        committed = true
        await late.query('COMMIT')
      }
    }
    const extract = zip.extract.bind(zip)
    zip.extract = async (...args) => {
      if (!late) {
        late = await sessionAs()
        await late.query('BEGIN')
        await late.query(`UPDATE books SET title = 'Written late' WHERE id = $1`, [bookId])
      }
      return extract(...args)
    }
    // Ends the transaction after 3 seconds so a restore that does not refuse cannot hang the test.
    const release = setTimeout(() => commitLate().catch(() => {}), 3000)
    let res
    try {
      res = await applyArchive(zip, entries)
    } finally {
      clearTimeout(release)
      zip.extract = extract
      await commitLate()
      if (late) await late.end()
    }
    fs.unlinkSync(dumpPath)
    expect(res.code).to.equal(409)
    expect(await bookTitle(bookId)).to.equal('Written late')
  })

  it('answers 503 on HTTP and sockets while pg_restore runs, and serves again afterwards', async function () {
    const maintenance = require('../../../server/utils/restoreMaintenance')
    const dumpPath = await manager.backupPostgresDb({ id: token() })
    const { zip, entries } = await writeArchive(dumpPath)

    let seen = null
    const original = manager.restorePostgresDb
    manager.restorePostgresDb = async (file) => {
      const http = fakeRes()
      let httpPassed = false
      maintenance.middleware({ method: 'GET', url: '/api/libraries' }, http, () => (httpPassed = true))
      let connectError = null
      maintenance.socketMiddleware({ id: 'socket-during-restore' }, (error) => (connectError = error))
      let eventError = null
      maintenance.packetMiddleware(['get_libraries'], (error) => (eventError = error))
      seen = { http: http.code, httpPassed, connectError, eventError }
      return original.call(manager, file)
    }
    let res
    try {
      res = await applyArchive(zip, entries)
    } finally {
      delete manager.restorePostgresDb
      fs.unlinkSync(dumpPath)
    }
    expect(seen, 'pg_restore was never reached').to.not.equal(null)
    expect(seen.http).to.equal(503)
    expect(seen.httpPassed).to.equal(false)
    expect(seen.connectError).to.be.an('error')
    expect(seen.eventError).to.be.an('error')
    expect(res.code).to.equal(200)
    expect(maintenance.active).to.equal(false)
  })

  it('refuses a restore while another instance holds the lock, and keeps this instance connected', async function () {
    const { RestoreLock } = require('../../../server/utils/postgresRestoreLock')
    const other = new RestoreLock()
    await other.join(appUrl)
    const dumpPath = await manager.backupPostgresDb({ id: token() })
    const { zip, entries } = await writeArchive(dumpPath)
    const before = await bookCount()
    let res
    try {
      res = await applyArchive(zip, entries)
    } finally {
      await other.leave()
      fs.unlinkSync(dumpPath)
    }
    expect(res.code).to.equal(409)
    expect(await bookCount()).to.equal(before)
  })

  it('refuses to start a new instance while a restore holds the lock', async function () {
    const { RestoreLock } = require('../../../server/utils/postgresRestoreLock')
    const restoring = Database.restoreLock
    expect(await restoring.tryExclusive()).to.equal(true)
    const starting = new RestoreLock()
    let refused = null
    try {
      await starting.join(appUrl)
    } catch (error) {
      refused = error
    } finally {
      await restoring.releaseExclusive()
    }
    expect(refused, 'a new instance joined during a restore').to.be.an('error')
    await starting.join(appUrl)
    expect(starting.isMember).to.equal(true)
    await starting.leave()
  })

  it('restores when no other session is connected, with the app connected as an ordinary role', async function () {
    await grantOtherRole()
    const dumpPath = await manager.backupPostgresDb({ id: token() })
    const { zip, entries } = await writeArchive(dumpPath)
    const before = await bookCount()
    await Database.bookModel.destroy({ where: { id: seeded.bookIds[0] } })
    const res = await applyArchive(zip, entries)
    fs.unlinkSync(dumpPath)
    expect(res.code).to.equal(200)
    expect(await bookCount()).to.equal(before)
  })

  it('refuses a second restore request without removing the dump of the first', async function () {
    const dumpPath = await manager.backupPostgresDb({ id: token() })
    const first = await writeArchive(dumpPath)
    const second = await writeArchive(dumpPath)
    fs.unlinkSync(dumpPath)

    // Holds the first request inside pg_restore until the second request has been refused.
    let reached
    const inRestore = new Promise((resolve) => (reached = resolve))
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const original = manager.restorePostgresDb
    manager.restorePostgresDb = async (file) => {
      reached()
      await gate
      return original.call(manager, file)
    }
    const firstRes = fakeRes()
    const secondRes = fakeRes()
    let firstDone
    try {
      firstDone = manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'first' }, first.zip, first.entries, firstRes)
      await inRestore
      await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'second' }, second.zip, second.entries, secondRes)
      release()
      await firstDone
    } finally {
      delete manager.restorePostgresDb
      release()
    }
    expect(secondRes.code).to.equal(409)
    expect(firstRes.code).to.equal(200)
  })

  it('opens no connections without the shared lock, and rejoins it after its session drops', async function () {
    this.timeout(30000)
    const lock = Database.restoreLock
    const waitFor = async (condition, ms) => {
      const deadline = Date.now() + ms
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      return condition()
    }
    expect(lock.isMember).to.equal(true)
    lock.client.end().catch(() => {})
    expect(await waitFor(() => !lock.isMember, 5000)).to.equal(true)
    expect(() => lock.assertMember()).to.throw(/does not hold the database lock/)
    // The rejoin timer fires after 5 seconds
    expect(await waitFor(() => lock.isMember, 20000)).to.equal(true)
  })
})
