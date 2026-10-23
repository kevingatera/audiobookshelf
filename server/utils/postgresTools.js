const { spawn } = require('child_process')
const path = require('path')

/**
 * Runs pg_dump and pg_restore for the Postgres backup path.
 *
 * - The password never goes in argv or in an error message. It is passed in PGPASSWORD.
 * - The rest of DATABASE_URL, including sslmode and other query parameters, is passed as the libpq conninfo.
 *   libpq understands every parameter, so none needs to be mapped by hand.
 * - Binaries come from PG_BIN_DIR when it is set, otherwise from PATH. The Docker image installs postgresql-client.
 */

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const KILL_GRACE_MS = 5000

/**
 * @param {string} databaseUrl postgres:// connection URL
 * @returns {{conninfo: string, password: string}}
 */
function splitConnection(databaseUrl) {
  const url = new URL(databaseUrl)
  const password = decodeURIComponent(url.password || '')
  url.password = ''
  return { conninfo: url.toString(), password }
}

/**
 * @param {string} text
 * @param {string} password
 */
function redact(text, password) {
  if (!password) return String(text)
  return String(text).split(password).join('***')
}

function binaryPath(name) {
  return process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, name) : name
}

/**
 * @param {object} options
 * @param {string} [options.name] pg_dump or pg_restore, resolved through PG_BIN_DIR
 * @param {string} [options.binary] full path override, used by tests
 * @param {string[]} options.args
 * @param {string} options.databaseUrl
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>} stdout
 */
function runPostgresTool({ name, binary, args, databaseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { password } = splitConnection(databaseUrl)
  const command = binary || binaryPath(name)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PGPASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(redact(`${command} failed to start: ${error.message}`, password)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)} seconds`))
      if (code !== 0) return reject(new Error(redact(`${path.basename(command)} exited with code ${code}: ${stderr.trim()}`, password)))
      resolve(stdout)
    })
  })
}

/**
 * Arguments for a custom-format dump. Ownership and ACLs are not dumped, so restores work for another role.
 * @param {string} databaseUrl
 * @param {string} file
 */
function dumpArgs(databaseUrl, file) {
  const { conninfo } = splitConnection(databaseUrl)
  return ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, `--dbname=${conninfo}`]
}

/**
 * --single-transaction with --exit-on-error means a failed restore rolls back and leaves the original data in place.
 * @param {string} databaseUrl
 * @param {string} file
 */
function restoreArgs(databaseUrl, file) {
  const { conninfo } = splitConnection(databaseUrl)
  return ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${conninfo}`, file]
}

module.exports = { splitConnection, redact, runPostgresTool, dumpArgs, restoreArgs, DEFAULT_TIMEOUT_MS }
