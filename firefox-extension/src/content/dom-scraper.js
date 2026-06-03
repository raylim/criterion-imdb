(function initDomScraper(globalScope) {
  const YEAR_REGEX = /\b(18\d{2}|19\d{2}|20\d{2})\b/;
  const BLOCKED_PATH_PREFIXES = new Set([
    "/search",
    "/browse",
    "/help",
    "/terms",
    "/privacy",
    "/cookies",
    "/login",
    "/sign_in",
    "/sign-in",
    "/signup",
    "/subscribe",
    "/gift",
    "/watchlist",
    "/continue-watching",
    "/my-list",
    "/watch-live"
  ]);
  const BLOCKED_EXACT_PATHS = new Set([
    "/",
    "/all-films"
  ]);
  const BLOCKED_ROW_HEADERS = new Set([
    "archival treasures",
    "observations on film art",
    "popular collections",
    "new collections",
    "featured collections",
    "recent collections",
    "featured carousel",
    "talking about movies"
  ]);
  const BLOCKED_PROGRAM_TITLE_PATTERNS = [
    "talking about movies",
    "archival treasures"
  ];
  const ALLOWED_TRACK_EVENTS = new Set([
    "site_movie",
    "site_video",
    "site_series"
  ]);

  function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function toTitleCase(text) {
    return normalizeWhitespace(text)
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function titleFromHref(href) {
    try {
      const url = new URL(href);
      const slug = url.pathname
        .split("/")
        .filter(Boolean)
        .filter((segment) => segment !== "videos")
        .pop();

      if (!slug) {
        return "";
      }

      return toTitleCase(
        slug
          .replace(/[-_]+/g, " ")
          .replace(/\b\d+\b/g, " ")
      );
    } catch (_error) {
      return "";
    }
  }

  function sanitizeTitleCandidate(value) {
    const clean = normalizeWhitespace(value);
    if (!clean) {
      return "";
    }

    const stripped = normalizeWhitespace(
      clean
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
        .replace(/\b\d+\s+minutes?\s+left\b/gi, " ")
        .replace(/\b\d+\s+mins?\b/gi, " ")
        .replace(/\bresume\b/gi, " ")
        .replace(/\bwatch(?:ing)?\s+now\b/gi, " ")
        .replace(/\bplay(?:ing)?\b/gi, " ")
        .replace(/\btrailer\b/gi, " ")
    );

    if (!stripped) {
      return "";
    }

    if (/\d{1,2}:\d{2}/.test(clean) || /\bminutes?\s+left\b/i.test(clean)) {
      return "";
    }

    if (stripped.length < 2 || stripped.length > 160) {
      return "";
    }

    return stripped;
  }

  function looksLikeCollectionPath(pathname) {
    const cleanPath = String(pathname || "").replace(/\/+$/, "") || "/";
    const lastSegment = cleanPath.split("/").filter(Boolean).pop() || "";

    if (/(^|\/)videos(\/|$)/i.test(cleanPath)) {
      return false;
    }

    return (
      cleanPath.includes("/season:") ||
      /(^|\/)(collection|collections)(\/|$)/i.test(cleanPath) ||
      /\d{4}-season-\d+$/i.test(lastSegment) ||
      /-(series|collection|program|programs|season-\d+)$/i.test(lastSegment)
    );
  }

  function looksLikeCollectionText(text) {
    const clean = normalizeWhitespace(text).toLowerCase();
    if (!clean) {
      return false;
    }

    return (
      /\bcollection\b/.test(clean) ||
      /\bcollections\b/.test(clean) ||
      /\bseason\s+\d+\b/.test(clean) ||
      /\bepisodes?\b/.test(clean) ||
      /\bseries\b/.test(clean) ||
      /\bcontinue watching\b/.test(clean) ||
      /\bmy list\b/.test(clean) ||
      /\bwatch live\b/.test(clean) ||
      /\bnew collections\b/.test(clean) ||
      /\bpopular collections\b/.test(clean) ||
      /\bfeatured collections\b/.test(clean) ||
      /\bpopular movies\b/.test(clean) ||
      /\bview all\b/.test(clean) ||
      /\bnow playing\b/.test(clean)
    );
  }

  function looksLikeSectionLabel(text) {
    const clean = normalizeWhitespace(text).toLowerCase();
    if (!clean) {
      return false;
    }

    return (
      clean === "now playing" ||
      clean === "search" ||
      clean === "all films" ||
      clean === "criterion.com" ||
      clean === "continue watching" ||
      clean === "my list" ||
      clean === "watch live" ||
      clean === "new collections" ||
      clean === "popular collections" ||
      clean === "fresh from theaters" ||
      clean === "popular movies" ||
      clean === "featured collections" ||
      clean === "view all"
    );
  }

  function isBlockedProgramTitle(text) {
    const clean = normalizeWhitespace(text).toLowerCase();
    return BLOCKED_PROGRAM_TITLE_PATTERNS.some((pattern) => clean.includes(pattern));
  }

  function looksLikeExtraVideo(title, text) {
    const clean = `${normalizeWhitespace(title)} ${normalizeWhitespace(text)}`.toLowerCase();
    if (!clean) {
      return false;
    }

    return (
      /\bcommentary\b/.test(clean) ||
      /\binterview\b/.test(clean) ||
      /\bteaser\b/.test(clean) ||
      /\btrailer\b/.test(clean) ||
      /\bspotlight on\b/.test(clean) ||
      /\bon l['’]/.test(clean) ||
      /\bthe craft of\b/.test(clean)
    );
  }

  function getCollectionItemType(anchor) {
    const item = anchor.closest(".js-collection-item, [data-item-type], .browse-item-card, [class*='item-type-']");
    if (!item) {
      return "";
    }

    const explicit = item.getAttribute("data-item-type");
    if (explicit) {
      return explicit.toLowerCase();
    }

    const typeClass = Array.from(item.classList || []).find((cls) => cls.startsWith("item-type-"));
    return typeClass ? typeClass.slice("item-type-".length).toLowerCase() : "";
  }

  function getTrackEvent(anchor) {
    const own = anchor.getAttribute("data-track-event");
    if (own) {
      return own.toLowerCase();
    }

    const innerLink = anchor.querySelector("[data-track-event]");
    if (innerLink) {
      return (innerLink.getAttribute("data-track-event") || "").toLowerCase();
    }

    return "";
  }

  function getRowHeaderLabel(anchor) {
    const row =
      anchor.closest(".browse-row") ||
      anchor.closest("[data-collection-slug]") ||
      anchor.closest(".product-set") ||
      anchor.closest("section");

    if (!row) {
      return "";
    }

    const header =
      row.querySelector(":scope > h1.horizontal-row-header") ||
      row.querySelector(":scope > header h1") ||
      row.querySelector(":scope > h1") ||
      row.querySelector(":scope > h2") ||
      row.querySelector(".horizontal-row-header") ||
      row.querySelector(".browse-row__title");

    return normalizeWhitespace(header?.textContent).toLowerCase();
  }

  function isLikelyFilmLink(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) {
      return false;
    }

    let url;
    try {
      url = new URL(anchor.href);
    } catch (_error) {
      return false;
    }

    const hostname = url.hostname.replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (!["criterionchannel.com", "films.criterionchannel.com", "criterion.com"].includes(hostname)) {
      return false;
    }

    const rawHref = anchor.getAttribute("href") || "";
    if (rawHref.startsWith("#") || rawHref.startsWith("javascript:")) {
      return false;
    }

    if (BLOCKED_EXACT_PATHS.has(pathname)) {
      return false;
    }

    if (looksLikeCollectionPath(pathname)) {
      return false;
    }

    for (const prefix of BLOCKED_PATH_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        return false;
      }
    }

    if (hostname === "criterion.com" && !pathname.includes("/films/")) {
      return false;
    }

    if (looksLikeSectionLabel(anchor.textContent) || looksLikeSectionLabel(anchor.getAttribute("aria-label"))) {
      return false;
    }

    if (anchor.closest("header, nav, footer")) {
      return false;
    }

    if (anchor.closest("h1, h2, h3, h4, h5, h6")) {
      return false;
    }

    if (anchor.closest(".horizontal-row-header, .browse-row__title, .browse-link, .row-header, .navigation-container")) {
      return false;
    }

    if (anchor.closest(".carousel-slides, .featured-carousel-slide, .slide-layout-featured, .slide-button, .slide-bg-img-wrapper")) {
      return false;
    }

    const itemType = getCollectionItemType(anchor);
    if (itemType && itemType !== "movie" && itemType !== "video" && itemType !== "series") {
      return false;
    }

    const trackEvent = getTrackEvent(anchor);
    if (trackEvent && !ALLOWED_TRACK_EVENTS.has(trackEvent)) {
      return false;
    }

    const rowHeader = getRowHeaderLabel(anchor);
    if (rowHeader && BLOCKED_ROW_HEADERS.has(rowHeader)) {
      return false;
    }

    return true;
  }

  function getAnchorTitle(anchor) {
    const textCandidates = [
      anchor.getAttribute("aria-label"),
      anchor.querySelector("img")?.getAttribute("alt"),
      anchor.title,
      sanitizeTitleCandidate(anchor.textContent),
      titleFromHref(anchor.href)
    ];

    return normalizeWhitespace(textCandidates.find((value) => normalizeWhitespace(value)));
  }

  function countDistinctFilmLinks(container) {
    if (!container || typeof container.querySelectorAll !== "function") {
      return 0;
    }

    const hrefs = new Set();
    for (const link of container.querySelectorAll("a[href]")) {
      if (isLikelyFilmLink(link)) {
        hrefs.add(link.href);
      }
    }
    return hrefs.size;
  }

  function pickContainer(anchor) {
    const cardLevel =
      anchor.closest(".js-collection-item") ||
      anchor.closest(".browse-item-card") ||
      anchor.closest(".browse-item");
    if (cardLevel) {
      return cardLevel;
    }

    const candidates = [
      anchor.closest(".browse-item-title"),
      anchor.closest(".browse-item-description"),
      anchor.closest("tr"),
      anchor.closest("li"),
      anchor.closest("article"),
      anchor.closest("[data-product-id]"),
      anchor.closest(".product"),
      anchor.closest(".product-set"),
      anchor.parentElement
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (
        candidate.classList?.contains("browse-item-title") ||
        candidate.classList?.contains("browse-item-description")
      ) {
        return candidate;
      }

      if (countDistinctFilmLinks(candidate) > 1) {
        continue;
      }

      const text = normalizeWhitespace(candidate.innerText);
      if (text.length >= 12 && text.length <= 600) {
        return candidate;
      }
    }

    return anchor;
  }

  function extractYear(text) {
    const match = String(text || "").match(YEAR_REGEX);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function extractCountry(text, year) {
    if (!text || !year) {
      return "";
    }

    const lineMatch = text.match(new RegExp(`([A-Z][A-Za-z .&'\\-]+(?:,\\s*[A-Z][A-Za-z .&'\\-]+)*)\\s*,?\\s*${year}`));
    if (!lineMatch) {
      return "";
    }

    return normalizeWhitespace(lineMatch[1].replace(/,\s*$/, ""));
  }

  function extractDirector(lines, title) {
    const normalizedTitle = normalizeWhitespace(title);

    for (const line of lines) {
      const clean = normalizeWhitespace(line);
      if (!clean || clean === normalizedTitle) {
        continue;
      }
      if (YEAR_REGEX.test(clean)) {
        continue;
      }
      if (/quick shop/i.test(clean) || /spine/i.test(clean) || /results?/i.test(clean)) {
        continue;
      }
      if (clean.length > 2 && clean.length <= 80) {
        return clean;
      }
    }

    return "";
  }

  function getTooltipText(container) {
    const owner = container.closest("[data-tooltip]") || container.querySelector("[data-tooltip]");
    if (!owner) {
      return "";
    }

    const attr = owner.getAttribute("data-tooltip") || "";
    const idMatch = attr.match(/\bid\s*:\s*([A-Za-z0-9_-]+)/);
    if (!idMatch) {
      return "";
    }

    const tooltip = document.getElementById(idMatch[1]);
    if (!tooltip) {
      return "";
    }

    return normalizeWhitespace(tooltip.textContent);
  }

  function extractDirectorFromTooltip(text) {
    const match = String(text || "").match(/Directed by\s+([^•\n]+?)(?:\s*[•\n]|$)/i);
    return match ? normalizeWhitespace(match[1]) : "";
  }

  function extractCountryFromTooltip(text, year) {
    if (!year) {
      return "";
    }
    const match = String(text || "").match(new RegExp(`${year}\\s*•\\s*([^•\\n]+?)(?:\\s*[•\\n]|\\s+(?:Starring|Cast|With|A film|This|Directed)\\b|$)`));
    if (!match) {
      return "";
    }
    const country = normalizeWhitespace(match[1]);
    return country.length <= 80 ? country : "";
  }

  function extractFilm(anchor) {
    const title = getAnchorTitle(anchor);
    if (!title) {
      return null;
    }

    if (looksLikeSectionLabel(title) || isBlockedProgramTitle(title)) {
      return null;
    }

    const container = pickContainer(anchor);
    const itemType = getCollectionItemType(anchor);
    const isSeriesCard = itemType === "series";
    const containerText = normalizeWhitespace(container.innerText);
    const tooltipText = getTooltipText(container);
    const combinedText = normalizeWhitespace(`${containerText} ${tooltipText}`);
    if (
      isBlockedProgramTitle(title) ||
      isBlockedProgramTitle(containerText) ||
      isBlockedProgramTitle(tooltipText)
    ) {
      return null;
    }
    if (!isSeriesCard && looksLikeCollectionText(containerText)) {
      return null;
    }
    if (looksLikeExtraVideo(title, containerText)) {
      return null;
    }
    const lines = `${container.innerText || ""}\n${tooltipText}`
      .split("\n")
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    const year = extractYear(combinedText);
    const tooltipDirector = extractDirectorFromTooltip(tooltipText);
    const director = tooltipDirector || extractDirector(lines, title);
    const country = extractCountryFromTooltip(tooltipText, year) || extractCountry(combinedText, year);
    return {
      key: anchor.href,
      node: container,
      film: {
        title,
        year,
        director,
        country,
        itemType: isSeriesCard ? "series" : (itemType || "movie"),
        url: anchor.href
      }
    };
  }

  function collectFilms(root = document) {
    const anchors = Array.from(root.querySelectorAll("a[href]")).filter(isLikelyFilmLink);
    const seenNodes = new Set();
    const films = [];

    for (const anchor of anchors) {
      const extracted = extractFilm(anchor);
      if (!extracted) {
        continue;
      }

      if (seenNodes.has(extracted.node)) {
        continue;
      }

      seenNodes.add(extracted.node);
      films.push(extracted);
    }

    return films;
  }

  globalScope.CriterionOverlayDom = {
    collectFilms
  };
  globalScope.__criterionOverlayDomTest = {
    isLikelyFilmLink,
    extractFilm,
    getRowHeaderLabel
  };
})(window);
