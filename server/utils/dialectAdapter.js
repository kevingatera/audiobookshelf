const { Sequelize } = require('sequelize')

/**
 * The only module that knows how SQLite and Postgres differ.
 *
 * Callers ask the adapter for SQL fragments and never test the dialect themselves.
 * Get the adapter with `dialectFor(sequelize)` or `Database.adapter`.
 *
 * Postgres runs with `quoteIdentifiers: false`, matching the existing fork schema, which was created
 * with unquoted (lower-cased) names. Plain identifiers are therefore left unquoted, so they fold to the
 * same names Sequelize emits. Output aliases must be quoted with `aliasAs()` or Postgres lower-cases them.
 * Names that Sequelize itself quotes (e.g. `series->bookSeries`) are quoted by `column()` too.
 */

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

class SqliteAdapter {
  /** @param {Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize
  }

  get name() {
    return 'sqlite'
  }

  /** Nothing to configure: SQLite already returns numbers for aggregates. */
  configureTypes() {}

  /** True when the database is a single file that can be copied for backups. */
  get fileBased() {
    return true
  }

  /**
   * Qualified column reference for raw SQL.
   * @param {string} alias table or join alias
   * @param {string} column
   */
  column(alias, column) {
    return `\`${alias}\`.\`${column}\``
  }

  /**
   * Identifier for the AS clause of a raw SQL output column.
   * @param {string} name
   */
  aliasAs(name) {
    return name
  }

  /** @param {boolean} value */
  bool(value) {
    return value ? '1' : '0'
  }

  /**
   * Case-insensitive ordering for an expression.
   * @param {string} expression
   */
  noCaseOrder(expression) {
    return `${expression} COLLATE NOCASE`
  }

  /**
   * Index field entry for a Sequelize model `indexes` definition.
   * @param {string} column
   * @returns {string|{name: string, collate: string}}
   */
  indexField(column) {
    return { name: column, collate: 'NOCASE' }
  }

  /**
   * Case-insensitive LIKE. SQLite LIKE is ASCII case-insensitive already.
   * @param {string} expression
   * @param {string} valueSql escaped literal or bind, e.g. ':pattern'
   */
  like(expression, valueSql) {
    return `${expression} LIKE ${valueSql}`
  }

  /**
   * Table function that yields one row per element of a JSON array column, with a `value` column.
   * @param {string} column
   * @param {{objects?: boolean}} [options] objects: values are JSON objects, read them with jsonPathText/jsonElementText
   */
  jsonArrayExpand(column, options = {}) {
    return `json_each(${column})`
  }

  /**
   * Scalar subquery: number of elements of a JSON array column that are in the bound list.
   * @param {string} column
   * @param {string} bindName
   */
  jsonArrayContainsAny(column, bindName) {
    return `(SELECT count(*) FROM json_each(${column}) WHERE json_valid(${column}) AND json_each.value IN (:${bindName}))`
  }

  /**
   * Scalar subquery: number of elements of a JSON array column equal to the bound value.
   * @param {string} column
   * @param {string} bindName
   */
  jsonArrayContainsValue(column, bindName) {
    return `(SELECT count(*) FROM json_each(${column}) WHERE json_valid(${column}) AND json_each.value = :${bindName})`
  }

  /**
   * Length of a JSON array column.
   * @param {string} column
   */
  jsonArrayLength(column) {
    return `json_array_length(${column})`
  }

  /**
   * True when the text column holds valid JSON. Postgres json columns are always valid.
   * @param {string} column
   */
  jsonValid(column) {
    return `json_valid(${column})`
  }

  /**
   * Text value at a JSON path.
   * @param {string} column
   * @param {string|string[]} path e.g. 'duration' or ['metadata', 'filename']
   */
  jsonPathText(column, path) {
    return `json_extract(${column}, '$.${[].concat(path).join('.')}')`
  }

  /**
   * Numeric value at a JSON path.
   * @param {string} column
   * @param {string|string[]} path
   */
  jsonPathNumber(column, path) {
    return this.jsonPathText(column, path)
  }

  /**
   * Text value at a JSON path of a value produced by jsonArrayExpand() with objects: true.
   * @param {string} alias table alias from jsonArrayExpand
   * @param {string|string[]} path
   */
  jsonElementText(alias, path) {
    return `json_extract(${alias}.value, '$.${[].concat(path).join('.')}')`
  }

