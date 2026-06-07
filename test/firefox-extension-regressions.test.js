const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function runScript(relativePath, context) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  vm.runInNewContext(source, context, { filename: relativePath });
}

function createBackgroundContext() {
  const context = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    fetch: async () => {
      throw new Error("fetch should not run in this test");
    },
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        getURL(value) {
          return value;
        },
        onMessage: {
          addListener() {}
        }
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
          async remove() {}
        }
      }
    }
  };

  context.globalThis = context;
  context.self = context;
  runScript("firefox-extension/src/shared/matcher.js", context);
  runScript("firefox-extension/src/background.js", context);
  return context;
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    for (const name of names) {
      this.values.add(name);
    }
  }

  remove(...names) {
    for (const name of names) {
      this.values.delete(name);
    }
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName = "div", classNames = [], attributes = {}) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.classList = new FakeClassList(classNames);
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.isConnected = true;
    this.textContent = "";
    this.innerText = "";
    this.attributes = { ...attributes };
    this.href = attributes.href || "";
    this.title = attributes.title || "";
    this._querySelectorMap = new Map();
    this._querySelectorAllMap = new Map();
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  insertAdjacentElement(position, element) {
    assert.equal(position, "afterend");
    assert.ok(this.parentElement, "expected parentElement for insertAdjacentElement");
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    element.parentElement = this.parentElement;
    element.isConnected = true;
    siblings.splice(index + 1, 0, element);
    return element;
  }

  querySelectorAll(selector) {
    if (this._querySelectorAllMap.has(selector)) {
      return this._querySelectorAllMap.get(selector);
    }

    if (selector === ":scope > .criterion-imdb-overlay") {
      return this.children.filter((child) => child.classList.contains("criterion-imdb-overlay"));
    }

    return [];
  }

  querySelector(selector) {
    if (this._querySelectorMap.has(selector)) {
      return this._querySelectorMap.get(selector);
    }

    return null;
  }

  setQuerySelector(selector, value) {
    this._querySelectorMap.set(selector, value);
  }

  setQuerySelectorAll(selector, value) {
    this._querySelectorAllMap.set(selector, value);
  }

  getAttribute(name) {
    if (name === "class") {
      return Array.from(this.classList.values).join(" ");
    }

    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "href") {
      this.href = value;
    }
    if (name === "title") {
      this.title = value;
    }
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelectorList(current, selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) {
        siblings.splice(index, 1);
      }
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  get nextElementSibling() {
    if (!this.parentElement) {
      return null;
    }

    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return siblings[index + 1] || null;
  }

  get childElementCount() {
    return this.children.length;
  }
}

class FakeAnchorElement extends FakeElement {
  constructor(attributes = {}) {
    super("a", [], attributes);
  }
}

function matchesSelectorList(node, selectorList) {
  return String(selectorList || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((selector) => matchesSimpleSelector(node, selector));
}

function matchesSimpleSelector(node, selector) {
  if (!selector) {
    return false;
  }

  if (selector.startsWith(".")) {
    return node.classList.contains(selector.slice(1));
  }

  if (selector.startsWith("[") && selector.endsWith("]")) {
    const attrSelector = selector.slice(1, -1);
    if (attrSelector === "data-collection-slug" || attrSelector === "data-product-id" || attrSelector === "data-tooltip" || attrSelector === "data-item-type") {
      return node.getAttribute(attrSelector) !== null;
    }
    if (attrSelector === "class*='item-type-'" || attrSelector === 'class*="item-type-"') {
      return Array.from(node.classList.values).some((className) => className.includes("item-type-"));
    }
    return false;
  }

  const tagAndClassMatch = selector.match(/^([a-z0-9]+)\.([a-z0-9_-]+)$/i);
  if (tagAndClassMatch) {
    return node.tagName === tagAndClassMatch[1].toUpperCase() && node.classList.contains(tagAndClassMatch[2]);
  }

  return node.tagName === selector.toUpperCase();
}

function createOverlayContext() {
  const fakeTimers = [];
  const document = {
    readyState: "loading",
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {}
  };

  const context = {
    console,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      fakeTimers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = fakeTimers.indexOf(timer);
      if (index >= 0) {
        fakeTimers.splice(index, 1);
      }
    },
    MutationObserver: class {
      observe() {}
    },
    HTMLAnchorElement: FakeAnchorElement,
    document,
    browser: {
      runtime: {
        async sendMessage() {
          throw new Error("sendMessage should not run in this test");
        }
      }
    },
    getComputedStyle() {
      return { position: "static" };
    }
  };

  context.window = context;
  context.globalThis = context;
  runScript("firefox-extension/src/content/criterion-overlay.js", context);
  context.__fakeTimers = fakeTimers;
  return context;
}

