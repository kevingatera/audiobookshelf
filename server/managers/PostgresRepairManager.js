const path = require('path')
const fs = require('fs')
const { Sequelize } = require('sequelize')
const Logger = require('../Logger')
const { dialectFor } = require('../utils/dialectAdapter')

/**
 * Runs the fork's Postgres repair migrations from server/migrations/fork-postgres.
 *
 * Why a separate runner: the released migrations are named by upstream version, and the fork's Postgres
 * schema drifted from them. Repairs use a fork-only `fork-pg-NNNN-*` namespace, so they can never collide
 * with an upstream `vX.Y.Z` migration. Repairs are not gated on the app version. Each one inspects the live
 * schema and changes only what is missing, so running them on every boot is safe and repairs a database
 * that is already at the current version.
 *
 * Phases: 'before' runs before MigrationManager reads its version rows. 'after' runs after the models
 * have created or verified their tables.
 */
class PostgresRepairManager {
  static REPAIRS_DIR = path.join(__dirname, '..', 'migrations', 'fork-postgres')
  static LEDGER_TABLE = 'forkPostgresRepairs'

  /** @param {Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize
    this.adapter = dialectFor(sequelize)
  }

  /** @returns {{id: string, phase: 'before'|'after', description: string, run: Function}[]} */
  static loadRepairs() {
    return fs
      .readdirSync(PostgresRepairManager.REPAIRS_DIR)
      .filter((file) => /^fork-pg-\d{4}-.+\.js$/.test(file))
      .sort()
      .map((file) => {
        const repair = require(path.join(PostgresRepairManager.REPAIRS_DIR, file))
        if (!repair.id || !['before', 'after'].includes(repair.phase) || typeof repair.run !== 'function') {
          throw new Error(`Invalid postgres repair ${file}`)
        }
        return repair
      })
  }

  /**
   * @param {'before'|'after'} phase
   */
  async run(phase) {
    // SQLite schemas are maintained by the released migrations and sqlite-only triggers.
    if (this.adapter.fileBased) return

    for (const repair of PostgresRepairManager.loadRepairs().filter((r) => r.phase === phase)) {
      Logger.debug(`[PostgresRepairManager] Checking ${repair.id}: ${repair.description}`)
      await repair.run({ sequelize: this.sequelize, adapter: this.adapter, logger: Logger })
      await this.recordApplied(repair.id)
    }
  }

  async recordApplied(id) {
    const table = PostgresRepairManager.LEDGER_TABLE
    await this.sequelize.query(`CREATE TABLE IF NOT EXISTS ${table} (id varchar(255) NOT NULL PRIMARY KEY, appliedAt timestamptz NOT NULL DEFAULT now())`)
    await this.sequelize.query(`INSERT INTO ${table} (id) VALUES (:id) ON CONFLICT (id) DO NOTHING`, { replacements: { id } })
  }
}

module.exports = PostgresRepairManager
