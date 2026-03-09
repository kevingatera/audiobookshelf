const { expect } = require('chai')
const sinon = require('sinon')
const User = require('../../../server/models/User')

describe('User model', () => {
  describe('case-insensitive lookup helpers', () => {
    afterEach(() => {
      sinon.restore()
    })

    it('should query usernames case-insensitively', async () => {
      User.sequelize = {
        models: {
          mediaProgress: {}
        }
      }

      const findOneStub = sinon.stub(User, 'findOne').resolves(null)

      await User.getUserByUsername('Madison')

      expect(findOneStub.calledOnce).to.equal(true)
      const options = findOneStub.firstCall.args[0]
      expect(options.where.attribute.fn).to.equal('LOWER')
      expect(options.where.attribute.args[0].col).to.equal('username')
      expect(options.where.logic).to.equal('madison')
    })

    it('should query emails case-insensitively', async () => {
      User.sequelize = {
        models: {
          mediaProgress: {}
        }
      }

      const findOneStub = sinon.stub(User, 'findOne').resolves(null)

      await User.getUserByEmail('Example.User@Example.com')

      expect(findOneStub.calledOnce).to.equal(true)
      const options = findOneStub.firstCall.args[0]
      expect(options.where.attribute.fn).to.equal('LOWER')
      expect(options.where.attribute.args[0].col).to.equal('email')
      expect(options.where.logic).to.equal('example.user@example.com')
    })
  })
})
