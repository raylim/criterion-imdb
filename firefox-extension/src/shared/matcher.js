(function initMatcher(globalScope) {
  const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
  const MATCHER_VERSION = 1;
  const OMDB_API_URL = "https://www.omdbapi.com/";
  const REQUEST_TIMEOUT_MS = 15000;
  const ALLOWED_IMDB_KINDS = new Set([
    "movie",
    "feature",
    "TV movie",
    "tvMovie",
    "short",
    "tvShort",
    "tvSpecial"
  ]);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return String(text || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
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

  function cacheKeyForFilm(film) {
    return `${normalizeText(film.title)}|${film.year || "unknown"}`;
  }

  function isFreshRecord(record, maxAgeDays) {
    if (!record || !record.checkedAt) {
      return false;
    }

    const checkedAtMs = Date.parse(record.checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      return false;
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    return Date.now() - checkedAtMs <= maxAgeMs;
  }

  async function fetchWithRetry(fetchImpl, url, accept, maxAttempts = 4) {
    let lastStatus = null;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetchImpl(url, {
          headers: {
            accept
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          return response;
        }

        lastStatus = response.status;
        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
          throw new Error(`Request failed (${response.status}) for ${url}`);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        if (attempt === maxAttempts) {
          throw new Error(
            error && error.name === "AbortError"
              ? `Request timed out for ${url}`
              : (error && error.message) || `fetch failed for ${url}`
          );
        }
      }

      const delayMs = 750 * (2 ** (attempt - 1));
      await sleep(delayMs);
    }

    if (lastError) {
      throw new Error(lastError.message || `fetch failed for ${url}`);
    }

    throw new Error(`Request failed (${lastStatus || "unknown"}) for ${url}`);
  }

  async function fetchJson(fetchImpl, url) {
    const response = await fetchWithRetry(fetchImpl, url, "application/json");
    return response.json();
  }

  async function fetchOmdbById(fetchImpl, imdbId, apiKey) {
    const url = `${OMDB_API_URL}?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`;
    const payload = await fetchJson(fetchImpl, url);

    if (!payload || payload.Response === "False") {
      const message = payload && payload.Error ? payload.Error : "Unknown OMDb error";
      throw new Error(`OMDb error for ${imdbId}: ${message}`);
    }

    return payload;
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
        const score = titleScore + similarityScore + kindScore + directorBonus - yearPenalty * 4 + rankScore;

        return {
          imdbId: item.id,
          suggestedTitle: item.l,
          suggestedYear: item.y,
          score
        };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0 || candidates[0].score < 12) {
      return null;
    }

    return candidates[0];
  }

  function pickBestCatalogResult(film, results) {
    const targetTitle = normalizeText(film.title);

    const candidates = results
      .filter((item) => item && item.id && item.name)
      .map((item) => {
        const candidateTitle = normalizeText(item.name || "");
        const directorText = normalizeText(Array.isArray(item.director) ? item.director.join(" ") : item.director);
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
          hasDirectorMatch: directorBonus > 0
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

    return confident ? best : null;
  }

  async function searchCatalogForFilm(fetchImpl, film, apiKey) {
    const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(film.title)}.json`;
    const response = await fetchJson(fetchImpl, url);
    const candidates = await Promise.all((response.metas || []).slice(0, 5).map(async (item) => {
      if (!apiKey || !(item.imdb_id || item.id)) {
        return item;
      }

      try {
        const omdb = await fetchOmdbById(fetchImpl, item.imdb_id || item.id, apiKey);
        return {
          ...item,
          name: omdb.Title || item.name,
          year: omdb.Year || item.year,
          director: omdb.Director ? omdb.Director.split(",").map((part) => part.trim()) : item.director,
          imdbRating: omdb.imdbRating,
          genres: omdb.Genre ? omdb.Genre.split(",").map((part) => part.trim()) : item.genres
        };
      } catch (_error) {
        return item;
      }
    }));

    return pickBestCatalogResult(film, candidates);
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

    const filmYearKnown = Number.isInteger(film.year);
    const filmDirectorKnown = Boolean(filmDirector);

    if (exactTitle && yearDelta <= 1) {
      return true;
    }

    if (exactTitle && directorSimilarity >= 0.5 && yearDelta <= 3) {
      return true;
    }

    if (directorSimilarity >= 0.75 && yearDelta <= 2) {
      return true;
    }

    if (exactTitle && !filmYearKnown && !filmDirectorKnown) {
      return true;
    }

    return titleSimilarity >= 0.8 && directorSimilarity >= 0.5 && yearDelta <= 2;
  }

  async function lookupFilm(fetchImpl, film, apiKey) {
    if (!apiKey) {
      return {
        matched: false,
        reason: "OMDb API key required"
      };
    }

    if (!film || !film.title) {
      return {
        matched: false,
        reason: "Film title missing"
      };
    }

    const firstChar = normalizeText(film.title)[0] || "a";
    const url = `https://v2.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(film.title)}.json`;
    const suggestionResponse = await fetchJson(fetchImpl, url);
    let match = pickBestSuggestion(film, suggestionResponse.d || []);

    if (!match) {
      match = await searchCatalogForFilm(fetchImpl, film, apiKey);
    }

    if (!match) {
      return {
        matched: false,
        reason: "No confident IMDb match found"
      };
    }

    const movie = await fetchOmdbById(fetchImpl, match.imdbId, apiKey);
    const imdbRating = Number.parseFloat(movie.imdbRating);
    const runtimeMatch = String(movie.Runtime || "").match(/(\d+)/);
    const runtimeMinutes = runtimeMatch ? Number.parseInt(runtimeMatch[1], 10) : null;

    if (!isPlausibleResolvedMatch(film, movie, match)) {
      return {
        matched: false,
        reason: "No confident IMDb match found"
      };
    }

    if (!Number.isFinite(imdbRating)) {
      return {
        matched: false,
        reason: `IMDb rating missing for ${match.imdbId}`
      };
    }

    return {
      matched: true,
      imdbId: match.imdbId,
      imdbRating,
      matchedTitle: movie.Title || match.suggestedTitle,
      matchedYear: Number.parseInt(movie.Year || match.suggestedYear, 10) || match.suggestedYear || null,
      genres: movie.Genre ? movie.Genre.split(",").map((part) => part.trim()).filter(Boolean) : [],
      languages: movie.Language ? movie.Language.split(",").map((part) => part.trim()).filter(Boolean) : [],
      runtimeMinutes: Number.isInteger(runtimeMinutes) ? runtimeMinutes : null,
      rated: movie.Rated || "",
      plot: movie.Plot || "",
      matcherVersion: MATCHER_VERSION,
      checkedAt: new Date().toISOString()
    };
  }

  globalScope.CriterionImdbMatcher = {
    MATCHER_VERSION,
    cacheKeyForFilm,
    isFreshRecord,
    lookupFilm
  };
})(typeof self !== "undefined" ? self : globalThis);
