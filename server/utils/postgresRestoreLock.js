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
 * Advisory locks are scoped to a database. A session that lacks ALTER DATABASE rights can still use them.
 */
const RESTORE_LOCK_KEY = 7210733
const REJOIN_DELAY_MS = 5000

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
   * Opens the membership session and takes the shared lock. Refuses while a restore holds the exclusive lock.
   * Calling it again while joined does nothing.
   * @param {string} databaseUrl
   */
  async join(databaseUrl) {
    this.stopped = false
    this.databaseUrl = databaseUrl
    await this.connectMembership()
  }

  async connectMembership() {
    if (this.member) return
    const client = new Client({ connectionString: withoutApplicationName(this.databaseUrl), application_name: POSTGRES_APPLICATION_NAME })
    client.on('error', (error) => this.lost(client, error))
    client.on('end', () => this.lost(client, new Error('connection closed')))
    await client.connect()
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock_shared($1) AS ok', [RESTORE_LOCK_KEY])
      if (!rows[0].ok) throw new Error('A database restore is in progress. Start this instance after it finishes.')
      if (this.stopped) throw new Error('The database lock was left while joining')
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    this.client = client
    this.member = true
  }

  /** Throws unless this instance holds the shared lock, so that it opens no connection without it. */
  assertMember() {
    if (!this.member) throw new Error('This instance does not hold the database lock, so it does not open connections. It rejoins when the restore finishes.')
  }

  /**
   * Takes the exclusive lock. Returns false when another instance holds the shared lock.
   * This instance's own shared lock is on this same session, which does not block its exclusive request.
   * @returns {Promise<boolean>}
   */
  async tryExclusive() {
    this.assertMember()
    const { rows } = await this.client.query('SELECT pg_try_advisory_lock($1) AS ok', [RESTORE_LOCK_KEY])
    this.exclusive = rows[0].ok
    return rows[0].ok
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

module.exports = { RestoreLock }
