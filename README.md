# Criterion IMDb

Tools for keeping a Criterion Channel title database mapped to IMDb metadata, generating a browsable local report, and powering a Firefox extension that overlays ratings on Criterion pages.

## What This Repo Contains

- `criterion-imdb-suggester.js`
  Crawls Criterion Channel film data, resolves titles to IMDb via OMDb, writes local caches, and generates an HTML report.
- `firefox-extension/`
  Firefox add-on that overlays IMDb ratings and metadata on Criterion pages.
- `scripts/refresh-cache.sh`
  End-to-end refresh script for rebuilding the local cache, report, extension dataset, and hosted JSON.
- `docs/criterion-cache.json`
  Repo-hosted cache artifact that the extension can fetch remotely after installation.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `/Users/rlim/.criterion-imdb.env` with your OMDb keys:

```dotenv
OMDB_API_KEYS=key1,key2,key3,key4
```

## Main Commands

Run an ad hoc Criterion search:

```bash
npm run movies:criterion -- --title noir --limit 20
```

Generate a full refreshed dataset:

```bash
npm run refresh:criterion
```

Refresh and open the HTML report:

```bash
npm run refresh:criterion:open
```

## Outputs

Tracked outputs:

- `.cache/criterion-imdb-cache.json`
- `.cache/criterion-imdb-unresolved.json`
- `.cache/criterion-movies.html`
- `firefox-extension/data/criterion-cache.json`
- `docs/criterion-cache.json`

The refresh script now crawls:

- `https://films.criterionchannel.com/`
- public browse pages on `https://www.criterionchannel.com/browse`
- linked collection pages
- explicit supplemental URLs from `criterion-imdb-supplemental-urls.json`

## Firefox Extension

The Firefox add-on lives in `firefox-extension/`.

Current behavior:

- overlays cached IMDb data on Criterion pages
- prefers the repo-hosted cache from GitHub Pages / raw GitHub
- falls back to the bundled cache inside the extension

That means ordinary score refreshes do not require a newly signed extension once the remote-cache version is installed.

## Publishing Score Updates

After running:

```bash
npm run refresh:criterion
```

push the repo updates to GitHub so `docs/criterion-cache.json` is updated remotely. Then in Firefox, use the extension option:

- `Fetch latest scores from GitHub`

## Notes

- Some Criterion collection pages expose episode-style or collection-scoped video URLs; the crawler dedupes those against direct film pages where possible.
- `criterion-imdb-aliases.json`, `criterion-imdb-manual.json`, and `criterion-imdb-supplemental-urls.json` are the override files for tricky titles and missing browse coverage.
