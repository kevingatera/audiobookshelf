const { expect } = require('chai')
const { randomUUID } = require('crypto')
const path = require('path')
const os = require('os')
const fs = require('fs')

// Runs only when ABS_TEST_POSTGRES_URL points at a disposable database. It creates the schema, seeds a small
// library and checks the dialect-sensitive queries. Never point it at a real library database.
const POSTGRES_URL = process.env.ABS_TEST_POSTGRES_URL

describe('Postgres query smoke', function () {
  this.timeout(120000)
  let Database
  let savedEnv
  let savedConfigPath
  let savedMetadataPath
  let savedServerSettings

  before(async function () {
    if (!POSTGRES_URL) return this.skip()
    savedEnv = { DB_DIALECT: process.env.DB_DIALECT, DATABASE_URL: process.env.DATABASE_URL }
    savedConfigPath = global.ConfigPath
    savedMetadataPath = global.MetadataPath
    savedServerSettings = global.ServerSettings
    process.env.DB_DIALECT = 'postgres'
    process.env.DATABASE_URL = POSTGRES_URL
    global.ConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-pg-test-'))
    global.MetadataPath = global.ConfigPath
    global.ServerSettings = { sortingIgnorePrefix: false }
    Database = require('../../../server/Database')
    await Database.init(true)
  })

  after(async function () {
    if (!POSTGRES_URL || !Database?.sequelize) return
    await Database.disconnect()
    process.env.DB_DIALECT = savedEnv.DB_DIALECT
    process.env.DATABASE_URL = savedEnv.DATABASE_URL
    global.ConfigPath = savedConfigPath
    global.MetadataPath = savedMetadataPath
    global.ServerSettings = savedServerSettings
  })

  async function seed() {
    const M = Database.models
    const libraryId = randomUUID()
    const folderId = randomUUID()
    await M.library.create({ id: libraryId, name: 'Books', displayOrder: 1, mediaType: 'book', settings: {}, extraData: {} })
    await M.libraryFolder.create({ id: folderId, path: '/tmp/books', libraryId })
    const author = await M.author.create({ id: randomUUID(), name: 'Jane Doe', lastFirst: 'Doe, Jane', libraryId })
    const series = await M.series.create({ id: randomUUID(), name: 'Saga', nameIgnorePrefix: 'Saga', libraryId })
    for (let i = 0; i < 3; i++) {
      const bookId = randomUUID()
      const libraryItemId = randomUUID()
      const audioFile = { ino: `${i}1`, duration: 60 + i, metadata: { filename: 'a.m4b', ext: '.m4b', path: '/tmp/x', size: 1000 + i } }
      await M.book.create({ id: bookId, title: `Book ${i}`, titleIgnorePrefix: `Book ${i}`, publishedYear: String(2000 + i), tags: ['fantasy'], genres: ['Sci-Fi'], narrators: ['Ann'], audioFiles: [audioFile], duration: 60 + i })
      await M.libraryItem.create({ id: libraryItemId, ino: `li${i}`, path: `/tmp/books/b${i}`, relPath: `b${i}`, mediaId: bookId, mediaType: 'book', libraryId, libraryFolderId: folderId, title: `Book ${i}`, titleIgnorePrefix: `Book ${i}`, authorNamesFirstLast: 'Jane Doe', authorNamesLastFirst: 'Doe, Jane', size: 1000 + i, isFile: false, isMissing: false, isInvalid: false, libraryFiles: [] })
      await M.bookAuthor.create({ bookId, authorId: author.id })
      await M.bookSeries.create({ bookId, seriesId: series.id, sequence: String(i + 1) })
    }
    const podId = randomUUID()
    const podItemId = randomUUID()
    await M.podcast.create({ id: podId, title: 'Pod', titleIgnorePrefix: 'Pod', author: 'Podcaster', tags: ['tech'], genres: ['News'], feedURL: 'http://x/feed', libraryItemId: podItemId, explicit: false })
    await M.libraryItem.create({ id: podItemId, ino: 'pod1', path: '/tmp/books/pod', relPath: 'pod', mediaId: podId, mediaType: 'podcast', libraryId, libraryFolderId: folderId, title: 'Pod', titleIgnorePrefix: 'Pod', size: 555, isFile: false, isMissing: false, isInvalid: false, libraryFiles: [] })
    for (let e = 0; e < 2; e++) {
      await M.podcastEpisode.create({ id: randomUUID(), index: e + 1, title: `Ep ${e}`, audioFile: { ino: `e${e}`, duration: 100 + e }, podcastId: podId, publishedAt: new Date(), enclosureURL: 'http://x/e', guid: `g${e}`, duration: 100 + e })
    }
    return { libraryId }
  }

  it('boots a fresh postgres schema with the dialect adapter', function () {
    expect(Database.dialect).to.equal('postgres')
    expect(Database.adapter.name).to.equal('postgres')
    expect(Database.isNew).to.equal(true)
  })

  it('returns podcast library stats with camelCase keys and numeric values', async function () {
    const { libraryId } = await seed()
    const stats = await require('../../../server/utils/queries/libraryItemsPodcastFilters').getPodcastLibraryStats(libraryId)
    expect(stats).to.deep.equal({ totalDuration: 201, numAudioFiles: 2, totalItems: 1, totalSize: 555 })
  })

  it('filters and counts book library items', async function () {
    const { libraryId } = await seed()
    const user = { id: 'u1', permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }
    const books = require('../../../server/utils/queries/libraryItemsBookFilters')
    const result = await books.getFilteredLibraryItems(libraryId, user, 'genres', 'Sci-Fi', 'media.metadata.title', false, false, [], 10, 0)
    expect(result.libraryItems).to.have.length(3)
    const bookStats = await books.getBookLibraryStats(libraryId)
    expect(bookStats.totalItems).to.equal(3)
    expect(bookStats.totalDuration).to.equal(183)
  })

  it('sorts series by an aliased subquery and returns its total duration', async function () {
    const { libraryId } = await seed()
    const user = { id: 'u1', permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }
    const library = { id: libraryId, mediaType: 'book', settings: { hideSingleBookSeries: false, onlyShowLaterBooksInContinueSeries: false, collapseSeries: false } }
    const seriesFilters = require('../../../server/utils/queries/seriesFilters')
    const byBooks = await seriesFilters.getFilteredSeries(library, user, 'all', 'numBooks', true, [], 10, 0)
    expect(byBooks.series).to.have.length(1)
    const byDuration = await seriesFilters.getFilteredSeries(library, user, 'all', 'totalDuration', true, [], 10, 0)
    expect(byDuration.series[0].totalDuration).to.equal(183)
  })

  it('searches books and podcasts', async function () {
    const { libraryId } = await seed()
    const user = { id: 'u1', permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }
    const books = await require('../../../server/utils/queries/libraryItemsBookFilters').search(user, { id: libraryId, mediaType: 'book', settings: {} }, 'book', 10, 0)
    expect(books.book.length).to.be.greaterThan(0)
    const pods = await require('../../../server/utils/queries/libraryItemsPodcastFilters').search(user, { id: libraryId, mediaType: 'podcast', settings: {} }, 'pod', 10, 0)
    expect(pods.podcast.length).to.be.greaterThan(0)
  })
})
