const { expect } = require('chai')
const { fakeRes } = require('../database/pgFixtures')

describe('restoreMaintenance', () => {
  const maintenance = () => require('../../../server/utils/restoreMaintenance')

  afterEach(() => maintenance().end())

  it('lets HTTP requests through when no restore is running', () => {
    let called = false
    maintenance().middleware({ method: 'GET', url: '/api/libraries' }, fakeRes(), () => (called = true))
    expect(called).to.equal(true)
  })

  it('answers every HTTP request with 503 while a restore runs', () => {
    expect(maintenance().begin()).to.equal(true)
    const res = fakeRes()
    let called = false
    maintenance().middleware({ method: 'GET', url: '/api/libraries' }, res, () => (called = true))
    expect(called).to.equal(false)
    expect(res.code).to.equal(503)
  })

  it('refuses socket connections and socket events with an error while a restore runs', () => {
    maintenance().begin()
    let connectError = null
    maintenance().socketMiddleware({ id: 'socket-1' }, (error) => (connectError = error))
    let eventError = null
    maintenance().packetMiddleware(['get_libraries'], (error) => (eventError = error))
    expect(connectError).to.be.an('error')
    expect(eventError).to.be.an('error')
  })

  it('lets sockets through when no restore is running', () => {
    let connectError = 'not called'
    maintenance().socketMiddleware({ id: 'socket-1' }, (error) => (connectError = error))
    expect(connectError).to.equal(undefined)
  })

  it('does not start a second restore while one is running on this instance', () => {
    expect(maintenance().begin()).to.equal(true)
    expect(maintenance().begin()).to.equal(false)
    maintenance().end()
    expect(maintenance().active).to.equal(false)
  })
})
