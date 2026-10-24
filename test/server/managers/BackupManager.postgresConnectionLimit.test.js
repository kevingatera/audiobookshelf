const { expect } = require('chai')
const { randomUUID } = require('crypto')
const fs = require('fs')
const { Client } = require('pg')
const { bootPostgres, seedLibrary, writeArchive, fakeRes, removeTempDirs } = require('../database/pgFixtures')

// The restore lock key (server/utils/postgresRestoreLock.js).
const RESTORE_LOCK_KEY = 7210733

// A restore while the app's pool is open, for a role with CONNECTION LIMIT 2. The app then holds its lock session and one
// pool connection, so the restore must not open a third connection. Needs ABS_TEST_POSTGRES_URL (a superuser that can
// create roles and databases) and PG_BIN_DIR.
describe('BackupManager postgres restore under a CONNECTION LIMIT', function () {
  this.timeout(120000)
  let admin
  let Database
  let BackupManager
  let manager
  let restore
  let seeded
  let names
  const token = () => randomUUID().replace(/-/g, '').slice(0, 16)

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL || !process.env.PG_BIN_DIR) return this.skip()
    const suffix = token()
    names = { db: `abs_limit_${suffix}`, app: `abs_limit_app_${suffix}`, password: token() }
    admin = new Client({ connectionString: process.env.ABS_TEST_POSTGRES_URL })
    await admin.connect()
    await admin.query(`CREATE ROLE "${names.app}" LOGIN PASSWORD '${names.password}' NOSUPERUSER`)
    await admin.query(`CREATE DATABASE "${names.db}" OWNER "${names.app}"`)

    const appUrl = new URL(process.env.ABS_TEST_POSTGRES_URL)
    appUrl.username = names.app
    appUrl.password = names.password
    appUrl.pathname = `/${names.db}`
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true, appUrl.toString())
    seeded = await seedLibrary(Database)
    BackupManager = require('../../../server/managers/BackupManager')
    manager = new BackupManager()
  })

  after(async function () {
    removeTempDirs()
    if (restore) await restore()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${names.db}"`).catch(() => {})
      await admin.query(`DROP ROLE IF EXISTS "${names.app}"`).catch(() => {})
      await admin.end().catch(() => {})
    }
  })

  it('restores with the pool open under CONNECTION LIMIT 2, and leaves the lock free', async function () {
    // The pool holds at least one connection during the restore. The dump needs its own connection, so the limit is set after it.
    await Database.sequelize.query('SELECT 1')
    const dumpPath = await manager.backupPostgresDb({ id: 'limit' })
    const { zip, entries } = await writeArchive(dumpPath)
    await admin.query(`ALTER ROLE "${names.app}" CONNECTION LIMIT 2`)

    const res = fakeRes()
    await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'limit' }, zip, entries, res)
    fs.unlinkSync(dumpPath)
    expect(res.code, `restore answered ${res.code}: ${res.message}`).to.equal(200)

    // No session holds the exclusive lock: a shared lock from another session is granted, then released.
    const { rows } = await admin.query('SELECT pg_try_advisory_lock_shared($1) AS ok', [RESTORE_LOCK_KEY])
    expect(rows[0].ok, 'the restore left the exclusive lock held').to.equal(true)
    await admin.query('SELECT pg_advisory_unlock_shared($1)', [RESTORE_LOCK_KEY])

    // A later instance can join, using the superuser URL so that its own connections do not count against the limit.
    const { RestoreLock } = require('../../../server/utils/postgresRestoreLock')
    const later = new RestoreLock()
    try {
      await later.join(process.env.ABS_TEST_POSTGRES_URL)
      expect(later.isMember).to.equal(true)
    } finally {
      await later.leave()
    }
  })

  it('releases the exclusive lock when the pooling probe cannot open its connection', async function () {
    // The dump needs a connection of its own, so the limit is lifted for it and set again before the restore.
    await admin.query(`ALTER ROLE "${names.app}" CONNECTION LIMIT -1`)
    const dumpPath = await manager.backupPostgresDb({ id: 'probe' })
    const { zip, entries } = await writeArchive(dumpPath)
    await admin.query(`ALTER ROLE "${names.app}" CONNECTION LIMIT 2`)

    const lock = Database.restoreLock
    lock.openSession = async () => {
      throw Object.assign(new Error(`too many connections for role "${names.app}"`), { code: '53300' })
    }
    const res = fakeRes()
    try {
      await manager.requestApplyPostgresBackup({ reset: async () => {} }, { filename: 'probe' }, zip, entries, res)
    } finally {
      delete lock.openSession
      fs.unlinkSync(dumpPath)
    }
    expect(res.code).to.equal(500)
    expect(lock.exclusive, 'the lock object still holds the exclusive lock').to.equal(false)

    const { rows } = await admin.query('SELECT pg_try_advisory_lock_shared($1) AS ok', [RESTORE_LOCK_KEY])
    expect(rows[0].ok, 'a failed probe left the exclusive lock held').to.equal(true)
    await admin.query('SELECT pg_advisory_unlock_shared($1)', [RESTORE_LOCK_KEY])
    expect(lock.isMember).to.equal(true)
  })

  it('rejoins the lock with the pool open under the limit, without a third connection', async function () {
    this.timeout(60000)
    const lock = Database.restoreLock
    await Database.sequelize.query('SELECT 1')
    expect(lock.isMember).to.equal(true)
    lock.client.end().catch(() => {})
    const waitFor = async (condition, ms) => {
      const deadline = Date.now() + ms
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      return condition()
    }
    expect(await waitFor(() => !lock.isMember, 5000)).to.equal(true)
    // The rejoin timer fires after 5 seconds. The pool connection is still open at 8 seconds and evicted after about 10,
    // so a rejoin that needs a retry fails this check.
    expect(await waitFor(() => lock.isMember, 8000), 'the instance did not rejoin the lock in time').to.equal(true)
    await Database.sequelize.query('SELECT 1')
  })
})
