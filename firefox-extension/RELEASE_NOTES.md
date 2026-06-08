# Criterion IMDb Overlay Release Notes

## 0.1.6

Release date: 2026-06-08

### Highlights

- Fixed bundled-cache matching regressions that could leave valid titles without a badge, including duplicate-title slugs such as `The Postman Always Rings Twice`.
- Improved badge behavior with clickable IMDb links, better handling for pending or unrated titles, and less ambiguous low-confidence messaging.
- Ensured bundled cache updates are merged even when Firefox still has an older hosted cache stored locally, so add-on reloads pick up newly shipped entries right away.
- Added and refreshed cache coverage for missing titles including `Lumière, Le Cinéma!`, with low-confidence fallback metadata when upstream sources disagree.
- Bumped matcher cache invalidation and expanded regression coverage around stale cache reuse, bundled cache merging, clickthrough behavior, and accented-title matching.

## 0.1.5

Release date: 2026-06-06

### Highlights

- Improved overlay matching and refreshed the bundled and hosted Criterion score cache.
- Added low-confidence "best guess" handling for titles with ambiguous public metadata matches.
- Improved refresh infrastructure with incremental browse caching and safer bounded lookup behavior.
- Fixed CI packaging and deployment so extension artifacts and GitHub Pages updates build reliably across environments.
- Includes public release metadata and hosted support/privacy assets.

## 0.1.4

Release date: 2026-06-04

### Highlights

- Version bump for AMO listed-channel submission retry
- No code changes from 0.1.3

## 0.1.3

Release date: 2026-06-04

### Highlights

- Public-release preparation update for the AMO-listed channel
- Added public listing support files, homepage metadata, and hosted privacy policy
- Keeps the remote-cache refresh flow, OMDb fallback, and regression-tested overlay behavior from 0.1.2

## 0.1.2

Release date: 2026-06-04

### Highlights

- Added a remote-cache update path so the extension can fetch refreshed score data from GitHub without requiring a new add-on package for ordinary data updates.
- Added a direct OMDb fallback path for titles missing from the bundled or hosted Criterion cache, with local result caching for repeated lookups.
- Improved browse and collection scraping, including better handling for collection-scoped video pages, series cards, and row-level exclusions.
- Reduced noisy badges on non-film rows such as `Talking About Movies`, `Archival Treasures`, and `Observations on Film Art`.
- Improved overlay responsiveness by prioritizing visible cards first and deferring below-the-fold OMDb fallback work.
- Added a regression test suite covering overlay cleanup, deferred batching, row exclusions, series extraction, and OMDb fallback cache freshness.

### User-visible changes

- Most cached ratings should appear faster on page load.
- OMDb fallback results should be reused more reliably across shelves and repeated visits.
- Debug-only status UI is hidden by default and can be re-enabled from extension options.
- Hosted score refreshes can be pulled from the extension options UI with `Fetch latest scores from GitHub`.

### Privacy / data

- The extension does not collect or transmit user browsing data to a custom backend.
- Optional OMDb fallback requests are sent only to public metadata services already used by the extension:
  - `omdbapi.com`
  - IMDb suggestion endpoints
  - Stremio Cinemeta fallback search
