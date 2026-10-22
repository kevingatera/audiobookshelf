const { expect } = require('chai')
const sinon = require('sinon')
const { Sequelize } = require('sequelize')

const Database = require('../../../../server/Database')
const libraryItemsBookFilters = require('../../../../server/utils/queries/libraryItemsBookFilters')

/**
 * Collapse-series shelf queries on SQLite. Runs the real query against an
 * in-memory database.
 */
describe('libraryItemsBookFilters collapse-series queries', () => {
  let library
  let user

  beforeEach(async () => {
    global.ServerSettings = { sortingIgnorePrefix: false }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Collapse Library', mediaType: 'book' })
    const libraryFolder = await Database.libraryFolderModel.create({ path: '/collapse-lib', libraryId: library.id })
    const book = await Database.bookModel.create({
      title: 'Standalone Book',
      explicit: false,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    await Database.libraryItemModel.create({
      path: '/collapse-lib/standalone',
      isFile: false,
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    user = await Database.userModel.create({
      username: 'collapse-user',
      pash: 'hash',
      token: 'token',
      type: 'root',
      isActive: true,
      permissions: Database.userModel.getDefaultPermissionsForUserType('root'),
      bookmarks: [],
      extraData: {}
    })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
  })

  function collapseShelf() {
    return libraryItemsBookFilters.getFilteredLibraryItems(library.id, user, null, null, 'title', false, true, [], 10, 0)
  }

  it('returns books when collapse-series has no series to include', async () => {
    sinon.stub(libraryItemsBookFilters, 'getCollapseSeriesBooksToExclude').resolves({
      booksToExclude: [],
      bookSeriesToInclude: []
    })

    const { libraryItems, count } = await collapseShelf()

    expect(count).to.equal(1)
    expect(libraryItems).to.have.length(1)
  })

  it('escapes series ids that contain a quote instead of failing the query', async () => {
    sinon.stub(libraryItemsBookFilters, 'getCollapseSeriesBooksToExclude').resolves({
      booksToExclude: [],
      bookSeriesToInclude: [{ id: "series'quoted", numBooks: 2, libraryItemIds: [] }]
    })

    const { libraryItems, count } = await collapseShelf()

    expect(count).to.equal(1)
    expect(libraryItems).to.have.length(1)
  })
})
