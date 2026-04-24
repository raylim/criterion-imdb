#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CRITERION_FILMS_URL = "https://films.criterionchannel.com/";
const DEFAULT_CACHE_FILE = path.join(__dirname, ".cache", "criterion-imdb-cache.json");
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_HTML_FILE = path.join(__dirname, ".cache", "criterion-movies.html");
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MATCHER_VERSION = 5;
const ALLOWED_IMDB_KINDS = new Set(["movie", "feature", "TV movie", "tvMovie", "short", "tvShort", "tvSpecial"]);
const REQUEST_TIMEOUT_MS = 15000;
const OMDB_API_URL = "https://www.omdbapi.com/";

function parseArgs(argv) {
  const args = {
    limit: 20,
    minRating: 8.0,
    yearFrom: null,
    yearTo: null,
    director: "",
    country: "",
    title: "",
    maxLookups: Infinity,
    concurrency: DEFAULT_CONCURRENCY,
    refresh: false,
    cacheFile: DEFAULT_CACHE_FILE,
    omdbApiKeys: parseOmdbKeys(process.env.OMDB_API_KEYS || process.env.OMDB_API_KEY || ""),
    html: false,
    htmlFile: DEFAULT_HTML_FILE,
    open: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--limit" && next) {
      args.limit = next.toLowerCase() === "all" ? Infinity : toPositiveInteger(next, "--limit");
      i += 1;
    } else if (arg === "--min-rating" && next) {
      args.minRating = toNumber(next, "--min-rating");
      i += 1;
    } else if (arg === "--year-from" && next) {
      args.yearFrom = toInteger(next, "--year-from");
      i += 1;
    } else if (arg === "--year-to" && next) {
      args.yearTo = toInteger(next, "--year-to");
      i += 1;
    } else if (arg === "--director" && next) {
      args.director = next.trim();
      i += 1;
    } else if (arg === "--country" && next) {
      args.country = next.trim();
      i += 1;
    } else if (arg === "--title" && next) {
      args.title = next.trim();
      i += 1;
    } else if (arg === "--max-lookups" && next) {
      args.maxLookups = next.toLowerCase() === "all" ? Infinity : toPositiveInteger(next, "--max-lookups");
      i += 1;
    } else if (arg === "--concurrency" && next) {
      args.concurrency = toPositiveInteger(next, "--concurrency");
      i += 1;
    } else if (arg === "--cache-file" && next) {
      args.cacheFile = path.resolve(next);
      i += 1;
    } else if (arg === "--omdb-api-key" && next) {
      args.omdbApiKeys = parseOmdbKeys(next);
      i += 1;
    } else if (arg === "--html") {
      args.html = true;
    } else if (arg === "--html-file" && next) {
      args.html = true;
      args.htmlFile = path.resolve(next);
      i += 1;
    } else if (arg === "--open") {
      args.html = true;
      args.open = true;
    } else if (arg === "--refresh") {
      args.refresh = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function toNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number`);
  }
  return parsed;
}

function toInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function toPositiveInteger(value, flag) {
  const parsed = toInteger(value, flag);
  if (parsed <= 0) {
    throw new Error(`${flag} must be greater than 0`);
  }
  return parsed;
}

function parseOmdbKeys(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`Criterion Channel movie suggester

Usage:
  node criterion-imdb-suggester.js [options]

Options:
  --limit <n|all>       Number of suggestions to print (default: 20)
  --min-rating <n>      Minimum IMDb rating to include (default: 8.0)
  --year-from <year>    Only include films from this year onward
  --year-to <year>      Only include films up to this year
  --director <name>     Only include films whose director contains this text
  --country <name>      Only include films whose country contains this text
  --title <text>        Only include films whose title contains this text
  --max-lookups <n|all> Cap new IMDb lookups for this run (default: all)
  --concurrency <n>     Parallel metadata lookups (default: 1)
  --cache-file <path>   Override the cache file path
  --omdb-api-key <keys> Use OMDb keys, comma-separated if multiple
  --html                Write a browsable HTML page
  --html-file <path>    Override the HTML output path
  --open                Open the generated HTML page
  --refresh             Ignore cached matches and ratings
  --help                Show this message

Examples:
  node criterion-imdb-suggester.js --limit 15 --min-rating 8.3
  node criterion-imdb-suggester.js --director kurosawa --limit 10
  node criterion-imdb-suggester.js --country Japan --year-from 1950 --year-to 1980
  node criterion-imdb-suggester.js --title noir --max-lookups 100
  OMDB_API_KEYS=key1,key2 node criterion-imdb-suggester.js --limit all --html --open
  node criterion-imdb-suggester.js --limit all --html --open
`);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object") {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read cache ${cacheFile}: ${error.message}`);
    }
  }

  return {
    updatedAt: null,
    items: {},
  };
}