  /**
   * Text that is safe to cast to a double. Invalid text becomes NULL.
   * @param {string} expression
   */
  safeTextToDouble(expression) {
    return `CAST(${expression} AS FLOAT)`
  }

  /**
   * Text that is safe to cast to an integer. Invalid text becomes NULL.
   * @param {string} expression
   */
  safeTextToInteger(expression) {
    return `CAST(${expression} AS INTEGER)`
  }

  /**
   * Aggregate concatenation of text values.
   * @param {string} expression
   * @param {string} orderBy
   * @param {string} [separator=', ']
   */
  groupConcat(expression, orderBy, separator = ', ') {
    return `GROUP_CONCAT(${expression}, '${separator}' ORDER BY ${orderBy})`
  }

  /** @param {string} name */
  async tableExists(name) {
    return this.sequelize.getQueryInterface().tableExists(name)
  }

  /** True when the database already has at least one table. */
  async hasTables() {
    const tables = await this.sequelize.getQueryInterface().showAllTables()
    return Array.isArray(tables) && tables.length > 0
  }

  /**
   * Lower-cased SQL type of a column, or null when the column does not exist.
   * @param {string} table
   * @param {string} column
   * @returns {Promise<string|null>}
   */
  async columnType(table, column) {
    const columns = await this.sequelize.getQueryInterface().describeTable(table).catch(() => null)
    if (!columns) return null
    const key = Object.keys(columns).find((c) => c === column)
    return key ? String(columns[key].type).toLowerCase() : null
  }

  /**
   * @param {string} table
   * @param {string} name
   */
  async indexExists(table, name) {
    const [row] = await this.sequelize.query(`SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND tbl_name = :table AND name = :name`, {
      replacements: { table, name },
      type: Sequelize.QueryTypes.SELECT
    })
    return !!row
  }

  /**
   * @param {string} table
   * @param {string} name
   */
  async triggerExists(table, name) {
    const [row] = await this.sequelize.query(`SELECT 1 AS found FROM sqlite_master WHERE type = 'trigger' AND tbl_name = :table AND name = :name`, {
      replacements: { table, name },
      type: Sequelize.QueryTypes.SELECT
    })
    return !!row
  }
}

class PostgresAdapter {
  /** @param {Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize
  }

  get name() {
    return 'postgres'
  }

  get fileBased() {
    return false
  }

  column(alias, column) {
    const qualify = (part) => (SIMPLE_IDENTIFIER.test(part) ? part : `"${part}"`)
    return `${qualify(alias)}.${qualify(column)}`
  }

  aliasAs(name) {
    return `"${name}"`
  }

  bool(value) {
    return value ? 'TRUE' : 'FALSE'
  }

  noCaseOrder(expression) {
    return `LOWER(${expression})`
  }

  indexField(column) {
    return column
  }

  like(expression, valueSql) {
    return `${expression} ILIKE ${valueSql}`
  }

  jsonArrayExpand(column, options = {}) {
    const fn = options.objects ? 'jsonb_array_elements' : 'jsonb_array_elements_text'
    return `${fn}(COALESCE(${column}::jsonb, '[]'::jsonb)) AS json_each(value)`
  }

  jsonArrayContainsAny(column, bindName) {
    return `(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(${column}::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value IN (:${bindName}))`
  }

  jsonArrayContainsValue(column, bindName) {
    return `(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(${column}::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value = :${bindName})`
  }

  jsonArrayLength(column) {
    return `jsonb_array_length(COALESCE(${column}::jsonb, '[]'::jsonb))`
  }

  jsonValid() {
    return 'TRUE'
  }

  jsonPathText(column, path) {
    return `(${column}::jsonb #>> '{${[].concat(path).join(',')}}')`
  }

  jsonPathNumber(column, path) {
    return `NULLIF(${this.jsonPathText(column, path)}, '')::double precision`
  }

  jsonElementText(alias, path) {
    return `(${alias}.value::jsonb #>> '{${[].concat(path).join(',')}}')`
  }

  safeTextToDouble(expression) {
    return `CASE WHEN BTRIM(${expression}) ~ '^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)$' THEN BTRIM(${expression})::double precision ELSE NULL END`
  }

  safeTextToInteger(expression) {
    return `CASE WHEN BTRIM(${expression}) ~ '^[+-]?\\d+$' THEN BTRIM(${expression})::integer ELSE NULL END`
  }

  groupConcat(expression, orderBy, separator = ', ') {
    return `string_agg(${expression}, '${separator}' ORDER BY ${orderBy})`
  }

  /**
   * COUNT and SUM return int8 and numeric, which the pg driver hands back as strings. SQLite returns numbers.
   * Call after authenticate(): Sequelize rebuilds its per-connection parser map while connecting.
   */
  configureTypes() {
    const toNumber = (value) => (value === null ? null : Number(value))
    this.sequelize.connectionManager.oidParserMap.set(20, toNumber)
    this.sequelize.connectionManager.oidParserMap.set(1700, toNumber)
  }

