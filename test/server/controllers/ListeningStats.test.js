const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const MeController = require('../../../server/controllers/MeController')
const UserController = require('../../../server/controllers/UserController')
const date = require('../../../server/libs/dateAndTime')
const Logger = require('../../../server/Logger')

/**
 * Behavior pin for the listening stats and listening sessions endpoints (SQLite).
 * Deliberate changes from the earlier default response: items are keyed by
 * library item only (no "null" key), item lastUpdate is the newest session
 * time, and a null timeListening counts as 0.
 *
 * Run: npx mocha test/server/controllers/ListeningStats.test.js
 */

const json = (o) => JSON.parse(JSON.stringify(o))

const TODAY_DATE = date.format(new Date(), 'YYYY-MM-DD')
const TODAY_DOW = date.format(new Date(), 'dddd')
const BASE_UPDATED_AT = new Date('2026-08-01T12:00:00.000Z')
const MINUTE = 60 * 1000

const BOOK_A_TITLE = 'Pinned Book A'
const BOOK_B_TITLE = 'Pinned Book B'
const METADATA_A = { title: BOOK_A_TITLE, authors: ['Kevin A'] }
const METADATA_B = { title: BOOK_B_TITLE, authors: ['Kevin B'] }

// k selects the book/library item; updatedAt is 1 min newer per session, so
// session 12 is the most recent. Session 7 is dated "today".
const USER1_SESSIONS = [
  { k: 'a', timeListening: 600, date: '2026-08-03', dayOfWeek: 'Monday' },
  { k: 'a', timeListening: 400, date: '2026-08-03', dayOfWeek: 'Monday' },
  { k: 'b', timeListening: 300, date: '2026-08-04', dayOfWeek: 'Tuesday' },
  { k: 'b', timeListening: 200, date: '2026-08-04', dayOfWeek: 'Tuesday' },
  { k: 'a', timeListening: 50, date: '2026-08-04', dayOfWeek: 'Tuesday' },
  { k: 'b', timeListening: 0, date: '2026-08-05', dayOfWeek: 'Wednesday' },
  { k: 'a', timeListening: 9999, date: TODAY_DATE, dayOfWeek: TODAY_DOW },
  { k: 'b', timeListening: 25, date: '2026-08-02', dayOfWeek: 'Sunday' },
  { k: 'a', timeListening: 75, date: '2026-08-02', dayOfWeek: 'Sunday' },
  { k: 'a', timeListening: 100, date: '2026-08-01', dayOfWeek: 'Saturday' },
  { k: 'b', timeListening: 700, date: '2026-08-01', dayOfWeek: 'Saturday' },
  { k: 'a', timeListening: 200, date: '2026-08-01', dayOfWeek: 'Saturday' }
]

// The 0-time session still creates a dayOfWeek entry and counts in totalTime,
// but no days entry.
const EXPECTED_TOTAL_TIME = 12649
const EXPECTED_ITEM_A_TIME = 11424 // sessions 1,2,5,7,9,10,12
const EXPECTED_ITEM_B_TIME = 1225 // sessions 3,4,6,8,11

function bucketAdd(obj, key, value) {
  if (!obj[key]) obj[key] = 0
  obj[key] += value
  return obj
}

