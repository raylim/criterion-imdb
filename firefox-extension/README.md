# Criterion IMDb Overlay

Firefox extension MVP that overlays IMDb ratings and selected metadata on Criterion pages.

## What works now

- scans Criterion pages for film links
- extracts title/year and best-effort director/country hints from the page
- reads IMDb metadata from the bundled cache generated from `.cache/criterion-movies.html`
- caches results in extension local storage
- renders an inline overlay with rating, runtime, genres, and languages
- exposes an options page for display settings

## Load it in Firefox

1. Open `about:debugging`
2. Choose `This Firefox`
3. Click `Load Temporary Add-on`
4. Select [manifest.json](/Users/rlim/repos/criterion-imdb/firefox-extension/manifest.json)

## Notes

- The current content script is tuned for Criterion browse-style pages first, including `www.criterion.com` and `www.criterionchannel.com`.
- Cached score data is packaged from the generated Criterion HTML output in this repo.
- The next useful step is to test against live Criterion layouts and tighten the DOM selectors around real containers.
