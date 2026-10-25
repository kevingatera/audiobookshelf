const { expect } = require('chai')
const { bootPostgres, seedLibrary } = require('./pgFixtures')
const PostgresRepairManager = require('../../../server/managers/PostgresRepairManager')
const Logger = require('../../../server/Logger')
const { dialectFor } = require('../../../server/utils/dialectAdapter')

// Author names on libraryItems must follow one order whatever plan Postgres picks. Links that share a createdAt
// are ordered by their unique link id. Link ids are inserted in reverse, so the id order differs from insertion order.
const AUTHOR = {
  amy1: '00000000-0000-4000-8000-0000000000a1',
  amy2: '00000000-0000-4000-8000-0000000000a2',
  zed: '00000000-0000-4000-8000-0000000000a3'
}
const LINK = {
  amy2: '00000000-0000-4000-8000-0000000000b1',
  amy1: '00000000-0000-4000-8000-0000000000b2',
  zed: '00000000-0000-4000-8000-0000000000b3'
}
const TIED_AT = '2024-06-01 12:00:00+00'

// Each entry forces a different join strategy for the author aggregate. enable_* = off only deprioritises a plan.
const PLANS = {
  'default plan': [],
  'nested loop': ['enable_hashjoin = off', 'enable_mergejoin = off'],
  'merge join': ['enable_hashjoin = off', 'enable_nestloop = off'],
  'hash join': ['enable_mergejoin = off', 'enable_nestloop = off']
}

describe('Postgres author order on libraryItems', function () {
  this.timeout(120000)
  let Database
  let restore
  let bookId
  let libraryId

  async function query(sql, replacements = {}) {
    return Database.sequelize.query(sql, { replacements, type: 'SELECT' })
  }

  async function authorNames() {
    const [row] = await query('SELECT authorNamesFirstLast AS firstlast, authorNamesLastFirst AS lastfirst FROM libraryItems WHERE mediaId = :id', { id: bookId })
    return row
  }

  async function execute(sql, replacements = {}, transaction) {
    return Database.sequelize.query(sql, { replacements, transaction })
  }

  // Runs the fork-pg-0005 repair with its queries pinned to one transaction, so SET LOCAL reaches the backfill.
  async function runAuthorRepair(transaction) {
    const repair = PostgresRepairManager.loadRepairs().find((r) => r.id === 'fork-pg-0005-denormalized-library-items')
    const sequelize = { query: (sql, options = {}) => Database.sequelize.query(sql, { ...options, transaction }) }
    await repair.run({ sequelize, adapter: dialectFor(Database.sequelize), logger: Logger })
  }

  async function inPlan(settings, work) {
    return Database.sequelize.transaction(async (transaction) => {
      for (const setting of settings) await execute(`SET LOCAL ${setting}`, {}, transaction)
      return work(transaction)
    })
  }

  // Clears the stored names, so the next repair or trigger must recompute them.
  async function makeStale() {
    await execute("UPDATE libraryItems SET authorNamesFirstLast = 'stale', authorNamesLastFirst = 'stale' WHERE mediaId = :id", { id: bookId })
  }

  async function insertLinks() {
    const links = [
      [LINK.zed, AUTHOR.zed],
      [LINK.amy1, AUTHOR.amy1],
      [LINK.amy2, AUTHOR.amy2]
    ]
    for (const [id, authorId] of links) {
      await execute('INSERT INTO bookAuthors (id, bookId, authorId, createdAt) VALUES (:id, :bookId, :authorId, :createdAt)', { id, bookId, authorId, createdAt: TIED_AT })
    }
  }

  const TIED = { firstlast: 'Amy Writer, Amy Writer, Zed Writer', lastfirst: 'Writer, Amy, Writer, Amy, Writer, Zed' }

  before(async function () {
    if (!process.env.ABS_TEST_POSTGRES_URL) return this.skip()
    Database = require('../../../server/Database')
    restore = await bootPostgres(Database, true)
    const seeded = await seedLibrary(Database)
    bookId = seeded.bookIds[1]
    libraryId = seeded.libraryId
    // Use one book with no seeded author link, so the tied links are the only authors it has.
    await execute('DELETE FROM bookAuthors WHERE bookId = :bookId', { bookId })
    await execute(
      `INSERT INTO authors (id, name, lastFirst, libraryId, createdAt, updatedAt) VALUES
        (:amy1, 'Amy Writer', 'Writer, Amy', :libraryId, now(), now()),
        (:amy2, 'Amy Writer', 'Writer, Amy', :libraryId, now(), now()),
        (:zed, 'Zed Writer', 'Writer, Zed', :libraryId, now(), now())`,
      { amy1: AUTHOR.amy1, amy2: AUTHOR.amy2, zed: AUTHOR.zed, libraryId }
    )
  })

  after(async function () {
    if (restore) await restore()
  })

  it('orders tied links by link id, keeping duplicate names, on the bookAuthors insert trigger', async function () {
    await insertLinks()
    expect(await authorNames()).to.deep.equal(TIED)
  })

  it('orders tied links the same way in the backfill', async function () {
    await makeStale()
    await runAuthorRepair()
    expect(await authorNames()).to.deep.equal(TIED)
  })

  it('gives the same order under every planner strategy, in the backfill and in the trigger', async function () {
    for (const [plan, settings] of Object.entries(PLANS)) {
      await makeStale()
      await inPlan(settings, (transaction) => runAuthorRepair(transaction))
      expect(await authorNames(), `${plan} backfill`).to.deep.equal(TIED)

      await makeStale()
      await inPlan(settings, (transaction) => execute('UPDATE bookAuthors SET bookId = bookId WHERE bookId = :bookId', { bookId }, transaction))
      expect(await authorNames(), `${plan} trigger`).to.deep.equal(TIED)
    }
  })

  it('backfill is idempotent: a second run rewrites no library item rows', async function () {
    await runAuthorRepair()
    const [before] = await query('SELECT xmin::text AS xid FROM libraryItems WHERE mediaId = :id', { id: bookId })
    await runAuthorRepair()
    const [after] = await query('SELECT xmin::text AS xid FROM libraryItems WHERE mediaId = :id', { id: bookId })
    expect(after.xid).to.equal(before.xid)
    expect(await authorNames()).to.deep.equal(TIED)
  })

  it('keeps link order when an author is renamed, on the authors trigger', async function () {
    await execute("UPDATE authors SET name = 'Zara Writer', lastFirst = 'Writer, Zara' WHERE id = :id", { id: AUTHOR.zed })
    expect(await authorNames()).to.deep.equal({ firstlast: 'Amy Writer, Amy Writer, Zara Writer', lastfirst: 'Writer, Amy, Writer, Amy, Writer, Zara' })
  })

  it('keeps the remaining order when a tied link is deleted, on the bookAuthors delete trigger', async function () {
    await execute('DELETE FROM bookAuthors WHERE id = :id', { id: LINK.amy2 })
    expect(await authorNames()).to.deep.equal({ firstlast: 'Amy Writer, Zara Writer', lastfirst: 'Writer, Amy, Writer, Zara' })
  })
})
