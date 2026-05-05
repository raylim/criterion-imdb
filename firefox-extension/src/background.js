const extensionApi = globalThis.browser || globalThis.chrome;

const CACHE_STORAGE_KEY = "criterionImdbCache";
const CACHE_META_STORAGE_KEY = "criterionImdbCacheMeta";
const SETTINGS_STORAGE_KEY = "criterionImdbSettings";
const CACHE_SCHEMA_VERSION = 7;
const DEFAULT_SETTINGS = {
  minRating: 7.5,
  showRuntime: true,
  showGenres: true,
  showLanguages: true,
  showDirector: true,
  showCountry: true,
  dimLowRated: false
};

let bundledIndexPromise = null;

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

async function loadBundledIndex() {
  if (!bundledIndexPromise) {
    bundledIndexPromise = (async () => {
      const response = await fetch(extensionApi.runtime.getURL("data/criterion-cache.json"));
      if (!response.ok) {
        throw new Error(`Bundled cache request failed (${response.status})`);
      }

      const payload = await response.json();
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
        byPath,
        byTitleYear,
        byTitle,
        byNormalizedTitle
      };
    })();
  }

  return bundledIndexPromise;
}

function getCacheKey(film) {
  return `${normalizeText(film.title)}|${film.year || "unknown"}|${toCriterionPath(film.url)}`;
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
    showRuntime: rawSettings.showRuntime ?? DEFAULT_SETTINGS.showRuntime,
    showGenres: rawSettings.showGenres ?? DEFAULT_SETTINGS.showGenres,
    showLanguages: rawSettings.showLanguages ?? DEFAULT_SETTINGS.showLanguages,
    showDirector: rawSettings.showDirector ?? DEFAULT_SETTINGS.showDirector,
    showCountry: rawSettings.showCountry ?? DEFAULT_SETTINGS.showCountry,
    dimLowRated: rawSettings.dimLowRated ?? DEFAULT_SETTINGS.dimLowRated
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

async function lookupFilms(films) {
  const settings = await getSettings();
  const index = await loadBundledIndex();
  const cache = await getCache(index.generatedAt);
  const results = [];
  let cacheChanged = false;

  for (const film of films) {
    const cacheKey = getCacheKey(film);
    const cached = cache[cacheKey];

    if (cached) {
      results.push({
        ...film,
        ...cached,
        source: "cache"
      });
      continue;
    }

    const bundled = findBundledMatch(index, film);
    const record = toLookupResult(film, bundled);
    cache[cacheKey] = record;
    cacheChanged = true;
    results.push({
      ...record,
      source: bundled ? "bundled" : "missing"
    });
  }

  if (cacheChanged) {
    await saveCache(cache, index.generatedAt);
  }

  return {
    settings,
    results,
    datasetCount: index.count
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
    return lookupFilms(Array.isArray(message.films) ? message.films : []);
  }

  if (message.type === "criterion-imdb:clear-cache") {
    return extensionApi.storage.local.remove([CACHE_STORAGE_KEY, CACHE_META_STORAGE_KEY]);
  }

  return undefined;
});
