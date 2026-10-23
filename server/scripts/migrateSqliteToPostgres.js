/**
 * Copies a SQLite library into an empty Postgres database.
 *
 *   DATABASE_URL=postgres://... node server/scripts/migrateSqliteToPostgres.js --source /path/absdatabase.sqlite [--dry-run] [--replace]
 *
 * - Tables and columns come from the Sequelize models, not from a hand-written list.
 * - The source must be at the same server version, so run the SQLite server once to upgrade it first.
 * - A non-empty target is refused unless --replace is given. --replace truncates every model table in the same transaction.
 * - Foreign keys stay enabled. Tables are copied in dependency order.
 * - Row counts and per-table checksums are compared inside the transaction. Any mismatch rolls everything back.
 * - Stop the SQLite server before running this, so the source does not change during the copy.
 */
const path = require('path')
const crypto = require('crypto')
const sqlite3 = require('sqlite3')
const fs = require('fs')

const packageJson = require('../../package.json')
const Database = require('../Database')
const Logger = require('../Logger')
const { createSequelize } = require('../utils/dialectAdapter')

const BATCH_SIZE = 500
// Column names that must be quoted in SQL. PlaylistMediaItem.order is one of them.
const RESERVED_COLUMNS = new Set(['order'])

/** SQL identifier for a physical column. Reserved names are quoted in lower case, which is how they are stored. */
function columnSql(name) {
  return RESERVED_COLUMNS.has(name.toLowerCase()) ? `"${name.toLowerCase()}"` : name
}
const SOURCE_ONLY_TABLES = new Set(['migrationsMeta', 'SequelizeMeta'])

function openSource(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(db)))
  })
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))))
}

/** Columns and their Sequelize types for one model, keyed by physical column name. */
function modelColumns(model) {
  const columns = {}
  for (const [attr, def] of Object.entries(model.rawAttributes)) {
    columns[def.field || attr] = { attr, key: def.type?.key || def.type?.constructor?.key || '' }
  }
  return columns
}

/** Tables ordered so that every referenced table is copied first. */
function dependencyOrder(models) {
  const byTable = new Map(models.map((m) => [m.getTableName().tableName || m.getTableName(), m]))
  const order = []
  const state = new Map()
  const visit = (table) => {
    if (state.get(table) === 'done') return
    if (state.get(table) === 'active') throw new Error(`Foreign key cycle through table ${table}`)
    state.set(table, 'active')
    const model = byTable.get(table)
    for (const def of Object.values(model.rawAttributes)) {
      const ref = def.references?.model
      const refTable = typeof ref === 'string' ? ref : ref?.tableName
      if (refTable && refTable !== table && byTable.has(refTable)) visit(refTable)
    }
    state.set(table, 'done')
    order.push(model)
  }
  for (const table of byTable.keys()) visit(table)
  return order
}

/** Converts a SQLite value to the value Postgres expects for the column type. */
function toPostgresValue(value, key) {
  if (value === null || value === undefined) return null
  if (key === 'BOOLEAN') return !!value
  return value
}

/** Canonical form of a row, used for checksums. SQLite and Postgres return different types for the same data. */
function canonicalValue(value, key) {
  if (value === null || value === undefined) return null
  if (key === 'BOOLEAN') return value === true || value === 1 || value === '1' ? 1 : 0
  if (key === 'DATE' || key === 'DATEONLY') {
    if (value instanceof Date) return value.getTime()
    const parsed = Date.parse(String(value).replace(' +00:00', 'Z').replace(' ', 'T'))
    return Number.isNaN(parsed) ? String(value) : parsed
  }
  if (key === 'JSON' || key === 'JSONB') {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return JSON.stringify(parsed, Object.keys(parsed || {}).sort())
  }
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value)
  return String(value)
}

/** One canonical line per row. */
function canonicalLines(rows, columns) {
  const names = Object.keys(columns).sort()
  return rows.map((row) => JSON.stringify(names.map((name) => canonicalValue(row[name], columns[name].key)))).sort()
}

