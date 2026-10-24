// Helpers for tests that run against a disposable Postgres database set in ABS_TEST_POSTGRES_URL.
// Never point ABS_TEST_POSTGRES_URL at a real library database: these helpers create and rewrite rows.
const { randomUUID } = require('crypto')
const path = require('path')
const os = require('os')
const fs = require('fs')

const POSTGRES_URL = process.env.ABS_TEST_POSTGRES_URL

function postgresUrl() {
  return POSTGRES_URL
}

/**
 * Points the app at the test database and boots Database.init(force) the way the server does.
 * Returns a restore function that puts the environment and globals back.
 */
async function bootPostgres(Database, force = true) {
  const saved = {
    DB_DIALECT: process.env.DB_DIALECT,
    DATABASE_URL: process.env.DATABASE_URL,
    ConfigPath: global.ConfigPath,
    MetadataPath: global.MetadataPath,
    ServerSettings: global.ServerSettings
  }
  process.env.DB_DIALECT = 'postgres'
  process.env.DATABASE_URL = POSTGRES_URL
  global.ConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-pg-test-'))
  global.MetadataPath = global.ConfigPath
  global.ServerSettings = { sortingIgnorePrefix: false }
  await Database.init(force)
  return async () => {
    if (Database.sequelize) await Database.disconnect()
    process.env.DB_DIALECT = saved.DB_DIALECT
    process.env.DATABASE_URL = saved.DATABASE_URL
    global.ConfigPath = saved.ConfigPath
    global.MetadataPath = saved.MetadataPath
    global.ServerSettings = saved.ServerSettings
  }
}

/**
 * Seeds one book library with three books (one author, one series) and one podcast with two episodes.
 * Returns the ids the tests need.
 */
async function seedLibrary(Database) {
  const M = Database.models
  const libraryId = randomUUID()
  const folderId = randomUUID()
  await M.library.create({ id: libraryId, name: 'Books', displayOrder: 1, mediaType: 'book', settings: {}, extraData: {} })
  await M.libraryFolder.create({ id: folderId, path: '/tmp/books', libraryId })
  const author = await M.author.create({ id: randomUUID(), name: 'Jane Doe', lastFirst: 'Doe, Jane', libraryId })
  const series = await M.series.create({ id: randomUUID(), name: 'Saga', nameIgnorePrefix: 'Saga', libraryId })
  const bookIds = []
  for (let i = 0; i < 3; i++) {
    const bookId = randomUUID()
    const libraryItemId = randomUUID()
    const audioFile = { ino: `${i}1`, duration: 60 + i, metadata: { filename: 'a.m4b', ext: '.m4b', path: '/tmp/x', size: 1000 + i } }
    await M.book.create({ id: bookId, title: `Book ${i}`, titleIgnorePrefix: `Book ${i}`, publishedYear: String(2000 + i), tags: ['fantasy'], genres: ['Sci-Fi'], narrators: ['Ann'], audioFiles: [audioFile], duration: 60 + i, explicit: false })
    await M.libraryItem.create({ id: libraryItemId, ino: `li${i}`, path: `/tmp/books/b${i}`, relPath: `b${i}`, mediaId: bookId, mediaType: 'book', libraryId, libraryFolderId: folderId, title: `Book ${i}`, titleIgnorePrefix: `Book ${i}`, authorNamesFirstLast: 'Jane Doe', authorNamesLastFirst: 'Doe, Jane', size: 1000 + i, isFile: false, isMissing: false, isInvalid: false, libraryFiles: [] })
    await M.bookAuthor.create({ bookId, authorId: author.id })
    await M.bookSeries.create({ bookId, seriesId: series.id, sequence: String(i + 1) })
    bookIds.push(bookId)
  }
  const podId = randomUUID()
  const podItemId = randomUUID()
  await M.podcast.create({ id: podId, title: 'Pod', titleIgnorePrefix: 'Pod', author: 'Podcaster', tags: ['tech'], genres: ['News'], feedURL: 'http://x/feed', libraryItemId: podItemId, explicit: false })
  await M.libraryItem.create({ id: podItemId, ino: 'pod1', path: '/tmp/books/pod', relPath: 'pod', mediaId: podId, mediaType: 'podcast', libraryId, libraryFolderId: folderId, title: 'Pod', titleIgnorePrefix: 'Pod', size: 555, isFile: false, isMissing: false, isInvalid: false, libraryFiles: [] })
  for (let e = 0; e < 2; e++) {
    await M.podcastEpisode.create({ id: randomUUID(), index: e + 1, title: `Ep ${e}`, audioFile: { ino: `e${e}`, duration: 100 + e }, podcastId: podId, publishedAt: new Date(), enclosureURL: 'http://x/e', guid: `g${e}`, duration: 100 + e })
  }
  return { libraryId, folderId, bookIds, authorId: author.id, seriesId: series.id, podId }
}

const user = { id: 'u1', permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }

module.exports = { postgresUrl, bootPostgres, seedLibrary, user }
