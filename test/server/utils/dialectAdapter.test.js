const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const { dialectFor, resolveDialect } = require('../../../server/utils/dialectAdapter')

describe('dialectAdapter (sqlite)', () => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
  const adapter = dialectFor(sequelize)

  it('reports the sqlite dialect and that it is file based', () => {
    expect(adapter.name).to.equal('sqlite')
    expect(adapter.fileBased).to.equal(true)
  })

  it('keeps the SQL text the queries used before the adapter', () => {
    expect(adapter.jsonArrayContainsAny('tags', 'userTagsSelected')).to.equal('(SELECT count(*) FROM json_each(tags) WHERE json_valid(tags) AND json_each.value IN (:userTagsSelected))')
    expect(adapter.jsonArrayContainsValue('genres', 'filterValue')).to.equal('(SELECT count(*) FROM json_each(genres) WHERE json_valid(genres) AND json_each.value = :filterValue)')
    expect(adapter.jsonArrayLength('audioFiles')).to.equal('json_array_length(audioFiles)')
    expect(adapter.jsonPathNumber('pe.audioFile', 'duration')).to.equal("json_extract(pe.audioFile, '$.duration')")
    expect(adapter.noCaseOrder('title')).to.equal('title COLLATE NOCASE')
    expect(adapter.aliasAs('totalSize')).to.equal('totalSize')
    expect(adapter.bool(true)).to.equal('1')
    expect(adapter.like('book.title', ':p')).to.equal('book.title LIKE :p')
    expect(adapter.indexField('title')).to.deep.equal({ name: 'title', collate: 'NOCASE' })
  })

  it('treats a missing dialect option as sqlite', () => {
    expect(resolveDialect({})).to.equal('sqlite')
    expect(resolveDialect({ DATABASE_URL: 'postgres://u:p@h/db' })).to.equal('postgres')
    expect(resolveDialect({ DB_DIALECT: 'sqlite', DATABASE_URL: 'postgres://u:p@h/db' })).to.equal('sqlite')
    expect(resolveDialect({ DB_DIALECT: 'POSTGRES' })).to.equal('postgres')
  })
})

describe('dialectAdapter (postgres SQL text)', () => {
  const sequelize = new Sequelize('postgres://user:pass@127.0.0.1:1/none', { dialect: 'postgres', logging: false, quoteIdentifiers: false })
  const adapter = dialectFor(sequelize)

  after(async () => {
    await sequelize.close()
  })

  it('quotes output aliases and keeps plain references unquoted', () => {
    expect(adapter.aliasAs('totalSize')).to.equal('"totalSize"')
    expect(adapter.column('libraryItem', 'title')).to.equal('libraryItem.title')
    expect(adapter.column('series->bookSeries', 'sequence')).to.equal('"series->bookSeries".sequence')
  })

  it('uses postgres operators and functions', () => {
    expect(adapter.like('x', ':p')).to.equal('x ILIKE :p')
    expect(adapter.noCaseOrder('x')).to.equal('LOWER(x)')
    expect(adapter.bool(false)).to.equal('FALSE')
    expect(adapter.jsonPathNumber('pe.audioFile', 'duration')).to.equal("NULLIF((pe.audioFile::jsonb #>> '{duration}'), '')::double precision")
    expect(adapter.groupConcat('name', 'createdAt ASC')).to.equal("string_agg(name, ', ' ORDER BY createdAt ASC)")
    expect(adapter.indexField('title')).to.equal('title')
  })
})
