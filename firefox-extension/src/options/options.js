const extensionApi = globalThis.browser || globalThis.chrome;
const SETTINGS_STORAGE_KEY = "criterionImdbSettings";
const DEFAULT_SETTINGS = {
  minRating: 7.5,
  maxCacheAgeDays: 30,
  showRuntime: true,
  showGenres: true,
  showLanguages: true,
  showDirector: true,
  showCountry: true,
  dimLowRated: false
};

const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");

function setFormValues(settings) {
  document.getElementById("minRating").value = settings.minRating;
  document.getElementById("maxCacheAgeDays").value = settings.maxCacheAgeDays;
  document.getElementById("showRuntime").checked = settings.showRuntime;
  document.getElementById("showGenres").checked = settings.showGenres;
  document.getElementById("showLanguages").checked = settings.showLanguages;
  document.getElementById("showDirector").checked = settings.showDirector;
  document.getElementById("showCountry").checked = settings.showCountry;
  document.getElementById("dimLowRated").checked = settings.dimLowRated;
}

async function loadSettings() {
  const stored = await extensionApi.storage.local.get(SETTINGS_STORAGE_KEY);
  setFormValues({
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_STORAGE_KEY] || {})
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = {
    minRating: Number.parseFloat(document.getElementById("minRating").value) || DEFAULT_SETTINGS.minRating,
    maxCacheAgeDays: Number.parseInt(document.getElementById("maxCacheAgeDays").value, 10) || DEFAULT_SETTINGS.maxCacheAgeDays,
    showRuntime: document.getElementById("showRuntime").checked,
    showGenres: document.getElementById("showGenres").checked,
    showLanguages: document.getElementById("showLanguages").checked,
    showDirector: document.getElementById("showDirector").checked,
    showCountry: document.getElementById("showCountry").checked,
    dimLowRated: document.getElementById("dimLowRated").checked
  };

  await extensionApi.storage.local.set({
    [SETTINGS_STORAGE_KEY]: settings
  });

  statusNode.textContent = "Saved.";
  globalThis.setTimeout(() => {
    if (statusNode.textContent === "Saved.") {
      statusNode.textContent = "";
    }
  }, 1500);
});

loadSettings().catch((error) => {
  statusNode.textContent = error.message || "Could not load settings.";
});
