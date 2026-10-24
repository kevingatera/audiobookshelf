const { expect } = require('chai')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Client } = require('pg')
const { seedLibrary } = require('../database/pgFixtures')

// Round trip: a seeded SQLite library is copied into a fresh Postgres database by the importer CLI.
// Needs ABS_TEST_POSTGRES_URL. The test creates and drops its own database on that server.
const SCRIPT = path.join(__dirname, '..', '..', '..', 'server', 'scripts', 'migrateSqliteToPostgres.js')

function serverUrl(dbName) {
  const url = new URL(process.env.ABS_TEST_POSTGRES_URL)
  url.pathname = `/${dbName}`
  return url.toString()
}

async function adminQuery(sql) {
  const client = new Client({ connectionString: serverUrl('postgres') })
  await client.connect()
  try {
    return await client.query(sql)
  } finally {
    await client.end()
  }
}

function runImporter(sourcePath, databaseUrl, extraArgs = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--source', sourcePath, ...extraArgs], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('migrateSqliteToPostgres', function () {
  this.timeout(180000)
  const dbName = `abs_import_test_${process.pid}_${Date.now()}`
  let sourcePath
  let databaseUrl
  let restoreEnv

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL) return this.skip()
    // Build the source with the SQLite dialect of the same app.
    const Database = require('../../../server/Database')
    const savedEnv = { DB_DIALECT: process.env.DB_DIALECT, DATABASE_URL: process.env.DATABASE_URL }
    const savedConfigPath = global.ConfigPath
    const savedMetadataPath = global.MetadataPath
    const savedServerSettings = global.ServerSettings
    const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-import-src-'))
    process.env.DB_DIALECT = 'sqlite'
    delete process.env.DATABASE_URL
    global.ConfigPath = configPath
    global.MetadataPath = configPath
    global.ServerSettings = { sortingIgnorePrefix: false }
    await Database.init(true)
    await seedLibrary(Database)
    await Database.disconnect()
    sourcePath = path.join(configPath, 'absdatabase.sqlite')
    restoreEnv = () => {
      process.env.DB_DIALECT = savedEnv.DB_DIALECT
      if (savedEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = savedEnv.DATABASE_URL
      global.ConfigPath = savedConfigPath
      global.MetadataPath = savedMetadataPath
      global.ServerSettings = savedServerSettings
    }

    await adminQuery(`CREATE DATABASE ${dbName}`)
    databaseUrl = serverUrl(dbName)
  })

  after(async function () {
    if (restoreEnv) restoreEnv()
    if (process.env.ABS_TEST_POSTGRES_URL) await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {})
  })

  async function count(table) {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      return Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)
    } finally {
      await client.end()
    }
  }

  it('copies every model table into an empty database and validates the copy', async function () {
    const dry = runImporter(sourcePath, databaseUrl, ['--dry-run'])
    expect(dry.status, dry.stderr).to.equal(0)
    expect(await count('libraryitems')).to.equal(0) // dry run rolls back

    const result = runImporter(sourcePath, databaseUrl)
    expect(result.status, result.stderr).to.equal(0)
    const line = result.stdout.split('\n').find((l) => l.startsWith('REPORT '))
    const report = JSON.parse(line.slice('REPORT '.length))
    expect(report.committed).to.equal(true)
    expect(report.tables.libraryItems.rows).to.equal(4)
    expect(report.tables.books.rows).to.equal(3)
    expect(await count('libraryitems')).to.equal(4)
    expect(await count('books')).to.equal(3)
  })

  it('refuses a populated target unless --replace is given', async function () {
    const refused = runImporter(sourcePath, databaseUrl)
    expect(refused.status).to.equal(1)
    expect(refused.stderr).to.contain('not empty')

    const replaced = runImporter(sourcePath, databaseUrl, ['--replace'])
    expect(replaced.status, replaced.stderr).to.equal(0)
    expect(await count('libraryitems')).to.equal(4)
  })
})

describe('migrateSqliteToPostgres checksums', function () {
  const { canonicalValue, compareOrdered } = require('../../../server/scripts/migrateSqliteToPostgres')
  const columns = { id: { key: 'UUID' }, audioFiles: { key: 'JSON' } }

  // Rows are plain objects ordered by id, served in batches the way the importer pages them.
  function pager(rows, size) {
    return async (after) => rows.filter((r) => after === null || r.id > after).slice(0, size)
  }
  const rowsWith = (nestedSize) => [1, 2, 3, 4, 5].map((n) => ({ id: `id-${n}`, audioFiles: JSON.stringify([{ ino: `${n}`, metadata: { filename: 'a.m4b', size: n === 3 ? nestedSize : n } }]) }))

  it('keeps nested JSON fields in the checksum and ignores nested key order', function () {
    const a = canonicalValue('[{"metadata":{"size":1,"filename":"a"}}]', 'JSON')
    const reordered = canonicalValue('[{"metadata":{"filename":"a","size":1}}]', 'JSON')
    const corrupted = canonicalValue('[{"metadata":{"size":2,"filename":"a"}}]', 'JSON')
    expect(reordered).to.equal(a)
    expect(corrupted).to.not.equal(a)
  })

  it('compares rows across batch boundaries', async function () {
    const rows = rowsWith(3)
    const result = await compareOrdered({ label: 't', key: 'id', columns, fetchSource: pager(rows, 2), fetchTarget: pager(rows, 2) })
    expect(result.rows).to.equal(5)
  })

  it('rejects a nested field that differs before anything is committed', async function () {
    const source = rowsWith(3)
    const target = rowsWith(4)
    let error = null
    try {
      await compareOrdered({ label: 't', key: 'id', columns, fetchSource: pager(source, 2), fetchTarget: pager(target, 2) })
    } catch (e) {
      error = e
    }
    expect(error?.message).to.match(/Checksum mismatch for t at id id-3/)
  })

  it('rejects a missing target row', async function () {
    const source = rowsWith(3)
    const target = source.filter((r) => r.id !== 'id-2')
    let error = null
    try {
      await compareOrdered({ label: 't', key: 'id', columns, fetchSource: pager(source, 2), fetchTarget: pager(target, 2) })
    } catch (e) {
      error = e
    }
    expect(error?.message).to.match(/Row mismatch for t/)
  })
})
