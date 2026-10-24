/**
 * Maintenance window for a Postgres restore on this instance. While it is open, HTTP requests and socket traffic
 * are answered with 503, so nothing from this instance reaches the database while pg_restore runs.
 */

let active = false

/**
 * Opens the window. Returns false when one is already open on this instance.
 * @returns {boolean}
 */
function begin() {
  if (active) return false
  active = true
  return true
}

function end() {
  active = false
}

/** Express middleware. Mount before every route. */
function middleware(req, res, next) {
  if (!active) return next()
  res.status(503).send('Restore in progress. Try again shortly.')
}

/** socket.io connection middleware (io.use). */
function socketMiddleware(socket, next) {
  if (!active) return next()
  next(new Error('503: Restore in progress. Try again shortly.'))
}

/** socket.io incoming event middleware (socket.use). */
function packetMiddleware(packet, next) {
  if (!active) return next()
  next(new Error('503: Restore in progress. Try again shortly.'))
}

module.exports = {
  begin,
  end,
  get active() {
    return active
  },
  middleware,
  socketMiddleware,
  packetMiddleware
}
