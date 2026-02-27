<template>
  <div class="page" :class="streamLibraryItem ? 'streaming' : ''">
    <app-book-shelf-toolbar is-home page="search" :search-query="query" />
    <div v-if="isBookLibrary && requestCapabilities.enabled" class="px-4 pt-4">
      <div class="rounded-md border border-black-300 bg-bg/60 p-3">
        <div class="flex items-center justify-between">
          <p class="font-semibold">{{ $strings.HeaderBookRequests }}</p>
          <p v-if="requestLoading" class="text-sm text-white/70">{{ $strings.MessageFetching }}</p>
        </div>
        <p class="text-sm text-white/70">{{ $strings.MessageBookRequestSearchHelp }}</p>
        <div v-if="requestResults.length" class="mt-3 space-y-2">
          <div v-for="result in requestResults" :key="result.foreignBookId" class="rounded border border-black-300 p-2">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="font-semibold">{{ result.title }}</p>
                <p class="text-xs text-white/70">{{ result.author }}</p>
                <p v-if="result.status === 'in_library'" class="text-xs text-warning">{{ $strings.LabelAlreadyInLibrary }}</p>
              </div>
              <ui-btn small :disabled="requestSubmitting[result.foreignBookId] || result.status === 'in_library'" :loading="requestSubmitting[result.foreignBookId]" @click="submitRequest(result)">
                {{ $strings.ButtonRequestBook }}
              </ui-btn>
            </div>
            <p v-if="result.localMatches?.length" class="mt-1 text-xs text-white/60">{{ $getString('MessageBookRequestMatchedItem', [result.localMatches[0].localItem.title]) }}</p>
          </div>
        </div>
        <p v-else-if="query && !requestLoading" class="mt-2 text-sm text-white/60">{{ $strings.MessageNoItemsFound }}</p>
      </div>
    </div>
    <app-book-shelf-categorized v-if="hasResults" ref="bookshelf" search :results="results" />
    <div v-else class="w-full py-16">
      <p class="text-xl text-center">{{ $getString('MessageNoSearchResultsFor', [query]) }}</p>
    </div>
  </div>
</template>

<script>
export default {
  async asyncData({ store, params, redirect, query, app }) {
    const libraryId = params.library
    const library = await store.dispatch('libraries/fetch', libraryId)
    if (!library) {
      return redirect('/oops?message=Library not found')
    }
    let results = await app.$axios.$get(`/api/libraries/${libraryId}/search?q=${encodeURIComponent(query.q)}`).catch((error) => {
      console.error('Failed to search library', error)
      return null
    })
    const isBookLibrary = library.mediaType === 'book'
    let requestCapabilities = { enabled: false }
    let requestResults = []
    if (isBookLibrary) {
      requestCapabilities = await app.$axios.$get(`/api/libraries/${libraryId}/book-requests/capabilities`).catch(() => ({ enabled: false }))
      if (requestCapabilities.enabled && query.q) {
        const requestResponse = await app.$axios.$get(`/api/libraries/${libraryId}/book-requests/search?q=${encodeURIComponent(query.q)}&limit=8`).catch(() => null)
        requestResults = requestResponse?.remote || []
      }
    }
    results = {
      podcasts: results?.podcast || [],
      episodes: results?.episodes || [],
      books: results?.book || [],
      authors: results?.authors || [],
      series: results?.series || [],
      tags: results?.tags || [],
      narrators: results?.narrators || []
    }
    return {
      libraryId,
      results,
      query: query.q,
      isBookLibrary,
      requestCapabilities,
      requestResults,
      requestLoading: false,
      requestSubmitting: {}
    }
  },
  data() {
    return {}
  },
  watch: {
    '$route.query'(newVal, oldVal) {
      if (newVal && newVal.q && newVal.q !== this.query) {
        this.query = newVal.q
        this.search()
      }
    }
  },
  computed: {
    streamLibraryItem() {
      return this.$store.state.streamLibraryItem
    },
    hasResults() {
      return Object.values(this.results).find((r) => !!r && r.length)
    }
  },
  methods: {
    async search() {
      const results = await this.$axios.$get(`/api/libraries/${this.libraryId}/search?q=${encodeURIComponent(this.query)}`).catch((error) => {
        console.error('Failed to search library', error)
        return null
      })
      this.results = {
        podcasts: results?.podcast || [],
        episodes: results?.episodes || [],
        books: results?.book || [],
        authors: results?.authors || [],
        series: results?.series || [],
        tags: results?.tags || [],
        narrators: results?.narrators || []
      }
      this.$nextTick(() => {
        if (this.$refs.bookshelf) {
          this.$refs.bookshelf.setShelvesFromSearch()
        }
      })

      if (this.isBookLibrary && this.requestCapabilities.enabled) {
        this.requestLoading = true
        const requestResponse = await this.$axios.$get(`/api/libraries/${this.libraryId}/book-requests/search?q=${encodeURIComponent(this.query)}&limit=8`).catch((error) => {
          console.error('Failed to search request candidates', error)
          return null
        })
        this.requestResults = requestResponse?.remote || []
        this.requestLoading = false
      }
    },
    async submitRequest(result) {
      this.$set(this.requestSubmitting, result.foreignBookId, true)
      const response = await this.$axios
        .$post(`/api/libraries/${this.libraryId}/book-requests`, {
          foreignBookId: result.foreignBookId,
          searchForNewBook: true,
          remoteBook: result.remoteBook
        })
        .catch((error) => {
          if (error?.response?.status === 409) {
            const code = error.response.data?.code
            if (code === 'ALREADY_IN_LIBRARY') {
              this.$toast.info(this.$strings.LabelAlreadyInLibrary)
            } else if (code === 'ALREADY_TRACKED_IN_READARR') {
              this.$toast.info(this.$strings.MessageBookAlreadyTracked)
            } else {
              this.$toast.error(this.$strings.ToastFailedToUpdate)
            }
          } else {
            this.$toast.error(this.$strings.ToastFailedToUpdate)
          }
          return null
        })
      this.$set(this.requestSubmitting, result.foreignBookId, false)
      if (response?.ok) {
        this.$toast.success(this.$strings.ToastBookRequestSubmitted)
      }
    }
  },
  mounted() {},
  beforeDestroy() {}
}
</script>
