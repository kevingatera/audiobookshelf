// User lookup regressions on real drivers.
//
// The Postgres block runs only when ABS_TEST_POSTGRES_URL points at a disposable database. It uses the
// real Sequelize/pg path so a quoted JSON path or a uuid cast on a legacy id fails here, not in production.
const { expect } = require('chai')
const { randomUUID } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { bootPostgres } = require('./pgFixtures')

const Database = require('../../../server/Database')

/**
 * Creates a user with one media progress so every lookup also proves the eager association.
 * @param {object} models
 * @param {object} [extraData]
 */
async function createUserWithProgress(models, extraData = {}) {
  const user = await models.user.create({
    id: randomUUID(),
    username: `lookup-${randomUUID()}`,
    type: 'user',
    isActive: true,
    extraData
  })
  const mediaProgress = await models.mediaProgress.create({
    id: randomUUID(),
    userId: user.id,
    mediaItemId: randomUUID(),
    mediaItemType: 'book',
    duration: 60,
    currentTime: 30,
    isFinished: false,
    extraData: {}
  })
  return { user, mediaProgress }
}

/** Lookups shared by both dialects. */
async function expectLookupsToWork() {
  const models = Database.models

  const { user, mediaProgress } = await createUserWithProgress(models)

  const byId = await models.user.getUserByIdOrOldId(user.id)
  expect(byId).to.not.equal(null)
  expect(byId.id).to.equal(user.id)
  expect(byId.mediaProgresses.map((mp) => mp.id)).to.deep.equal([mediaProgress.id])

  // Legacy ids were not UUIDs before 2.3.0. Comparing one with the uuid id column raises 22P02 on Postgres.
  const legacyId = `legacy-${randomUUID()}`
  const legacy = await createUserWithProgress(models, { oldUserId: legacyId })
  const byLegacyId = await models.user.getUserByIdOrOldId(legacyId)
  expect(byLegacyId).to.not.equal(null)
  expect(byLegacyId.id).to.equal(legacy.user.id)
  expect(byLegacyId.mediaProgresses.map((mp) => mp.id)).to.deep.equal([legacy.mediaProgress.id])

  // A UUID-shaped legacy id misses the primary key, then matches extraData.oldUserId.
  const uuidLegacyId = randomUUID()
  const uuidLegacy = await createUserWithProgress(models, { oldUserId: uuidLegacyId })
  const byUuidLegacyId = await models.user.getUserByIdOrOldId(uuidLegacyId)
  expect(byUuidLegacyId).to.not.equal(null)
  expect(byUuidLegacyId.id).to.equal(uuidLegacy.user.id)

  expect(await models.user.getUserByIdOrOldId(`missing-${randomUUID()}`)).to.equal(null)
  expect(await models.user.getUserByIdOrOldId(randomUUID())).to.equal(null)
  expect(await models.user.getUserByIdOrOldId('')).to.equal(null)

  const sub = `sub-${randomUUID()}`
  const oidcUser = await createUserWithProgress(models, { authOpenIDSub: sub })
  const bySub = await models.user.getUserByOpenIDSub(sub)
  expect(bySub).to.not.equal(null)
  expect(bySub.id).to.equal(oidcUser.user.id)
  expect(await models.user.getUserByOpenIDSub(`missing-${randomUUID()}`)).to.equal(null)
}

describe('User lookup by id and legacy id', function () {
  this.timeout(120000)

  describe('postgres', function () {
    let restore

    before(async function () {
      if (!process.env.ABS_TEST_POSTGRES_URL) return this.skip()
      restore = await bootPostgres(Database, true)
    })

    after(async function () {
      if (restore) await restore()
    })

    it('finds users by id, legacy id and OpenID sub with media progress', async function () {
      await expectLookupsToWork()
    })
  })

  describe('sqlite', function () {
    let saved
    let configPath

    before(async function () {
      saved = {
        DB_DIALECT: process.env.DB_DIALECT,
        DATABASE_URL: process.env.DATABASE_URL,
        ConfigPath: global.ConfigPath,
        MetadataPath: global.MetadataPath,
        ServerSettings: global.ServerSettings
      }
      configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-user-lookup-'))
      delete process.env.DATABASE_URL
      process.env.DB_DIALECT = 'sqlite'
      global.ConfigPath = configPath
      global.MetadataPath = configPath
      global.ServerSettings = { sortingIgnorePrefix: false }
      await Database.init(true)
    })

    after(async function () {
      if (Database.sequelize) await Database.disconnect()
      if (Database.restoreLock) await Database.restoreLock.leave()
      process.env.DB_DIALECT = saved.DB_DIALECT
      if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved.DATABASE_URL
      global.ConfigPath = saved.ConfigPath
      global.MetadataPath = saved.MetadataPath
      global.ServerSettings = saved.ServerSettings
      if (configPath) fs.rmSync(configPath, { recursive: true, force: true })
    })

    it('finds users by id, legacy id and OpenID sub with media progress', async function () {
      await expectLookupsToWork()
    })
  })
})
