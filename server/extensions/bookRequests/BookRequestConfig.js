const REQUIRED_KEYS = ['READARR_BASE_URL', 'READARR_API_KEY', 'READARR_ROOT_FOLDER_PATH', 'READARR_QUALITY_PROFILE_ID', 'READARR_METADATA_PROFILE_ID']

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseNumber(value) {
  const parsed = Number(value)
  if (isNaN(parsed)) return null
  return parsed
}

function getReadarrConfig() {
  const provider = String(process.env.BOOK_REQUESTS_PROVIDER || 'readarr').trim().toLowerCase()
  const enabled = parseBool(process.env.BOOK_REQUESTS_ENABLED, false)

  const config = {
    enabled,
    provider,
    readarr: {
      baseUrl: (process.env.READARR_BASE_URL || '').trim().replace(/\/$/, ''),
      apiKey: (process.env.READARR_API_KEY || '').trim(),
      rootFolderPath: (process.env.READARR_ROOT_FOLDER_PATH || '').trim(),
      qualityProfileId: parseNumber(process.env.READARR_QUALITY_PROFILE_ID),
      metadataProfileId: parseNumber(process.env.READARR_METADATA_PROFILE_ID),
      searchOnAdd: parseBool(process.env.READARR_SEARCH_ON_ADD, true),
      timeoutMs: parseNumber(process.env.READARR_TIMEOUT_MS) || 15000
    }
  }

  const missing = []
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      missing.push(key)
    }
  }

  if (config.readarr.qualityProfileId === null) missing.push('READARR_QUALITY_PROFILE_ID')
  if (config.readarr.metadataProfileId === null) missing.push('READARR_METADATA_PROFILE_ID')

  if (!enabled) {
    return {
      ...config,
      active: false,
      missing,
      reason: 'BOOK_REQUESTS_ENABLED is disabled'
    }
  }

  if (provider !== 'readarr') {
    return {
      ...config,
      active: false,
      missing,
      reason: `Unsupported provider "${provider}"`
    }
  }

  if (missing.length) {
    return {
      ...config,
      active: false,
      missing,
      reason: 'Missing required Readarr configuration'
    }
  }

  return {
    ...config,
    active: true,
    missing,
    reason: null
  }
}

module.exports = {
  getReadarrConfig
}
