const Sequelize = require('sequelize')
const Logger = require('../../Logger')
const Database = require('../../Database')
const libraryItemsBookFilters = require('./libraryItemsBookFilters')

/**
 * Subquery attribute with an output alias. The alias is quoted by the adapter so Postgres keeps its case.
 * @param {string} expression
 * @param {string} alias
 */
function aliasedLiteral(expression, alias) {
  return Sequelize.literal(`${expression} AS ${Database.adapter.aliasAs(alias)}`)
}

module.exports = {
  decode(text) {
    try {
      return Buffer.from(decodeURIComponent(text), 'base64').toString()
    } catch (error) {
      Logger.warn(`[seriesFilters] Failed to decode filter value "${text}": ${error.message}`)
      return null
    }
  },

  /**
   * Get series filtered and sorted
   *
   * @param {import('../../models/Library')} library
   * @param {import('../../models/User')} user
   * @param {string} filterBy
   * @param {string} sortBy
   * @param {boolean} sortDesc
   * @param {string[]} include
   * @param {number} limit
   * @param {number} offset
   * @returns {Promise<{ series:object[], count:number }>}
   */
  async getFilteredSeries(library, user, filterBy, sortBy, sortDesc, include, limit, offset) {
    let filterValue = null
    let filterGroup = null
    if (filterBy) {
      const searchGroups = ['genres', 'tags', 'authors', 'progress', 'narrators', 'publishers', 'languages']
      const group = searchGroups.find((_group) => filterBy.startsWith(_group + '.'))
      filterGroup = group || filterBy
      filterValue = group ? this.decode(filterBy.replace(`${group}.`, '')) : null
    }

    const seriesIncludes = []
    if (include.includes('rssfeed')) {
      seriesIncludes.push({
        model: Database.feedModel
      })
    }

    const userPermissionBookWhere = libraryItemsBookFilters.getUserPermissionBookWhereQuery(user)

    const seriesWhere = [
      {
        libraryId: library.id
      }
    ]

    // Handle library setting to hide single book series
    // TODO: Merge with existing query
    if (library.settings.hideSingleBookSeries) {
      seriesWhere.push(
        Sequelize.where(Sequelize.literal(`(SELECT count(*) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND bs.bookId = b.id)`), {
          [Sequelize.Op.gt]: 1
        })
      )
    }

    // Handle filters
    // TODO: Simplify and break-out
    let attrQuery = null
    if (['genres', 'tags', 'narrators'].includes(filterGroup)) {
      attrQuery = `SELECT count(*) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND bs.bookId = b.id AND ${Database.adapter.jsonArrayContainsValue(`b.${filterGroup}`, 'filterValue')} > 0`
      userPermissionBookWhere.replacements.filterValue = filterValue
    } else if (filterGroup === 'authors') {
      attrQuery = 'SELECT count(*) FROM books b, bookSeries bs, bookAuthors ba WHERE bs.seriesId = series.id AND bs.bookId = b.id AND ba.bookId = b.id AND ba.authorId = :filterValue'
      userPermissionBookWhere.replacements.filterValue = filterValue
    } else if (filterGroup === 'publishers') {
      attrQuery = 'SELECT count(*) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND bs.bookId = b.id AND b.publisher = :filterValue'
      userPermissionBookWhere.replacements.filterValue = filterValue
    } else if (filterGroup === 'languages') {
      attrQuery = 'SELECT count(*) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND bs.bookId = b.id AND b.language = :filterValue'
      userPermissionBookWhere.replacements.filterValue = filterValue
    } else if (filterGroup === 'progress') {
      if (filterValue === 'not-finished') {
        attrQuery = 'SELECT count(*) FROM books b INNER JOIN bookSeries bs ON bs.bookId = b.id LEFT OUTER JOIN mediaProgresses mp ON mp.mediaItemId = b.id AND mp.userId = :userId WHERE bs.seriesId = series.id AND bs.bookId = b.id AND (mp.isFinished IS NULL OR mp.isFinished = ' + Database.adapter.bool(false) + ')'
        userPermissionBookWhere.replacements.userId = user.id
      } else if (filterValue === 'finished') {
        const progQuery = 'SELECT count(*) FROM books b INNER JOIN bookSeries bs ON bs.bookId = b.id LEFT OUTER JOIN mediaProgresses mp ON mp.mediaItemId = b.id AND mp.userId = :userId WHERE bs.seriesId = series.id AND bs.bookId = b.id AND (mp.isFinished IS NULL OR mp.isFinished = ' + Database.adapter.bool(false) + ')'
        seriesWhere.push(Sequelize.where(Sequelize.literal(`(${progQuery})`), 0))
        userPermissionBookWhere.replacements.userId = user.id
      } else if (filterValue === 'not-started') {
        const progQuery = 'SELECT count(*) FROM books b INNER JOIN bookSeries bs ON bs.bookId = b.id LEFT OUTER JOIN mediaProgresses mp ON mp.mediaItemId = b.id AND mp.userId = :userId WHERE bs.seriesId = series.id AND bs.bookId = b.id AND (mp.isFinished = ' + Database.adapter.bool(true) + ' OR mp.currentTime > 0)'
        seriesWhere.push(Sequelize.where(Sequelize.literal(`(${progQuery})`), 0))
        userPermissionBookWhere.replacements.userId = user.id
      } else if (filterValue === 'in-progress') {
        attrQuery = 'SELECT count(*) FROM books b INNER JOIN bookSeries bs ON bs.bookId = b.id LEFT OUTER JOIN mediaProgresses mp ON mp.mediaItemId = b.id AND mp.userId = :userId WHERE bs.seriesId = series.id AND bs.bookId = b.id AND (mp.currentTime > 0 OR mp.ebookProgress > 0) AND mp.isFinished = ' + Database.adapter.bool(false)
        userPermissionBookWhere.replacements.userId = user.id
      }
    }

    // Handle user permissions to only include series with at least 1 book
    // TODO: Simplify to a single query
    if (userPermissionBookWhere.bookWhere.length) {
      if (!attrQuery) attrQuery = 'SELECT count(*) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND bs.bookId = b.id'

      if (!user.canAccessExplicitContent) {
        attrQuery += ` AND b.explicit = ${Database.adapter.bool(false)}`
      }
      if (!user.permissions?.accessAllTags && user.permissions?.itemTagsSelected?.length) {
        if (user.permissions.selectedTagsNotAccessible) {
          attrQuery += ` AND ${Database.adapter.jsonArrayContainsAny('tags', 'userTagsSelected')} = 0`
        } else {
          attrQuery += ` AND ${Database.adapter.jsonArrayContainsAny('tags', 'userTagsSelected')} > 0`
        }
      }
    }

    if (attrQuery) {
      seriesWhere.push(
        Sequelize.where(Sequelize.literal(`(${attrQuery})`), {
          [Sequelize.Op.gt]: 0
        })
      )
    }

    const order = []
    let seriesAttributes = {
      include: []
    }

    // Handle sort order
    const dir = sortDesc ? 'DESC' : 'ASC'
    if (sortBy === 'numBooks') {
      seriesAttributes.include.push(aliasedLiteral('(SELECT count(*) FROM bookSeries bs WHERE bs.seriesId = series.id)', 'numBooks'))
      order.push([Sequelize.literal(Database.adapter.aliasAs('numBooks')), dir])
    } else if (sortBy === 'addedAt') {
      order.push(['createdAt', dir])
    } else if (sortBy === 'name') {
      if (global.ServerSettings.sortingIgnorePrefix) {
        order.push([Sequelize.literal(Database.adapter.noCaseOrder('nameIgnorePrefix')), dir])
      } else {
        order.push([Sequelize.literal(Database.adapter.noCaseOrder(Database.adapter.column('series', 'name'))), dir])
      }
    } else if (sortBy === 'totalDuration') {
      seriesAttributes.include.push(aliasedLiteral('(SELECT SUM(b.duration) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND b.id = bs.bookId)', 'totalDuration'))
      order.push([Sequelize.literal(Database.adapter.aliasAs('totalDuration')), dir])
    } else if (sortBy === 'lastBookAdded') {
      seriesAttributes.include.push(aliasedLiteral('(SELECT MAX(b.createdAt) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND b.id = bs.bookId)', 'mostRecentBookAdded'))
      order.push([Sequelize.literal(Database.adapter.aliasAs('mostRecentBookAdded')), dir])
    } else if (sortBy === 'lastBookUpdated') {
      seriesAttributes.include.push(aliasedLiteral('(SELECT MAX(b.updatedAt) FROM books b, bookSeries bs WHERE bs.seriesId = series.id AND b.id = bs.bookId)', 'mostRecentBookUpdated'))
      order.push([Sequelize.literal(Database.adapter.aliasAs('mostRecentBookUpdated')), dir])
    } else if (sortBy === 'random') {
      order.push(Database.sequelize.random())
    }

    const { rows: series, count } = await Database.seriesModel.findAndCountAll({
      where: seriesWhere,
      limit,
      offset,
      distinct: true,
      subQuery: false,
      attributes: seriesAttributes,
      replacements: userPermissionBookWhere.replacements,
      include: [
        {
          model: Database.bookSeriesModel,
          include: {
            model: Database.bookModel,
            where: userPermissionBookWhere.bookWhere,
            include: [
              {
                model: Database.libraryItemModel
              },
              {
                model: Database.authorModel
              },
              {
                model: Database.seriesModel
              }
            ]
          },
          separate: true
        },
        ...seriesIncludes
      ],
      order
    })

    // Map series to old series
    const allOldSeries = []

    // Postgres does not keep an unknown SELECT alias on the model instance, so read the totals with a grouped query.
    let totalDurationBySeriesId = new Map()
    if (sortBy === 'totalDuration' && series.length && series.some((s) => s.dataValues.totalDuration === undefined)) {
      const totals = await Database.sequelize.query(
        `SELECT bs.seriesId AS ${Database.adapter.aliasAs('seriesId')}, SUM(b.duration) AS ${Database.adapter.aliasAs('totalDuration')} FROM books b, bookSeries bs WHERE bs.seriesId IN (:seriesIds) AND b.id = bs.bookId GROUP BY bs.seriesId`,
        { replacements: { seriesIds: series.map((s) => s.id) }, type: Sequelize.QueryTypes.SELECT }
      )
      totalDurationBySeriesId = new Map(totals.map((row) => [row.seriesId, row.totalDuration]))
    }

    for (const s of series) {
      const oldSeries = s.toOldJSON()

      const totalDuration = s.dataValues.totalDuration ?? totalDurationBySeriesId.get(s.id)
      if (totalDuration) {
        oldSeries.totalDuration = totalDuration
      }

      if (s.feeds?.length) {
        oldSeries.rssFeed = s.feeds[0].toOldJSONMinified()
      }

      // TODO: Sort books by sequence in query
      s.bookSeries.sort((a, b) => {
        if (!a.sequence) return 1
        if (!b.sequence) return -1
        return a.sequence.localeCompare(b.sequence, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      })
      oldSeries.books = s.bookSeries.map((bs) => {
        const libraryItem = bs.book.libraryItem
        delete bs.book.libraryItem
        libraryItem.media = bs.book
        const oldLibraryItem = libraryItem.toOldJSONMinified()
        return oldLibraryItem
      })
      allOldSeries.push(oldSeries)
    }

    return {
      series: allOldSeries,
      count
    }
  }
}
