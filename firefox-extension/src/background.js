const extensionApi = globalThis.browser || globalThis.chrome;
const matcherApi = globalThis.CriterionImdbMatcher || null;

const CACHE_STORAGE_KEY = "criterionImdbCache";
const CACHE_META_STORAGE_KEY = "criterionImdbCacheMeta";
const API_CACHE_STORAGE_KEY = "criterionImdbApiCache";
const API_CACHE_META_STORAGE_KEY = "criterionImdbApiCacheMeta";
const REMOTE_INDEX_STORAGE_KEY = "criterionImdbRemoteIndex";
const REMOTE_INDEX_META_STORAGE_KEY = "criterionImdbRemoteIndexMeta";
const SETTINGS_STORAGE_KEY = "criterionImdbSettings";
const CACHE_SCHEMA_VERSION = 9;
const API_CACHE_SCHEMA_VERSION = 1;
const BUNDLED_CACHE_URL = "data/criterion-cache.json";
const REMOTE_CACHE_URLS = [
  "https://raylim.github.io/criterion-imdb/criterion-cache.json",
  "https://raw.githubusercontent.com/raylim/criterion-imdb/main/docs/criterion-cache.json"
];
const OMDB_FALLBACK_CONCURRENCY = 4;
const DEFAULT_SETTINGS = {
  minRating: 7.5,
  maxCacheAgeDays: 30,
  omdbApiKeys: [],
  showRuntime: true,
  showGenres: true,
  showLanguages: true,
  showDirector: true,
  showCountry: true,
  dimLowRated: false,
  debugMode: false
};

let activeIndexPromise = null;

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(concurrency || 1, items.length || 1));
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function toCriterionPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "") || "/";
  } catch (_error) {
    return String(url || "").replace(/\/+$/, "") || "/";
  }
}

function titleFromPath(path) {
  return normalizeText(
    String(path || "")
      .split("/")
      .filter(Boolean)
      .filter((segment) => segment !== "videos")
      .pop()
      ?.replace(/[-_]+/g, " ") || ""
  );
}

function isVideoPath(path) {
  return /(^|\/)videos(\/|$)/i.test(String(path || ""));
}

function buildIndexFromPayload(payload, source) {
  const byPath = new Map();
  const byTitleYear = new Map();
  const byTitle = new Map();
  const byNormalizedTitle = new Map();

  for (const entry of payload.entries || []) {
    if (entry.path) {
      byPath.set(entry.path, entry);
    }

    const titleYearKey = `${normalizeText(entry.title)}|${entry.year || "unknown"}`;
    byTitleYear.set(titleYearKey, entry);

    const titleKey = normalizeText(entry.title);
    const titleMatches = byTitle.get(titleKey) || [];
    titleMatches.push(entry);
    byTitle.set(titleKey, titleMatches);

    const normalizedMatches = byNormalizedTitle.get(entry.normalizedTitle) || [];
    normalizedMatches.push(entry);
    byNormalizedTitle.set(entry.normalizedTitle, normalizedMatches);
  }

  return {
    count: Number(payload.count) || 0,
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : "",
    source,
    byPath,
    byTitleYear,
    byTitle,
    byNormalizedTitle
  };
}

function isValidCachePayload(payload) {
  return Boolean(payload) && Array.isArray(payload.entries);
}

