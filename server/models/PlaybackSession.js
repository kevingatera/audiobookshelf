const { DataTypes, Model, Op, QueryTypes, fn, col } = require('sequelize')

const date = require('../libs/dateAndTime')
const oldPlaybackSession = require('../objects/PlaybackSession')

// SQLite returns JSON columns as text from raw queries; Postgres returns objects.
function parseJsonColumn(value) {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch (error) {
    return null
  }
}

class PlaybackSession extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.mediaItemId
    /** @type {string} */
    this.mediaItemType
    /** @type {string} */
    this.displayTitle
    /** @type {string} */
    this.displayAuthor
    /** @type {number} */
    this.duration
    /** @type {number} */
    this.playMethod
    /** @type {string} */
    this.mediaPlayer
    /** @type {number} */
    this.startTime
    /** @type {number} */
    this.currentTime
    /** @type {string} */
    this.serverVersion
    /** @type {string} */
    this.coverPath
    /** @type {number} */
    this.timeListening
    /** @type {Object} */
    this.mediaMetadata
    /** @type {string} */
    this.date
    /** @type {string} */
    this.dayOfWeek
    /** @type {Object} */
    this.extraData
    /** @type {UUIDV4} */
    this.userId
    /** @type {UUIDV4} */
    this.deviceId
    /** @type {UUIDV4} */
    this.libraryId
    /** @type {Date} */
    this.updatedAt
    /** @type {Date} */
    this.createdAt
  }

  /**
   * @param {object|null} where
   * @param {{ limit?: number, offset?: number, order?: Array }} [options]
   */
  static async getOldPlaybackSessions(where = null, options = {}) {
    const playbackSessions = await this.findAll({
      where,
      limit: options.limit ?? undefined,
      offset: options.offset ?? undefined,
      order: options.order ?? [['updatedAt', 'DESC']],
      include: [
        {
          model: this.sequelize.models.device
        }
      ]
    })
    return playbackSessions.map((session) => this.getOldPlaybackSession(session))
  }

  static countWithWhere(where = null) {
    return this.count({ where })
  }

  /**
   * Listening totals computed in the database. Only the per-item and recent
   * session lists are optional, so minified stats never load session rows.
   *
   * @param {string} userId
   * @param {{ includeItems?: boolean, includeRecentSessions?: boolean }} [options]
   * @returns {Promise<object>}
   */
  static async getListeningStats(userId, options = {}) {
    const includeItems = options.includeItems !== false
    const includeRecentSessions = options.includeRecentSessions !== false
    const today = date.format(new Date(), 'YYYY-MM-DD')
    const seconds = fn('SUM', col('timeListening'))
    const nonEmpty = (field) => ({ [field]: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } })

    const [totals, dayRows, dayOfWeekRows] = await Promise.all([
      this.findOne({ where: { userId }, attributes: [[seconds, 'seconds']], raw: true, hooks: false }),
      this.findAll({
        where: { userId, timeListening: { [Op.gt]: 0 }, ...nonEmpty('date') },
        attributes: ['date', [seconds, 'seconds']],
        group: ['date'],
        raw: true,
        hooks: false
      }),
      this.findAll({
        where: { userId, ...nonEmpty('dayOfWeek') },
        attributes: [['dayOfWeek', 'dayofweek'], [seconds, 'seconds']],
        group: ['dayOfWeek'],
        raw: true,
        hooks: false
      })
    ])

    const stats = {
      totalTime: Number(totals?.seconds) || 0,
      days: {},
      dayOfWeek: {},
      today: 0
    }
    for (const row of dayRows) stats.days[row.date] = Number(row.seconds) || 0
    for (const row of dayOfWeekRows) stats.dayOfWeek[row.dayofweek] = Number(row.seconds) || 0
    stats.today = stats.days[today] || 0

    if (includeItems) {
      stats.items = await this.getListeningItemTotals(userId)
    }
    if (includeRecentSessions) {
      stats.recentSessions = await this.getOldPlaybackSessions({ userId }, { limit: 10 })
    }
    return stats
  }

  /**
   * One row per library item: summed seconds plus the metadata and time of its
   * most recent session. Sessions without a library item id are left out.
   *
   * @param {string} userId
   * @returns {Promise<Object<string, object>>}
   */
  static async getListeningItemTotals(userId) {
    // No quoted identifiers: the production Postgres schema is lower case, so quoted camelCase names do not match it.
    // Output aliases are lower case too, so SQLite and Postgres return the same row keys.
    const libraryItemId = this.sequelize.getDialect() === 'postgres' ? `extraData->>'libraryItemId'` : `json_extract(extraData, '$.libraryItemId')`

    const rows = await this.sequelize.query(
      `SELECT libraryitemid, seconds, mediametadata, lastupdate FROM (
        SELECT ${libraryItemId} AS libraryitemid,
          mediaMetadata AS mediametadata,
          updatedAt AS lastupdate,
          SUM(timeListening) OVER (PARTITION BY ${libraryItemId}) AS seconds,
          ROW_NUMBER() OVER (PARTITION BY ${libraryItemId} ORDER BY updatedAt DESC) AS rn
        FROM ${this.getTableName()}
        WHERE userId = :userId AND ${libraryItemId} IS NOT NULL
      ) AS ranked WHERE rn = 1`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    )

    // Normalize the lower-case aliases back to the camelCase shape the API returns.
    const items = {}
    for (const row of rows) {
      items[row.libraryitemid] = {
        id: row.libraryitemid,
        timeListening: Number(row.seconds) || 0,
        mediaMetadata: parseJsonColumn(row.mediametadata),
        lastUpdate: new Date(row.lastupdate).valueOf()
      }
    }
    return items
  }

  static async getById(sessionId) {
    const playbackSession = await this.findByPk(sessionId, {
      include: [
        {
          model: this.sequelize.models.device
        }
      ]
    })
    if (!playbackSession) return null
    return this.getOldPlaybackSession(playbackSession)
  }

  static getOldPlaybackSession(playbackSessionExpanded) {
    const isPodcastEpisode = playbackSessionExpanded.mediaItemType === 'podcastEpisode'

    return new oldPlaybackSession({
      id: playbackSessionExpanded.id,
      userId: playbackSessionExpanded.userId,
      libraryId: playbackSessionExpanded.libraryId,
      libraryItemId: playbackSessionExpanded.extraData?.libraryItemId || null,
      bookId: isPodcastEpisode ? null : playbackSessionExpanded.mediaItemId,
      episodeId: isPodcastEpisode ? playbackSessionExpanded.mediaItemId : null,
      mediaType: isPodcastEpisode ? 'podcast' : 'book',
      mediaMetadata: playbackSessionExpanded.mediaMetadata,
      chapters: null,
      displayTitle: playbackSessionExpanded.displayTitle,
      displayAuthor: playbackSessionExpanded.displayAuthor,
      coverPath: playbackSessionExpanded.coverPath,
      duration: playbackSessionExpanded.duration,
      playMethod: playbackSessionExpanded.playMethod,
      mediaPlayer: playbackSessionExpanded.mediaPlayer,
      deviceInfo: playbackSessionExpanded.device?.getOldDevice() || null,
      serverVersion: playbackSessionExpanded.serverVersion,
      date: playbackSessionExpanded.date,
      dayOfWeek: playbackSessionExpanded.dayOfWeek,
      timeListening: playbackSessionExpanded.timeListening,
      startTime: playbackSessionExpanded.startTime,
      currentTime: playbackSessionExpanded.currentTime,
      startedAt: playbackSessionExpanded.createdAt.valueOf(),
      updatedAt: playbackSessionExpanded.updatedAt.valueOf()
    })
  }

  static removeById(sessionId) {
    return this.destroy({
      where: {
        id: sessionId
      }
    })
  }

  static createFromOld(oldPlaybackSession) {
    const playbackSession = this.getFromOld(oldPlaybackSession)
    return this.upsert(playbackSession, {
      silent: true
    })
  }

  static updateFromOld(oldPlaybackSession) {
    const playbackSession = this.getFromOld(oldPlaybackSession)
    return this.update(playbackSession, {
      where: {
        id: playbackSession.id
      },
      silent: true
    })
  }

  static getFromOld(oldPlaybackSession) {
    return {
      id: oldPlaybackSession.id,
      mediaItemId: oldPlaybackSession.episodeId || oldPlaybackSession.bookId,
      mediaItemType: oldPlaybackSession.episodeId ? 'podcastEpisode' : 'book',
      libraryId: oldPlaybackSession.libraryId,
      displayTitle: oldPlaybackSession.displayTitle,
      displayAuthor: oldPlaybackSession.displayAuthor,
      duration: oldPlaybackSession.duration,
      playMethod: oldPlaybackSession.playMethod,
      mediaPlayer: oldPlaybackSession.mediaPlayer,
      startTime: oldPlaybackSession.startTime,
      currentTime: oldPlaybackSession.currentTime,
      serverVersion: oldPlaybackSession.serverVersion || null,
      createdAt: oldPlaybackSession.startedAt,
      updatedAt: oldPlaybackSession.updatedAt,
      userId: oldPlaybackSession.userId,
      deviceId: oldPlaybackSession.deviceInfo?.id || null,
      timeListening: oldPlaybackSession.timeListening,
      coverPath: oldPlaybackSession.coverPath,
      mediaMetadata: oldPlaybackSession.mediaMetadata,
      date: oldPlaybackSession.date,
      dayOfWeek: oldPlaybackSession.dayOfWeek,
      extraData: {
        libraryItemId: oldPlaybackSession.libraryItemId
      }
    }
  }

  getMediaItem(options) {
    if (!this.mediaItemType) return Promise.resolve(null)
    const mixinMethodName = `get${this.sequelize.uppercaseFirst(this.mediaItemType)}`
    return this[mixinMethodName](options)
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        mediaItemId: DataTypes.UUID,
        mediaItemType: DataTypes.STRING,
        displayTitle: DataTypes.STRING,
        displayAuthor: DataTypes.STRING,
        duration: DataTypes.FLOAT,
        playMethod: DataTypes.INTEGER,
        mediaPlayer: DataTypes.STRING,
        startTime: DataTypes.FLOAT,
        currentTime: DataTypes.FLOAT,
        serverVersion: DataTypes.STRING,
        coverPath: DataTypes.STRING,
        timeListening: DataTypes.INTEGER,
        mediaMetadata: DataTypes.JSON,
        date: DataTypes.STRING,
        dayOfWeek: DataTypes.STRING,
        extraData: DataTypes.JSON
      },
      {
        sequelize,
        modelName: 'playbackSession'
      }
    )

    const { book, podcastEpisode, user, device, library } = sequelize.models

    user.hasMany(PlaybackSession)
    PlaybackSession.belongsTo(user)

    device.hasMany(PlaybackSession)
    PlaybackSession.belongsTo(device)

    library.hasMany(PlaybackSession)
    PlaybackSession.belongsTo(library)

    book.hasMany(PlaybackSession, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'book'
      }
    })
    PlaybackSession.belongsTo(book, { foreignKey: 'mediaItemId', constraints: false })

    podcastEpisode.hasOne(PlaybackSession, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'podcastEpisode'
      }
    })
    PlaybackSession.belongsTo(podcastEpisode, { foreignKey: 'mediaItemId', constraints: false })

    PlaybackSession.addHook('afterFind', (findResult) => {
      if (!findResult) return

      if (!Array.isArray(findResult)) findResult = [findResult]

      for (const instance of findResult) {
        if (instance.mediaItemType === 'book' && instance.book !== undefined) {
          instance.mediaItem = instance.book
          instance.dataValues.mediaItem = instance.dataValues.book
        } else if (instance.mediaItemType === 'podcastEpisode' && instance.podcastEpisode !== undefined) {
          instance.mediaItem = instance.podcastEpisode
          instance.dataValues.mediaItem = instance.dataValues.podcastEpisode
        }
        // To prevent mistakes:
        delete instance.book
        delete instance.dataValues.book
        delete instance.podcastEpisode
        delete instance.dataValues.podcastEpisode
      }
    })
  }
}

module.exports = PlaybackSession
