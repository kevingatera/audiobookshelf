const Logger = require('../../Logger')
const libraryItemFilters = require('../../utils/queries/libraryItemFilters')
const { levenshteinSimilarity } = require('../../utils')
const ReadarrClient = require('./ReadarrClient')

const MIN_LOCAL_MATCH_SCORE = 0.82

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getPrimaryAuthor(value) {
  return String(value || '')
    .split(',')[0]
    .split('&')[0]
    .trim()
}

function computeMatchScore(localItem, remoteBook) {
  const localTitle = normalize(localItem.title)
  const remoteTitle = normalize(remoteBook.title)
  const localAuthor = normalize(getPrimaryAuthor(localItem.author))
  const remoteAuthor = normalize(getPrimaryAuthor(remoteBook.author))
  const titleScore = localTitle && remoteTitle ? levenshteinSimilarity(localTitle, remoteTitle) : 0
  const authorScore = localAuthor && remoteAuthor ? levenshteinSimilarity(localAuthor, remoteAuthor) : 0
  const combined = titleScore * 0.8 + authorScore * 0.2
  return {
    titleScore,
    authorScore,
    combined
  }
}

class BookRequestService {
  constructor(config) {
    this.config = config
    this.readarrClient = new ReadarrClient(config.readarr)
  }

  async search(user, library, query, limit = 12) {
    const localResults = await this.searchLocal(user, library, query, limit)
    const remoteResults = await this.readarrClient.lookupBooks(query)

    const mergedRemoteResults = remoteResults.map((book) => {
      const localMatches = localResults
        .map((localItem) => {
          const score = computeMatchScore(localItem, book)
          return {
            localItem,
            score
          }
        })
        .filter((candidate) => candidate.score.combined >= MIN_LOCAL_MATCH_SCORE)
        .sort((a, b) => b.score.combined - a.score.combined)
        .slice(0, 3)

      const localStatus = localMatches.length ? 'in_library' : 'not_in_library'

      return {
        source: 'readarr',
        foreignBookId: book.foreignBookId,
        title: book.title,
        author: book.author?.authorName || book.author?.name || '',
        releaseDate: book.releaseDate,
        remoteCover: book.remoteCover,
        titleSlug: book.titleSlug,
        remoteBook: book,
        status: localStatus,
        localMatches: localMatches.map((match) => ({
          score: Math.round(match.score.combined * 1000) / 1000,
          titleScore: Math.round(match.score.titleScore * 1000) / 1000,
          authorScore: Math.round(match.score.authorScore * 1000) / 1000,
          localItem: match.localItem
        }))
      }
    })

    return {
      query,
      local: localResults,
      remote: mergedRemoteResults
    }
  }

  async submit(user, library, foreignBookId, options = {}) {
    const searchForNewBook = options.searchForNewBook !== false
    const remoteBookHint = options.remoteBook || null

    let selectedBook = null
    if (remoteBookHint && typeof remoteBookHint === 'object') {
      if (remoteBookHint.foreignBookId === foreignBookId) {
        selectedBook = remoteBookHint
      }
    }

    if (!selectedBook) {
      const lookupResults = await this.readarrClient.lookupBooks(foreignBookId)
      selectedBook = lookupResults.find((book) => book.foreignBookId === foreignBookId) || lookupResults[0]
    }

    if (!selectedBook) {
      return {
        ok: false,
        status: 404,
        code: 'READARR_BOOK_NOT_FOUND',
        message: 'Readarr did not return a matching book for this request'
      }
    }

    const localSearch = await this.searchLocal(user, library, `${selectedBook.title} ${selectedBook.author?.authorName || ''}`, 8)
    const strongLocalMatch = localSearch
      .map((localItem) => ({ localItem, score: computeMatchScore(localItem, selectedBook) }))
      .find((item) => item.score.combined >= 0.92)

    if (strongLocalMatch) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_LIBRARY',
        message: 'A highly similar title already exists in your library',
        localItem: strongLocalMatch.localItem,
        matchScore: Math.round(strongLocalMatch.score.combined * 1000) / 1000
      }
    }

    const tracked = await this.findTrackedBook(selectedBook)
    if (tracked) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_TRACKED_IN_READARR',
        message: 'Book is already tracked in Readarr',
        readarrBook: tracked
      }
    }

    const addPayload = this.buildReadarrAddPayload(selectedBook, searchForNewBook)
    const added = await this.readarrClient.addBook(addPayload)

    Logger.info(
      `[BookRequest] User "${user.username}" requested "${selectedBook.title}" (${selectedBook.foreignBookId}) for library "${library.name}"`
    )

    return {
      ok: true,
      status: 201,
      code: 'REQUEST_SUBMITTED',
      message: 'Book request submitted to Readarr',
      readarrBook: added
    }
  }

  async searchLocal(user, library, query, limit) {
    const local = await libraryItemFilters.search(user, library, query, limit)
    const books = local?.book || []
    return books
      .map((entry) => {
        const libraryItem = entry.libraryItem
        const media = libraryItem?.media || {}
        return {
          id: libraryItem?.id,
          path: libraryItem?.path,
          title: media.title,
          author: media.authorName || media.authors?.[0]?.name || '',
          subtitle: media.subtitle || null,
          publishedYear: media.publishedYear || null,
          coverPath: media.coverPath || null
        }
      })
      .filter((entry) => entry.id && entry.title)
  }

  async findTrackedBook(remoteBook) {
    if (remoteBook?.id && Number(remoteBook.id) > 0) {
      return remoteBook
    }

    const bySlug = await this.readarrClient.getBooksByTitleSlug(remoteBook.titleSlug)
    if (!bySlug.length) return null

    const exactForeign = bySlug.find((book) => book.foreignBookId === remoteBook.foreignBookId)
    if (exactForeign) return exactForeign

    const remoteTitle = normalize(remoteBook.title)
    const remoteAuthor = normalize(remoteBook.author?.authorName || remoteBook.author?.name || '')
    const fuzzy = bySlug.find((book) => {
      const titleScore = levenshteinSimilarity(normalize(book.title), remoteTitle)
      const authorScore = levenshteinSimilarity(normalize(book.author?.authorName || book.author?.name || ''), remoteAuthor)
      return titleScore >= 0.92 && authorScore >= 0.7
    })

    return fuzzy || null
  }

  buildReadarrAddPayload(lookupBook, searchForNewBook) {
    const payload = JSON.parse(JSON.stringify(lookupBook))
    payload.monitored = true
    payload.addOptions = {
      addType: 'manual',
      searchForNewBook: !!searchForNewBook
    }

    if (!payload.author) {
      payload.author = {}
    }

    payload.author.monitored = true
    payload.author.monitorNewItems = 'none'
    payload.author.qualityProfileId = this.config.readarr.qualityProfileId
    payload.author.metadataProfileId = this.config.readarr.metadataProfileId
    payload.author.rootFolderPath = this.config.readarr.rootFolderPath
    payload.author.tags = payload.author.tags || []
    payload.author.addOptions = {
      monitor: 'specificBook',
      booksToMonitor: [lookupBook.foreignBookId],
      searchForMissingBooks: false
    }

    return payload
  }
}

module.exports = BookRequestService