describe('Listening stats and listening sessions behavior pin', () => {
  let user1
  let user2
  let bookA
  let bookB
  let libraryItemA
  let libraryItemB
  let sessionIds
  let meCtx
  let userCtx

  // Bind to an ApiRouter.prototype-derived context so the stats helpers resolve
  // to whichever implementation the checked-out version ships.
  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')

    const library = await Database.libraryModel.create({ name: 'Pinned Library', mediaType: 'book' })
    const libraryFolder = await Database.libraryFolderModel.create({ path: '/pinned-lib', libraryId: library.id })

    bookA = await Database.bookModel.create({
      title: BOOK_A_TITLE,
      explicit: false,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    bookB = await Database.bookModel.create({
      title: BOOK_B_TITLE,
      explicit: false,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    libraryItemA = await Database.libraryItemModel.create({
      path: '/pinned-lib/book-a',
      isFile: false,
      libraryFiles: [],
      mediaId: bookA.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    libraryItemB = await Database.libraryItemModel.create({
      path: '/pinned-lib/book-b',
      isFile: false,
      libraryFiles: [],
      mediaId: bookB.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })

    const makeUser = async (username) =>
      Database.userModel.create({
        username,
        pash: 'hash',
        token: 'token',
        type: 'user',
        isActive: true,
        permissions: Database.userModel.getDefaultPermissionsForUserType('user'),
        bookmarks: [],
        extraData: {}
      })
    user1 = await makeUser('pinned-user-1')
    user2 = await makeUser('pinned-user-2')

    const sessionIdsDesc = []
    await Promise.all(
      USER1_SESSIONS.map(async (spec, index) => {
        const item = spec.k === 'a' ? { book: bookA, libraryItem: libraryItemA } : { book: bookB, libraryItem: libraryItemB }
        const session = await Database.playbackSessionModel.create(
          {
            mediaItemId: item.book.id,
            mediaItemType: 'book',
            displayTitle: spec.k === 'a' ? BOOK_A_TITLE : BOOK_B_TITLE,
            displayAuthor: 'Kevin',
            duration: 3600,
            timeListening: spec.timeListening,
            mediaMetadata: spec.k === 'a' ? METADATA_A : METADATA_B,
            date: spec.date,
            dayOfWeek: spec.dayOfWeek,
            extraData: { libraryItemId: item.libraryItem.id },
            userId: user1.id,
            libraryId: library.id,
            updatedAt: new Date(BASE_UPDATED_AT.getTime() + (index + 1) * MINUTE),
            createdAt: new Date(BASE_UPDATED_AT.getTime() + (index + 1) * MINUTE)
          },
          { silent: true }
        )
        sessionIdsDesc.push({ index: index + 1, id: session.id, timeListening: spec.timeListening, k: spec.k })
      })
    )
    sessionIdsDesc.sort((x, y) => y.index - x.index)
    sessionIds = sessionIdsDesc.map((s) => s.id)

    // 3 sessions for user2, exercised by the /users/:id tests
    await Database.playbackSessionModel.create(
      {
        mediaItemId: bookA.id,
        mediaItemType: 'book',
        displayTitle: BOOK_A_TITLE,
        displayAuthor: 'Kevin',
        duration: 3600,
        timeListening: 100,
        mediaMetadata: METADATA_A,
        date: '2026-08-02',
        dayOfWeek: 'Sunday',
        extraData: { libraryItemId: libraryItemA.id },
        userId: user2.id,
        libraryId: library.id,
        updatedAt: new Date(BASE_UPDATED_AT.getTime() + 20 * MINUTE),
        createdAt: new Date(BASE_UPDATED_AT.getTime() + 20 * MINUTE)
      },
      { silent: true }
    )
    await Database.playbackSessionModel.create(
      {
        mediaItemId: bookB.id,
        mediaItemType: 'book',
        displayTitle: BOOK_B_TITLE,
        displayAuthor: 'Kevin',
        duration: 3600,
        timeListening: 50,
        mediaMetadata: METADATA_B,
        date: '2026-08-02',
        dayOfWeek: 'Sunday',
        extraData: { libraryItemId: libraryItemB.id },
        userId: user2.id,
        libraryId: library.id,
        updatedAt: new Date(BASE_UPDATED_AT.getTime() + 21 * MINUTE),
        createdAt: new Date(BASE_UPDATED_AT.getTime() + 21 * MINUTE)
      },
      { silent: true }
    )
    await Database.playbackSessionModel.create(
      {
        mediaItemId: bookA.id,
        mediaItemType: 'book',
        displayTitle: BOOK_A_TITLE,
        displayAuthor: 'Kevin',
        duration: 3600,
        timeListening: 25,
        mediaMetadata: METADATA_A,
        date: '2026-08-03',
        dayOfWeek: 'Monday',
        extraData: { libraryItemId: libraryItemA.id },
        userId: user2.id,
        libraryId: library.id,
        updatedAt: new Date(BASE_UPDATED_AT.getTime() + 22 * MINUTE),
        createdAt: new Date(BASE_UPDATED_AT.getTime() + 22 * MINUTE)
      },
      { silent: true }
    )

    meCtx = Object.create(ApiRouter.prototype)
    userCtx = Object.create(ApiRouter.prototype)
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
  })

  function callListeningStats(req) {
    const res = { json: sinon.spy() }
    const fn = MeController.getListeningStats.bind(meCtx)
    return fn(req, res).then(() => json(res.json.args[0][0]))
  }

  function callListeningSessions(req) {
    const res = { json: sinon.spy() }
    const fn = MeController.getListeningSessions.bind(meCtx)
    return fn(req, res).then(() => json(res.json.args[0][0]))
  }

  function callUserListeningStats(req) {
    const res = { json: sinon.spy() }
    const fn = UserController.getListeningStats.bind(userCtx)
    return fn(req, res).then(() => json(res.json.args[0][0]))
  }

  function callUserListeningSessions(req) {
    const res = { json: sinon.spy() }
    const fn = UserController.getListeningSessions.bind(userCtx)
    return fn(req, res).then(() => json(res.json.args[0][0]))
  }

  function expectedDays() {
    const days = {
      '2026-08-03': 1000,
      '2026-08-04': 550,
      '2026-08-02': 100,
      '2026-08-01': 1000
    }
    bucketAdd(days, TODAY_DATE, 9999)
    return days
  }

  function expectedDayOfWeek() {
    const dow = {
      Monday: 1000,
      Tuesday: 550,
      Wednesday: 0,
      Sunday: 100,
      Saturday: 1000
    }
    bucketAdd(dow, TODAY_DOW, 9999)
    return dow
  }

  function expectedItems() {
    return {
      [libraryItemA.id]: { id: libraryItemA.id, timeListening: EXPECTED_ITEM_A_TIME, mediaMetadata: METADATA_A },
      [libraryItemB.id]: { id: libraryItemB.id, timeListening: EXPECTED_ITEM_B_TIME, mediaMetadata: METADATA_B }
    }
  }

  describe('GET /api/me/listening-stats (contract)', () => {
    it('returns pinned totalTime, days, dayOfWeek and today buckets', async () => {
      const stats = await callListeningStats({ user: user1, query: {} })

      expect(stats.totalTime).to.equal(EXPECTED_TOTAL_TIME)
      expect(stats.today).to.equal(9999)
      expect(stats.days).to.deep.equal(expectedDays())
      expect(stats.dayOfWeek).to.deep.equal(expectedDayOfWeek())
    })

    it('aggregates items per library item with timeListening and mediaMetadata', async () => {
      const stats = await callListeningStats({ user: user1, query: {} })

      const normItems = {}
      for (const [key, item] of Object.entries(stats.items)) {
        normItems[key] = { id: item.id, timeListening: item.timeListening, mediaMetadata: item.mediaMetadata }
      }
      expect(normItems).to.deep.equal(expectedItems())
    })

    it('returns the 10 most recently updated sessions as recentSessions', async () => {
      const stats = await callListeningStats({ user: user1, query: {} })

      expect(stats.recentSessions).to.have.length(10)
      expect(stats.recentSessions.map((s) => s.id)).to.deep.equal(sessionIds.slice(0, 10))
      for (let i = 1; i < stats.recentSessions.length; i++) {
        expect(stats.recentSessions[i - 1].updatedAt).to.be.at.least(stats.recentSessions[i].updatedAt)
      }
    })

    it('default response shape contains items and recentSessions keys', async () => {
      const stats = await callListeningStats({ user: user1, query: {} })

      expect(stats).to.have.property('items')
      expect(stats).to.have.property('recentSessions')
    })
  })

  describe('GET /api/me/listening-sessions (contract)', () => {
    it('paginates with total/numPages/page/itemsPerPage and newest-first ordering', async () => {
      const payload = await callListeningSessions({ user: user1, query: {} })

      expect(payload.total).to.equal(12)
      expect(payload.numPages).to.equal(2)
      expect(payload.page).to.equal(0)
      expect(payload.itemsPerPage).to.equal(10)
      expect(payload.sessions).to.have.length(10)
      expect(payload.sessions.map((s) => s.id)).to.deep.equal(sessionIds.slice(0, 10))
    })

    it('returns the remaining sessions on page 1', async () => {
      const payload = await callListeningSessions({ user: user1, query: { page: '1' } })

      expect(payload.total).to.equal(12)
      expect(payload.numPages).to.equal(2)
      expect(payload.sessions).to.have.length(2)
      expect(payload.sessions.map((s) => s.id)).to.deep.equal(sessionIds.slice(10, 12))
    })

    it('honors a custom itemsPerPage', async () => {
      const payload = await callListeningSessions({ user: user1, query: { itemsPerPage: '5' } })

      expect(payload.total).to.equal(12)
      expect(payload.numPages).to.equal(3)
      expect(payload.sessions).to.have.length(5)
      expect(payload.sessions.map((s) => s.id)).to.deep.equal(sessionIds.slice(0, 5))
    })

    it('is scoped to the requesting user', async () => {
      const payload = await callListeningSessions({ user: user2, query: {} })

      expect(payload.total).to.equal(3)
      expect(payload.numPages).to.equal(1)
    })
  })

  describe('GET /api/users/:id/listening-* (contract)', () => {
    it('returns the target users stats, not the requesting users', async () => {
      const stats = await callUserListeningStats({ user: user1, params: { id: user2.id }, query: {} })

      expect(stats.totalTime).to.equal(175)
      expect(stats.today).to.equal(0)
      expect(stats.days).to.deep.equal({ '2026-08-02': 150, '2026-08-03': 25 })
      expect(stats.dayOfWeek).to.deep.equal({ Sunday: 150, Monday: 25 })
      const normItems = {}
      for (const [key, item] of Object.entries(stats.items)) {
        normItems[key] = { id: item.id, timeListening: item.timeListening, mediaMetadata: item.mediaMetadata }
      }
      expect(normItems).to.deep.equal({
        [libraryItemA.id]: { id: libraryItemA.id, timeListening: 125, mediaMetadata: METADATA_A },
        [libraryItemB.id]: { id: libraryItemB.id, timeListening: 50, mediaMetadata: METADATA_B }
      })
    })

    it('maps the target user into each listening session', async () => {
      const payload = await callUserListeningSessions({ user: user1, reqUser: user2, params: { id: user2.id }, query: {} })

      expect(payload.total).to.equal(3)
      expect(payload.sessions).to.have.length(3)
      payload.sessions.forEach((session) => {
        expect(session.user).to.deep.equal({ id: user2.id, username: user2.username })
      })
    })
  })

  describe('GET /api/me/item/listening-sessions (contract)', () => {
    it('filters by media item and paginates', async () => {
      const res = { json: sinon.spy(), sendStatus: sinon.spy() }
      const fn = MeController.getItemListeningSessions.bind(meCtx)
      await fn({ user: user1, params: { libraryItemId: libraryItemA.id }, query: {} }, res)

      expect(res.sendStatus.called).to.be.false
      const payload = json(res.json.args[0][0])
      expect(payload.total).to.equal(7)
      expect(payload.numPages).to.equal(1)
      expect(payload.sessions).to.have.length(7)
      // sessions belonging to book A (k='a'): indexes 1,2,5,7,9,10,12 -> newest first
      const expectedIds = [12, 10, 9, 7, 5, 2, 1].map((index) => sessionIds[12 - index])
      expect(payload.sessions.map((s) => s.id)).to.deep.equal(expectedIds)
    })
  })

  describe('Minified stats mode', () => {
    it('?minified=1 omits items and recentSessions but keeps aggregates', async () => {
      const stats = await callListeningStats({ user: user1, query: { minified: '1' } })

      expect(stats.totalTime).to.equal(EXPECTED_TOTAL_TIME)
      expect(stats.today).to.equal(9999)
      expect(stats.days).to.deep.equal(expectedDays())
      expect(stats.dayOfWeek).to.deep.equal(expectedDayOfWeek())
      expect(stats).to.not.have.property('items')
      expect(stats).to.not.have.property('recentSessions')
    })

    it('?minified=true behaves the same as minified=1', async () => {
      const stats = await callListeningStats({ user: user1, query: { minified: 'true' } })

      expect(stats.totalTime).to.equal(EXPECTED_TOTAL_TIME)
      expect(stats).to.not.have.property('items')
      expect(stats).to.not.have.property('recentSessions')
    })

    it('works on the /api/users/:id variant too', async () => {
      const stats = await callUserListeningStats({ user: user1, params: { id: user2.id }, query: { minified: '1' } })

      expect(stats.totalTime).to.equal(175)
      expect(stats).to.not.have.property('items')
      expect(stats).to.not.have.property('recentSessions')
    })
  })

  describe('Minified stats do not load session rows', () => {
    it('minified stats never call getOldPlaybackSessions', async () => {
      const loadSpy = sinon.spy(Database.playbackSessionModel, 'getOldPlaybackSessions')

      await callListeningStats({ user: user1, query: { minified: '1' } })

      expect(loadSpy.called).to.be.false
    })

    it('full stats load only the 10 recent sessions', async () => {
      const loadSpy = sinon.spy(Database.playbackSessionModel, 'getOldPlaybackSessions')

      await callListeningStats({ user: user1, query: {} })

      expect(loadSpy.calledOnce).to.be.true
      expect(loadSpy.firstCall.args[1]).to.deep.include({ limit: 10 })
    })
  })

  describe('Deliberate response changes', () => {
    it('sets item lastUpdate to the most recent updatedAt of the item', async () => {
      const stats = await callListeningStats({ user: user1, query: {} })

      // newest session for A is index 12, for B index 11
      expect(new Date(stats.items[libraryItemA.id].lastUpdate).getTime()).to.equal(BASE_UPDATED_AT.getTime() + 12 * MINUTE)
      expect(new Date(stats.items[libraryItemB.id].lastUpdate).getTime()).to.equal(BASE_UPDATED_AT.getTime() + 11 * MINUTE)
    })

    it('counts sessions without a libraryItemId in totalTime but not in items', async () => {
      await Database.playbackSessionModel.create(
        {
          mediaItemId: bookA.id,
          mediaItemType: 'book',
          displayTitle: BOOK_A_TITLE,
          displayAuthor: 'Kevin',
          duration: 3600,
          timeListening: 40,
          mediaMetadata: METADATA_A,
          date: '2026-08-03',
          dayOfWeek: 'Monday',
          extraData: {},
          userId: user1.id,
          updatedAt: new Date(BASE_UPDATED_AT.getTime() + 30 * MINUTE),
          createdAt: new Date(BASE_UPDATED_AT.getTime() + 30 * MINUTE)
        },
        { silent: true }
      )

      const stats = await callListeningStats({ user: user1, query: {} })

      expect(stats.totalTime).to.equal(EXPECTED_TOTAL_TIME + 40)
      expect(stats.items).to.not.have.property('null')
      // Grouped rows come back in no guaranteed order, so compare membership.
      expect(Object.keys(stats.items).sort()).to.deep.equal([libraryItemA.id, libraryItemB.id].sort())
    })

    it('clamps paging values before they reach the query', async () => {
      const low = await callListeningSessions({ user: user1, query: { itemsPerPage: '-1', page: '-3' } })
      expect(low.itemsPerPage).to.equal(10)
      expect(low.page).to.equal(0)
      expect(Array.isArray(low.sessions)).to.equal(true)
      const high = await callListeningSessions({ user: user1, query: { itemsPerPage: '1000', page: '0' } })
      expect(high.itemsPerPage).to.equal(100)
    })

    it('treats a null timeListening as 0 without poisoning totals', async () => {
      await Database.playbackSessionModel.create(
        {
          mediaItemId: bookB.id,
          mediaItemType: 'book',
          displayTitle: BOOK_B_TITLE,
          displayAuthor: 'Kevin',
          duration: 3600,
          timeListening: null,
          mediaMetadata: METADATA_B,
          date: '2026-08-05',
          dayOfWeek: 'Wednesday',
          extraData: { libraryItemId: libraryItemB.id },
          userId: user1.id,
          updatedAt: new Date(BASE_UPDATED_AT.getTime() + 31 * MINUTE),
          createdAt: new Date(BASE_UPDATED_AT.getTime() + 31 * MINUTE)
        },
        { silent: true }
      )

      const stats = await callListeningStats({ user: user1, query: {} })

      expect(Number.isNaN(stats.totalTime)).to.be.false
      expect(stats.totalTime).to.equal(EXPECTED_TOTAL_TIME)
      expect(stats.items[libraryItemB.id].timeListening).to.equal(EXPECTED_ITEM_B_TIME)
    })
  })
})
