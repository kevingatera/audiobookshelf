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