function createDomScraperContext() {
  const document = {
    getElementById() {
      return null;
    }
  };

  const context = {
    console,
    document,
    HTMLAnchorElement: FakeAnchorElement
  };

  context.window = context;
  context.globalThis = context;
  runScript("firefox-extension/src/content/dom-scraper.js", context);
  return context;
}

test("background does not reuse stale OMDb fallback records forever", () => {
  const context = createBackgroundContext();
  const { shouldReuseApiRecord } = context.__criterionImdbBackgroundTest;

  const staleRecord = {
    matched: true,
    source: "omdb",
    matcherVersion: 2,
    checkedAt: new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)).toISOString()
  };
  const freshRecord = {
    matched: true,
    source: "omdb",
    matcherVersion: 2,
    checkedAt: new Date().toISOString()
  };

  assert.equal(shouldReuseApiRecord(staleRecord, 30), false);
  assert.equal(shouldReuseApiRecord(freshRecord, 30), true);
  assert.equal(shouldReuseApiRecord({ ...freshRecord, matcherVersion: 1 }, 30), false);
});

test("background preserves low-confidence match metadata for UI rendering", () => {
  const context = createBackgroundContext();
  const { normalizeMatchResult } = context.__criterionImdbBackgroundTest;

  const normalized = normalizeMatchResult(
    { title: "Pauline at the Beach", year: 1983 },
    {
      matched: true,
      imdbRating: 7.2,
      matchedTitle: "Pauline at the Beach",
      lowConfidence: true,
      confidenceNote: "Best guess from public metadata"
    },
    "omdb"
  );

  assert.equal(normalized.matched, true);
  assert.equal(normalized.lowConfidence, true);
  assert.match(normalized.confidenceNote, /Best guess/);
  assert.equal(normalized.source, "omdb");
});

test("matcher returns a low-confidence best guess when public metadata resolves but confidence is weak", async () => {
  const context = createBackgroundContext();
  const matcher = context.CriterionImdbMatcher;

  const result = await matcher.lookupFilm(async (url) => {
    if (String(url).includes("omdbapi.com/?t=")) {
      throw new Error("title lookup miss");
    }

    if (String(url).includes("v2.sg.media-imdb.com/suggestion/")) {
      return {
        ok: true,
        async json() {
          return {
            d: [
              {
                id: "tt1234567",
                l: "Pauline Story",
                qid: "movie",
                y: 1983
              }
            ]
          };
        }
      };
    }

    if (String(url).includes("omdbapi.com/?i=tt1234567")) {
      return {
        ok: true,
        async json() {
          return {
            Response: "True",
            imdbID: "tt1234567",
            Title: "Pauline at the Beach",
            Year: "1983",
            Director: "Eric Rohmer",
            Genre: "Comedy, Drama, Romance",
            Language: "French",
            Runtime: "94 min",
            imdbRating: "7.2"
          };
        }
      };
    }

    throw new Error(`unexpected url ${url}`);
  }, {
    title: "Pauline at the Beach",
    year: 1983,
    director: "Wrong Director"
  }, "demo-key");

  assert.equal(result.matched, true);
  assert.equal(result.lowConfidence, true);
  assert.equal(result.imdbRating, 7.2);
  assert.match(result.confidenceNote, /Best guess/);
});

test("matcher keeps an exact direct OMDb title hit as low confidence when metadata is off", async () => {
  const context = createBackgroundContext();
  const matcher = context.CriterionImdbMatcher;

  const result = await matcher.lookupFilm(async (url) => {
    if (String(url).includes("omdbapi.com/?t=")) {
      return {
        ok: true,
        async json() {
          return {
            Response: "True",
            imdbID: "tt0089960",
            Title: "Vagabond",
            Year: "1985",
            Director: "Agnès Varda",
            Genre: "Drama",
            Language: "French",
            Runtime: "105 min",
            imdbRating: "7.6"
          };
        }
      };
    }

    throw new Error(`unexpected url ${url}`);
  }, {
    title: "Vagabond",
    year: 1995,
    director: ""
  }, "demo-key");

  assert.equal(result.matched, true);
  assert.equal(result.imdbId, "tt0089960");
  assert.equal(result.imdbRating, 7.6);
  assert.equal(result.lowConfidence, true);
  assert.match(result.confidenceNote, /Best guess/);
});

