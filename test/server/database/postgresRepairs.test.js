const { expect } = require('chai')
const { bootPostgres, seedLibrary } = require('./pgFixtures')

// Builds the state an existing fork database has before the repairs ran, then checks the repairs fix it.
describe('Postgres schema repairs', function () {
  this.timeout(120000)
  let Database
  let restore
  let seeded

  async function query(sql, replacements = {}) {
    return Database.sequelize.query(sql, { replacements, type: 'SELECT' })
  }

  async function columnType(table, column) {
    const [row] = await query(`SELECT data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND lower(table_name) = lower(:table) AND lower(column_name) = lower(:column)`, { table, column })
    return row && row.type
  }

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL) return this.skip()
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true)
    seeded = await seedLibrary(Database)

    // Old-shape schema: narrow token columns, integer listening time, duplicate meta rows, no unique key, no triggers, stale titles
    const sequelize = Database.sequelize
    await sequelize.query('ALTER TABLE sessions ALTER COLUMN refreshToken TYPE varchar(255)')
    await sequelize.query('ALTER TABLE sessions ALTER COLUMN lastRefreshToken TYPE varchar(255)')
    await sequelize.query('ALTER TABLE sessions ALTER COLUMN userAgent TYPE varchar(255)')
    await sequelize.query('ALTER TABLE users ALTER COLUMN token TYPE varchar(255)')
    await sequelize.query('ALTER TABLE books ALTER COLUMN subtitle TYPE varchar(255)')
    await sequelize.query('ALTER TABLE playbackSessions ALTER COLUMN timeListening TYPE integer USING round(timeListening)')
    await sequelize.query('DROP INDEX IF EXISTS migrationsMeta_key_unique')
    await sequelize.query("INSERT INTO migrationsMeta (key, value) VALUES ('version', '2.37.0')")
    await sequelize.query('DROP TRIGGER IF EXISTS update_library_items_title ON books')
    await sequelize.query("UPDATE libraryItems SET title = 'stale' WHERE mediaType = 'book'")
    await sequelize.query("UPDATE libraryItems SET authorNamesFirstLast = NULL WHERE mediaType = 'book'")
  })

  after(async function () {
    if (restore) await restore()
  })

  it('widens token columns and the subtitle, and changes timeListening to a float', async function () {
    const PostgresRepairManager = require('../../../server/managers/PostgresRepairManager')
    await new PostgresRepairManager(Database.sequelize).run('before')
    await new PostgresRepairManager(Database.sequelize).run('after')
    expect(await columnType('sessions', 'refreshToken')).to.equal('text')
    expect(await columnType('sessions', 'lastRefreshToken')).to.equal('text')
    expect(await columnType('sessions', 'userAgent')).to.equal('text')
    expect(await columnType('users', 'token')).to.equal('text')
    expect(await columnType('books', 'subtitle')).to.equal('text')
    expect(await columnType('playbackSessions', 'timeListening')).to.equal('double precision')
  })

  it('collapses duplicate meta rows to the highest version and adds the unique key', async function () {
    const rows = await query('SELECT key, value FROM migrationsMeta ORDER BY key')
    expect(rows.map((r) => r.key)).to.deep.equal(['maxVersion', 'version'])
    expect(rows.find((r) => r.key === 'version').value).to.equal('2.37.1')
    const index = await query("SELECT 1 AS found FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'migrationsmeta_key_unique'")
    expect(index).to.have.length(1)
  })

  it('backfills denormalized titles and author names from existing rows', async function () {
    const [row] = await query('SELECT title, authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[0] })
    expect(row.title).to.equal('Book 0')
    expect(row.authornamesfirstlast).to.equal('Jane Doe')
  })

  it('keeps library item titles in sync with book and podcast updates', async function () {
    await Database.sequelize.query("UPDATE books SET title = 'Renamed' WHERE id = :id", { replacements: { id: seeded.bookIds[1] } })
    const [book] = await query('SELECT title FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[1] })
    expect(book.title).to.equal('Renamed')
    await Database.sequelize.query("UPDATE podcasts SET title = 'Pod renamed' WHERE id = :id", { replacements: { id: seeded.podId } })
    const [pod] = await query('SELECT title FROM libraryItems WHERE mediaId = :id', { id: seeded.podId })
    expect(pod.title).to.equal('Pod renamed')
  })

  it('keeps author names in sync on author rename and bookAuthor changes', async function () {
    await Database.sequelize.query("UPDATE authors SET name = 'Janet Doe' WHERE id = :id", { replacements: { id: seeded.authorId } })
    const [row] = await query('SELECT authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[2] })
    expect(row.authornamesfirstlast).to.equal('Janet Doe')
    await Database.sequelize.query('DELETE FROM bookAuthors WHERE bookId = :id', { replacements: { id: seeded.bookIds[2] } })
    const [cleared] = await query('SELECT authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[2] })
    expect(cleared.authornamesfirstlast).to.equal(null)
  })

  it('is idempotent across repeated runs and across a normal boot', async function () {
    const PostgresRepairManager = require('../../../server/managers/PostgresRepairManager')
    await new PostgresRepairManager(Database.sequelize).run('before')
    await new PostgresRepairManager(Database.sequelize).run('after')
    const triggers = await query("SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('libraryitems','books','podcasts','bookauthors','authors')")
    expect(Number(triggers[0].n)).to.equal(8)
    await Database.disconnect()
    await Database.init(false)
    const rows = await query('SELECT key, value FROM migrationsMeta ORDER BY key')
    expect(rows).to.have.length(2)
  })
})