async function loadBundledPayload() {
  const response = await fetch(extensionApi.runtime.getURL(BUNDLED_CACHE_URL), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Bundled cache request failed (${response.status})`);
  }

  return response.json();
}

async function getStoredRemotePayload(maxCacheAgeDays) {
  const stored = await extensionApi.storage.local.get([REMOTE_INDEX_STORAGE_KEY, REMOTE_INDEX_META_STORAGE_KEY]);
  const payload = stored[REMOTE_INDEX_STORAGE_KEY];
  const meta = stored[REMOTE_INDEX_META_STORAGE_KEY] || {};

  if (!isValidCachePayload(payload) || !meta.fetchedAt) {
    return null;
  }

  const maxAgeMs = Math.max(1, Number(maxCacheAgeDays) || DEFAULT_SETTINGS.maxCacheAgeDays) * 24 * 60 * 60 * 1000;
  const fetchedAtMs = new Date(meta.fetchedAt).getTime();
  if (!Number.isFinite(fetchedAtMs) || (Date.now() - fetchedAtMs) > maxAgeMs) {
    return null;
  }

  return {
    payload,
    url: meta.url || "remote cache",
    fetchedAt: meta.fetchedAt
  };
}

async function saveRemotePayload(payload, url) {
  await extensionApi.storage.local.set({
    [REMOTE_INDEX_STORAGE_KEY]: payload,
    [REMOTE_INDEX_META_STORAGE_KEY]: {
      url,
      fetchedAt: new Date().toISOString(),
      generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : ""
    }
  });
}

async function fetchRemotePayload() {
  let lastError = null;

  for (const url of REMOTE_CACHE_URLS) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Remote cache request failed (${response.status})`);
      }

      const payload = await response.json();
      if (!isValidCachePayload(payload)) {
        throw new Error("Remote cache payload is invalid");
      }

      await saveRemotePayload(payload, url);
      return {
        payload,
        url
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not fetch remote Criterion cache");
}

async function loadActiveIndex(options = {}) {
  const { forceRemoteRefresh = false } = options;
  if (!forceRemoteRefresh && activeIndexPromise) {
    return activeIndexPromise;
  }

  activeIndexPromise = (async () => {
    const settings = await getSettings();

    if (!forceRemoteRefresh) {
      const storedRemote = await getStoredRemotePayload(settings.maxCacheAgeDays);
      if (storedRemote) {
        return buildIndexFromPayload(storedRemote.payload, storedRemote.url);
      }
    }

    try {
      const remote = await fetchRemotePayload();
      return buildIndexFromPayload(remote.payload, remote.url);
    } catch (_error) {
      const bundledPayload = await loadBundledPayload();
      return buildIndexFromPayload(bundledPayload, "bundled extension cache");
    }
  })();

  return activeIndexPromise;
}

function getCacheKey(film) {
  return `${normalizeText(film.title)}|${film.year || "unknown"}|${toCriterionPath(film.url)}`;
}