function saveCache(cacheFile, cache) {
  ensureDirForFile(cacheFile);
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(text) {
  return decodeHtml(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanCountry(text) {
  return stripTags(text).replace(/\s*,\s*$/, "").trim();
}

function normalizeText(text) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cacheKeyForFilm(film) {
  return `${normalizeText(film.title)}|${film.year}`;
}

function isTransientFailure(record) {
  if (!record || typeof record.reason !== "string") {
    return false;
  }

  return (
    record.reason.startsWith("Request failed") ||
    record.reason.startsWith("Request timed out") ||
    record.reason === "fetch failed"
  );
}

function isCurrentMatcherVersion(record) {
  return Boolean(record && record.matcherVersion === MATCHER_VERSION);
}

function shouldPersistCacheRecord(record) {
  return !isTransientFailure(record);
}

function hasCachedRuntime(record) {
  if (!record || !record.matched) {
    return true;
  }

  return record.runtimeChecked === true;
}

function hasCachedLanguages(record) {
  if (!record || !record.matched) {
    return true;
  }

  return record.languageChecked === true;
}

function isCompatibleLegacyCacheRecord(film, record) {
  if (!record || !record.matched) {
    return false;
  }

  const filmTitle = normalizeText(film.title);
  const matchedTitle = normalizeText(record.matchedTitle || "");
  const matchedYear = Number.parseInt(record.matchedYear, 10);
  const titleSimilarity = computeTitleSimilarity(record.matchedTitle || "", film.title);
  const exactTitle = filmTitle && matchedTitle && filmTitle === matchedTitle;
  const yearDelta = Number.isInteger(matchedYear) ? Math.abs(matchedYear - film.year) : 99;

  if (exactTitle && yearDelta <= 1) {
    return true;
  }

  return titleSimilarity >= 0.9 && yearDelta <= 1;
}

function canReuseCachedRecord(film, record, refresh) {
  if (
    refresh ||
    !record ||
    !record.checkedAt ||
    isTransientFailure(record) ||
    !hasCachedRuntime(record) ||
    !hasCachedLanguages(record)
  ) {
    return false;
  }

  if (isCurrentMatcherVersion(record)) {
    return true;
  }

  return isCompatibleLegacyCacheRecord(film, record);
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, "text/html,application/json");
  return response.text();
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, "application/json");
  return response.json();
}

async function fetchOmdbById(imdbId, apiKeys) {
  let lastError = null;

  for (const apiKey of apiKeys) {
    const url = `${OMDB_API_URL}?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`;

    try {
      const payload = await fetchJson(url);

      if (!payload || payload.Response === "False") {
        const errorMessage = payload && payload.Error ? payload.Error : "Unknown OMDb error";

        if (errorMessage.toLowerCase().includes("limit")) {
          lastError = new Error(`OMDb quota reached for key ending in ${apiKey.slice(-4)}`);
          continue;
        }

        throw new Error(`OMDb error for ${imdbId}: ${errorMessage}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`OMDb error for ${imdbId}`);
}

async function fetchWithRetry(url, accept, maxAttempts = 4) {
  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        headers: {
          "user-agent": "criterion-imdb-suggester/1.0",
          accept,
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt === maxAttempts) {
        throw new Error(error.name === "AbortError" ? `Request timed out for ${url}` : (error.message || `fetch failed for ${url}`));
      }

      const delayMs = 750 * (2 ** (attempt - 1));
      await sleep(delayMs);
      continue;
    }
    clearTimeout(timeoutId);

    if (response.ok) {
      return response;
    }

    lastStatus = response.status;

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    const delayMs = 750 * (2 ** (attempt - 1));
    await sleep(delayMs);
  }

  if (lastError) {
    throw new Error(lastError.message || `fetch failed for ${url}`);
  }

  throw new Error(`Request failed (${lastStatus || "unknown"}) for ${url}`);
}

async function fetchCriterionFilms() {
  const html = await fetchText(CRITERION_FILMS_URL);
  const rowRegex = /<tr class="criterion-channel__tr"[\s\S]*?<\/tr>/g;
  const rows = html.match(rowRegex) || [];

  return rows
    .map((row) => {
      const url = row.match(/data-href="([^"]+)"/)?.[1] || "";
      const title = stripTags(row.match(/criterion-channel__td--title">([\s\S]*?)<\/td>/)?.[1] || "");
      const director = stripTags(row.match(/criterion-channel__td--director">([\s\S]*?)<\/td>/)?.[1] || "");
      const country = cleanCountry(row.match(/criterion-channel__td--country">([\s\S]*?)<\/td>/)?.[1] || "");
      const yearText = stripTags(row.match(/criterion-channel__td--year">([\s\S]*?)<\/td>/)?.[1] || "");
      const year = Number.parseInt(yearText, 10);

      if (!title || !Number.isInteger(year) || !url) {
        return null;
      }

      return { title, director, country, year, url };
    })
    .filter(Boolean);
}

function filterFilms(films, args) {
  const directorNeedle = normalizeText(args.director);
  const countryNeedle = normalizeText(args.country);
  const titleNeedle = normalizeText(args.title);

  return films.filter((film) => {
    if (args.yearFrom && film.year < args.yearFrom) {
      return false;
    }
    if (args.yearTo && film.year > args.yearTo) {
      return false;
    }
    if (directorNeedle && !normalizeText(film.director).includes(directorNeedle)) {
      return false;
    }
    if (countryNeedle && !normalizeText(film.country).includes(countryNeedle)) {
      return false;
    }
    if (titleNeedle && !normalizeText(film.title).includes(titleNeedle)) {
      return false;
    }
    return true;
  });
}

function uniqueWords(text) {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

function computeTitleSimilarity(a, b) {
  const left = uniqueWords(a);
  const right = uniqueWords(b);

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const word of left) {
    if (right.has(word)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.size, right.size);
}

function computeTokenOverlap(a, b) {
  return computeTitleSimilarity(a, b);
}

function isPlausibleResolvedMatch(film, movie, match) {
  const filmTitle = normalizeText(film.title);
  const movieTitle = normalizeText(movie.Title || match.suggestedTitle || "");
  const filmDirector = normalizeText(film.director || "");
  const movieDirector = normalizeText(movie.Director || "");
  const titleSimilarity = computeTitleSimilarity(movieTitle, filmTitle);
  const movieYear = Number.parseInt(movie.Year || match.suggestedYear, 10);
  const yearDelta = Number.isInteger(movieYear) ? Math.abs(movieYear - film.year) : 99;
  const directorSimilarity = filmDirector && movieDirector ? computeTokenOverlap(movieDirector, filmDirector) : 0;
  const exactTitle = movieTitle === filmTitle;

  if (exactTitle && yearDelta <= 1) {
    return true;
  }

  if (exactTitle && directorSimilarity >= 0.5 && yearDelta <= 3) {
    return true;
  }

  if (directorSimilarity >= 0.75 && yearDelta <= 2) {
    return true;
  }

  return titleSimilarity >= 0.8 && directorSimilarity >= 0.5 && yearDelta <= 2;
}

function pickBestSuggestion(film, suggestions) {
  const targetTitle = normalizeText(film.title);
  const targetDirector = normalizeText(film.director);

  const candidates = suggestions
    .filter((item) => item && item.id && item.l && (ALLOWED_IMDB_KINDS.has(item.qid) || ALLOWED_IMDB_KINDS.has(item.q)))
    .map((item) => {
      const title = normalizeText(item.l || "");
      const castOrCrew = normalizeText(item.s || "");
      const exactTitle = title === targetTitle;
      const titleContains = title.includes(targetTitle) || targetTitle.includes(title);
      const titleSimilarity = computeTitleSimilarity(item.l || "", film.title);
      const yearPenalty = Number.isInteger(item.y) ? Math.abs(item.y - film.year) : 5;
      const directorBonus = targetDirector && castOrCrew.includes(targetDirector) ? 2 : 0;
      const titleScore = exactTitle ? 40 : titleContains ? 15 : 0;
      const similarityScore = titleSimilarity * 20;
      const kindScore = item.qid === "movie" ? 5 : item.qid === "short" ? 4 : 3;
      const rankScore = typeof item.rank === "number" ? Math.max(0, 10 - Math.log10(item.rank + 10)) : 0;
      const score = titleScore + similarityScore + kindScore + directorBonus + rankScore - yearPenalty * 4;

      return {
        imdbId: item.id,
        suggestedTitle: item.l,
        suggestedYear: item.y,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return null;
  }

  const best = candidates[0];
  if (best.score < 12) {
    return null;
  }

  return best;
}

function pickBestCatalogResult(film, results) {
  const targetTitle = normalizeText(film.title);
  const targetDirector = normalizeText(film.director);

  const candidates = results
    .filter((item) => item && item.id && item.name)
    .map((item) => {
      const candidateTitle = normalizeText(item.name || "");
      const directorText = normalizeText(Array.isArray(item.director) ? item.director.join(" ") : "");
      const exactTitle = candidateTitle === targetTitle;
      const titleContains = candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle);
      const titleSimilarity = computeTitleSimilarity(item.name || "", film.title);
      const candidateYear = Number.parseInt(item.year || item.releaseInfo, 10);
      const yearPenalty = Number.isInteger(candidateYear) ? Math.abs(candidateYear - film.year) : 5;
      const directorSimilarity = computeTokenOverlap(directorText, film.director);
      const directorBonus = directorSimilarity >= 0.5 ? 24 + directorSimilarity * 8 : 0;
      const titleScore = exactTitle ? 40 : titleContains ? 18 : 0;
      const similarityScore = titleSimilarity * 24;
      const searchScore = Number(item.score) || 0;
      const score = titleScore + similarityScore + directorBonus + searchScore - yearPenalty * 6;

      return {
        imdbId: item.imdb_id || item.id,
        suggestedTitle: item.name,
        suggestedYear: candidateYear,
        score,
        exactTitle,
        yearPenalty,
        hasDirectorMatch: directorBonus > 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return null;
  }

  const best = candidates[0];
  const confident =
    best.exactTitle ||
    (best.hasDirectorMatch && best.yearPenalty <= 1) ||
    (best.hasDirectorMatch && best.score >= 28);

  if (!confident) {
    return null;
  }

  return best;
}

async function searchCatalogForFilm(film, omdbApiKeys) {
  const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(film.title)}.json`;
  const response = await fetchJson(url);
  const candidates = await Promise.all((response.metas || []).slice(0, 5).map(async (item) => {
    if (!omdbApiKeys.length || !(item.imdb_id || item.id)) {
      return item;
    }

    try {
      const omdb = await fetchOmdbById(item.imdb_id || item.id, omdbApiKeys);
      return {
        ...item,
        name: omdb.Title || item.name,
        year: omdb.Year || item.year,
        director: omdb.Director ? omdb.Director.split(",").map((part) => part.trim()) : item.director,
        imdbRating: omdb.imdbRating,
        genres: omdb.Genre ? omdb.Genre.split(",").map((part) => part.trim()) : item.genres,
      };
    } catch (error) {
      return item;
    }
  }));

  return pickBestCatalogResult(film, candidates);
}

async function lookupImdbForFilm(film, omdbApiKeys) {
  const firstChar = normalizeText(film.title)[0] || "a";
  const query = encodeURIComponent(film.title);
  const url = `https://v2.sg.media-imdb.com/suggestion/${firstChar}/${query}.json`;
  const suggestionResponse = await fetchJson(url);
  let match = pickBestSuggestion(film, suggestionResponse.d || []);

  if (!match) {
    match = await searchCatalogForFilm(film, omdbApiKeys);
  }

  if (!match) {
    return {
      matched: false,
      reason: "No confident IMDb match found",
    };
  }

  if (!omdbApiKeys.length) {
    return {
      matched: false,
      reason: "OMDb API key required for IMDb ratings",
    };
  }

  const movie = await fetchOmdbById(match.imdbId, omdbApiKeys);
  const imdbRating = Number.parseFloat(movie.imdbRating);
  const runtimeMatch = String(movie.Runtime || "").match(/(\d+)/);
  const runtimeMinutes = runtimeMatch ? Number.parseInt(runtimeMatch[1], 10) : null;

  if (!isPlausibleResolvedMatch(film, movie, match)) {
    return {
      matched: false,
      reason: "No confident IMDb match found",
    };
  }

  if (!Number.isFinite(imdbRating)) {
    return {
      matched: false,
      reason: `IMDb rating missing for ${match.imdbId}`,
    };
  }

  return {
    matched: true,
    imdbId: match.imdbId,
    imdbRating,
    matchedTitle: movie.Title || match.suggestedTitle,
    matchedYear: Number.parseInt(movie.Year || match.suggestedYear, 10) || match.suggestedYear || null,
    genres: movie.Genre ? movie.Genre.split(",").map((part) => part.trim()) : [],
    languages: movie.Language ? movie.Language.split(",").map((part) => part.trim()).filter(Boolean) : [],
    runtimeMinutes: Number.isInteger(runtimeMinutes) ? runtimeMinutes : null,
    runtimeChecked: true,
    languageChecked: true,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;

      if (current >= items.length) {
        return;
      }

      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function formatSuggestion(suggestion, index) {
  const rating = suggestion.imdbRating.toFixed(1);
  const runtime = Number.isInteger(suggestion.runtimeMinutes) ? ` | ${suggestion.runtimeMinutes} min` : "";
  const director = suggestion.director ? ` | dir. ${suggestion.director}` : "";
  const country = suggestion.country ? ` | ${suggestion.country}` : "";
  return `${String(index + 1).padStart(2, " ")}. ${suggestion.title} (${suggestion.year}) | IMDb ${rating}${runtime}${director}${country}\n    ${suggestion.url}`;
}

function groupSuggestionsByGenre(suggestions) {
  const groups = new Map();

  for (const suggestion of suggestions) {
    const genres = Array.isArray(suggestion.genres) && suggestion.genres.length > 0
      ? suggestion.genres
      : ["Unknown"];

    for (const genre of genres) {
      if (!groups.has(genre)) {
        groups.set(genre, []);
      }
      groups.get(genre).push(suggestion);
    }
  }

  return Array.from(groups.entries()).sort((a, b) => {
    if (b[1].length !== a[1].length) {
      return b[1].length - a[1].length;
    }
    return a[0].localeCompare(b[0]);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugifyGenre(name) {
  return normalizeText(name).replace(/\s+/g, "-") || "unknown";
}

function buildHtmlPage({ suggestions, groups, summary }) {
  const allGenres = groups.map(([genre]) => genre);
  const allLanguages = Array.from(new Set(
    suggestions.flatMap((film) => Array.isArray(film.languages) && film.languages.length > 0 ? film.languages : ["Unknown"])
  )).sort((a, b) => a.localeCompare(b));
  const minAvailableRating = suggestions.reduce((min, film) => Math.min(min, film.imdbRating), 10);
  const maxAvailableRating = suggestions.reduce((max, film) => Math.max(max, film.imdbRating), 0);
  const yearValues = suggestions
    .map((film) => film.year)
    .filter((year) => Number.isInteger(year));
  const minAvailableYear = yearValues.length > 0 ? Math.min(...yearValues) : 0;
  const maxAvailableYear = yearValues.length > 0 ? Math.max(...yearValues) : 0;
  const runtimeValues = suggestions
    .map((film) => film.runtimeMinutes)
    .filter((runtime) => Number.isInteger(runtime));
  const minAvailableRuntime = runtimeValues.length > 0 ? Math.min(...runtimeValues) : 0;
  const maxAvailableRuntime = runtimeValues.length > 0 ? Math.max(...runtimeValues) : 0;
  const filmCards = suggestions
    .map((film) => {
      const genres = Array.isArray(film.genres) && film.genres.length > 0 ? film.genres : ["Unknown"];
      const languages = Array.isArray(film.languages) && film.languages.length > 0 ? film.languages : ["Unknown"];
      const genreBadges = genres.map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("");
      const genreAttr = genres.map((genre) => slugifyGenre(genre)).join(" ");
      const languageAttr = languages.map((language) => slugifyGenre(language)).join(" ");
      const languageText = languages.join(", ");
      return `
        <article class="film-card" data-title="${escapeHtml(normalizeText(film.title))}" data-director="${escapeHtml(normalizeText(film.director))}" data-genre="${escapeHtml(genreAttr)}" data-language="${escapeHtml(languageAttr)}" data-rating="${escapeHtml(String(film.imdbRating))}" data-year="${escapeHtml(String(film.year || 0))}" data-runtime="${escapeHtml(String(film.runtimeMinutes || 0))}">
          <div class="film-card__top">
            <div>
              <h3><a href="${escapeHtml(film.url)}" target="_blank" rel="noreferrer">${escapeHtml(film.title)}</a></h3>
              <p class="meta">${escapeHtml(String(film.year))} | IMDb ${escapeHtml(film.imdbRating.toFixed(1))}${Number.isInteger(film.runtimeMinutes) ? ` | ${escapeHtml(String(film.runtimeMinutes))} min` : ""}</p>
            </div>
            <div class="rating-pill">${escapeHtml(film.imdbRating.toFixed(1))}</div>
          </div>
          <p class="details">${escapeHtml(film.director || "Unknown director")}${film.country ? ` | ${escapeHtml(film.country)}` : ""}</p>
          <p class="details">Language: ${escapeHtml(languageText)}</p>
          <div class="tags">${genreBadges}</div>
        </article>
      `;
    })
    .join("");

  const genreSections = groups
    .map(([genre, films]) => {
      const items = films
        .slice()
        .sort((a, b) => b.imdbRating - a.imdbRating || a.title.localeCompare(b.title))
        .map((film) => {
          const languages = Array.isArray(film.languages) && film.languages.length > 0 ? film.languages : ["Unknown"];
          const languageAttr = languages.map((language) => slugifyGenre(language)).join(" ");
          return `<li data-rating="${escapeHtml(String(film.imdbRating))}" data-year="${escapeHtml(String(film.year || 0))}" data-runtime="${escapeHtml(String(film.runtimeMinutes || 0))}" data-language="${escapeHtml(languageAttr)}" data-title="${escapeHtml(normalizeText(film.title))}" data-director="${escapeHtml(normalizeText(film.director))}"><a href="${escapeHtml(film.url)}" target="_blank" rel="noreferrer">${escapeHtml(film.title)}</a> <span>${escapeHtml(String(film.year))}${Number.isInteger(film.runtimeMinutes) ? `, ${escapeHtml(String(film.runtimeMinutes))} min` : ""}${languages.length > 0 ? `, ${escapeHtml(languages.join(", "))}` : ""}</span> <strong>${escapeHtml(film.imdbRating.toFixed(1))}</strong></li>`;
        })
        .join("");

      return `
        <section class="genre-section" data-genre-section="${escapeHtml(slugifyGenre(genre))}">
          <div class="genre-section__header">
            <h2>${escapeHtml(genre)}</h2>
            <span>${films.length} title${films.length === 1 ? "" : "s"}</span>
          </div>
          <ol>${items}</ol>
        </section>
      `;
    })
    .join("");

  const genreOptions = ['<option value="all">All genres</option>']
    .concat(allGenres.map((genre) => `<option value="${escapeHtml(slugifyGenre(genre))}">${escapeHtml(genre)}</option>`))
    .join("");
  const languageOptions = ['<option value="all">All languages</option>']
    .concat(allLanguages.map((language) => `<option value="${escapeHtml(slugifyGenre(language))}">${escapeHtml(language)}</option>`))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Criterion Channel Suggestions</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5efe2;
      --paper: rgba(255, 251, 245, 0.92);
      --ink: #1f1b18;
      --muted: #655d57;
      --line: rgba(31, 27, 24, 0.12);
      --accent: #b13a24;
      --accent-soft: #f0d3c4;
      --shadow: 0 16px 40px rgba(56, 35, 21, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Iowan Old Style", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(177, 58, 36, 0.12), transparent 35%),
        linear-gradient(180deg, #efe3cc 0%, var(--bg) 45%, #efe7da 100%);
    }
    a { color: inherit; }
    .page {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }
    .hero, .panel {
      background: var(--paper);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
      border-radius: 24px;
    }
    .hero {
      padding: 28px;
      margin-bottom: 20px;
    }
    .eyebrow {
      margin: 0 0 10px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font: 600 12px/1.4 "Montserrat", "Avenir Next", sans-serif;
      color: var(--accent);
    }
    h1, h2, h3 {
      margin: 0;
      font-weight: 600;
    }
    h1 {
      font-size: clamp(2rem, 4vw, 3.6rem);
      line-height: 0.98;
      max-width: 10ch;
    }
    .summary {
      margin-top: 18px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .stat {
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.55);
      font: 500 13px/1.2 "Montserrat", "Avenir Next", sans-serif;
    }
    .controls {
      display: grid;
      grid-template-columns: 1.4fr 0.8fr;
      gap: 20px;
      margin-bottom: 20px;
      padding: 20px;
    }
    .control-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .controls input, .controls select {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.88);
      font: 500 15px/1.2 "Montserrat", "Avenir Next", sans-serif;
      color: var(--ink);
    }
    .controls label {
      display: block;
      width: 100%;
      font: 600 12px/1.3 "Montserrat", "Avenir Next", sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .runtime-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .range-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .runtime-grid label {
      margin-bottom: 0;
    }
    .range-grid label {
      margin-bottom: 0;
    }
    .control-stack {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .film-card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .film-card__top {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .film-card h3 {
      font-size: 1.2rem;
      line-height: 1.1;
      margin-bottom: 6px;
    }
    .meta, .details {
      margin: 0;
      color: var(--muted);
      font: 500 14px/1.45 "Montserrat", "Avenir Next", sans-serif;
    }
    .rating-pill {
      min-width: 52px;
      text-align: center;
      padding: 8px 10px;
      border-radius: 999px;
      background: var(--accent);
      color: #fff7f2;
      font: 700 14px/1 "Montserrat", "Avenir Next", sans-serif;
    }
    .tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .tag {
      padding: 7px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #6f2416;
      font: 600 12px/1 "Montserrat", "Avenir Next", sans-serif;
    }
    .genre-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .genre-section {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .genre-section__header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      align-items: baseline;
    }
    .genre-section__header span {
      color: var(--muted);
      font: 500 13px/1.2 "Montserrat", "Avenir Next", sans-serif;
    }
    .genre-section ol {
      margin: 0;
      padding-left: 20px;
    }
    .genre-section li {
      margin: 0 0 10px;
      line-height: 1.4;
    }
    .genre-section li span {
      color: var(--muted);
      margin-left: 6px;
    }
    .genre-section li strong {
      margin-left: 8px;
      font: 700 12px/1 "Montserrat", "Avenir Next", sans-serif;
      color: var(--accent);
    }
    .hidden {
      display: none !important;
    }
    @media (max-width: 760px) {
      .controls {
        grid-template-columns: 1fr;
      }
      .page {
        width: min(100vw - 20px, 1180px);
        padding-top: 18px;
      }
      .hero, .panel {
        border-radius: 20px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <p class="eyebrow">Criterion Channel Browser</p>
      <h1>Browse highly rated films by genre.</h1>
      <div class="summary">
        <div class="stat">Criterion titles scanned: ${escapeHtml(String(summary.scanned))}</div>
        <div class="stat">Matched filters: ${escapeHtml(String(summary.matched))}</div>
        <div class="stat">Suggestions shown: ${escapeHtml(String(summary.shown))}</div>
        <div class="stat">Minimum IMDb rating: ${escapeHtml(summary.minRating.toFixed(1))}</div>
      </div>
    </section>

    <section class="panel controls">
      <div>
        <label for="search">Search title or director</label>
        <input id="search" type="search" placeholder="Try Kurosawa, noir, or Tokyo">
      </div>
      <div class="control-stack">
        <label for="genre">Genre</label>
        <select id="genre">${genreOptions}</select>
        <label for="language">Language</label>
        <select id="language">${languageOptions}</select>
        <label for="rating">Minimum IMDb rating <span id="rating-value">${escapeHtml(summary.minRating.toFixed(1))}</span></label>
        <input id="rating" type="range" min="${escapeHtml(minAvailableRating.toFixed(1))}" max="${escapeHtml(maxAvailableRating.toFixed(1))}" step="0.1" value="${escapeHtml(summary.minRating.toFixed(1))}">
        <div class="range-grid">
          <div>
            <label for="year-min">Min year</label>
            <input id="year-min" type="number" min="${escapeHtml(String(minAvailableYear))}" max="${escapeHtml(String(maxAvailableYear))}" step="1" placeholder="${escapeHtml(String(minAvailableYear || 0))}">
          </div>
          <div>
            <label for="year-max">Max year</label>
            <input id="year-max" type="number" min="${escapeHtml(String(minAvailableYear))}" max="${escapeHtml(String(maxAvailableYear))}" step="1" placeholder="${escapeHtml(String(maxAvailableYear || 0))}">
          </div>
        </div>
        <div class="runtime-grid">
          <div>
            <label for="runtime-min">Min runtime</label>
            <input id="runtime-min" type="number" min="${escapeHtml(String(minAvailableRuntime))}" max="${escapeHtml(String(maxAvailableRuntime))}" step="1" placeholder="${escapeHtml(String(minAvailableRuntime || 0))}">
          </div>
          <div>
            <label for="runtime-max">Max runtime</label>
            <input id="runtime-max" type="number" min="${escapeHtml(String(minAvailableRuntime))}" max="${escapeHtml(String(maxAvailableRuntime))}" step="1" placeholder="${escapeHtml(String(maxAvailableRuntime || 0))}">
          </div>
        </div>
      </div>
    </section>

    <section class="cards" id="cards">${filmCards}</section>
    <section class="genre-grid" id="genres">${genreSections}</section>
  </main>

  <script>
    const searchInput = document.getElementById("search");
    const genreSelect = document.getElementById("genre");
    const languageSelect = document.getElementById("language");
    const ratingInput = document.getElementById("rating");
    const ratingValue = document.getElementById("rating-value");
    const yearMinInput = document.getElementById("year-min");
    const yearMaxInput = document.getElementById("year-max");
    const runtimeMinInput = document.getElementById("runtime-min");
    const runtimeMaxInput = document.getElementById("runtime-max");
    const cards = Array.from(document.querySelectorAll(".film-card"));
    const sections = Array.from(document.querySelectorAll(".genre-section"));

    function applyFilters() {
      const query = searchInput.value.trim().toLowerCase();
      const genre = genreSelect.value;
      const language = languageSelect.value;
      const minRating = Number(ratingInput.value);
      const minYear = yearMinInput.value ? Number(yearMinInput.value) : null;
      const maxYear = yearMaxInput.value ? Number(yearMaxInput.value) : null;
      const minRuntime = runtimeMinInput.value ? Number(runtimeMinInput.value) : null;
      const maxRuntime = runtimeMaxInput.value ? Number(runtimeMaxInput.value) : null;
      ratingValue.textContent = minRating.toFixed(1);

      cards.forEach((card) => {
        const haystack = (card.dataset.title + " " + card.dataset.director).toLowerCase();
        const genres = (card.dataset.genre || "").split(" ");
        const languages = (card.dataset.language || "").split(" ");
        const rating = Number(card.dataset.rating || 0);
        const year = Number(card.dataset.year || 0);
        const runtime = Number(card.dataset.runtime || 0);
        const matchesQuery = !query || haystack.includes(query);
        const matchesGenre = genre === "all" || genres.includes(genre);
        const matchesLanguage = language === "all" || languages.includes(language);
        const matchesRating = rating >= minRating;
        const matchesYear = (!minYear || year >= minYear) && (!maxYear || year <= maxYear);
        const matchesRuntime = (!minRuntime || runtime >= minRuntime) && (!maxRuntime || runtime <= maxRuntime);
        card.classList.toggle("hidden", !(matchesQuery && matchesGenre && matchesLanguage && matchesRating && matchesYear && matchesRuntime));
      });

      sections.forEach((section) => {
        const matchesGenre = genre === "all" || section.dataset.genreSection === genre;
        const listItems = Array.from(section.querySelectorAll("li"));
        let visibleCount = 0;

        listItems.forEach((item) => {
          const rating = Number(item.dataset.rating || 0);
          const languages = (item.dataset.language || "").split(" ");
          const year = Number(item.dataset.year || 0);
          const runtime = Number(item.dataset.runtime || 0);
          const haystack = (item.dataset.title + " " + item.dataset.director).toLowerCase();
          const matchesQuery = !query || haystack.includes(query);
          const matchesRating = rating >= minRating;
          const matchesLanguage = language === "all" || languages.includes(language);
          const matchesYear = (!minYear || year >= minYear) && (!maxYear || year <= maxYear);
          const matchesRuntime = (!minRuntime || runtime >= minRuntime) && (!maxRuntime || runtime <= maxRuntime);
          const visible = matchesQuery && matchesRating && matchesLanguage && matchesYear && matchesRuntime;
          item.classList.toggle("hidden", !visible);
          if (visible) {
            visibleCount += 1;
          }
        });

        section.classList.toggle("hidden", !(matchesGenre && visibleCount > 0));
      });
    }

    searchInput.addEventListener("input", applyFilters);
    genreSelect.addEventListener("change", applyFilters);
    languageSelect.addEventListener("change", applyFilters);
    ratingInput.addEventListener("input", applyFilters);
    yearMinInput.addEventListener("input", applyFilters);
    yearMaxInput.addEventListener("input", applyFilters);
    runtimeMinInput.addEventListener("input", applyFilters);
    runtimeMaxInput.addEventListener("input", applyFilters);
    applyFilters();
  </script>
</body>
</html>`;
}

function writeHtmlOutput(htmlFile, suggestions, allFilmsCount, filteredFilmsCount, minRating) {
  const groups = groupSuggestionsByGenre(suggestions);
  const html = buildHtmlPage({
    suggestions,
    groups,
    summary: {
      scanned: allFilmsCount,
      matched: filteredFilmsCount,
      shown: suggestions.length,
      minRating,
    },
  });

  ensureDirForFile(htmlFile);
  fs.writeFileSync(htmlFile, html);
}

function openFile(filePath) {
  execFileSync("open", [filePath], { stdio: "ignore" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.omdbApiKeys.length) {
    throw new Error("OMDb API key required. Set OMDB_API_KEYS/OMDB_API_KEY or pass --omdb-api-key.");
  }

  const cache = loadCache(args.cacheFile);
  const allFilms = await fetchCriterionFilms();
  const filteredFilms = filterFilms(allFilms, args);

  if (filteredFilms.length === 0) {
    console.log("No Criterion titles matched those filters.");
    return;
  }

  let newLookups = 0;
  const enriched = await mapWithConcurrency(filteredFilms, args.concurrency, async (film, index) => {
    const key = cacheKeyForFilm(film);
    const cached = cache.items[key];
    const shouldUseCache = canReuseCachedRecord(film, cached, args.refresh);

    if (shouldUseCache) {
      return { ...film, ...cached };
    }

    if (newLookups >= args.maxLookups) {
      return {
        ...film,
        matched: false,
        skipped: true,
        reason: "Skipped because --max-lookups was reached",
      };
    }

    newLookups += 1;

    if (newLookups % 25 === 0 || index === 0) {
      console.error(`Looked up ${newLookups} / ${filteredFilms.length} titles...`);
    }

    try {
      const lookup = await lookupImdbForFilm(film, args.omdbApiKeys);
      const record = {
        ...lookup,
        matcherVersion: MATCHER_VERSION,
        checkedAt: new Date().toISOString(),
      };
      if (shouldPersistCacheRecord(record)) {
        cache.items[key] = record;
      }
      return { ...film, ...record };
    } catch (error) {
      const record = {
        matched: false,
        reason: error.message,
        matcherVersion: MATCHER_VERSION,
        checkedAt: new Date().toISOString(),
      };
      if (shouldPersistCacheRecord(record)) {
        cache.items[key] = record;
      }
      return { ...film, ...record };
    }
  });

  saveCache(args.cacheFile, cache);

  const suggestions = enriched
    .filter((film) => film.matched && Number.isFinite(film.imdbRating) && film.imdbRating >= args.minRating)
    .sort((a, b) => {
      if (b.imdbRating !== a.imdbRating) {
        return b.imdbRating - a.imdbRating;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, args.limit);

  console.log(`Criterion titles scanned: ${allFilms.length}`);
  console.log(`Matched filters: ${filteredFilms.length}`);
  console.log(`New IMDb lookups this run: ${newLookups}`);
  console.log(`Cache file: ${args.cacheFile}`);
  console.log("");

  if (suggestions.length === 0) {
    console.log("No suggestions met that minimum IMDb rating yet.");
    console.log("Try lowering --min-rating, broadening your filters, or raising --max-lookups.");
    return;
  }

  console.log(`Top ${suggestions.length} suggestions:\n`);
  for (const [index, suggestion] of suggestions.entries()) {
    console.log(formatSuggestion(suggestion, index));
  }

  console.log("");
  console.log("By genre:\n");

  for (const [genre, films] of groupSuggestionsByGenre(suggestions)) {
    const topFilms = films
      .slice()
      .sort((a, b) => {
        if (b.imdbRating !== a.imdbRating) {
          return b.imdbRating - a.imdbRating;
        }
        return a.title.localeCompare(b.title);
      })
      .map((film) => `${film.title} (${film.year}, ${film.imdbRating.toFixed(1)}${Number.isInteger(film.runtimeMinutes) ? `, ${film.runtimeMinutes} min` : ""})`)
      .join("; ");

    console.log(`${genre} (${films.length})`);
    console.log(`  ${topFilms}`);
  }

  if (args.html) {
    writeHtmlOutput(args.htmlFile, suggestions, allFilms.length, filteredFilms.length, args.minRating);
    console.log("");
    console.log(`HTML page written to: ${args.htmlFile}`);

    if (args.open) {
      openFile(args.htmlFile);
      console.log("Opened HTML page in your browser.");
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
