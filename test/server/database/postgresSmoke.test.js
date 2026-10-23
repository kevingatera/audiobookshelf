const { expect } = require('chai')
const { bootPostgres, seedLibrary, user } = require('./pgFixtures')

// Runs only when ABS_TEST_POSTGRES_URL points at a disposable database.
describe('Postgres query smoke', function () {
  this.timeout(120000)
  let Database
  let restore

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL) return this.skip()
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true)
  })

  after(async function () {
    if (restore) await restore()
  })

  it('boots a fresh postgres schema with the dialect adapter', function () {
    expect(Database.dialect).to.equal('postgres')
    expect(Database.adapter.name).to.equal('postgres')
    expect(Database.isNew).to.equal(true)
  })

  it('returns podcast library stats with camelCase keys and numeric values', async function () {
    const { libraryId } = await seedLibrary(Database)
    const stats = await require('../../../server/utils/queries/libraryItemsPodcastFilters').getPodcastLibraryStats(libraryId)
    expect(stats).to.deep.equal({ totalDuration: 201, numAudioFiles: 2, totalItems: 1, totalSize: 555 })
  })

  it('filters and counts book library items', async function () {
    const { libraryId } = await seedLibrary(Database)
    const books = require('../../../server/utils/queries/libraryItemsBookFilters')
    const result = await books.getFilteredLibraryItems(libraryId, user, 'genres', 'Sci-Fi', 'media.metadata.title', false, false, [], 10, 0)
    expect(result.libraryItems).to.have.length(3)
    const bookStats = await books.getBookLibraryStats(libraryId)
    expect(bookStats.totalItems).to.equal(3)
    expect(bookStats.totalDuration).to.equal(183)
  })

  it('sorts series by an aliased subquery and returns its total duration', async function () {
    const { libraryId } = await seedLibrary(Database)
    const library = { id: libraryId, mediaType: 'book', settings: { hideSingleBookSeries: false, onlyShowLaterBooksInContinueSeries: false, collapseSeries: false } }
    const seriesFilters = require('../../../server/utils/queries/seriesFilters')
    const byBooks = await seriesFilters.getFilteredSeries(library, user, 'all', 'numBooks', true, [], 10, 0)
    expect(byBooks.series).to.have.length(1)
    const byDuration = await seriesFilters.getFilteredSeries(library, user, 'all', 'totalDuration', true, [], 10, 0)
    expect(byDuration.series[0].totalDuration).to.equal(183)
  })

  it('searches books and podcasts', async function () {
    const { libraryId } = await seedLibrary(Database)
    const books = await require('../../../server/utils/queries/libraryItemsBookFilters').search(user, { id: libraryId, mediaType: 'book', settings: {} }, 'book', 10, 0)
    expect(books.book.length).to.be.greaterThan(0)
    const pods = await require('../../../server/utils/queries/libraryItemsPodcastFilters').search(user, { id: libraryId, mediaType: 'podcast', settings: {} }, 'pod', 10, 0)
    expect(pods.podcast.length).to.be.greaterThan(0)
  })
})
