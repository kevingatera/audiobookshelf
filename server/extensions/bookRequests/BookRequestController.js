const Logger = require('../../Logger')
const { ValidationError, getQueryParamAsString } = require('../../utils')
const { getReadarrConfig } = require('./BookRequestConfig')
const BookRequestService = require('./BookRequestService')

class BookRequestController {
  getCapabilities(req, res) {
    const config = getReadarrConfig()
    return res.json({
      enabled: config.active,
      provider: config.provider,
      reason: config.reason,
      missing: config.missing,
      defaults: config.active
        ? {
            searchOnAdd: config.readarr.searchOnAdd
          }
        : null
    })
  }

  async search(req, res) {
    const config = getReadarrConfig()
    if (!config.active) {
      return res.status(503).json({
        error: config.reason || 'Book request integration is not configured',
        missing: config.missing
      })
    }

    try {
      const query = getQueryParamAsString(req.query, 'q', '', true, 250)
      const limitRaw = getQueryParamAsString(req.query, 'limit', '12', false, 3)
      const limit = Math.min(25, Math.max(1, Number(limitRaw) || 12))

      const service = new BookRequestService(config)
      const results = await service.search(req.user, req.library, query, limit)
      return res.json(results)
    } catch (error) {
      if (error instanceof ValidationError) {
        return res.status(400).json({ error: error.message })
      }
      const status = error?.response?.status || 500
      const details = error?.response?.data || null
      Logger.error('[BookRequestController] search failed', error?.message || error)
      return res.status(status).json({
        error: 'Book request search failed',
        details
      })
    }
  }

  async submit(req, res) {
    const config = getReadarrConfig()
    if (!config.active) {
      return res.status(503).json({
        error: config.reason || 'Book request integration is not configured',
        missing: config.missing
      })
    }

    const foreignBookId = req.body?.foreignBookId
    if (!foreignBookId || typeof foreignBookId !== 'string') {
      return res.status(400).json({ error: 'foreignBookId is required' })
    }

    try {
      const service = new BookRequestService(config)
      const result = await service.submit(req.user, req.library, foreignBookId, {
        searchForNewBook: req.body?.searchForNewBook !== false,
        remoteBook: req.body?.remoteBook
      })
      return res.status(result.status).json(result)
    } catch (error) {
      const status = error?.response?.status || 500
      const details = error?.response?.data || null
      Logger.error('[BookRequestController] submit failed', error?.message || error)
      return res.status(status).json({
        ok: false,
        error: 'Book request submit failed',
        details
      })
    }
  }
}

module.exports = new BookRequestController()
