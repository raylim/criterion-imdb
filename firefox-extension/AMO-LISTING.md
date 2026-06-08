# AMO Listing Copy

Use this file as the source for a public AMO listing.

## Add-on name

Criterion IMDb Overlay

## Summary

Shows IMDb ratings and film metadata while you browse the Criterion Channel and Criterion film pages.

## Description

Criterion IMDb Overlay adds a lightweight IMDb badge to supported Criterion pages so you can see film ratings and a few useful details without leaving the page.

Features:

- Shows IMDb ratings directly on Criterion Channel and Criterion film listings
- Can also show runtime, genres, languages, director, and country
- Uses a repo-hosted Criterion score cache for fast lookups
- Falls back to public metadata services for missing titles when OMDb keys are configured
- Stores results locally to speed up repeated browsing

Notes:

- This is an unofficial fan-made extension and is not affiliated with Criterion, IMDb, or OMDb.
- Some titles may still appear without a rating if no reliable public match is available.
- Collection rows, editorial programs, and other non-film shelves are intentionally filtered where possible.

## Category suggestion

- Entertainment

## Support URL

https://github.com/raylim/criterion-imdb

## Homepage URL

https://raylim.github.io/criterion-imdb/

## Privacy policy URL

https://raylim.github.io/criterion-imdb/privacy.html

## Release notes

See:

- `firefox-extension/RELEASE_NOTES.md`

Suggested AMO version notes for 0.1.6:

- Fixed bundled-cache matching so reloaded add-ons pick up newly shipped score entries more reliably
- Improved badge clickthroughs for exact matches, low-confidence guesses, and titles whose IMDb page exists but is still unrated
- Refreshed cache coverage and low-confidence fallback data for missing Criterion titles including `Lumière, Le Cinéma!`
- Added stronger regression tests around stale cache reuse, bundled cache merging, duplicate-title slug matching, and overlay link behavior

## Reviewer notes

- The extension does not use a private backend.
- The hosted cache file is fetched from this repository’s GitHub Pages site.
- Optional OMDb fallback uses user-supplied OMDb API keys stored locally in Firefox extension storage.
- The extension also uses public IMDb suggestion and Stremio Cinemeta endpoints as fallback match helpers when direct cache resolution fails.
