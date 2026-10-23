const { expect } = require('chai')
const { splitConnection, redact, runPostgresTool, dumpArgs, restoreArgs } = require('../../../server/utils/postgresTools')

describe('postgresTools', () => {
  it('keeps the password out of the conninfo and keeps every other connection option', () => {
    const url = 'postgres://backup:p%40ss@db.example.com:5433/abs?sslmode=verify-full&sslrootcert=/certs/ca.pem&application_name=abs'
    const { conninfo, password } = splitConnection(url)
    expect(password).to.equal('p@ss')
    expect(conninfo).to.not.contain('p%40ss')
    expect(conninfo).to.contain('sslmode=verify-full')
    expect(conninfo).to.contain('sslrootcert=/certs/ca.pem')
    expect(conninfo).to.contain('application_name=abs')
    expect(conninfo).to.contain('db.example.com:5433')
  })

  it('never puts the password in dump or restore argv', () => {
    const url = 'postgres://backup:topsecret@127.0.0.1:5432/abs'
    for (const arg of [...dumpArgs(url, '/tmp/x.dump'), ...restoreArgs(url, '/tmp/x.dump')]) {
      expect(arg).to.not.contain('topsecret')
    }
    expect(dumpArgs(url, '/tmp/x.dump')).to.include('--format=custom')
    expect(restoreArgs(url, '/tmp/x.dump')).to.include('--single-transaction')
  })

  it('redacts the password from text', () => {
    expect(redact('auth failed for topsecret', 'topsecret')).to.equal('auth failed for ***')
  })

  it('times out a tool that does not finish', async () => {
    try {
      await runPostgresTool({ binary: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], databaseUrl: 'postgres://u:topsecret@127.0.0.1/abs', timeoutMs: 200 })
      expect.fail('should time out')
    } catch (error) {
      expect(error.message).to.contain('timed out')
    }
  })

  it('reports a failing tool without its password', async () => {
    try {
      await runPostgresTool({ binary: process.execPath, args: ['-e', 'console.error("bad password topsecret"); process.exit(3)'], databaseUrl: 'postgres://u:topsecret@127.0.0.1/abs' })
      expect.fail('should fail')
    } catch (error) {
      expect(error.message).to.contain('exited with code 3')
      expect(error.message).to.not.contain('topsecret')
    }
  })
})
