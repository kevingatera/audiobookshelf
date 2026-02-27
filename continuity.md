# Continuity Notes

Last updated: 2026-02-28

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

## Open PR prep notes (for upstream later)

- Split into logical PRs if possible:
  1. Server extension + routes
  2. Web UI request entry points
  3. Mobile UX/performance adjustments
- Keep defaults non-breaking when feature env vars are unset.
- Include clear docs that this feature is disabled by default.
