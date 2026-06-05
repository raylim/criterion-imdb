(function initCriterionOverlay(globalScope) {
  const extensionApi = globalThis.browser || globalThis.chrome;
  const domScraper = globalScope.CriterionOverlayDom;
  const ROOT_CLASS = "criterion-imdb-overlay";
  const ANCHOR_HOST_CLASS = "criterion-imdb-overlay-anchor-host";
  const STATUS_CLASS = "criterion-imdb-status";
  const PROCESSED_DATASET_KEY = "criterionImdbProcessedV6";
  const VISIBLE_LOOKUP_PADDING_PX = 240;
  const pendingNodes = new WeakSet();
  const pendingNodeStartedAt = new WeakMap();
  const pendingNodeTimers = new WeakMap();
  const PENDING_NODE_TIMEOUT_MS = 30000;
  let scanScheduled = false;
  let latestSettings = null;
  let debugMode = false;
  let deferredBatchTimer = null;
  let deferredBatchItems = new Map();

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    globalScope.setTimeout(() => {
      scanScheduled = false;
      scanAndOverlay().catch((error) => {
        console.warn("Criterion IMDb overlay scan failed:", error);
      });
    }, 150);
  }

  function formatDetails(result, settings) {
    const details = [];

    if (result.lowConfidence) {
      const sourceYear = Number.isInteger(result.year) ? result.year : null;
      const matchedYear = Number.isInteger(result.matchedYear) ? result.matchedYear : null;
      const showMatchedYear = matchedYear !== null && sourceYear !== matchedYear;
      details.push(
        showMatchedYear
          ? `${result.confidenceNote || "Best guess"} (${matchedYear})`
          : (result.confidenceNote || "Best guess")
      );
    }
    if (settings.showDirector && result.director) {
      details.push(result.director);
    }
    if (settings.showCountry && result.country) {
      details.push(result.country);
    }
    if (settings.showRuntime && Number.isInteger(result.runtimeMinutes)) {
      details.push(`${result.runtimeMinutes} min`);
    }
    if (settings.showLanguages && Array.isArray(result.languages) && result.languages.length > 0) {
      details.push(result.languages.join(", "));
    }
    if (settings.showGenres && Array.isArray(result.genres) && result.genres.length > 0) {
      details.push(result.genres.slice(0, 3).join(", "));
    }

    return details.join(" • ");
  }

  function needsSiblingHost(container) {
    return Boolean(
      container instanceof HTMLAnchorElement ||
      container.classList?.contains("browse-item-title") ||
      container.classList?.contains("browse-item-description")
    );
  }

  function getExistingOverlayHost(container) {
    if (!needsSiblingHost(container)) {
      return container;
    }

    const host = container.nextElementSibling;
    if (host && host.classList.contains(ANCHOR_HOST_CLASS)) {
      return host;
    }

    return null;
  }

  function ensureOverlayHost(container) {
    const existingHost = getExistingOverlayHost(container);
    if (existingHost) {
      return existingHost;
    }

    if (!needsSiblingHost(container)) {
      return container;
    }

    const host = document.createElement("div");
    host.className = ANCHOR_HOST_CLASS;
    container.insertAdjacentElement("afterend", host);
    return host;
  }

  function cleanupEmptyOverlayHost(host) {
    if (
      host &&
      host.classList?.contains(ANCHOR_HOST_CLASS) &&
      host.childElementCount === 0
    ) {
      host.remove();
    }
  }

  function clearProcessedState(container) {
    if (!container?.dataset) {
      return;
    }

    delete container.dataset[PROCESSED_DATASET_KEY];
  }

  function hasRenderedOverlay(container) {
    if (!container) {
      return false;
    }

    const host = getExistingOverlayHost(container) || (!needsSiblingHost(container) ? container : null);
    if (!host) {
      return false;
    }

    return host.querySelectorAll(`:scope > .${ROOT_CLASS}`).length > 0;
  }

  function markNodePending(container) {
    clearNodePending(container);
    pendingNodes.add(container);
    pendingNodeStartedAt.set(container, Date.now());
    const timerId = globalScope.setTimeout(() => {
      if (!container?.isConnected) {
        clearNodePending(container);
        return;
      }

      clearNodePending(container);
      removeOverlay(container);
      clearProcessedState(container);
      scheduleScan();
    }, PENDING_NODE_TIMEOUT_MS);
    pendingNodeTimers.set(container, timerId);
  }

  function clearNodePending(container) {
    pendingNodes.delete(container);
    pendingNodeStartedAt.delete(container);
    const timerId = pendingNodeTimers.get(container);
    if (timerId) {
      globalScope.clearTimeout(timerId);
    }
    pendingNodeTimers.delete(container);
  }

  function isNodePending(container) {
    if (!container || !pendingNodes.has(container)) {
      return false;
    }

    const startedAt = pendingNodeStartedAt.get(container);
    if (!Number.isFinite(startedAt)) {
      return true;
    }

    if ((Date.now() - startedAt) > PENDING_NODE_TIMEOUT_MS) {
      clearNodePending(container);
      return false;
    }

    return true;
  }

  function ensureOverlayNode(container) {
    const host = ensureOverlayHost(container);
    const directChild = host.querySelector(`:scope > .${ROOT_CLASS}`);
    const extras = host.querySelectorAll(`.${ROOT_CLASS}`);
    extras.forEach((node) => {
      if (node !== directChild) {
        node.remove();
      }
    });

    if (directChild) {
      return directChild;
    }

    const overlay = document.createElement("div");
    overlay.className = ROOT_CLASS;
    const pill = document.createElement("div");
    pill.className = "criterion-imdb-overlay__pill";
    pill.textContent = "IMDb …";

    const details = document.createElement("div");
    details.className = "criterion-imdb-overlay__details";
    details.textContent = "Loading…";

    overlay.append(pill, details);

    if (globalScope.getComputedStyle(host).position === "static") {
      host.classList.add("criterion-imdb-overlay-host");
    }

    host.appendChild(overlay);
    return overlay;
  }

  function ensureStatusNode() {
    let statusNode = document.querySelector(`.${STATUS_CLASS}`);
    if (statusNode) {
      return statusNode;
    }

    statusNode = document.createElement("div");
    statusNode.className = STATUS_CLASS;
    statusNode.textContent = "Criterion IMDb: starting…";
    (document.body || document.documentElement).appendChild(statusNode);
    return statusNode;
  }

  function removeOverlay(container) {
    const host = getExistingOverlayHost(container);
    if (!host) {
      container.classList?.remove("criterion-imdb-overlay-dimmed");
      return;
    }

    host.querySelectorAll(`:scope > .${ROOT_CLASS}`).forEach((node) => node.remove());
    cleanupEmptyOverlayHost(host);
    container.classList?.remove("criterion-imdb-overlay-dimmed");
  }

  function syncDebugMode(settings) {
    debugMode = Boolean(settings?.debugMode);
    const statusNode = document.querySelector(`.${STATUS_CLASS}`);
    if (!debugMode && statusNode) {
      statusNode.remove();
    }
  }

  function setStatus(text, tone) {
    if (!debugMode) {
      return;
    }
    const statusNode = ensureStatusNode();
    statusNode.textContent = text;
    statusNode.dataset.tone = tone || "neutral";
    console.log("[criterion-imdb]", text);
  }

  function isSeriesResult(result) {
    return result?.itemType === "series";
  }

  function formatMissingReason(result) {
    const reason = String(result?.reason || "").trim();

    if (!reason) {
      return "No confident match";
    }

    if (reason.startsWith("IMDb rating missing for ")) {
      return "No IMDb rating available yet";
    }

    if (reason === "No cached IMDb score found") {
      return "No IMDb score found";
    }

    if (reason === "No confident IMDb match found") {
      return "No confident IMDb match";
    }

    if (reason === "OMDb API key required") {
      return "Set an OMDb API key in extension settings";
    }

    if (reason === "Film title missing") {
      return "Title metadata missing";
    }

    if (reason === "OMDb fallback unavailable" || reason === "OMDb lookup failed") {
      return "Score lookup unavailable right now";
    }

    if (/NetworkError|Failed to fetch|timed out|ECONNRESET/i.test(reason)) {
      return "Score lookup unavailable right now";
    }

    return reason;
  }

  function renderResult(container, result, settings) {
    if (result.ignored) {
      removeOverlay(container);
      return;
    }

    if (isSeriesResult(result) && !result.matched) {
      removeOverlay(container);
      return;
    }

    const overlay = ensureOverlayNode(container);
    const pill = overlay.querySelector(".criterion-imdb-overlay__pill");
    const details = overlay.querySelector(".criterion-imdb-overlay__details");

    overlay.classList.remove(
      "is-loading",
      "is-missing",
      "is-low-confidence",
      "is-low-rated",
      "is-error",
      "is-success"
    );

    if (!result.matched) {
      overlay.classList.add("is-missing");
      pill.textContent = "IMDb n/a";
      details.textContent = formatMissingReason(result);
      container.classList.remove("criterion-imdb-overlay-dimmed");
      return;
    }

    overlay.classList.add("is-success");
    if (result.lowConfidence) {
      overlay.classList.add("is-low-confidence");
    }
    if (result.imdbRating < settings.minRating) {
      overlay.classList.add("is-low-rated");
      if (settings.dimLowRated) {
        container.classList.add("criterion-imdb-overlay-dimmed");
      } else {
        container.classList.remove("criterion-imdb-overlay-dimmed");
      }
    } else {
      container.classList.remove("criterion-imdb-overlay-dimmed");
    }

    pill.textContent = result.lowConfidence
      ? `? IMDb ${result.imdbRating.toFixed(1)}`
      : `IMDb ${result.imdbRating.toFixed(1)}`;
    details.textContent = formatDetails(result, settings) || `Matched ${result.matchedTitle || result.title}`;
  }

  function markLoading(container) {
    const overlay = ensureOverlayNode(container);
    overlay.classList.add("is-loading");
  }

  function markPendingOmdb(container) {
    const overlay = ensureOverlayNode(container);
    const pill = overlay.querySelector(".criterion-imdb-overlay__pill");
    const details = overlay.querySelector(".criterion-imdb-overlay__details");
    overlay.classList.remove("is-missing", "is-low-rated", "is-error", "is-success");
    overlay.classList.add("is-loading");
    pill.textContent = "IMDb …";
    details.textContent = "Checking OMDb…";
  }

  function isLikelyVisible(node) {
    if (!node?.isConnected || typeof node.getBoundingClientRect !== "function") {
      return false;
    }

    const rect = node.getBoundingClientRect();
    const viewportHeight = globalScope.innerHeight || document.documentElement.clientHeight || 0;

    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    return rect.bottom >= -VISIBLE_LOOKUP_PADDING_PX && rect.top <= viewportHeight + VISIBLE_LOOKUP_PADDING_PX;
  }

  function sortCandidatesByViewport(candidates) {
    return candidates.slice().sort((left, right) => {
      const leftRect = left.node.getBoundingClientRect();
      const rightRect = right.node.getBoundingClientRect();

      if (leftRect.top !== rightRect.top) {
        return leftRect.top - rightRect.top;
      }

      return leftRect.left - rightRect.left;
    });
  }

  function splitVisibleCandidates(candidates) {
    const sorted = sortCandidatesByViewport(candidates);
    const immediate = [];
    const deferred = [];

    for (const candidate of sorted) {
      if (isLikelyVisible(candidate.node)) {
        immediate.push(candidate);
      } else {
        deferred.push(candidate);
      }
    }

    return {
      immediate,
      deferred
    };
  }

  function mergeDeferredBatchItems(existing, batch) {
    const merged = new Map(existing);
    for (const item of batch) {
      if (!item?.node) {
        continue;
      }
      merged.set(item.node, item);
    }
    return merged;
  }

  function scheduleDeferredBatch(batch) {
    if (batch.length === 0) {
      return;
    }

    deferredBatchItems = mergeDeferredBatchItems(deferredBatchItems, batch);
    if (deferredBatchTimer) {
      return;
    }

    deferredBatchTimer = globalScope.setTimeout(() => {
      deferredBatchTimer = null;
      const queuedBatch = Array.from(deferredBatchItems.values()).filter((item) => item?.node?.isConnected);
      deferredBatchItems = new Map();
      processCandidateBatch(queuedBatch).catch((error) => {
        console.warn("Criterion IMDb deferred batch failed:", error);
      });
    }, 400);
  }

  async function processCandidateBatch(batch) {
    if (batch.length === 0) {
      return;
    }

    for (const item of batch) {
      markNodePending(item.node);
      if (!isSeriesResult(item.film)) {
        markLoading(item.node);
      }
    }

    const response = await extensionApi.runtime.sendMessage({
      type: "criterion-imdb:lookup-films",
      films: batch.map((item) => item.film),
      options: {
        allowOmdbFallback: false
      }
    });

    latestSettings = response.settings;
    syncDebugMode(latestSettings);
    const pendingOmdb = [];
    const matchedCount = response.results.filter((result) => result && result.matched).length;
    const missingCount = response.results.filter((result) => result && !result.matched).length;
    setStatus(
      `Criterion IMDb: ${matchedCount} matched, ${missingCount} missing`,
      matchedCount > 0 ? "success" : "warn"
    );

    response.results.forEach((result, index) => {
      const candidate = batch[index];
      if (!candidate || !candidate.node.isConnected) {
        return;
      }

      if (result.source === "pending") {
        pendingOmdb.push(candidate);
        if (!isSeriesResult(candidate.film)) {
          markPendingOmdb(candidate.node);
        }
        return;
      }

      clearNodePending(candidate.node);
      candidate.node.dataset[PROCESSED_DATASET_KEY] = "true";
      renderResult(candidate.node, result, response.settings);
    });

    enrichWithOmdb(pendingOmdb).catch((error) => {
      console.warn("Criterion IMDb OMDb enrichment failed:", error);
      pendingOmdb.forEach((candidate) => {
        if (!candidate?.node?.isConnected) {
          return;
        }

        clearNodePending(candidate.node);
        candidate.node.dataset[PROCESSED_DATASET_KEY] = "true";
        renderResult(candidate.node, {
          ...candidate.film,
          matched: false,
          reason: error.message || "OMDb lookup failed"
        }, response.settings);
      });
    });
  }

  async function enrichWithOmdb(pendingItems) {
    if (pendingItems.length === 0) {
      return;
    }

    const response = await extensionApi.runtime.sendMessage({
      type: "criterion-imdb:lookup-films",
      films: pendingItems.map((item) => item.film),
      options: {
        allowOmdbFallback: true
      }
    });

    latestSettings = response.settings;
    syncDebugMode(latestSettings);

    response.results.forEach((result, index) => {
      const candidate = pendingItems[index];
      if (!candidate || !candidate.node.isConnected) {
        return;
      }

      clearNodePending(candidate.node);
      candidate.node.dataset[PROCESSED_DATASET_KEY] = "true";
      renderResult(candidate.node, result, response.settings);
    });
  }

  async function scanAndOverlay() {
    const candidates = domScraper.collectFilms();
    const validNodes = new WeakSet(candidates.map(({ node }) => node));
    document.querySelectorAll(`.${ROOT_CLASS}`).forEach((overlay) => {
      const host = overlay.parentElement;
      const ownerNode = host?.classList?.contains(ANCHOR_HOST_CLASS)
        ? host.previousElementSibling
        : host;
      if (ownerNode && !validNodes.has(ownerNode)) {
        const wasProcessed = ownerNode.dataset?.[PROCESSED_DATASET_KEY] === "true";
        const isPending = isNodePending(ownerNode);
        const keepDuringTransientMiss = ownerNode.isConnected && (wasProcessed || isPending);

        if (keepDuringTransientMiss) {
          return;
        }

        overlay.remove();
        ownerNode.classList?.remove("criterion-imdb-overlay-dimmed");
        clearNodePending(ownerNode);
        clearProcessedState(ownerNode);
        cleanupEmptyOverlayHost(host);
      }
    });
    setStatus(`Criterion IMDb: found ${candidates.length} candidate links`, candidates.length > 0 ? "neutral" : "warn");
    const fresh = candidates.filter(({ node }) => {
      const alreadyProcessed = node.dataset[PROCESSED_DATASET_KEY] === "true";
      const alreadyRendered = hasRenderedOverlay(node);
      if (!node.isConnected || isNodePending(node)) {
        return false;
      }
      if (alreadyProcessed && alreadyRendered) {
        return false;
      }
      return true;
    });

    if (fresh.length === 0) {
      if (candidates.length === 0) {
        setStatus("Criterion IMDb: no film links detected on this page", "warn");
      }
      return;
    }

    const { immediate, deferred } = splitVisibleCandidates(fresh);
    await processCandidateBatch(immediate.length > 0 ? immediate : fresh.slice(0, Math.min(12, fresh.length)));
    scheduleDeferredBatch(immediate.length > 0 ? deferred : fresh.slice(Math.min(12, fresh.length)));
  }

  async function bootstrap() {
    try {
      latestSettings = await extensionApi.runtime.sendMessage({
        type: "criterion-imdb:get-settings"
      });
      syncDebugMode(latestSettings);
      setStatus("Criterion IMDb: content script loaded", "neutral");
      setStatus("Criterion IMDb: ready", "neutral");
      scheduleScan();

      const observer = new MutationObserver(() => {
        scheduleScan();
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (error) {
      syncDebugMode(latestSettings);
      setStatus(`Criterion IMDb: startup failed - ${error.message || "unknown error"}`, "error");
      console.error("[criterion-imdb] startup failed", error);
    }
  }

  globalScope.__criterionImdbDebug = function debugScrape() {
    const films = domScraper.collectFilms();
    const summary = films.map(({ film, node }) => ({
      title: film.title,
      year: film.year,
      director: film.director,
      url: film.url,
      processed: node.dataset?.[PROCESSED_DATASET_KEY] === "true",
      hasOverlay: Boolean(node.querySelector?.(`.${ROOT_CLASS}`)),
      containerClass: typeof node.className === "string" ? node.className.slice(0, 80) : ""
    }));
    console.table(summary);
    return summary;
  };

  globalScope.__criterionImdbOverlayTest = {
    clearProcessedState,
    clearNodePending,
    formatDetails,
    hasRenderedOverlay,
    isNodePending,
    markNodePending,
    mergeDeferredBatchItems,
    removeOverlay,
    needsSiblingHost,
    getExistingOverlayHost
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(window);
