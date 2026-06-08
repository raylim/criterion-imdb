#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const CRITERION_FILMS_URL = "https://films.criterionchannel.com/";
const CRITERION_BROWSE_URL = "https://www.criterionchannel.com/browse";
const EXTRA_COLLECTION_SEED_URLS = [
  "https://www.criterionchannel.com/exclusive-streaming-premieres",
];
const DEFAULT_CACHE_FILE = path.join(__dirname, ".cache", "criterion-imdb-cache.json");
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_HTML_FILE = path.join(__dirname, ".cache", "criterion-movies.html");
const DEFAULT_ALIAS_FILE = path.join(__dirname, "criterion-imdb-aliases.json");
const DEFAULT_UNRESOLVED_FILE = path.join(__dirname, ".cache", "criterion-imdb-unresolved.json");
const DEFAULT_BROWSE_CACHE_FILE = path.join(__dirname, ".cache", "criterion-browse-supplement.json");
const DEFAULT_BUNDLED_CACHE_FILE = path.join(__dirname, "firefox-extension", "data", "criterion-cache.json");
const DEFAULT_MANUAL_BUNDLED_FILE = path.join(__dirname, "criterion-imdb-manual.json");
const DEFAULT_SUPPLEMENTAL_URLS_FILE = path.join(__dirname, "criterion-imdb-supplemental-urls.json");
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MATCHER_VERSION = 7;
const ALLOWED_IMDB_KINDS = new Set([
  "movie",
  "feature",
  "TV movie",
  "tvMovie",
  "series",
  "tvSeries",
  "TV series",
  "miniSeries",
  "TV mini-series",
  "short",
  "tvShort",
  "tvSpecial"
]);
const REQUEST_TIMEOUT_MS = 15000;
const OMDB_API_URL = "https://www.omdbapi.com/";
const MIN_CONFIDENT_GUESS_SCORE = 12;
const MIN_LOW_CONFIDENCE_GUESS_SCORE = 6;
const BROWSE_CACHE_MAX_AGE_MS = 18 * 60 * 60 * 1000;
let cachedCriterionCookieHeader = undefined;
let cachedCriterionApiToken = undefined;

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
    aliasFile: DEFAULT_ALIAS_FILE,
    unresolvedFile: DEFAULT_UNRESOLVED_FILE,
    browseCacheFile: DEFAULT_BROWSE_CACHE_FILE,
    bundledCacheFile: DEFAULT_BUNDLED_CACHE_FILE,
    manualBundledFile: DEFAULT_MANUAL_BUNDLED_FILE,
    supplementalUrlsFile: DEFAULT_SUPPLEMENTAL_URLS_FILE,
    omdbApiKeys: parseOmdbKeys(process.env.OMDB_API_KEYS || process.env.OMDB_API_KEY || ""),
    html: false,
    htmlFile: DEFAULT_HTML_FILE,
    open: false,
    browseCacheOnly: false,
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
    } else if (arg === "--alias-file" && next) {
      args.aliasFile = path.resolve(next);
      i += 1;
    } else if (arg === "--unresolved-file" && next) {
      args.unresolvedFile = path.resolve(next);
      i += 1;
    } else if (arg === "--browse-cache-file" && next) {
      args.browseCacheFile = path.resolve(next);
      i += 1;
    } else if (arg === "--bundled-cache-file" && next) {
      args.bundledCacheFile = path.resolve(next);
      i += 1;
    } else if (arg === "--manual-bundled-file" && next) {
      args.manualBundledFile = path.resolve(next);
      i += 1;
    } else if (arg === "--supplemental-urls-file" && next) {
      args.supplementalUrlsFile = path.resolve(next);
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
    } else if (arg === "--browse-cache-only") {
      args.browseCacheOnly = true;
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
  --alias-file <path>   Override the alias file path
  --unresolved-file <path> Override the unresolved report path
  --browse-cache-file <path> Override the browse supplement cache path
  --supplemental-urls-file <path> Override the supplemental page URL file
  --omdb-api-key <keys> Use OMDb keys, comma-separated if multiple
  --html                Write a browsable HTML page
  --html-file <path>    Override the HTML output path
  --open                Open the generated HTML page
  --refresh             Ignore cached matches and ratings
  --browse-cache-only   Only refresh the incremental browse supplement cache
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

function firefoxProfilesRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
}

function pickFirefoxProfileDir() {
  try {
    const root = firefoxProfilesRoot();
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(root, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          fullPath,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((left, right) => {
        const leftScore = left.name.includes("default-release") ? 2 : left.name.includes("default") ? 1 : 0;
        const rightScore = right.name.includes("default-release") ? 2 : right.name.includes("default") ? 1 : 0;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return right.mtimeMs - left.mtimeMs;
      });

    return entries[0]?.fullPath || "";
  } catch (_error) {
    return "";
  }
}

function loadCriterionCookieHeader() {
  if (cachedCriterionCookieHeader !== undefined) {
    return cachedCriterionCookieHeader;
  }

  const profileDir = process.env.FIREFOX_PROFILE_DIR || pickFirefoxProfileDir();
  if (!profileDir) {
    cachedCriterionCookieHeader = "";
    return cachedCriterionCookieHeader;
  }

  const dbPath = path.join(profileDir, "cookies.sqlite");
  if (!fs.existsSync(dbPath)) {
    cachedCriterionCookieHeader = "";
    return cachedCriterionCookieHeader;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "criterion-firefox-cookies-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${dbPath}${suffix}`;
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, path.join(tempDir, `cookies.sqlite${suffix}`));
      }
    }

    const sql = [
      "select name, value from moz_cookies",
      "where host like '%criterionchannel.com%'",
      "order by length(host) desc, name asc;"
    ].join(" ");
    const output = execFileSync("sqlite3", [path.join(tempDir, "cookies.sqlite"), sql], { encoding: "utf8" });
    const pairs = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("|");
        if (separator <= 0) {
          return null;
        }
        return {
          name: line.slice(0, separator),
          value: line.slice(separator + 1),
        };
      })
      .filter(Boolean);

    const seen = new Set();
    cachedCriterionCookieHeader = pairs
      .filter(({ name }) => {
        if (seen.has(name)) {
          return false;
        }
        seen.add(name);
        return true;
      })
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    return cachedCriterionCookieHeader;
  } catch (error) {
    console.warn(`Could not load Firefox Criterion cookies: ${error.message}`);
    cachedCriterionCookieHeader = "";
    return cachedCriterionCookieHeader;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function criterionRequestHeaders(url, accept, extraHeaders = {}) {
  const headers = {
    "user-agent": "criterion-imdb-suggester/1.0",
    accept,
    ...extraHeaders,
  };

  try {
    const parsed = new URL(url);
    if (/(^|\\.)criterionchannel\\.com$/i.test(parsed.hostname)) {
      const cookieHeader = loadCriterionCookieHeader();
      if (cookieHeader) {
        headers.cookie = cookieHeader;
      }
    }
  } catch (_error) {
    // Ignore invalid URLs and leave default headers intact.
  }

  return headers;
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

function loadBrowseSupplementCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.films)) {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read browse cache ${cacheFile}: ${error.message}`);
    }
  }

  return {
    updatedAt: null,
    films: [],
  };
}

function saveBrowseSupplementCache(cacheFile, payload) {
  ensureDirForFile(cacheFile);
  fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
}

function isFreshBrowseSupplementCache(payload) {
  if (!payload || !payload.updatedAt || !Array.isArray(payload.films) || payload.films.length === 0) {
    return false;
  }

  const updatedAtMs = Date.parse(payload.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return (Date.now() - updatedAtMs) <= BROWSE_CACHE_MAX_AGE_MS;
}

function loadAliasMap(aliasFile) {
  try {
    const raw = fs.readFileSync(aliasFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read alias file ${aliasFile}: ${error.message}`);
    }
  }

  return {};
}

