const semver = require('semver')
const { Sequelize } = require('sequelize')

const TABLE = 'migrationsMeta'
const INDEX = 'migrationsMeta_key_unique'

/**
 * Collapses duplicate migrationsMeta rows and enforces one row per key.
 * Duplicates came from boots that failed to see the table. Keep the highest semver value per key.
 */
module.exports = {
  id: 'fork-pg-0001-migrations-meta-key',
  phase: 'before',
  description: 'one migrationsMeta row per key',
  async run({ sequelize, adapter, logger }) {
    if (!(await adapter.tableExists(TABLE))) return // a new database creates the table itself

    const rows = await sequelize.query(`SELECT key, value FROM ${TABLE}`, { type: Sequelize.QueryTypes.SELECT })
    const valuesByKey = new Map()
    for (const row of rows) valuesByKey.set(row.key, [...(valuesByKey.get(row.key) || []), row.value])
    const duplicates = [...valuesByKey.entries()].filter(([, values]) => values.length > 1)

    if (duplicates.length) {
      logger.warn(`[${module.exports.id}] Collapsing duplicate ${TABLE} rows for keys: ${duplicates.map(([key]) => key).join(', ')}`)
      await sequelize.transaction(async (transaction) => {
        for (const [key, values] of duplicates) {
          const highest = values.reduce((best, value) => (semver.valid(value) && (!semver.valid(best) || semver.gt(value, best)) ? value : best))
          await sequelize.query(`DELETE FROM ${TABLE} WHERE key = :key`, { replacements: { key }, transaction })
          await sequelize.query(`INSERT INTO ${TABLE} (key, value) VALUES (:key, :value)`, { replacements: { key, value: highest }, transaction })
        }
      })
    }

    if (!(await adapter.indexExists(TABLE, INDEX))) {
      logger.info(`[${module.exports.id}] Creating unique index ${INDEX}`)
      await sequelize.query(`CREATE UNIQUE INDEX ${INDEX} ON ${TABLE} (key)`)
    }
  }
}
