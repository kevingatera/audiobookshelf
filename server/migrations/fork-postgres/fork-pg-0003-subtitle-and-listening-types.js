/**
 * Book.subtitle is TEXT and PlaybackSession.timeListening is a float, matching the models.
 * Integer listening time was truncating fractional seconds. Converting an integer to double precision keeps every value.
 */
module.exports = {
  id: 'fork-pg-0003-subtitle-and-listening-types',
  phase: 'after',
  description: 'subtitle is text and timeListening is a float',
  async run({ sequelize, adapter, logger }) {
    const changes = [
      ['books', 'subtitle', 'text', 'ALTER COLUMN subtitle TYPE text'],
      ['playbackSessions', 'timeListening', 'double precision', 'ALTER COLUMN timeListening TYPE double precision USING timeListening::double precision']
    ]
    for (const [table, column, target, alter] of changes) {
      if (!(await adapter.tableExists(table))) continue
      const type = await adapter.columnType(table, column)
      if (!type || type === target) continue
      logger.info(`[fork-pg-0003-subtitle-and-listening-types] Changing ${table}.${column} from ${type} to ${target}`)
      await sequelize.query(`ALTER TABLE ${table} ${alter}`)
    }
  }
}
