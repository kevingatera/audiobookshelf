// Helpers for tests that run against a disposable Postgres database set in ABS_TEST_POSTGRES_URL.
// Never point ABS_TEST_POSTGRES_URL at a real library database: these helpers create and rewrite rows.
const { randomUUID } = require('crypto')
const path = require('path')
const os = require('os')
const fs = require('fs')
const archiver = require('../../../server/libs/archiver')
const StreamZip = require('../../../server/libs/nodeStreamZip')

const POSTGRES_URL = process.env.ABS_TEST_POSTGRES_URL

function postgresUrl() {
  return POSTGRES_URL
}

/**
 * Points the app at the test database and boots Database.init(force) the way the server does.
 * Returns a restore function that puts the environment and globals back and gives up the restore lock session.
 * @param {object} Database the server/Database singleton
 * @param {boolean} [force=true]
 * @param {string} [url=POSTGRES_URL] DATABASE_URL for the app, e.g. one with an ordinary role
 */
async function bootPostgres(Database, force = true, url = POSTGRES_URL) {
  const saved = {
    DB_DIALECT: process.env.DB_DIALECT,
    DATABASE_URL: process.env.DATABASE_URL,
    ConfigPath: global.ConfigPath,
    MetadataPath: global.MetadataPath,
    ServerSettings: global.ServerSettings
  }
  process.env.DB_DIALECT = 'postgres'
  process.env.DATABASE_URL = url
  global.ConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-pg-test-'))
  global.MetadataPath = global.ConfigPath
  global.ServerSettings = { sortingIgnorePrefix: false }
  await Database.init(force)
  return async () => {
    if (Database.sequelize) await Database.disconnect()
    if (Database.restoreLock) await Database.restoreLock.leave()
    process.env.DB_DIALECT = saved.DB_DIALECT
    process.env.DATABASE_URL = saved.DATABASE_URL
    global.ConfigPath = saved.ConfigPath
    global.MetadataPath = saved.MetadataPath
    global.ServerSettings = saved.ServerSettings
  }
}

const tempDirs = []

/** Removes every directory that writeArchive() created. Call from an after() hook. */
function removeTempDirs() {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true })
}

/**
 * Writes a real zip with the app's archiver, the same way the backup job does: the dump and two metadata folders.
 * @param {string} dumpPath
 * @param {{withDump?: boolean}} [options]
 * @returns {Promise<{zip: object, entries: object}>}
 */
async function writeArchive(dumpPath, { withDump = true } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-pg-archive-'))
  tempDirs.push(workDir)
  const itemsDir = path.join(workDir, 'items')
  const authorsDir = path.join(workDir, 'authors')
  fs.mkdirSync(itemsDir)
  fs.mkdirSync(authorsDir)
  fs.writeFileSync(path.join(itemsDir, 'probe.json'), '{"probe":true}')
  fs.writeFileSync(path.join(authorsDir, 'probe.json'), '{"probe":true}')
  const file = path.join(workDir, 'backup.audiobookshelf')
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file)
    const archive = archiver('zip', { zlib: { level: 1 } })
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    if (withDump) archive.file(dumpPath, { name: 'absdatabase.postgres.dump' })
    archive.directory(itemsDir, 'metadata-items')
    archive.directory(authorsDir, 'metadata-authors')
    archive.finalize()
  })
  const zip = new StreamZip.async({ file })
  return { zip, entries: await zip.entries() }
}

/** Minimal express-like response for calling request handlers directly. */
function fakeRes() {
  return {
    code: null,
    status(code) {
      this.code = code
      return this
    },
    send(message) {
      this.message = message
      return this
    },
    sendStatus(code) {
      this.code = code
      return this
    }
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

module.exports = { postgresUrl, bootPostgres, seedLibrary, user, writeArchive, fakeRes, removeTempDirs }