function digest(rows, columns) {
  return crypto.createHash('sha256').update(canonicalLines(rows, columns).join('\n')).digest('hex')
}

async function migrate({ sourcePath, databaseUrl, dryRun = false, replace = false }) {
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be a postgres:// URL')
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database not found: ${sourcePath}`)

  const source = await openSource(sourcePath)
  const sourceVersionRows = await all(source, `SELECT value FROM migrationsMeta WHERE key = 'version'`).catch(() => [])
  const sourceVersion = sourceVersionRows[0]?.value
  if (sourceVersion !== packageJson.version) {
    throw new Error(`Source is at version ${sourceVersion || 'unknown'}, expected ${packageJson.version}. Start the SQLite server once to upgrade it, then stop it and retry.`)
  }

  Database.dialect = 'postgres'
  Database.sequelize = createSequelize({ dialect: 'postgres', databaseUrl })
  await Database.sequelize.authenticate()
  Database.adapter.configureTypes()
  // A fresh target gets its schema from the models. Schema creation is not transactional, so an existing
  // target must already have every model table; sync is skipped for it.
  Database.isNew = !(await Database.adapter.hasTables())
  await Database.buildModels(false)
  const sequelize = Database.sequelize
  const models = Object.values(sequelize.models)
  const order = dependencyOrder(models)
  for (const model of order) {
    const table = model.getTableName().tableName || model.getTableName()
    if (!(await Database.adapter.tableExists(table))) throw new Error(`Target schema is incomplete: table ${table} is missing`)
  }

  // Schema check: every source column is explained by a model attribute, and every model column is in the source.
  const sourceTables = (await all(source, `SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name)
  const modelTables = new Set(order.map((m) => m.getTableName().tableName || m.getTableName()))
  // sqlite_* tables are SQLite's own bookkeeping (ANALYZE writes sqlite_stat1), not library data
  const unexplained = sourceTables.filter((t) => !modelTables.has(t) && !SOURCE_ONLY_TABLES.has(t) && !t.startsWith('sqlite_'))
  if (unexplained.length) throw new Error(`Source tables with no model: ${unexplained.join(', ')}`)
  const problems = []
  for (const model of order) {
    const table = model.getTableName().tableName || model.getTableName()
    const cols = modelColumns(model)
    const sourceCols = (await all(source, `PRAGMA table_info(\`${table}\`)`)).map((c) => c.name)
    if (!sourceCols.length) problems.push(`${table}: missing in source`)
    for (const c of sourceCols) if (!cols[c]) problems.push(`${table}.${c}: source column has no model attribute`)
    for (const c of Object.keys(cols)) if (!sourceCols.includes(c)) problems.push(`${table}.${c}: model column missing in source`)
  }
  if (problems.length) throw new Error(`Schema mismatch:\n  ${problems.join('\n  ')}`)

  // Target must be empty unless --replace is given.
  let populated = []
  for (const model of order) {
    const table = model.getTableName().tableName || model.getTableName()
    const [{ n }] = await sequelize.query(`SELECT count(*) AS n FROM ${table}`, { type: 'SELECT' })
    if (Number(n) > 0) populated.push(table)
  }
  if (populated.length && !replace) {
    throw new Error(`Target is not empty (${populated.join(', ')}). Pass --replace to truncate every model table first.`)
  }

  const transaction = await sequelize.transaction()
  const report = { tables: {}, dryRun, replaced: replace }
  try {
    if (replace) {
      const tableList = order.map((m) => m.getTableName().tableName || m.getTableName()).join(', ')
      await sequelize.query(`TRUNCATE ${tableList}`, { transaction })
    }

    // Copy. Read the source inside one read transaction so every table is a consistent snapshot.
    await all(source, 'BEGIN')
    try {
      for (const model of order) {
        const table = model.getTableName().tableName || model.getTableName()
        const cols = modelColumns(model)
        let offset = 0
        for (;;) {
          const rows = await all(source, `SELECT * FROM \`${table}\` ORDER BY rowid LIMIT ${BATCH_SIZE} OFFSET ${offset}`)
          if (!rows.length) break
          const names = Object.keys(cols)
          const replacements = {}
          const valuesSql = rows.map((row, r) => {
            const placeholders = names.map((name, c) => {
              const key = `v${r}_${c}`
              replacements[key] = toPostgresValue(row[name], cols[name].key)
              return `:${key}`
            })
            return `(${placeholders.join(', ')})`
          })
          await sequelize.query(`INSERT INTO ${table} (${names.map(columnSql).join(', ')}) VALUES ${valuesSql.join(', ')}`, { replacements, transaction })
          offset += rows.length
        }
        report.tables[table] = { copied: offset }
      }

      // Validate before commit: counts and canonical checksums of every table.
      for (const model of order) {
        const table = model.getTableName().tableName || model.getTableName()
        const cols = modelColumns(model)
        const sourceRows = await all(source, `SELECT * FROM \`${table}\` ORDER BY rowid`)
        // Postgres folds unquoted output names to lower case. Quote each alias so the keys match the source rows.
        const selectList = Object.keys(cols).map((c) => `${columnSql(c)} AS ${Database.adapter.aliasAs(c)}`).join(', ')
        const targetRows = await sequelize.query(`SELECT ${selectList} FROM ${table}`, { type: 'SELECT', transaction })
        const sourceSubset = sourceRows.map((r) => Object.fromEntries(Object.keys(cols).map((c) => [c, r[c]])))
        if (sourceSubset.length !== targetRows.length) throw new Error(`Row count mismatch for ${table}: source ${sourceSubset.length}, target ${targetRows.length}`)
        const sourceDigest = digest(sourceSubset, cols)
        const targetDigest = digest(targetRows, cols)
        if (sourceDigest !== targetDigest) {
          const sourceLines = canonicalLines(sourceSubset, cols)
          const targetLines = canonicalLines(targetRows, cols)
          const i = sourceLines.findIndex((line, idx) => line !== targetLines[idx])
          throw new Error(`Checksum mismatch for ${table} at sorted row ${i}:\n  source ${sourceLines[i]}\n  target ${targetLines[i]}`)
        }
        report.tables[table] = { rows: targetRows.length, checksum: targetDigest.slice(0, 16) }
      }
    } finally {
      await all(source, 'COMMIT').catch(() => {})
    }

    // Migration bookkeeping for the copied data. The server boots with no pending migrations.
    await sequelize.query(`CREATE TABLE IF NOT EXISTS migrationsMeta (key varchar(255) NOT NULL, value varchar(255) NOT NULL)`, { transaction })
    await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS migrationsMeta_key_unique ON migrationsMeta (key)`, { transaction })
    await sequelize.query(`INSERT INTO migrationsMeta (key, value) VALUES ('version', :v), ('maxVersion', :v) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, {
      replacements: { v: sourceVersion },
      transaction
    })

    if (dryRun) {
      await transaction.rollback()
      report.committed = false
    } else {
      await transaction.commit()
      report.committed = true
    }
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    source.close()
    await sequelize.close()
  }
  return report
}

module.exports = { migrate, dependencyOrder, canonicalValue }

if (require.main === module) {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : null
  }
  const sourcePath = value('--source') ? path.resolve(value('--source')) : null
  if (!sourcePath) {
    console.error('Usage: DATABASE_URL=postgres://... node server/scripts/migrateSqliteToPostgres.js --source <absdatabase.sqlite> [--dry-run] [--replace]')
    process.exit(2)
  }
  migrate({ sourcePath, databaseUrl: process.env.DATABASE_URL, dryRun: args.includes('--dry-run'), replace: args.includes('--replace') })
    .then((report) => {
      console.log(`REPORT ${JSON.stringify(report)}`)
      process.exit(0)
    })
    .catch((error) => {
      console.error(`[migrateSqliteToPostgres] ${error.message}`)
      process.exit(1)
    })
}
