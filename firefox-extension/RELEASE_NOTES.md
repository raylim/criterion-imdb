# Criterion IMDb Overlay Release Notes

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
