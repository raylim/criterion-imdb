# Quince Reservation Watcher

This script watches Quince's public SevenRooms availability endpoints and alerts you when a matching slot appears.

It can also open the exact SevenRooms search page for your date and party size, then try to click the matching slot for you. It does not attempt to bypass login, CAPTCHA, or final payment/confirmation steps.

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your target date, experience name, times, and party size
3. Run:

```bash
npm run watch:quince
```

## Example `.env`

```dotenv
TARGET_DATE=2026-04-01
PARTY_SIZE=2
EXPERIENCE_NAME=Gastronomy Menu
PREFERRED_TIMES=5:00 PM,5:30 PM,6:00 PM
AREA_KEYWORDS=Dining Room
CHECK_INTERVAL_MS=3000
RELEASE_AT=2026-04-01T10:00:00-07:00
AUTO_OPEN_BROWSER=true
HEADLESS=false
```

## Notes

- Quince's official site currently says reservations are released on the 1st of the prior month.
- `RELEASE_AT` is optional. If you set it, the script sleeps until that exact timestamp before it starts polling.
- The browser profile is stored in `.playwright-profile/` so your session can persist between runs.

## Criterion Movie Suggester

There is also a small script that scrapes the currently streaming film list from the Criterion Channel and suggests titles using IMDb ratings.

Run it with:

```bash
OMDB_API_KEY=your_key npm run movies:criterion -- --limit 15 --min-rating 8.3
```

Useful filters:

```bash
npm run movies:criterion -- --director kurosawa
npm run movies:criterion -- --country Japan --year-from 1950 --year-to 1980
npm run movies:criterion -- --title noir --max-lookups 100
OMDB_API_KEY=your_key npm run movies:criterion -- --limit all --html --open
```

Notes:

- The script caches title-to-IMDb matches in `.cache/criterion-imdb-cache.json` so later runs are much faster.
- `--max-lookups` is helpful if you want a quick first pass instead of resolving every filtered title.
- IMDb's public site and the old public metadata endpoint are both unreliable from this environment, so the script now uses an OMDb API key for IMDb ratings.
- `--html` writes a browsable page to `.cache/criterion-movies.html` by default, and `--open` opens it in your browser.
- The HTML page supports live filtering by search text, genre, language, year, runtime, and minimum IMDb rating.