function parseOmdbApiKeys(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map((part) => String(part || "").trim()).filter(Boolean);
  }

  return String(rawValue || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findBundledMatch(index, film) {
  const path = toCriterionPath(film.url);
  if (path && index.byPath.has(path)) {
    return index.byPath.get(path);
  }

  const slugTitle = titleFromPath(path);
  const slugMatches = slugTitle ? index.byNormalizedTitle.get(slugTitle) || [] : [];
  if (film.year) {
    const slugYearMatch = slugMatches.find((entry) => entry.year === film.year);
    if (slugYearMatch) {
      return slugYearMatch;
    }
  }
  if (slugMatches.length === 1) {
    return slugMatches[0];
  }

  const titleYearKey = `${normalizeText(film.title)}|${film.year || "unknown"}`;
  if (film.title && film.year && index.byTitleYear.has(titleYearKey)) {
    return index.byTitleYear.get(titleYearKey);
  }

  const titleKey = normalizeText(film.title);
  const titleMatches = titleKey ? index.byTitle.get(titleKey) || [] : [];
  if (film.title && film.year) {
    const titleYearFromList = titleMatches.find((entry) => entry.year === film.year);
    if (titleYearFromList) {
      return titleYearFromList;
    }
  }
  if (titleMatches.length === 1) {
    return titleMatches[0];
  }

  return null;
}

function toLookupResult(film, bundled) {
  if (!bundled) {
    return {
      ...film,
      matched: false,
      reason: "No cached IMDb score found"
    };
  }

  return {
    ...film,
    title: film.title || bundled.title,
    year: film.year || bundled.year || null,
    director: film.director || bundled.director || "",
    matched: true,
    imdbRating: bundled.imdbRating,
    matchedTitle: bundled.title,
    matchedYear: bundled.year || null,
    genres: Array.isArray(bundled.genres) ? bundled.genres : [],
    languages: Array.isArray(bundled.languages) ? bundled.languages : [],
    runtimeMinutes: Number.isInteger(bundled.runtimeMinutes) ? bundled.runtimeMinutes : null,
    checkedAt: new Date().toISOString()
  };
}

async function getSettings() {
  const stored = await extensionApi.storage.local.get(SETTINGS_STORAGE_KEY);
  const rawSettings = stored[SETTINGS_STORAGE_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    minRating: Number.isFinite(Number(rawSettings.minRating)) ? Number(rawSettings.minRating) : DEFAULT_SETTINGS.minRating,
    maxCacheAgeDays: Number.isInteger(Number.parseInt(rawSettings.maxCacheAgeDays, 10)) ? Number.parseInt(rawSettings.maxCacheAgeDays, 10) : DEFAULT_SETTINGS.maxCacheAgeDays,
    omdbApiKeys: parseOmdbApiKeys(rawSettings.omdbApiKeys),
    showRuntime: rawSettings.showRuntime ?? DEFAULT_SETTINGS.showRuntime,
    showGenres: rawSettings.showGenres ?? DEFAULT_SETTINGS.showGenres,
    showLanguages: rawSettings.showLanguages ?? DEFAULT_SETTINGS.showLanguages,
    showDirector: rawSettings.showDirector ?? DEFAULT_SETTINGS.showDirector,
    showCountry: rawSettings.showCountry ?? DEFAULT_SETTINGS.showCountry,
    dimLowRated: rawSettings.dimLowRated ?? DEFAULT_SETTINGS.dimLowRated,
    debugMode: rawSettings.debugMode ?? DEFAULT_SETTINGS.debugMode
  };
}

async function getApiCache() {
  const stored = await extensionApi.storage.local.get([API_CACHE_STORAGE_KEY, API_CACHE_META_STORAGE_KEY]);
  const meta = stored[API_CACHE_META_STORAGE_KEY] || {};
  if (meta.schemaVersion !== API_CACHE_SCHEMA_VERSION) {
    return {};
  }

  return stored[API_CACHE_STORAGE_KEY] || {};
}

async function saveApiCache(cache) {
  await extensionApi.storage.local.set({
    [API_CACHE_STORAGE_KEY]: cache,
    [API_CACHE_META_STORAGE_KEY]: {
      schemaVersion: API_CACHE_SCHEMA_VERSION
    }
  });
}

function shouldReuseApiRecord(record, maxCacheAgeDays) {
  return Boolean(record) && (
    (record.matched && record.source === "omdb") ||
    (matcherApi && typeof matcherApi.isFreshRecord === "function" && matcherApi.isFreshRecord(record, maxCacheAgeDays))
  );
}

async function lookupViaOmdb(film, apiKeys) {
  if (!matcherApi || typeof matcherApi.lookupFilm !== "function") {
    return {
      attempted: false,
      matched: false,
      reason: "OMDb fallback unavailable"
    };
  }

  if (!apiKeys.length) {
    return {
      attempted: false,
      matched: false,
      reason: "No cached IMDb score found"
    };
  }

  let lastError = null;
  for (const apiKey of apiKeys) {
    try {
      const result = await matcherApi.lookupFilm(fetch.bind(globalThis), film, apiKey);
      if (result.matched || result.reason !== "OMDb API key required") {
        return {
          attempted: true,
          ...result
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    return {
      attempted: true,
      matched: false,
      reason: lastError.message || "OMDb lookup failed"
    };
  }

  return {
    attempted: false,
    matched: false,
    reason: "No cached IMDb score found"
  };
}

async function getCache(bundleGeneratedAt) {
  const stored = await extensionApi.storage.local.get([CACHE_STORAGE_KEY, CACHE_META_STORAGE_KEY]);
  const meta = stored[CACHE_META_STORAGE_KEY] || {};
  if (
    meta.schemaVersion !== CACHE_SCHEMA_VERSION ||
    meta.bundleGeneratedAt !== bundleGeneratedAt
  ) {
    return {};
  }
  return stored[CACHE_STORAGE_KEY] || {};
}

async function saveCache(cache, bundleGeneratedAt) {
  await extensionApi.storage.local.set({
    [CACHE_STORAGE_KEY]: cache,
    [CACHE_META_STORAGE_KEY]: {
      schemaVersion: CACHE_SCHEMA_VERSION,
      bundleGeneratedAt
    }
  });
}

async function lookupFilms(films, options = {}) {
  const allowOmdbFallback = options.allowOmdbFallback !== false;
  const settings = await getSettings();
  const index = await loadActiveIndex();
  const cache = await getCache(index.generatedAt);
  const apiCache = await getApiCache();
  const results = new Array(films.length);
  const omdbLookups = [];
  let cacheChanged = false;
  let apiCacheChanged = false;

  for (const [filmIndex, film] of films.entries()) {
    const cacheKey = getCacheKey(film);
    const cached = cache[cacheKey];

    if (cached) {
      results[filmIndex] = {
        ...film,
        ...cached,
        source: "cache"
      };
      continue;
    }

    const bundled = findBundledMatch(index, film);
    if (bundled) {
      const record = toLookupResult(film, bundled);
      cache[cacheKey] = record;
      cacheChanged = true;
      results[filmIndex] = {
        ...record,
        source: "bundled"
      };
      continue;
    }

    const cachedApiRecord = apiCache[cacheKey];
    if (shouldReuseApiRecord(cachedApiRecord, settings.maxCacheAgeDays)) {
      results[filmIndex] = {
        ...film,
        ...cachedApiRecord,
        source: cachedApiRecord.source || (cachedApiRecord.matched ? "omdb" : "missing")
      };
      continue;
    }

    if (!allowOmdbFallback) {
      results[filmIndex] = {
        ...film,
        matched: false,
        reason: "Checking OMDb…",
        source: "pending"
      };
      continue;
    }

    omdbLookups.push({ film, filmIndex, cacheKey });
  }

  if (omdbLookups.length > 0) {
    const omdbResults = await mapWithConcurrency(
      omdbLookups,
      Math.min(OMDB_FALLBACK_CONCURRENCY, Math.max(1, settings.omdbApiKeys.length || 1)),
      async ({ film, filmIndex, cacheKey }) => {
        const omdbRecord = await lookupViaOmdb(film, settings.omdbApiKeys);
        const record = omdbRecord.matched
          ? {
              ...film,
              ...omdbRecord,
              checkedAt: omdbRecord.checkedAt || new Date().toISOString(),
              source: "omdb"
            }
          : {
              ...film,
              matched: false,
              reason: omdbRecord.reason || "No cached IMDb score found",
              checkedAt: new Date().toISOString(),
              source: "missing"
            };

        return {
          filmIndex,
          cacheKey,
          attempted: omdbRecord.attempted,
          record
        };
      }
    );

    for (const payload of omdbResults) {
      if (!payload) {
        continue;
      }

      results[payload.filmIndex] = payload.record;
      if (payload.attempted) {
        apiCache[payload.cacheKey] = payload.record;
        apiCacheChanged = true;
      }
    }
  }

  if (cacheChanged) {
    await saveCache(cache, index.generatedAt);
  }

  if (apiCacheChanged) {
    await saveApiCache(apiCache);
  }

  return {
    settings,
    results,
    datasetCount: index.count,
    dataSource: index.source,
    bundleGeneratedAt: index.generatedAt
  };
}

async function refreshExtensionCache() {
  activeIndexPromise = null;
  const index = await loadActiveIndex({ forceRemoteRefresh: true });
  await extensionApi.storage.local.remove([CACHE_STORAGE_KEY, CACHE_META_STORAGE_KEY, API_CACHE_STORAGE_KEY, API_CACHE_META_STORAGE_KEY]);
  return {
    cleared: true,
    datasetCount: index.count,
    bundleGeneratedAt: index.generatedAt,
    dataSource: index.source
  };
}

extensionApi.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "criterion-imdb:get-settings") {
    return getSettings();
  }

  if (message.type === "criterion-imdb:lookup-films") {
    return lookupFilms(
      Array.isArray(message.films) ? message.films : [],
      message.options && typeof message.options === "object" ? message.options : {}
    );
  }

  if (message.type === "criterion-imdb:clear-cache") {
    return extensionApi.storage.local.remove([CACHE_STORAGE_KEY, CACHE_META_STORAGE_KEY, API_CACHE_STORAGE_KEY, API_CACHE_META_STORAGE_KEY]);
  }

  if (message.type === "criterion-imdb:refresh-extension-cache") {
    return refreshExtensionCache();
  }

  return undefined;
});
