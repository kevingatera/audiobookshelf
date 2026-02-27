# Continuity Notes

Last updated: 2026-02-28 (late)

## Branch and deployment state

- Working branch for homelab server/web customizations: `homelab`
- Book-request feature changes were added and pushed to homelab-related branches.
- Homelab image workflow (`Homelab Docker Build`) has completed successfully for the related updates.

## Readarr request feature context

- Added modular request integration under `server/extensions/bookRequests/`.
- New server routes were added under library context in `server/routers/ApiRouter.js`.
- Config is env-driven (no schema/db migration required):
  - `BOOK_REQUESTS_ENABLED`
  - `BOOK_REQUESTS_PROVIDER`
  - `READARR_BASE_URL`
  - `READARR_API_KEY`
  - `READARR_ROOT_FOLDER_PATH`
  - `READARR_QUALITY_PROFILE_ID`
  - `READARR_METADATA_PROFILE_ID`
  - `READARR_SEARCH_ON_ADD`
  - `READARR_TIMEOUT_MS`

## Why this implementation style

- Keep upgrade surface small for future upstream rebases.
- Avoid invasive settings schema or DB migrations for v1.
- Keep provider-specific behavior isolated behind extension files.

## App/home performance findings relevant to server PR planning

- Mobile home cold experience improved most by reducing first personalized payload cost and rendering above-the-fold shelves first.
- `include=rssfeed` can materially hurt cold personalized responses in some runs.
- Hybrid model chosen: fast first paint first, then background RSS metadata hydration for visible shelves.
- Server-side Discover shelf now uses a short-lived cache (`PERSONALIZED_DISCOVER_CACHE_MS`, default 10 minutes) keyed by library/user/include/limit to avoid repeating expensive cold Discover queries after personalized cache invalidation.
- Personalized endpoint now supports optional shelf filtering via `?shelves=...` (comma-separated shelf ids) to allow fast first-paint subset fetches from clients without changing default behavior.
- Remaining production bottleneck signature in logs:
  - Full personalized requests can still spike to ~3.8s after cache invalidation events.
  - `Discover` remains the dominant expensive shelf during spikes (~2.7s to ~3.5s).
  - Spikes correlate with cache clears from playback/progress updates (`mediaProgress.afterUpdate`, `playbackSession.afterBulkUpdate`, and global `Array.afterUpsert`).
  - Dual personalized misses (`include=numEpisodesIncomplete` + `include=rssfeed`) amplify the effect.

## Suggested next server-safe optimizations

- Add in-flight request coalescing for identical personalized cache keys.
- Narrow cache invalidation scope for progress-related updates to avoid broad personalized flushes.
- Support shelf-filtered RSS hydration requests from clients to avoid full 7-shelf recomputation when only top shelves need metadata.

## Latest findings + fix applied

- Observed intermittent `Array.afterUpsert: Clearing cache` events in `ApiCacheManager` during playback/progress updates.
- Root cause: Sequelize hook payload can be an array/tuple; cache invalidation logic treated model name as `Array`, causing full cache clears instead of high-churn slice clears.
- Fix applied: `ApiCacheManager.getModelName` now unwraps array hook payloads and resolves the underlying model before invalidation.

## Open PR prep notes (for upstream later)

- Split into logical PRs if possible:
  1. Server extension + routes
  2. Web UI request entry points
  3. Mobile UX/performance adjustments
- Keep defaults non-breaking when feature env vars are unset.
- Include clear docs that this feature is disabled by default.