test("background sanitizes remote cache payloads and strips malformed entries", () => {
  const context = createBackgroundContext();
  const { sanitizeCachePayload } = context.__criterionImdbBackgroundTest;

  const payload = sanitizeCachePayload({
    generatedAt: "2026-06-05T00:00:00.000Z",
    entries: [
      {
        path: "/films/the-third-man",
        title: "The Third Man",
        normalizedTitle: "the third man",
        year: 1949,
        director: "Carol Reed",
        country: "United Kingdom",
        imdbRating: 8.1,
        lowConfidence: true,
        confidenceNote: "Best guess from public metadata",
        genres: ["Film-Noir", "Mystery"],
        languages: ["English"],
        runtimeMinutes: 104
      },
      {
        path: "",
        title: "Bad Entry",
        normalizedTitle: "",
        year: 1949,
        imdbId: "",
        imdbRating: 100
      }
    ]
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].title, "The Third Man");
  assert.equal(payload.entries[0].imdbId, "");
  assert.equal(payload.entries[0].lowConfidence, true);
  assert.match(payload.entries[0].confidenceNote, /Best guess/);
});

test("background accepts real bundled cache entries that do not include imdbId", () => {
  const context = createBackgroundContext();
  const { sanitizeCachePayload } = context.__criterionImdbBackgroundTest;
  const bundledPayload = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "firefox-extension/data/criterion-cache.json"), "utf8")
  );
  const realEntryWithoutImdbId = bundledPayload.entries.find((entry) => !entry.imdbId);

  assert.ok(realEntryWithoutImdbId, "expected a real cache entry without imdbId");

  const payload = sanitizeCachePayload({
    generatedAt: bundledPayload.generatedAt,
    entries: [realEntryWithoutImdbId]
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.entries[0].path, realEntryWithoutImdbId.path);
  assert.equal(payload.entries[0].title, realEntryWithoutImdbId.title);
  assert.equal(payload.entries[0].imdbId, "");
});

test("background rejects oversized remote cache payloads", () => {
  const context = createBackgroundContext();
  const { sanitizeCachePayload } = context.__criterionImdbBackgroundTest;

  assert.throws(() => {
    sanitizeCachePayload({
      entries: Array.from({ length: 10001 }, (_, index) => ({
        path: `/films/title-${index}`,
        title: `Title ${index}`,
        normalizedTitle: `title ${index}`,
        year: 2000,
        imdbId: `tt${String(index).padStart(7, "0")}`,
        imdbRating: 7.1
      }))
    });
  }, /exceeds 10000 entries/);
});

test("overlay cleanup does not create a sibling host just to remove a badge", () => {
  const context = createOverlayContext();
  const { removeOverlay } = context.__criterionImdbOverlayTest;

  const parent = new FakeElement("div");
  const anchor = new FakeAnchorElement();
  parent.appendChild(anchor);

  removeOverlay(anchor);

  assert.equal(parent.children.length, 1);
  assert.equal(anchor.nextElementSibling, null);
});

test("overlay cleanup removes an empty existing anchor host", () => {
  const context = createOverlayContext();
  const { removeOverlay } = context.__criterionImdbOverlayTest;

  const parent = new FakeElement("div");
  const anchor = new FakeAnchorElement();
  const host = new FakeElement("div", ["criterion-imdb-overlay-anchor-host"]);
  const overlay = new FakeElement("div", ["criterion-imdb-overlay"]);
  host.appendChild(overlay);
  parent.appendChild(anchor);
  parent.appendChild(host);

  removeOverlay(anchor);

  assert.deepEqual(parent.children, [anchor]);
});

test("processed nodes without a remaining overlay are eligible to render again", () => {
  const context = createOverlayContext();
  const { clearProcessedState, hasRenderedOverlay } = context.__criterionImdbOverlayTest;

  const parent = new FakeElement("div");
  const anchor = new FakeAnchorElement();
  parent.appendChild(anchor);
  anchor.dataset.criterionImdbProcessedV6 = "true";

  assert.equal(hasRenderedOverlay(anchor), false);
  clearProcessedState(anchor);
  assert.equal(anchor.dataset.criterionImdbProcessedV6, undefined);
});