function loadSupplementalUrls(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read supplemental URL file ${filePath}: ${error.message}`);
    }
  }

  return [];
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

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function aliasKeyForFilm(film) {
  return cacheKeyForFilm(film);
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

async function fetchCriterionApiJson(url) {
  const token = await loadCriterionApiToken();
  if (!token) {
    throw new Error(`Missing Criterion API token for ${url}`);
  }

  const response = await fetchWithRetry(
    url,
    "application/json, text/plain, */*",
    4,
    { Authorization: `Bearer ${token}` }
  );
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

async function fetchWithRetry(url, accept, maxAttempts = 4, extraHeaders = {}) {
  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        headers: criterionRequestHeaders(url, accept, extraHeaders),
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

function isBrowsableFilmUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.criterionchannel.com") {
      return false;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    if (
      pathname === "/" ||
      pathname === "/browse" ||
      pathname === "/search" ||
      pathname === "/my-list" ||
      pathname === "/continue-watching" ||
      pathname === "/watch-live" ||
      pathname === "/help" ||
      pathname === "/tos" ||
      pathname === "/privacy" ||
      pathname === "/cookies" ||
      pathname === "/new-collections" ||
      pathname === "/top-stories"
    ) {
      return false;
    }

    return !/^\/(events|checkout|gift|account)(\/|$)/.test(pathname);
  } catch (_error) {
    return false;
  }
}

function parseCriterionChannelPage(url, html) {
  const title = stripTags((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "")
    .replace(/\s*-\s*The Criterion Channel\s*$/i, "")
    .trim();
  const description = decodeHtml((html.match(/<meta name="description" content="([\s\S]*?)"\s*\/?>/i) || [])[1] || "");
  const directorMatch = description.match(/Directed by\s+(.+?)(?:\s+•|$)/i);
  const yearMatch = description.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  const countryMatch = yearMatch
    ? description.match(new RegExp(`${yearMatch[1]}\\s+•\\s+([^\\n<"]+)`, "i"))
    : null;
  const year = Number.parseInt(yearMatch?.[1], 10);

  if (!title || !Number.isInteger(year)) {
    return null;
  }

  return {
    title,
    director: stripTags(directorMatch?.[1] || ""),
    year,
    country: cleanCountry(countryMatch?.[1] || ""),
    url
  };
}

function parseJsonDataPropsObjects(html) {
  return [...html.matchAll(/data-props="([\s\S]*?)"/gi)]
    .map((match) => {
      try {
        return JSON.parse(decodeHtml(match[1] || ""));
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function parseBrowseRowsPayload(html) {
  return parseJsonDataPropsObjects(html).find((item) => item && item.rows) || null;
}

function extractCriterionApiToken(html) {
  return html.match(/\bTOKEN\s*=\s*"([^"]+)"/)?.[1] || "";
}

async function loadCriterionApiToken() {
  if (cachedCriterionApiToken !== undefined) {
    return cachedCriterionApiToken;
  }

  try {
    const html = await fetchText(CRITERION_BROWSE_URL);
    cachedCriterionApiToken = extractCriterionApiToken(html);
    return cachedCriterionApiToken;
  } catch (error) {
    console.warn(`Could not load Criterion API token: ${error.message}`);
    cachedCriterionApiToken = "";
    return cachedCriterionApiToken;
  }
}

function normalizeCriterionUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/+$/, "");
  } catch (_error) {
    return String(url || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function isCriterionCollectionUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.criterionchannel.com") {
      return false;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    if (
      pathname === "/" ||
      pathname === "/browse" ||
      pathname === "/search" ||
      pathname === "/my-list" ||
      pathname === "/continue-watching" ||
      pathname === "/help" ||
      pathname === "/tos" ||
      pathname === "/privacy" ||
      pathname === "/cookies"
    ) {
      return false;
    }

    return !isCriterionVideoUrl(url) && !/^\/(events|checkout|gift|account|login)(\/|$)/.test(pathname);
  } catch (_error) {
    return false;
  }
}

function isCriterionVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.criterionchannel.com" && /(^|\/)videos(\/|$)/i.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

function parsePaginationPageCount(url, fallbackCount = 1) {
  try {
    const parsed = new URL(url);
    const page = Number.parseInt(parsed.searchParams.get("page"), 10);
    return Number.isInteger(page) && page > 0 ? page : fallbackCount;
  } catch (_error) {
    return fallbackCount;
  }
}

function extractBrowseCollectionUrlsFromPayload(payload) {
  const items = payload?.rows?._embedded?.items || [];

  return [...new Set(
    items
      .map((item) => normalizeCriterionUrl(item?._links?.collection_page?.href || ""))
      .filter(isCriterionCollectionUrl)
  )];
}

function buildPaginatedApiUrls(firstHref, lastHref) {
  try {
    const firstUrl = new URL(firstHref);
    const lastUrl = new URL(lastHref || firstHref);
    const pageCount = parsePaginationPageCount(lastUrl.href, 1);
    const urls = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageUrl = new URL(firstUrl.href);
      pageUrl.searchParams.set("page", String(pageNumber));
      urls.push(pageUrl.href);
    }

    return urls;
  } catch (_error) {
    return firstHref ? [firstHref] : [];
  }
}

function extractBrowseCollectionItemApiUrlsFromPayload(payload) {
  const items = payload?.rows?._embedded?.items || [];

  return [...new Set(
    items
      .map((item) => item?._links?.items?.href || "")
      .filter((url) => url && !/\/customers\//i.test(url))
  )];
}

function extractBrowseCollectionPageUrlsFromPayload(payload) {
  const items = payload?.rows?._embedded?.items || [];

  return [...new Set(
    items
      .map((item) => normalizeCriterionUrl(item?._links?.collection_page?.href || ""))
      .filter(isCriterionCollectionUrl)
  )];
}

function extractVhxLeafPageUrl(item) {
  const itemType = String(item?.type || item?.entity?.type || "").toLowerCase();
  const nestedItemsUrl = extractVhxNestedItemsUrl(item);

  if (nestedItemsUrl && ["series", "season"].includes(itemType)) {
    return "";
  }

  return normalizeCriterionUrl(
    item?._links?.collection_page?.href ||
    item?._links?.video_page?.href ||
    item?.page_url ||
    item?.entity?.page_url ||
    ""
  );
}

function extractVhxNestedItemsUrl(item) {
  return item?._links?.items?.href || item?.entity?._links?.items?.href || "";
}

function extractVhxItemsFromPayload(payload) {
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  if (Array.isArray(payload?._embedded?.items)) {
    return payload._embedded.items;
  }

  return [];
}

function parseYearFromText(text) {
  const match = String(text || "").match(/\b((?:19|20)\d{2})\b/);
  const year = Number.parseInt(match?.[1], 10);
  return Number.isInteger(year) ? year : null;
}

function parseDirectorFromText(text) {
  return stripTags(String(text || "").match(/Directed by\s+([^\n•<]+)/i)?.[1] || "").trim();
}

function parseCountryFromText(text) {
  const match = String(text || "").match(/(?:19|20)\d{2}\s+•\s+([^\n<]+)/i);
  return cleanCountry(match?.[1] || "");
}

function buildFilmFromVhxItem(item) {
  const pageUrl = extractVhxLeafPageUrl(item);
  const title = decodeHtml(
    stripTags(
      item?.title ||
      item?.name ||
      item?.entity?.title ||
      item?.entity?.name ||
      ""
    )
  ).trim();
  const metadata = item?.metadata || item?.entity?.metadata || {};
  const description = item?.description || item?.entity?.description || "";
  const director =
    stripTags(metadata.director || item?.director_names || item?.entity?.director_names || "").trim() ||
    parseDirectorFromText(description);
  const year =
    Number.parseInt(metadata.year_released, 10) ||
    Number.parseInt(item?.year, 10) ||
    Number.parseInt(item?.entity?.year, 10) ||
    parseYearFromText(description);
  const country =
    cleanCountry(metadata.country || item?.country || item?.entity?.country || "") ||
    parseCountryFromText(description);

  if (!title || !pageUrl) {
    return null;
  }

  return {
    title,
    director,
    year: Number.isInteger(year) ? year : null,
    country,
    url: pageUrl,
  };
}

function isCompleteFilmMetadata(film) {
  return Boolean(film && film.title && film.url && Number.isInteger(film.year) && film.director);
}

function betterBrowseFilm(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftComplete = isCompleteFilmMetadata(left);
  const rightComplete = isCompleteFilmMetadata(right);
  if (leftComplete !== rightComplete) {
    return rightComplete ? right : left;
  }

  const leftVideo = isCriterionVideoUrl(left.url);
  const rightVideo = isCriterionVideoUrl(right.url);
  if (leftVideo !== rightVideo) {
    return leftVideo ? left : right;
  }

  const leftFields = Number(Boolean(left.country)) + Number(Boolean(left.director)) + Number(Number.isInteger(left.year));
  const rightFields = Number(Boolean(right.country)) + Number(Boolean(right.director)) + Number(Number.isInteger(right.year));
  if (leftFields !== rightFields) {
    return rightFields > leftFields ? right : left;
  }

  return right;
}

async function fetchBrowseApiSupplement(args) {
  let firstHtml;
  try {
    firstHtml = await fetchText(CRITERION_BROWSE_URL);
  } catch (error) {
    console.warn(`Could not fetch browse page for API supplement: ${error.message}`);
    return {
      pageUrls: [],
      hubPageCount: 0,
      crawledCollectionApiUrlCount: 0,
    };
  }

  const firstPayload = parseBrowseRowsPayload(firstHtml);
  const token = extractCriterionApiToken(firstHtml);
  cachedCriterionApiToken = token || cachedCriterionApiToken || "";

  if (!firstPayload || !token) {
    return {
      pageUrls: [],
      hubPageCount: 0,
      crawledCollectionApiUrlCount: 0,
    };
  }

  const hubSelfHref = firstPayload.rows?._links?.self?.href || "";
  const hubLastHref = firstPayload.rows?._links?.last?.href || hubSelfHref;
  const hubPageUrls = buildPaginatedApiUrls(hubSelfHref, hubLastHref);
  const hubPayloads = await mapWithConcurrency(hubPageUrls, args.concurrency, async (url) => {
    try {
      return await fetchCriterionApiJson(url);
    } catch (error) {
      console.warn(`Could not fetch browse hub page ${url}: ${error.message}`);
      return null;
    }
  });

  const pageUrlsNeedingBackfill = new Set();
  const films = [];
  const seenFilmUrls = new Set();
  const pendingCollectionApiUrls = new Set(
    hubPayloads
      .filter(Boolean)
      .flatMap((payload) => extractBrowseCollectionItemApiUrlsFromPayload({ rows: payload }))
      .filter(Boolean)
  );
  const seenCollectionApiUrls = new Set();

  while (pendingCollectionApiUrls.size > 0) {
    const batch = [...pendingCollectionApiUrls];
    pendingCollectionApiUrls.clear();

    const payloads = await mapWithConcurrency(batch, args.concurrency, async (url) => {
      if (seenCollectionApiUrls.has(url)) {
        return null;
      }

      seenCollectionApiUrls.add(url);

      try {
        const firstPayloadForUrl = await fetchCriterionApiJson(url);
        const firstHref = firstPayloadForUrl?._links?.self?.href || url;
        const lastHref = firstPayloadForUrl?._links?.last?.href || firstHref;
        const pageApiUrls = buildPaginatedApiUrls(firstHref, lastHref);
        const pagePayloads = await mapWithConcurrency(pageApiUrls, args.concurrency, async (pageUrl) => {
          try {
            return pageUrl === firstHref ? firstPayloadForUrl : await fetchCriterionApiJson(pageUrl);
          } catch (error) {
            console.warn(`Could not fetch browse collection API page ${pageUrl}: ${error.message}`);
            return null;
          }
        });
        return pagePayloads.filter(Boolean);
      } catch (error) {
        console.warn(`Could not fetch browse collection API ${url}: ${error.message}`);
        return [];
      }
    });

    for (const payloadList of payloads) {
      for (const payload of payloadList || []) {
        for (const item of extractVhxItemsFromPayload(payload)) {
          const film = buildFilmFromVhxItem(item);
          if (film && (isCriterionCollectionUrl(film.url) || isCriterionVideoUrl(film.url))) {
            const normalizedUrl = normalizeCriterionUrl(film.url);
            if (!seenFilmUrls.has(normalizedUrl)) {
              seenFilmUrls.add(normalizedUrl);
              films.push(film);
            }

            if (!Number.isInteger(film.year) || !film.director) {
              pageUrlsNeedingBackfill.add(normalizedUrl);
            }
          }

          const nestedUrl = extractVhxNestedItemsUrl(item);
          if (nestedUrl && !/\/customers\//i.test(nestedUrl) && !seenCollectionApiUrls.has(nestedUrl)) {
            pendingCollectionApiUrls.add(nestedUrl);
          }
        }
      }
    }
  }

  return {
    films,
    pageUrlsNeedingBackfill: [...pageUrlsNeedingBackfill],
    hubPageCount: hubPageUrls.length,
    crawledCollectionApiUrlCount: seenCollectionApiUrls.size,
  };
}

function browsePageUrl(pageNumber) {
  if (pageNumber <= 1) {
    return CRITERION_BROWSE_URL;
  }

  return `${CRITERION_BROWSE_URL}?page=${pageNumber}`;
}

async function fetchBrowseCollectionUrls(args) {
  const firstHtml = await fetchText(CRITERION_BROWSE_URL);
  const firstPayload = parseBrowseRowsPayload(firstHtml);
  if (!firstPayload) {
    return [];
  }

  const firstUrls = extractBrowseCollectionUrlsFromPayload(firstPayload);
  const lastHref = firstPayload.rows?._links?.last?.href || firstPayload.rows?._links?.self?.href || "";
  const pageCount = parsePaginationPageCount(lastHref, 1);
  const otherPageNumbers = [];

  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
    otherPageNumbers.push(pageNumber);
  }

  const otherPages = await mapWithConcurrency(otherPageNumbers, args.concurrency, async (pageNumber) => {
    try {
      const html = await fetchText(browsePageUrl(pageNumber));
      return parseBrowseRowsPayload(html);
    } catch (error) {
      console.warn(`Could not fetch browse page ${pageNumber}: ${error.message}`);
      return null;
    }
  });

  return [...new Set([
    ...firstUrls,
    ...otherPages
      .filter(Boolean)
      .flatMap((payload) => extractBrowseCollectionUrlsFromPayload(payload)),
  ])];
}

function extractCollectionVideoUrls(html, baseUrl) {
  return [...new Set(
    [...html.matchAll(/href="([^"#?]+)"/gi)]
      .map((match) => {
        try {
          return normalizeCriterionUrl(new URL(match[1], baseUrl).href);
        } catch (_error) {
          return "";
        }
      })
      .filter(isCriterionVideoUrl)
  )];
}

function extractCollectionPaginationUrls(html, baseUrl) {
  return [...new Set(
    [...html.matchAll(/href="([^"]*[\?&](?:amp;)?page=\d+[^"]*)"/gi)]
      .map((match) => {
        const rawHref = decodeHtml(match[1] || "");

        try {
          const parsed = new URL(rawHref, baseUrl);
          if (parsed.hostname !== "www.criterionchannel.com") {
            return "";
          }

          if (!parsed.searchParams.has("page")) {
            return "";
          }

          parsed.hash = "";
          return parsed.href.replace(/\/+$/, "");
        } catch (_error) {
          return "";
        }
      })
      .filter(Boolean)
  )];
}

function extractCollectionItemBlocks(html) {
  return html.match(/<li[\s\S]*?class="js-collection-item[\s\S]*?<\/li>/gi) || [];
}

function extractCollectionItemHref(block, baseUrl) {
  const rawHref = block.match(/<a[^>]+href="([^"]+)"/i)?.[1] || "";
  if (!rawHref) {
    return "";
  }

  try {
    return normalizeCriterionUrl(new URL(rawHref, baseUrl).href);
  } catch (_error) {
    return "";
  }
}

function extractCollectionFilmFromBlock(block, baseUrl) {
  const itemType = (block.match(/data-item-type="([^"]+)"/i)?.[1] || "").toLowerCase();
  if (!["movie", "video", "series"].includes(itemType)) {
    return null;
  }

  const url = extractCollectionItemHref(block, baseUrl);
  const title =
    stripTags(block.match(/<strong[^>]*title="([^"]+)"/i)?.[1] || "") ||
    stripTags(block.match(/<h3[^>]*>\s*<strong>([\s\S]*?)<\/strong>/i)?.[1] || "");
  const detailsMatch = block.match(/Directed by\s+(.+?)\s+•\s+(\d{4})\s+•\s+([^<\n]+)/i);
  const year = Number.parseInt(detailsMatch?.[2], 10);

  if (!title || !url) {
    return null;
  }

  return {
    title: decodeHtml(title).trim(),
    director: stripTags(detailsMatch?.[1] || "").trim(),
    year: Number.isInteger(year) ? year : null,
    country: cleanCountry(detailsMatch?.[3] || ""),
    url,
  };
}

function extractNestedCollectionUrlsFromBlock(block, baseUrl) {
  const itemType = (block.match(/data-item-type="([^"]+)"/i)?.[1] || "").toLowerCase();
  if (["movie", "video"].includes(itemType)) {
    return [];
  }

  const href = extractCollectionItemHref(block, baseUrl);
  return isCriterionCollectionUrl(href) ? [href] : [];
}

function parseCollectionPage(html, pageUrl) {
  const blocks = extractCollectionItemBlocks(html);
  const films = [];
  const nestedCollectionUrls = new Set();

  for (const block of blocks) {
    const film = extractCollectionFilmFromBlock(block, pageUrl);
    if (film) {
      films.push(film);
      continue;
    }

    for (const nestedUrl of extractNestedCollectionUrlsFromBlock(block, pageUrl)) {
      nestedCollectionUrls.add(nestedUrl);
    }
  }

  return {
    films,
    nestedCollectionUrls: [...nestedCollectionUrls],
  };
}

async function fetchCriterionChannelPagePayloads(urls, args) {
  return mapWithConcurrency(urls, args.concurrency, async (url) => {
    try {
      const html = await fetchText(url);
      return {
        url,
        html,
        film: parseCriterionChannelPage(url, html),
      };
    } catch (error) {
      console.warn(`Could not fetch supplemental Criterion page ${url}: ${error.message}`);
      return null;
    }
  });
}

async function fetchCriterionChannelPages(urls, args) {
  const payloads = (await fetchCriterionChannelPagePayloads(urls, args)).filter(Boolean);
  const seenUrls = new Set(payloads.map((payload) => payload.url));
  const nestedVideoUrls = [...new Set(
    payloads.flatMap((payload) => payload.film ? [] : extractCollectionVideoUrls(payload.html, payload.url))
  )].filter((url) => !seenUrls.has(url));
  const nestedPayloads = (await fetchCriterionChannelPagePayloads(nestedVideoUrls, args)).filter(Boolean);

  return [...payloads, ...nestedPayloads]
    .map((payload) => payload.film)
    .filter(Boolean);
}

async function fetchBrowseSupplement(args) {
  const cachedBrowsePayload = loadBrowseSupplementCache(args.browseCacheFile);
  if (!args.refresh && isFreshBrowseSupplementCache(cachedBrowsePayload)) {
    return {
      films: cachedBrowsePayload.films,
      collectionUrlCount: 0,
      crawledCollectionUrlCount: 0,
      hubPageCount: 0,
      crawledCollectionApiUrlCount: 0,
      apiBackfillUrlCount: 0,
      usedBrowseCache: true,
    };
  }

  const apiSupplement = await fetchBrowseApiSupplement(args);
  const cachedBrowseFilms = cachedBrowsePayload.films || [];
  const cachedBrowseByUrl = new Map(
    cachedBrowseFilms
      .filter((film) => film && film.url)
      .map((film) => [normalizeCriterionUrl(film.url), film])
  );
  const seedCollectionUrls = [...new Set(EXTRA_COLLECTION_SEED_URLS)];
  const seenCollectionUrls = new Set();
  const seenCollectionPageUrls = new Set();
  const seenFilmUrls = new Set();
  const films = [];
  let pendingCollectionUrls = seedCollectionUrls.slice();

  while (pendingCollectionUrls.length > 0) {
    const batch = pendingCollectionUrls;
    pendingCollectionUrls = [];

    const payloads = await mapWithConcurrency(batch, args.concurrency, async (url) => {
      if (seenCollectionUrls.has(url)) {
        return null;
      }

      seenCollectionUrls.add(url);

      try {
        const firstHtml = await fetchText(url);
        const pageUrls = [...new Set([url, ...extractCollectionPaginationUrls(firstHtml, url)])]
          .filter((pageUrl) => !seenCollectionPageUrls.has(pageUrl));
        const pagePayloads = await mapWithConcurrency(pageUrls, args.concurrency, async (pageUrl) => {
          try {
            const html = pageUrl === url ? firstHtml : await fetchText(pageUrl);
            seenCollectionPageUrls.add(pageUrl);
            return { pageUrl, html };
          } catch (error) {
            console.warn(`Could not fetch collection page ${pageUrl}: ${error.message}`);
            return null;
          }
        });

        return {
          url,
          parsedPages: pagePayloads
            .filter(Boolean)
            .map(({ pageUrl, html }) => parseCollectionPage(html, pageUrl || url)),
        };
      } catch (error) {
        console.warn(`Could not fetch collection page ${url}: ${error.message}`);
        return null;
      }
    });

    for (const payload of payloads.filter(Boolean)) {
      for (const parsedPage of payload.parsedPages) {
        for (const film of parsedPage.films) {
          const normalizedUrl = normalizeCriterionUrl(film.url);
          if (seenFilmUrls.has(normalizedUrl)) {
            continue;
          }

          seenFilmUrls.add(normalizedUrl);
          films.push(film);
        }

        for (const nestedUrl of parsedPage.nestedCollectionUrls) {
          if (!seenCollectionUrls.has(nestedUrl)) {
            pendingCollectionUrls.push(nestedUrl);
          }
        }
      }
    }
  }

  const apiFilms = [];
  for (const film of apiSupplement.films) {
    const normalizedUrl = normalizeCriterionUrl(film.url);
    const mergedFilm = betterBrowseFilm(cachedBrowseByUrl.get(normalizedUrl), film);
    cachedBrowseByUrl.set(normalizedUrl, mergedFilm);
    apiFilms.push(mergedFilm);
  }

  const apiBackfillUrls = [...new Set(
    apiFilms
      .filter((film) => !isCompleteFilmMetadata(film))
      .map((film) => normalizeCriterionUrl(film.url))
  )];

  saveBrowseSupplementCache(args.browseCacheFile, {
    updatedAt: new Date().toISOString(),
    films: apiFilms,
  });

  const apiResolvedFilms = await fetchCriterionChannelPages(apiBackfillUrls, args);
  for (const film of apiFilms) {
    const normalizedUrl = normalizeCriterionUrl(film.url);
    if (seenFilmUrls.has(normalizedUrl)) {
      continue;
    }

    seenFilmUrls.add(normalizedUrl);
    films.push(film);
  }
  for (const film of apiResolvedFilms) {
    const normalizedUrl = normalizeCriterionUrl(film.url);
    if (seenFilmUrls.has(normalizedUrl)) {
      const existingIndex = films.findIndex((entry) => normalizeCriterionUrl(entry.url) === normalizedUrl);
      if (existingIndex >= 0) {
        films[existingIndex] = {
          ...films[existingIndex],
          ...film,
        };
      }
      continue;
    }

    seenFilmUrls.add(normalizedUrl);
    films.push(film);
  }

  const incompleteUrls = [...new Set(
    films
      .filter((film) => film && film.url && (!Number.isInteger(film.year) || !film.director))
      .map((film) => normalizeCriterionUrl(film.url))
  )];
  const resolvedByUrl = new Map(
    (await fetchCriterionChannelPages(incompleteUrls, args))
      .filter((film) => film && film.url && Number.isInteger(film.year))
      .map((film) => [normalizeCriterionUrl(film.url), film])
  );
  const completedFilms = films
    .map((film) => resolvedByUrl.get(normalizeCriterionUrl(film.url)) || film)
    .filter((film) => film && film.title && Number.isInteger(film.year) && film.url);

  saveBrowseSupplementCache(args.browseCacheFile, {
    updatedAt: new Date().toISOString(),
    films: completedFilms,
  });

  return {
    films: completedFilms,
    collectionUrlCount: seedCollectionUrls.length,
    crawledCollectionUrlCount: seenCollectionUrls.size,
    hubPageCount: apiSupplement.hubPageCount,
    crawledCollectionApiUrlCount: apiSupplement.crawledCollectionApiUrlCount,
    apiBackfillUrlCount: apiBackfillUrls.length,
    usedBrowseCache: false,
  };
}

function mergeCriterionFilms(primaryFilms, supplementalFilms) {
  const merged = new Map();

  for (const film of [...primaryFilms, ...supplementalFilms]) {
    if (!film || !film.title || !Number.isInteger(film.year) || !film.url) {
      continue;
    }

    const key = [
      normalizeText(film.title),
      film.year,
      normalizeText(film.director || ""),
    ].join("|");
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, film);
      continue;
    }

    const existingIsVideo = isCriterionVideoUrl(existing.url);
    const nextIsVideo = isCriterionVideoUrl(film.url);

    if (existingIsVideo && !nextIsVideo) {
      merged.set(key, film);
      continue;
    }

    if (existingIsVideo === nextIsVideo && film.url.length < existing.url.length) {
      merged.set(key, film);
    }
  }

  return [...merged.values()];
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

function isAcceptableLowConfidenceResolvedMatch(film, movie, match) {
  const filmTitle = normalizeText(film.title);
  const movieTitle = normalizeText(movie.Title || match.suggestedTitle || "");
  const titleSimilarity = computeTitleSimilarity(movieTitle, filmTitle);
  const movieYear = Number.parseInt(movie.Year || match.suggestedYear, 10);
  const yearDelta = Number.isInteger(movieYear) && Number.isInteger(film.year)
    ? Math.abs(movieYear - film.year)
    : 0;
  const exactTitle = movieTitle === filmTitle;

  if (exactTitle) {
    return true;
  }

  return titleSimilarity >= 0.9 && yearDelta <= 3;
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
  if (best.score < MIN_LOW_CONFIDENCE_GUESS_SCORE) {
    return null;
  }

  return {
    ...best,
    confident: best.score >= MIN_CONFIDENT_GUESS_SCORE,
  };
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

  if (best.score < MIN_LOW_CONFIDENCE_GUESS_SCORE) {
    return null;
  }

  return {
    ...best,
    confident,
  };
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

async function lookupImdbForFilm(film, omdbApiKeys, aliasRecord = null) {
  const effectiveFilm = aliasRecord
    ? {
      ...film,
      title: aliasRecord.matchTitle || aliasRecord.searchTitle || film.title,
      director: aliasRecord.matchDirector || film.director,
      year: aliasRecord.matchYear || film.year,
    }
    : film;

  if (aliasRecord && aliasRecord.imdbId) {
    const aliasedMovie = await fetchOmdbById(aliasRecord.imdbId, omdbApiKeys);
    const aliasedRating = Number.parseFloat(aliasedMovie.imdbRating);
    const runtimeMatch = String(aliasedMovie.Runtime || "").match(/(\d+)/);
    const runtimeMinutes = runtimeMatch ? Number.parseInt(runtimeMatch[1], 10) : null;

    if (!Number.isFinite(aliasedRating)) {
      return {
        matched: false,
        reason: `IMDb rating missing for ${aliasRecord.imdbId}`,
      };
    }

    return {
      matched: true,
      imdbId: aliasRecord.imdbId,
      imdbRating: aliasedRating,
      lowConfidence: false,
      confidenceNote: "",
      matchedTitle: aliasedMovie.Title || effectiveFilm.title,
      matchedYear: Number.parseInt(aliasedMovie.Year || effectiveFilm.year, 10) || effectiveFilm.year || null,
      genres: aliasedMovie.Genre ? aliasedMovie.Genre.split(",").map((part) => part.trim()) : [],
      languages: aliasedMovie.Language ? aliasedMovie.Language.split(",").map((part) => part.trim()).filter(Boolean) : [],
      runtimeMinutes: Number.isInteger(runtimeMinutes) ? runtimeMinutes : null,
      runtimeChecked: true,
      languageChecked: true,
    };
  }

  const firstChar = normalizeText(effectiveFilm.title)[0] || "a";
  const query = encodeURIComponent(effectiveFilm.title);
  const url = `https://v2.sg.media-imdb.com/suggestion/${firstChar}/${query}.json`;
  const suggestionResponse = await fetchJson(url);
  let match = pickBestSuggestion(effectiveFilm, suggestionResponse.d || []);

  if (!match) {
    match = await searchCatalogForFilm(effectiveFilm, omdbApiKeys);
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
  const plausibleResolvedMatch = isPlausibleResolvedMatch(effectiveFilm, movie, match);
  const acceptableLowConfidenceMatch = isAcceptableLowConfidenceResolvedMatch(effectiveFilm, movie, match);
  const lowConfidence = !match.confident || !plausibleResolvedMatch;

  if (!plausibleResolvedMatch && !acceptableLowConfidenceMatch) {
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
    lowConfidence,
    confidenceNote: lowConfidence ? "Best guess from public metadata" : "",
    matchedTitle: movie.Title || match.suggestedTitle,
    matchedYear: Number.parseInt(movie.Year || match.suggestedYear, 10) || match.suggestedYear || null,
    genres: movie.Genre ? movie.Genre.split(",").map((part) => part.trim()) : [],
    languages: movie.Language ? movie.Language.split(",").map((part) => part.trim()).filter(Boolean) : [],
    runtimeMinutes: Number.isInteger(runtimeMinutes) ? runtimeMinutes : null,
    runtimeChecked: true,
    languageChecked: true,
  };
}

function lookupPriorityForFilm(film, cache) {
  const record = cache.items[cacheKeyForFilm(film)];
  if (!record) {
    return 2;
  }
  if (isTransientFailure(record) || String(record.reason || "").startsWith("OMDb error")) {
    return 0;
  }
  if (!record.matched) {
    return 1;
  }
  return 3;
}

function prioritizeFilmsForLookup(films, cache) {
  return films
    .slice()
    .sort((left, right) => lookupPriorityForFilm(left, cache) - lookupPriorityForFilm(right, cache));
}

function writeUnresolvedReport(unresolvedFile, films) {
  ensureDirForFile(unresolvedFile);
  fs.writeFileSync(unresolvedFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: films.length,
    items: films.map((film) => ({
      title: film.title,
      year: film.year,
      director: film.director,
      country: film.country,
      url: film.url,
      reason: film.reason,
      imdbId: film.imdbId || null,
      matchedTitle: film.matchedTitle || null,
      matchedYear: film.matchedYear || null,
    })),
  }, null, 2));
}

function loadManualBundledEntries(manualFile) {
  try {
    const raw = fs.readFileSync(manualFile, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
    return list.filter((entry) => entry && entry.url && Number.isFinite(entry.imdbRating));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read manual bundle file ${manualFile}: ${error.message}`);
    }
    return [];
  }
}

function loadBundledCacheEntries(bundledFile) {
  try {
    const raw = fs.readFileSync(bundledFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read bundled cache file ${bundledFile}: ${error.message}`);
    }
  }

  return {
    generatedAt: null,
    entries: [],
  };
}

function buildBundledEntryIndexes(bundledPayload) {
  const byPath = new Map();
  const byTitleYear = new Map();

  for (const entry of bundledPayload.entries || []) {
    if (entry && entry.path) {
      byPath.set(entry.path, entry);
    }
    if (entry && entry.title && Number.isInteger(entry.year)) {
      const key = `${normalizeText(entry.title)}|${entry.year}`;
      const list = byTitleYear.get(key) || [];
      list.push(entry);
      byTitleYear.set(key, list);
    }
  }

  return { byPath, byTitleYear, generatedAt: bundledPayload.generatedAt || null };
}

function bundledCacheRecordForFilm(film, bundledIndex) {
  if (!bundledIndex) {
    return null;
  }

  let path = "";
  try {
    path = new URL(film.url).pathname.replace(/\/+$/, "") || "/";
  } catch (_error) {
    path = "";
  }

  const pathMatch = path ? bundledIndex.byPath.get(path) : null;
  let entry = pathMatch || null;

  if (!entry) {
    const candidates = bundledIndex.byTitleYear.get(`${normalizeText(film.title)}|${film.year}`) || [];
    if (candidates.length === 1) {
      entry = candidates[0];
    } else if (candidates.length > 1) {
      const exactDirector = candidates.find((candidate) =>
        normalizeText(candidate.director || "") === normalizeText(film.director || "")
      );
      entry = exactDirector || null;
    }
  }

  if (!entry || !Number.isFinite(entry.imdbRating)) {
    return null;
  }

  return {
    matched: true,
    imdbRating: entry.imdbRating,
    matchedTitle: entry.title,
    matchedYear: entry.year,
    genres: Array.isArray(entry.genres) ? entry.genres : [],
    languages: Array.isArray(entry.languages) ? entry.languages : [],
    runtimeMinutes: Number.isInteger(entry.runtimeMinutes) ? entry.runtimeMinutes : null,
    runtimeChecked: true,
    languageChecked: true,
    lowConfidence: Boolean(entry.lowConfidence),
    confidenceNote: entry.confidenceNote || "",
    matcherVersion: MATCHER_VERSION,
    checkedAt: bundledIndex.generatedAt || new Date().toISOString(),
    bundledCacheHit: true,
  };
}

function buildFallbackBundledEntryFromCache(cacheKey, record) {
  if (!record || !record.matched || !Number.isFinite(record.imdbRating)) {
    return null;
  }

  const [normalizedKeyTitle = "", cacheYear = ""] = String(cacheKey || "").split("|");
  const title = record.matchedTitle || normalizedKeyTitle;
  const normalizedTitle = normalizeText(title);
  const year = Number.parseInt(record.matchedYear || cacheYear, 10);

  if (!title || !normalizedTitle || !Number.isInteger(year)) {
    return null;
  }

  return {
    url: "",
    path: `/__title__/${normalizedTitle.replace(/\s+/g, "-")}/${year}`,
    title,
    normalizedTitle,
    director: "",
    genres: Array.isArray(record.genres) ? record.genres : [],
    languages: Array.isArray(record.languages) ? record.languages : [],
    imdbRating: record.imdbRating,
    lowConfidence: Boolean(record.lowConfidence),
    confidenceNote: record.confidenceNote || "",
    year,
    runtimeMinutes: Number.isInteger(record.runtimeMinutes) ? record.runtimeMinutes : null,
  };
}

function writeBundledCache(bundledFile, films, manualFile, cache) {
  function toEntry(source) {
    let pathname = source.path || "";
    if (!pathname && source.url) {
      try {
        pathname = new URL(source.url).pathname.replace(/\/+$/, "") || "/";
      } catch (_error) {
        pathname = "";
      }
    }
    return {
      url: source.url,
      path: pathname,
      title: source.title,
      normalizedTitle: source.normalizedTitle || normalizeText(source.title),
      director: typeof source.director === "string" ? source.director.toLowerCase() : normalizeText(source.director || ""),
      genres: Array.isArray(source.genres) ? source.genres.map((g) => String(g).toLowerCase()) : [],
      languages: Array.isArray(source.languages) ? source.languages.map((l) => String(l).toLowerCase()) : [],
      imdbRating: source.imdbRating,
      lowConfidence: Boolean(source.lowConfidence),
      confidenceNote: source.confidenceNote || "",
      year: Number.isInteger(source.year) ? source.year : null,
      runtimeMinutes: Number.isInteger(source.runtimeMinutes) ? source.runtimeMinutes : null,
    };
  }

  const entriesByPath = new Map();
  const entriesByTitleYear = new Map();

  for (const film of films) {
    if (!film.matched || !Number.isFinite(film.imdbRating)) {
      continue;
    }

    const entry = toEntry(film);
    if (entry.path) {
      entriesByPath.set(entry.path, entry);
    }
    if (entry.title && Number.isInteger(entry.year)) {
      entriesByTitleYear.set(`${normalizeText(entry.title)}|${entry.year}`, entry);
    }
  }

  for (const [cacheKey, record] of Object.entries(cache?.items || {})) {
    const entry = buildFallbackBundledEntryFromCache(cacheKey, record);
    if (!entry) {
      continue;
    }

    const titleYearKey = `${normalizeText(entry.title)}|${entry.year}`;
    if (entriesByTitleYear.has(titleYearKey)) {
      continue;
    }

    entriesByPath.set(entry.path, entry);
    entriesByTitleYear.set(titleYearKey, entry);
  }

  for (const manualEntry of loadManualBundledEntries(manualFile)) {
    const entry = toEntry(manualEntry);
    if (entry.path) {
      entriesByPath.set(entry.path, entry);
    }
    if (entry.title && Number.isInteger(entry.year)) {
      entriesByTitleYear.set(`${normalizeText(entry.title)}|${entry.year}`, entry);
    }
  }

  const entries = [...entriesByPath.values()];

  ensureDirForFile(bundledFile);
  fs.writeFileSync(bundledFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  }, null, 2));
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
  const confidence = suggestion.lowConfidence ? " ?best guess" : "";
  const runtime = Number.isInteger(suggestion.runtimeMinutes) ? ` | ${suggestion.runtimeMinutes} min` : "";
  const director = suggestion.director ? ` | dir. ${suggestion.director}` : "";
  const country = suggestion.country ? ` | ${suggestion.country}` : "";
  return `${String(index + 1).padStart(2, " ")}. ${suggestion.title} (${suggestion.year}) | IMDb ${rating}${confidence}${runtime}${director}${country}\n    ${suggestion.url}`;
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

function buildHtmlPage({ films, groups, summary }) {
  const allGenres = groups.map(([genre]) => genre);
  const allLanguages = Array.from(new Set(
    films.flatMap((film) => Array.isArray(film.languages) && film.languages.length > 0 ? film.languages : ["Unknown"])
  )).sort((a, b) => a.localeCompare(b));
  const minAvailableRating = films.reduce((min, film) => Math.min(min, film.imdbRating), 10);
  const maxAvailableRating = films.reduce((max, film) => Math.max(max, film.imdbRating), 0);
  const yearValues = films
    .map((film) => film.year)
    .filter((year) => Number.isInteger(year));
  const minAvailableYear = yearValues.length > 0 ? Math.min(...yearValues) : 0;
  const maxAvailableYear = yearValues.length > 0 ? Math.max(...yearValues) : 0;
  const runtimeValues = films
    .map((film) => film.runtimeMinutes)
    .filter((runtime) => Number.isInteger(runtime));
  const minAvailableRuntime = runtimeValues.length > 0 ? Math.min(...runtimeValues) : 0;
  const maxAvailableRuntime = runtimeValues.length > 0 ? Math.max(...runtimeValues) : 0;
  const filmCards = films
    .map((film) => {
      const genres = Array.isArray(film.genres) && film.genres.length > 0 ? film.genres : ["Unknown"];
      const languages = Array.isArray(film.languages) && film.languages.length > 0 ? film.languages : ["Unknown"];
      const genreBadges = genres.map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("");
      const genreAttr = genres.map((genre) => slugifyGenre(genre)).join(" ");
      const languageAttr = languages.map((language) => slugifyGenre(language)).join(" ");
      const languageText = languages.join(", ");
      const confidenceBadge = film.lowConfidence ? '<span class="tag tag--confidence">? Best guess</span>' : "";
      const ratingText = film.lowConfidence ? `? ${escapeHtml(film.imdbRating.toFixed(1))}` : escapeHtml(film.imdbRating.toFixed(1));
      return `
        <article class="film-card${film.lowConfidence ? " film-card--low-confidence" : ""}" data-title="${escapeHtml(normalizeText(film.title))}" data-director="${escapeHtml(normalizeText(film.director))}" data-genre="${escapeHtml(genreAttr)}" data-language="${escapeHtml(languageAttr)}" data-rating="${escapeHtml(String(film.imdbRating))}" data-year="${escapeHtml(String(film.year || 0))}" data-runtime="${escapeHtml(String(film.runtimeMinutes || 0))}">
          <div class="film-card__top">
            <div>
              <h3><a href="${escapeHtml(film.url)}" target="_blank" rel="noreferrer">${escapeHtml(film.title)}</a></h3>
              <p class="meta">${escapeHtml(String(film.year))} | IMDb ${ratingText}${Number.isInteger(film.runtimeMinutes) ? ` | ${escapeHtml(String(film.runtimeMinutes))} min` : ""}</p>
            </div>
            <div class="rating-pill">${ratingText}</div>
          </div>
          <p class="details">${film.lowConfidence ? `${escapeHtml(film.confidenceNote || "Best guess from public metadata")} | ` : ""}${escapeHtml(film.director || "Unknown director")}${film.country ? ` | ${escapeHtml(film.country)}` : ""}</p>
          <p class="details">Language: ${escapeHtml(languageText)}</p>
          <div class="tags">${confidenceBadge}${genreBadges}</div>
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
          return `<li data-rating="${escapeHtml(String(film.imdbRating))}" data-year="${escapeHtml(String(film.year || 0))}" data-runtime="${escapeHtml(String(film.runtimeMinutes || 0))}" data-language="${escapeHtml(languageAttr)}" data-title="${escapeHtml(normalizeText(film.title))}" data-director="${escapeHtml(normalizeText(film.director))}"><a href="${escapeHtml(film.url)}" target="_blank" rel="noreferrer">${escapeHtml(film.title)}</a> <span>${escapeHtml(String(film.year))}${Number.isInteger(film.runtimeMinutes) ? `, ${escapeHtml(String(film.runtimeMinutes))} min` : ""}${languages.length > 0 ? `, ${escapeHtml(languages.join(", "))}` : ""}${film.lowConfidence ? `, best guess` : ""}</span> <strong>${film.lowConfidence ? "?" : ""}${escapeHtml(film.imdbRating.toFixed(1))}</strong></li>`;
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
    .film-card--low-confidence .rating-pill {
      background: #5c4b8a;
      color: #f7f0ff;
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
    .tag--confidence {
      background: #e0d7ff;
      color: #4f3d8b;
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
      <h1>Browse every scored Criterion title by genre.</h1>
      <div class="summary">
        <div class="stat">Criterion titles scanned: ${escapeHtml(String(summary.scanned))}</div>
        <div class="stat">Matched filters: ${escapeHtml(String(summary.matched))}</div>
        <div class="stat">Titles with IMDb scores: ${escapeHtml(String(summary.scored))}</div>
        <div class="stat">CLI suggestion cutoff: ${escapeHtml(summary.minRating.toFixed(1))}</div>
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

function writeHtmlOutput(htmlFile, films, allFilmsCount, filteredFilmsCount, minRating) {
  const groups = groupSuggestionsByGenre(films);
  const html = buildHtmlPage({
    films,
    groups,
    summary: {
      scanned: allFilmsCount,
      matched: filteredFilmsCount,
      scored: films.length,
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
  const bundledIndex = buildBundledEntryIndexes(loadBundledCacheEntries(args.bundledCacheFile));
  const aliasMap = loadAliasMap(args.aliasFile);
  const catalogFilms = await fetchCriterionFilms();
  const browseSupplement = await fetchBrowseSupplement(args);

  if (args.browseCacheOnly) {
    console.log(`Browse cache reused: ${browseSupplement.usedBrowseCache ? "yes" : "no"}`);
    console.log(`Browse seed collections discovered: ${browseSupplement.collectionUrlCount}`);
    console.log(`Browse collection pages crawled: ${browseSupplement.crawledCollectionUrlCount}`);
    console.log(`Browse API collections crawled: ${browseSupplement.crawledCollectionApiUrlCount}`);
    console.log(`Browse API pages backfilled via HTML: ${browseSupplement.apiBackfillUrlCount}`);
    console.log(`Browse supplement titles cached: ${browseSupplement.films.length}`);
    console.log(`Browse cache file: ${args.browseCacheFile}`);
    return;
  }

  const explicitSupplementUrls = [...new Set(loadSupplementalUrls(args.supplementalUrlsFile))];
  const explicitSupplementFilms = await fetchCriterionChannelPages(explicitSupplementUrls, args);
  const supplementalFilms = mergeCriterionFilms(browseSupplement.films, explicitSupplementFilms);
  const allFilms = mergeCriterionFilms(catalogFilms, supplementalFilms);
  const filteredFilms = prioritizeFilmsForLookup(filterFilms(allFilms, args), cache);

  if (filteredFilms.length === 0) {
    console.log("No Criterion titles matched those filters.");
    return;
  }

  let newLookups = 0;
  const lookupNeededCount = filteredFilms.reduce((count, film) => {
    const key = cacheKeyForFilm(film);
    const cached = cache.items[key];
    if (canReuseCachedRecord(film, cached, args.refresh)) {
      return count;
    }
    if (bundledCacheRecordForFilm(film, bundledIndex)) {
      return count;
    }
    return count + 1;
  }, 0);
  const enriched = await mapWithConcurrency(filteredFilms, args.concurrency, async (film, index) => {
    const key = cacheKeyForFilm(film);
    const cached = cache.items[key];
    const shouldUseCache = canReuseCachedRecord(film, cached, args.refresh);

    if (shouldUseCache) {
      return { ...film, ...cached };
    }

    const bundledRecord = bundledCacheRecordForFilm(film, bundledIndex);
    if (bundledRecord) {
      cache.items[key] = bundledRecord;
      return { ...film, ...bundledRecord };
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
      console.error(`Looked up ${newLookups} / ${lookupNeededCount} uncached titles...`);
    }

    try {
      const lookup = await lookupImdbForFilm(film, args.omdbApiKeys, aliasMap[aliasKeyForFilm(film)] || null);
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
  writeUnresolvedReport(args.unresolvedFile, enriched.filter((film) => !film.matched));
  writeBundledCache(args.bundledCacheFile, enriched, args.manualBundledFile, cache);

  const suggestions = enriched
    .filter((film) => film.matched && Number.isFinite(film.imdbRating) && film.imdbRating >= args.minRating)
    .sort((a, b) => {
      if (b.imdbRating !== a.imdbRating) {
        return b.imdbRating - a.imdbRating;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, args.limit);
  const scoredFilms = enriched
    .filter((film) => film.matched && Number.isFinite(film.imdbRating))
    .sort((a, b) => {
      if (b.imdbRating !== a.imdbRating) {
        return b.imdbRating - a.imdbRating;
      }
      return a.title.localeCompare(b.title);
    });

  console.log(`Criterion titles scanned: ${allFilms.length}`);
  console.log(`Browse supplements added: ${supplementalFilms.length}`);
  console.log(`Browse cache reused: ${browseSupplement.usedBrowseCache ? "yes" : "no"}`);
  console.log(`Browse seed collections discovered: ${browseSupplement.collectionUrlCount}`);
  console.log(`Browse collection pages crawled: ${browseSupplement.crawledCollectionUrlCount}`);
  console.log(`Browse API pages backfilled via HTML: ${browseSupplement.apiBackfillUrlCount}`);
  console.log(`Explicit supplemental URLs queried: ${explicitSupplementUrls.length}`);
  console.log(`Matched filters: ${filteredFilms.length}`);
  console.log(`Uncached titles needing OMDb lookup: ${lookupNeededCount}`);
  console.log(`New IMDb lookups this run: ${newLookups}`);
  console.log(`Cache file: ${args.cacheFile}`);
  console.log("");

  if (args.html) {
    writeHtmlOutput(args.htmlFile, scoredFilms, allFilms.length, filteredFilms.length, args.minRating);
    console.log(`HTML page written to: ${args.htmlFile}`);

    if (args.open) {
      openFile(args.htmlFile);
      console.log("Opened HTML page in your browser.");
    }

    console.log("");
  }

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

}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
