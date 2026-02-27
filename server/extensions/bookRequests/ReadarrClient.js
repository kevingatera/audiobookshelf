const axios = require('axios').default

class ReadarrClient {
  constructor(config) {
    this.config = config
    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      headers: {
        'X-Api-Key': this.config.apiKey
      }
    })
  }

  async lookupBooks(term) {
    try {
      const response = await this.client.get('/api/v1/book/lookup', {
        params: { term }
      })
      return Array.isArray(response.data) ? response.data : []
    } catch (error) {
      const response = await this.client.get('/api/v1/search', {
        params: { term }
      })
      const rows = Array.isArray(response.data) ? response.data : []
      return rows
        .map((row) => row.book)
        .filter((book) => !!book)
    }
  }

  async getBooksByTitleSlug(titleSlug) {
    if (!titleSlug) return []
    const response = await this.client.get('/api/v1/book', {
      params: { titleSlug }
    })
    return Array.isArray(response.data) ? response.data : []
  }

  async addBook(bookPayload) {
    const response = await this.client.post('/api/v1/book', bookPayload)
    return response.data
  }
}

module.exports = ReadarrClient