  /** True when the public schema has at least one table. */
  async hasTables() {
    const [row] = await this.sequelize.query(`SELECT 1 AS found FROM information_schema.tables WHERE table_schema = current_schema() LIMIT 1`, { type: Sequelize.QueryTypes.SELECT })
    return !!row
  }

  /**
   * Physical names are lower-case, so match case-insensitively with bound values.
   * @param {string} name
   */
  async tableExists(name) {
    const [row] = await this.sequelize.query(`SELECT 1 AS found FROM information_schema.tables WHERE table_schema = current_schema() AND lower(table_name) = lower(:name)`, {
      replacements: { name },
      type: Sequelize.QueryTypes.SELECT
    })
    return !!row
  }

  async columnType(table, column) {
    const [row] = await this.sequelize.query(
      `SELECT data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND lower(table_name) = lower(:table) AND lower(column_name) = lower(:column)`,
      { replacements: { table, column }, type: Sequelize.QueryTypes.SELECT }
    )
    return row ? String(row.type).toLowerCase() : null
  }

  async indexExists(table, name) {
    const [row] = await this.sequelize.query(`SELECT 1 AS found FROM pg_indexes WHERE schemaname = current_schema() AND lower(tablename) = lower(:table) AND lower(indexname) = lower(:name)`, {
      replacements: { table, name },
      type: Sequelize.QueryTypes.SELECT
    })
    return !!row
  }

  async triggerExists(table, name) {
    const [row] = await this.sequelize.query(
      `SELECT 1 AS found FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema() AND lower(c.relname) = lower(:table) AND t.tgname = lower(:name)`,
      { replacements: { table, name }, type: Sequelize.QueryTypes.SELECT }
    )
    return !!row
  }
}

const adapters = new WeakMap()

/**
 * Adapter for a Sequelize instance. Cached per instance.
 * @param {Sequelize} sequelize
 * @returns {SqliteAdapter|PostgresAdapter}
 */
function dialectFor(sequelize) {
  if (!sequelize) throw new Error('dialectFor requires a Sequelize instance')
  let adapter = adapters.get(sequelize)
  if (!adapter) {
    adapter = sequelize.getDialect() === 'postgres' ? new PostgresAdapter(sequelize) : new SqliteAdapter(sequelize)
    adapters.set(sequelize, adapter)
  }
  return adapter
}

/**
 * Chooses the dialect from the environment. DB_DIALECT wins, then a postgres:// DATABASE_URL, else SQLite.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {'sqlite'|'postgres'}
 */
function resolveDialect(env = process.env) {
  const explicit = env.DB_DIALECT?.trim().toLowerCase()
  if (explicit === 'postgres' || explicit === 'sqlite') return explicit
  const url = env.DATABASE_URL || ''
  return url.startsWith('postgres://') || url.startsWith('postgresql://') ? 'postgres' : 'sqlite'
}

/**
 * Creates the Sequelize instance for a dialect. The only place that sets dialect connection options.
 * @param {object} options
 * @param {'sqlite'|'postgres'} options.dialect
 * @param {string} [options.storage] SQLite file path
 * @param {string} [options.databaseUrl] Postgres connection URL
 * @param {Function|boolean} [options.logging]
 * @param {boolean} [options.benchmark]
 * @returns {Sequelize}
 */
function createSequelize({ dialect, storage, databaseUrl, logging = false, benchmark = false }) {
  if (dialect === 'postgres') {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for the postgres dialect')
    return new Sequelize(databaseUrl, { dialect: 'postgres', logging, benchmark, quoteIdentifiers: false })
  }
  return new Sequelize({ dialect: 'sqlite', storage, logging, benchmark, transactionType: 'IMMEDIATE' })
}

module.exports = { dialectFor, resolveDialect, createSequelize, SqliteAdapter, PostgresAdapter }
