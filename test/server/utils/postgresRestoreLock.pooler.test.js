const { expect } = require('chai')
const { Client } = require('pg')
const { RestoreLock, PooledLockError } = require('../../../server/utils/postgresRestoreLock')
const { bootPostgres } = require('../database/pgFixtures')

// Lock connections through PgBouncer. The lock needs a session that keeps its locks, so a transaction-mode pooler must be refused.
// Needs:
//   ABS_TEST_POSTGRES_URL              direct connection to the disposable server
//   ABS_TEST_PGBOUNCER_TRANSACTION_URL PgBouncer with pool_mode = transaction and one server backend
//   ABS_TEST_PGBOUNCER_SESSION_URL     PgBouncer with pool_mode = session
// The tests skip when a URL is missing. Restart the poolers before the suite: their idle server connections count as
// sessions in the restore tests.
describe('restore lock through PgBouncer', function () {
  this.timeout(60000)
  const direct = () => process.env.ABS_TEST_POSTGRES_URL
  const transaction = () => process.env.ABS_TEST_PGBOUNCER_TRANSACTION_URL
  const session = () => process.env.ABS_TEST_PGBOUNCER_SESSION_URL

  // A transaction pooler keeps a session-level lock on its backend after the client disconnects. Clears it so later tests start clean.
  async function clearTransactionBackend() {
    const client = new Client({ connectionString: transaction() })
    await client.connect()
    try {
      await client.query('SELECT pg_advisory_unlock_all()')
    } finally {
      await client.end()
    }
  }

  it('refuses to join through a transaction-mode pooler', async function () {
    if (!transaction()) return this.skip()
    const lock = new RestoreLock()
    let error = null
    try {
      await lock.join(transaction())
    } catch (caught) {
      error = caught
    } finally {
      await lock.leave()
      await clearTransactionBackend()
    }
    expect(error, 'joined through a transaction-mode pooler').to.be.an('error')
    expect(error).to.be.instanceOf(PooledLockError)
    expect(lock.isMember).to.equal(false)
  })

  it('joins through a session-mode pooler, and a second instance is refused during an exclusive hold', async function () {
    if (!session() || !direct()) return this.skip()
    const member = new RestoreLock()
    await member.join(session())
    try {
      expect(await member.tryExclusive()).to.equal(true)
      const second = new RestoreLock()
      let refused = null
      try {
        await second.join(direct())
      } catch (caught) {
        refused = caught
      }
      expect(refused, 'a second instance joined during the exclusive hold').to.be.an('error')
      await member.releaseExclusive()

      await second.join(direct())
      expect(second.isMember).to.equal(true)
      await second.leave()
    } finally {
      await member.leave()
    }
  })

  it('takes the lock on DATABASE_LOCK_URL while the app pools through PgBouncer on DATABASE_URL', async function () {
    if (!transaction() || !direct()) return this.skip()
    const Database = require('../../../server/Database')
    const savedLockUrl = process.env.DATABASE_LOCK_URL
    process.env.DATABASE_LOCK_URL = direct()
    let restore = null
    try {
      restore = await bootPostgres(Database, false, transaction())
      expect(Database.restoreLock.isMember).to.equal(true)
      const [row] = await Database.sequelize.query('SELECT current_database() AS db', { type: 'SELECT' })
      expect(row.db).to.equal('abs_test')
    } finally {
      if (restore) await restore()
      if (savedLockUrl === undefined) delete process.env.DATABASE_LOCK_URL
      else process.env.DATABASE_LOCK_URL = savedLockUrl
    }
  })

  it('refuses an exclusive lock that a second session can also take, which means the lock is pooled', async function () {
    if (!direct()) return this.skip()
    const lock = new RestoreLock()
    await lock.join(direct())
    // Stands in for a pooler that routes the probe to the backend holding the lock: the probe session gets the lock.
    lock.openSession = async () => ({ query: async () => ({ rows: [{ ok: true }] }), end: async () => {} })
    let error = null
    try {
      await lock.tryExclusive()
    } catch (caught) {
      error = caught
    } finally {
      delete lock.openSession
      await lock.leave()
    }
    expect(error).to.be.instanceOf(PooledLockError)
  })
})