test("pending nodes expire and stop blocking rerender attempts", () => {
  const context = createOverlayContext();
  const { isNodePending, markNodePending } = context.__criterionImdbOverlayTest;

  const originalDate = context.Date;
  let fakeNow = 1_000;
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };

  const node = new FakeElement("div");
  markNodePending(node);
  assert.equal(isNodePending(node), true);

  fakeNow += 31_000;
  assert.equal(isNodePending(node), false);
  context.Date = originalDate;
});

test("low-confidence overlay details show matched year only when it differs", () => {
  const context = createOverlayContext();
  const { formatDetails } = context.__criterionImdbOverlayTest;

  const withDifferentYear = formatDetails({
    lowConfidence: true,
    confidenceNote: "Best guess from public metadata",
    year: 1983,
    matchedYear: 1985,
    director: "",
    country: "",
    runtimeMinutes: null,
    languages: [],
    genres: []
  }, {
    showDirector: true,
    showCountry: true,
    showRuntime: true,
    showLanguages: true,
    showGenres: true
  });

  const withSameYear = formatDetails({
    lowConfidence: true,
    confidenceNote: "Best guess from public metadata",
    year: 1985,
    matchedYear: 1985,
    director: "",
    country: "",
    runtimeMinutes: null,
    languages: [],
    genres: []
  }, {
    showDirector: true,
    showCountry: true,
    showRuntime: true,
    showLanguages: true,
    showGenres: true
  });

  assert.match(withDifferentYear, /Best guess from public metadata \(1985\)/);
  assert.equal(withSameYear, "Best guess from public metadata");
});

test("deferred candidate merges preserve previously queued below-the-fold work", () => {
  const context = createOverlayContext();
  const { mergeDeferredBatchItems } = context.__criterionImdbOverlayTest;

  const firstNode = { id: "first" };
  const secondNode = { id: "second" };
  const firstBatch = [{ node: firstNode, film: { title: "First" } }];
  const secondBatch = [{ node: secondNode, film: { title: "Second" } }];

  const merged = mergeDeferredBatchItems(new Map(), firstBatch);
  const mergedAgain = mergeDeferredBatchItems(merged, secondBatch);

  assert.equal(mergedAgain.size, 2);
  assert.equal(mergedAgain.get(firstNode).film.title, "First");
  assert.equal(mergedAgain.get(secondNode).film.title, "Second");
});

test("scraper blocks film-looking links under blocked row headers", () => {
  const context = createDomScraperContext();
  const { isLikelyFilmLink } = context.__criterionOverlayDomTest;

  const row = new FakeElement("section");
  const header = new FakeElement("h1", ["horizontal-row-header"]);
  header.textContent = "Talking About Movies";
  row.setQuerySelector(":scope > h1.horizontal-row-header", header);
  row.setQuerySelector(".horizontal-row-header", header);

  const anchor = new FakeAnchorElement({
    href: "https://www.criterionchannel.com/the-third-man",
    "aria-label": "The Third Man"
  });
  anchor.textContent = "The Third Man";
  row.appendChild(anchor);

  assert.equal(isLikelyFilmLink(anchor), false);
});

test("scraper keeps real series cards instead of filtering them as collections", () => {
  const context = createDomScraperContext();
  const { extractFilm } = context.__criterionOverlayDomTest;

  const row = new FakeElement("section");
  const header = new FakeElement("h1", ["horizontal-row-header"]);
  header.textContent = "Fresh from Theaters";
  row.setQuerySelector(":scope > h1.horizontal-row-header", header);
  row.setQuerySelector(".horizontal-row-header", header);

  const card = new FakeElement("div", ["browse-item-card"], { "data-item-type": "series" });
  card.innerText = "Conbody vs Everybody Series 2024";
  row.appendChild(card);

  const anchor = new FakeAnchorElement({
    href: "https://www.criterionchannel.com/conbody-vs-everybody",
    "aria-label": "Conbody vs Everybody"
  });
  anchor.textContent = "Conbody vs Everybody";
  card.appendChild(anchor);

  const extracted = extractFilm(anchor);
  assert.ok(extracted);
  assert.equal(extracted.film.itemType, "series");
  assert.equal(extracted.film.title, "Conbody vs Everybody");
  assert.equal(extracted.film.year, 2024);
});
