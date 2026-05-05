(function initCriterionOverlay(globalScope) {
  const extensionApi = globalThis.browser || globalThis.chrome;
  const domScraper = globalScope.CriterionOverlayDom;
  const ROOT_CLASS = "criterion-imdb-overlay";
  const ANCHOR_HOST_CLASS = "criterion-imdb-overlay-anchor-host";
  const STATUS_CLASS = "criterion-imdb-status";
  const PROCESSED_DATASET_KEY = "criterionImdbProcessedV6";
  const pendingNodes = new WeakSet();
  let scanScheduled = false;
  let latestSettings = null;

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

  function ensureOverlayHost(container) {
    const needsSiblingHost =
      container instanceof HTMLAnchorElement ||
      container.classList?.contains("browse-item-title") ||
      container.classList?.contains("browse-item-description");

    if (needsSiblingHost) {
      let host = container.nextElementSibling;
      if (host && host.classList.contains(ANCHOR_HOST_CLASS)) {
        return host;
      }

      host = document.createElement("div");
      host.className = ANCHOR_HOST_CLASS;
      container.insertAdjacentElement("afterend", host);
      return host;
    }

    return container;
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
    overlay.innerHTML = [
      '<div class="criterion-imdb-overlay__pill">IMDb …</div>',
      '<div class="criterion-imdb-overlay__details">Loading…</div>'
    ].join("");

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

  function setStatus(text, tone) {
    const statusNode = ensureStatusNode();
    statusNode.textContent = text;
    statusNode.dataset.tone = tone || "neutral";
    console.log("[criterion-imdb]", text);
  }

  function renderResult(container, result, settings) {
    if (result.ignored) {
      const existing = container.querySelector(`:scope > .${ROOT_CLASS}`);
      if (existing) {
        existing.remove();
      }
      container.classList.remove("criterion-imdb-overlay-dimmed");
      return;
    }

    const overlay = ensureOverlayNode(container);
    const pill = overlay.querySelector(".criterion-imdb-overlay__pill");
    const details = overlay.querySelector(".criterion-imdb-overlay__details");

    overlay.classList.remove(
      "is-loading",
      "is-missing",
      "is-low-rated",
      "is-error",
      "is-success"
    );

    if (!result.matched) {
      overlay.classList.add("is-missing");
      pill.textContent = "IMDb n/a";
      details.textContent = result.reason || "No confident match";
      container.classList.remove("criterion-imdb-overlay-dimmed");
      return;
    }

    overlay.classList.add("is-success");
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

    pill.textContent = `IMDb ${result.imdbRating.toFixed(1)}`;
    details.textContent = formatDetails(result, settings) || `Matched ${result.matchedTitle || result.title}`;
  }

  function markLoading(container) {
    const overlay = ensureOverlayNode(container);
    overlay.classList.add("is-loading");
  }

  async function scanAndOverlay() {
    const candidates = domScraper.collectFilms();
    setStatus(`Criterion IMDb: found ${candidates.length} candidate links`, candidates.length > 0 ? "neutral" : "warn");
    const fresh = candidates.filter(({ node }) => {
      if (!node.isConnected || node.dataset[PROCESSED_DATASET_KEY] === "true" || pendingNodes.has(node)) {
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

    for (const item of fresh) {
      pendingNodes.add(item.node);
      markLoading(item.node);
    }

    const response = await extensionApi.runtime.sendMessage({
      type: "criterion-imdb:lookup-films",
      films: fresh.map((item) => item.film)
    });

    latestSettings = response.settings;
    const matchedCount = response.results.filter((result) => result && result.matched).length;
    const missingCount = response.results.length - matchedCount;
    setStatus(
      `Criterion IMDb: ${matchedCount} matched, ${missingCount} missing`,
      matchedCount > 0 ? "success" : "warn"
    );

    response.results.forEach((result, index) => {
      const candidate = fresh[index];
      if (!candidate || !candidate.node.isConnected) {
        return;
      }

      candidate.node.dataset[PROCESSED_DATASET_KEY] = "true";
      renderResult(candidate.node, result, response.settings);
    });
  }

  async function bootstrap() {
    setStatus("Criterion IMDb: content script loaded", "neutral");

    try {
      latestSettings = await extensionApi.runtime.sendMessage({
        type: "criterion-imdb:get-settings"
      });
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(window);
