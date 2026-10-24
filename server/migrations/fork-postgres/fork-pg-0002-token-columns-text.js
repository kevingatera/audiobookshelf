/**
 * Token and user-agent columns must be TEXT. Postgres enforces varchar(255), and JWTs exceed it.
 * The widening is a type change only, so existing values are kept as they are.
 */
const COLUMNS = [
  ['sessions', 'refreshToken'],
  ['sessions', 'lastRefreshToken'],
  ['sessions', 'userAgent'],
  ['users', 'token']
]

module.exports = {
  id: 'fork-pg-0002-token-columns-text',
  phase: 'after',
  description: 'token and user-agent columns are text',
  async run({ sequelize, adapter, logger }) {
    for (const [table, column] of COLUMNS) {
      if (!(await adapter.tableExists(table))) continue
      const type = await adapter.columnType(table, column)
      if (!type) {
        logger.warn(`[fork-pg-0002-token-columns-text] Column ${table}.${column} does not exist, skipping`)
        continue
      }
      if (type === 'text') continue
      logger.info(`[fork-pg-0002-token-columns-text] Widening ${table}.${column} from ${type} to text`)
      await sequelize.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE text`)
    }
  }
}
