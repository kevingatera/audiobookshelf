const { Client } = require('pg')
const Logger = require('../Logger')
const { POSTGRES_APPLICATION_NAME } = require('./dialectAdapter')

/**
 * Coordinates Postgres restores between instances that share one database.
 *
 * One advisory lock per database. Every running instance holds it in shared mode on its own session, for its whole life.
 * A restore takes it in exclusive mode, which fails while any instance holds it. An instance cannot take the shared
 * lock while a restore holds it, so it refuses to open connections then.
 *
 * The guarantee needs the membership session to keep its locks for its whole life. A transaction-mode pooler (PgBouncer
 * pool_mode = transaction) does not, so its lock connection must be direct or session-pooled. See otherSessionGotLock().
 */
const RESTORE_LOCK_KEY = 7210733
const REJOIN_DELAY_MS = 5000
const PROBE_ATTEMPTS = 3
const SESSION_TIMEOUT_MS = 5000

class PooledLockError extends Error {
  constructor() {
    super('The database lock connection is pooled per transaction, so it cannot hold the restore lock. Point DATABASE_LOCK_URL at a direct or session-pooled connection.')
    this.name = 'PooledLockError'
  }
}

/** The membership session takes its own tag. A name in the URL would replace it, so the URL's copy is dropped. */
function withoutApplicationName(databaseUrl) {
  const url = new URL(databaseUrl)
  url.searchParams.delete('application_name')
  return url.toString()
}

class RestoreLock {
  constructor() {
    this.client = null // membership session, separate from the Sequelize pool
    this.member = false
    this.exclusive = false
    this.databaseUrl = null
    this.stopped = false // set by leave(); only join() clears it
    this.rejoinTimer = null
  }

  get isMember() {
    return this.member
  }

  /**
   * Opens the membership session and takes the shared lock. Refuses while a restore holds the exclusive lock, and
   * refuses a lock connection that is pooled per transaction. Calling it again while joined does nothing.
   * @param {string} databaseUrl the lock connection URL (DATABASE_LOCK_URL, or DATABASE_URL when that is unset)
   */
  async join(databaseUrl) {
    this.stopped = false
    this.databaseUrl = databaseUrl
    await this.connectMembership()
  }

  /** A new session on the lock URL. Tests replace it with a stub. */
  async openSession(url) {
    const client = new Client({
      connectionString: withoutApplicationName(url),
      application_name: POSTGRES_APPLICATION_NAME,
      connectionTimeoutMillis: SESSION_TIMEOUT_MS
    })
    await client.connect()
    return client
  }

  async connectMembership() {
    if (this.member) return
    const client = await this.openSession(this.databaseUrl)
    client.on('error', (error) => this.lost(client, error))
    client.on('end', () => this.lost(client, new Error('connection closed')))
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock_shared($1) AS ok', [RESTORE_LOCK_KEY])
      if (!rows[0].ok) throw new Error('A database restore is in progress. Start this instance after it finishes.')
      if (this.stopped) throw new Error('The database lock was left while joining')
      // A second session must not get the lock exclusively while this one holds it shared.
      if (await this.otherSessionGotLock('exclusive')) {
        await client.query('SELECT pg_advisory_unlock_all()').catch(() => {})
        throw new PooledLockError()
      }
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    this.client = client
    this.member = true
  }

  /**
   * Asks for the lock from fresh sessions while this instance holds it in the other mode. `exclusive` is asked while
   * this instance holds it shared; `shared` is asked while it holds it exclusively. A direct or session-pooled
   * connection always refuses. A transaction pooler can route the probe to the backend that holds the lock, and the
   * probe then gets it. With one backend that is certain. With several, a single probe may miss, so it is repeated.
   * Returns true when a second session got the lock.
   * @param {'exclusive'|'shared'} mode
   */
  async otherSessionGotLock(mode) {
    const take = mode === 'exclusive' ? 'pg_try_advisory_lock' : 'pg_try_advisory_lock_shared'
    const release = mode === 'exclusive' ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared'
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      const session = await this.openSession(this.databaseUrl)
      try {
        const { rows } = await session.query(`SELECT ${take}($1) AS ok`, [RESTORE_LOCK_KEY])
        if (rows[0].ok) {
          await session.query(`SELECT ${release}($1)`, [RESTORE_LOCK_KEY]).catch(() => {})
          return true
        }
      } finally {
        await session.end().catch(() => {})
      }
    }
    return false
  }

  /** Throws unless this instance holds the shared lock, so that it opens no connection without it. */
  assertMember() {
    if (!this.member) throw new Error('This instance does not hold the database lock, so it does not open connections. It rejoins when the restore finishes.')
  }

  /**
   * Takes the exclusive lock. Returns false when another instance holds the shared lock. Throws PooledLockError when a
   * second session gets the lock while this one holds it exclusively, which means the lock connection is pooled.
   * This instance's own shared lock is on this same session, which does not block its exclusive request.
   * @returns {Promise<boolean>}
   */
  async tryExclusive() {
    this.assertMember()
    const { rows } = await this.client.query('SELECT pg_try_advisory_lock($1) AS ok', [RESTORE_LOCK_KEY])
    if (!rows[0].ok) return false
    this.exclusive = true
    if (await this.otherSessionGotLock('shared')) {
      await this.releaseExclusive()
      throw new PooledLockError()
    }
    return true
  }

  /** Throws when the exclusive lock is not held, for example after the membership session dropped. */
  assertExclusive() {
    if (!this.exclusive || !this.member) throw new Error('The database restore lock was lost during the restore. Check the database before using it.')
  }

  /** Releases the exclusive lock and keeps the shared one. */
  async releaseExclusive() {
    if (!this.exclusive) return
    this.exclusive = false
    if (this.client) await this.client.query('SELECT pg_advisory_unlock($1)', [RESTORE_LOCK_KEY])
  }

  /**
   * Counts the sessions on this database other than the membership session. Counts every role's sessions, with no
   * dependence on application_name or backend_type, which Postgres hides from an ordinary role. Call it after this
   * instance's pool is closed, so that its own connections are not left in the count.
   * @returns {Promise<number>}
   */
  async countOtherSessions() {
    this.assertMember()
    const { rows } = await this.client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
    return rows[0].count
  }

  /** Closes the membership session. The lock is released by Postgres. */
  async leave() {
    this.stopped = true
    clearTimeout(this.rejoinTimer)
    this.rejoinTimer = null
    const client = this.client
    this.client = null
    this.member = false
    this.exclusive = false
    if (client) await client.end().catch(() => {})
  }

  /** Called when the membership session fails or closes. Only the current session counts. */
  lost(client, error) {
    if (client !== this.client) return
    this.client = null
    this.member = false
    this.exclusive = false
    if (this.stopped) return
    Logger.error(`[RestoreLock] Lost the database lock session. This instance opens no new connections until it rejoins.`, error)
    this.scheduleRejoin()
  }

  scheduleRejoin() {
    clearTimeout(this.rejoinTimer)
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null
      if (this.stopped) return
      this.connectMembership()
        .then(() => Logger.info(`[RestoreLock] Rejoined the database lock`))
        .catch((error) => {
          Logger.error(`[RestoreLock] Could not rejoin the database lock: ${error.message}`)
          if (!this.stopped) this.scheduleRejoin()
        })
    }, REJOIN_DELAY_MS)
    this.rejoinTimer.unref()
  }
}

module.exports = { RestoreLock, PooledLockError }
