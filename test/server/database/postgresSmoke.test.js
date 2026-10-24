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

  it('runs personalized shelves and series filters for admin and restricted users', async function () {
    const { libraryId } = await seedLibrary(Database)
    const library = { id: libraryId, mediaType: 'book', settings: { hideSingleBookSeries: false, onlyShowLaterBooksInContinueSeries: false, collapseSeries: false } }
    const admin = { id: randomUUID(), type: 'admin', permissions: { accessAllTags: true }, canAccessExplicitContent: true, extraData: {} }
    const restricted = { id: randomUUID(), type: 'user', permissions: { accessAllTags: true }, canAccessExplicitContent: false, extraData: {} }
    const libraryFilters = require('../../../server/utils/queries/libraryFilters')
    const seriesFilters = require('../../../server/utils/queries/seriesFilters')
    const notFinished = `progress.${Buffer.from('not-finished').toString('base64')}`
    for (const user of [admin, restricted]) {
      await libraryFilters.getLibraryItemsToDiscover(library, user, [], 10)
      await libraryFilters.getMediaItemsInProgress(library, user, [], 10)
      await libraryFilters.getLibraryItemsContinueSeries(library, user, [], 10)
      await libraryFilters.getMediaFinished(library, user, [], 10)
      const notStarted = await seriesFilters.getFilteredSeries(library, user, notFinished, 'name', false, [], 10, 0)
      expect(notStarted.series.length).to.be.greaterThan(0)
      const all = await seriesFilters.getFilteredSeries(library, user, 'all', 'name', false, [], 10, 0)
      expect(all.series.length).to.be.greaterThan(0)
    }
  })

  it('returns the next unread book in Continue Series when only later books are shown', async function () {
    const { libraryId } = await seed()
    const M = Database.models
    const user = await Database.userModel.create({ id: randomUUID(), username: `cs-${randomUUID()}`, pash: null, type: 'user', isActive: true, extraData: {}, permissions: { accessAllTags: true } })
    const series = await M.series.findOne({ where: { libraryId } })
    const firstInSeries = await M.bookSeries.findOne({ where: { seriesId: series.id, sequence: '1' } })
    await M.mediaProgress.create({ id: randomUUID(), userId: user.id, mediaItemId: firstInSeries.bookId, mediaItemType: 'book', duration: 60, currentTime: 60, isFinished: true, finishedAt: new Date(), extraData: {} })
    const library = { id: libraryId, mediaType: 'book', settings: { hideSingleBookSeries: false, onlyShowLaterBooksInContinueSeries: true, collapseSeries: false } }
    const result = await require('../../../server/utils/queries/libraryFilters').getLibraryItemsContinueSeries(library, user, [], 10)
    expect(result.count).to.equal(1)
    expect(result.libraryItems).to.have.length(1)
    expect(result.libraryItems[0].media.metadata.series.sequence).to.equal('2')
  })

  it('totals book and podcast sizes and year stats', async function () {
    await seedLibrary(Database)
    const adminStats = require('../../../server/utils/queries/adminStats')
    const sizes = await adminStats.getTotalSize()
    expect(sizes.books.numItems).to.be.at.least(3)
    expect(sizes.books.totalSize).to.be.greaterThan(0)
    expect(sizes.podcasts.numItems).to.be.at.least(1)
    expect(sizes.podcasts.totalSize).to.be.greaterThan(0)
    const stats = await adminStats.getStatsForYear(new Date().getFullYear())
    expect(stats.numBooksAdded).to.be.at.least(3)
    expect(stats.numBooks).to.be.at.least(3)
    expect(stats.totalBooksSize).to.be.greaterThan(0)
  })

  it('collapses series for books that have no series without an empty IN list', async function () {
    const { libraryId } = await seedLibrary(Database)
    const M = Database.models
    const folder = await M.libraryFolder.findOne({ where: { libraryId } })
    const bookId = randomUUID()
    await M.book.create({ id: bookId, title: 'Solo', titleIgnorePrefix: 'Solo', tags: [], genres: ['Solo Genre'], narrators: [], audioFiles: [], duration: 10 })
    await M.libraryItem.create({ id: randomUUID(), ino: 'solo', path: '/tmp/books/solo', relPath: 'solo', mediaId: bookId, mediaType: 'book', libraryId, libraryFolderId: folder.id, title: 'Solo', titleIgnorePrefix: 'Solo', authorNamesFirstLast: '', authorNamesLastFirst: '', size: 1, isFile: false, isMissing: false, isInvalid: false, libraryFiles: [] })
    const user = { id: randomUUID(), permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }
    const books = require('../../../server/utils/queries/libraryItemsBookFilters')
    for (const ignorePrefix of [false, true]) {
      global.ServerSettings.sortingIgnorePrefix = ignorePrefix
      const result = await books.getFilteredLibraryItems(libraryId, user, 'genres', 'Solo Genre', 'media.metadata.title', false, true, [], 10, 0)
      expect(result.libraryItems).to.have.length(1)
    }
    global.ServerSettings.sortingIgnorePrefix = false
  })

  it('filters supplementary ebooks and finds users by OpenID subject', async function () {
    const { libraryId } = await seedLibrary(Database)
    const admin = { id: randomUUID(), permissions: { accessAllTags: true }, canAccessExplicitContent: true, type: 'admin', extraData: {} }
    const books = require('../../../server/utils/queries/libraryItemsBookFilters')
    const plain = await books.getFilteredLibraryItems(libraryId, admin, 'ebooks', 'no-supplementary', 'media.metadata.title', false, false, [], 10, 0)
    expect(plain.libraryItems).to.have.length(3)
    const supplementary = await books.getFilteredLibraryItems(libraryId, admin, 'ebooks', 'supplementary', 'media.metadata.title', false, false, [], 10, 0)
    expect(supplementary.libraryItems).to.have.length(0)
    const sub = `oidc-${randomUUID()}`
    const user = await Database.userModel.create({ id: randomUUID(), username: `oidc-${sub}`, pash: null, type: 'user', isActive: true, extraData: { authOpenIDSub: sub }, permissions: {} })
    const found = await Database.userModel.getUserByOpenIDSub(sub)
    expect(found?.id).to.equal(user.id)
  })

  it('counts books per author with a quoted alias', async function () {
    const { libraryId } = await seedLibrary(Database)
    const author = await Database.authorModel.findOne({ where: { libraryId, name: 'Jane Doe' } })
    const counts = await Database.bookAuthorModel.getCountsForAuthors([author.id])
    expect(counts[author.id]).to.equal(3)
  })
})
