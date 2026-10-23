const { Sequelize } = require('sequelize')

/**
 * Creates any model-declared index that is missing. An existing index counts as a match only when it has the
 * same table, the same columns in the same order and the same uniqueness. Index names are not trusted.
 */
module.exports = {
  id: 'fork-pg-0004-model-indexes',
  phase: 'after',
  description: 'model-declared indexes exist with the declared columns',
  async run({ sequelize, adapter, logger }) {
    for (const model of Object.values(sequelize.models)) {
      const table = model.getTableName().tableName || model.getTableName()
      const declared = (model.options.indexes || []).map((index) => ({
        fields: index.fields.map((field) => (typeof field === 'string' ? field : field.name)).map((name) => name.toLowerCase()),
        unique: !!index.unique,
        name: index.name
      }))
      if (!declared.length || !(await adapter.tableExists(table))) continue

      const existing = await sequelize.query(
        `SELECT i.relname AS name, ix.indisunique AS "unique", array_agg(lower(a.attname) ORDER BY k.ord) AS columns
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = current_schema() AND lower(t.relname) = lower(:table) AND ix.indpred IS NULL
         GROUP BY i.relname, ix.indisunique`,
        { replacements: { table }, type: Sequelize.QueryTypes.SELECT }
      )

      for (const index of declared) {
        // Partial indexes need their WHERE clause, which the declaration does not carry in this form. Leave them alone.
        if (model.options.indexes.find((i) => i.name === index.name && i.where)) continue
        const match = existing.some((e) => e.unique === index.unique && e.columns.join(',') === index.fields.join(','))
        if (match) continue
        const name = (index.name || `${table}_${index.fields.join('_')}${index.unique ? '_unique' : ''}`).toLowerCase()
        logger.info(`[fork-pg-0004-model-indexes] Creating index ${name} on ${table} (${index.fields.join(', ')})`)
        await sequelize.getQueryInterface().addIndex(table, index.fields, { name, unique: index.unique })
      }
    }
  }
}
