const { expect } = require('chai')
const { randomUUID } = require('crypto')
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

  async function bookIndexes() {
    return query("SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = current_schema() AND lower(tablename) = 'books' ORDER BY indexname")
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
    // The deployed fork's author trigger watched only name, before lastFirst was added to it.
    await sequelize.query('DROP TRIGGER IF EXISTS update_library_items_author_names_on_authors_update ON authors')
    await sequelize.query('CREATE TRIGGER update_library_items_author_names_on_authors_update AFTER UPDATE OF name ON authors FOR EACH ROW EXECUTE FUNCTION update_library_items_author_names_on_authors_update_fn()')
    // An old database had a books_title index on duration, so the declared title index needs another name.
    await sequelize.query('DROP INDEX IF EXISTS books_title')
    await sequelize.query('CREATE INDEX books_title ON books (duration)')
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

  it('creates the title index under a free name and keeps the existing books_title index', async function () {
    const indexes = await bookIndexes()
    const titleIndexes = indexes.filter((i) => /\(title\)/i.test(i.def))
    expect(titleIndexes).to.have.length(1)
    expect(titleIndexes[0].name).to.not.equal('books_title')
    const kept = indexes.find((i) => i.name === 'books_title')
    expect(kept.def).to.contain('(duration)')
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

  it('replaces the outdated author trigger so lastFirst-only changes reach libraryItems', async function () {
    const [def] = await query("SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'update_library_items_author_names_on_authors_update'")
    expect(def.def.toLowerCase()).to.contain('lastfirst')
    await Database.sequelize.query("UPDATE authors SET lastFirst = 'Smith, Janet' WHERE id = :id", { replacements: { id: seeded.authorId } })
    const [row] = await query('SELECT authorNamesLastFirst FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[0] })
    expect(row.authornameslastfirst).to.equal('Smith, Janet')
  })

  it('refreshes both the old and the new book when a bookAuthor link moves', async function () {
    const writerId = randomUUID()
    const linkId = randomUUID()
    await Database.sequelize.query("INSERT INTO authors (id, name, lastFirst, libraryId, createdAt, updatedAt) VALUES (:id, 'Moved Writer', 'Writer, Moved', :libraryId, now(), now())", { replacements: { id: writerId, libraryId: seeded.libraryId } })
    await Database.sequelize.query('INSERT INTO bookAuthors (id, bookId, authorId, createdAt) VALUES (:id, :bookId, :authorId, now())', { replacements: { id: linkId, bookId: seeded.bookIds[0], authorId: writerId } })
    const [before] = await query('SELECT authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[0] })
    expect(before.authornamesfirstlast).to.contain('Moved Writer')
    await Database.sequelize.query('UPDATE bookAuthors SET bookId = :to WHERE id = :id', { replacements: { to: seeded.bookIds[1], id: linkId } })
    const [from] = await query('SELECT authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[0] })
    const [to] = await query('SELECT authorNamesFirstLast FROM libraryItems WHERE mediaId = :id', { id: seeded.bookIds[1] })
    expect(from.authornamesfirstlast).to.not.contain('Moved Writer')
    expect(to.authornamesfirstlast).to.contain('Moved Writer')
  })

  it('is idempotent across repeated runs and across a normal boot', async function () {
    const PostgresRepairManager = require('../../../server/managers/PostgresRepairManager')
    const indexesBefore = (await bookIndexes()).map((i) => i.name)
    await new PostgresRepairManager(Database.sequelize).run('before')
    await new PostgresRepairManager(Database.sequelize).run('after')
    expect((await bookIndexes()).map((i) => i.name)).to.deep.equal(indexesBefore)
    const triggers =await query("SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('libraryitems','books','podcasts','bookauthors','authors')")
    expect(Number(triggers[0].n)).to.equal(8)
    await Database.disconnect()
    await Database.init(false)
    const rows = await query('SELECT key, value FROM migrationsMeta ORDER BY key')
    expect(rows).to.have.length(2)
  })
})
