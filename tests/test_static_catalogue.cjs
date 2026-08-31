const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticDirectory = path.join(__dirname, "..", "static");
const SETTINGS_KEY = "steamDescriptionComparer:settings";
const SAMPLE_KEY = "steamDescriptionComparer:comparisonSample";
const EXCLUSIONS_KEY = "steamDescriptionComparer:excludedSteamGameIds";
const YOUR_DESCRIPTION_ID = "your-description";
const plain = value => JSON.parse(JSON.stringify(value));

function catalogueFixture() {
  const games = Array.from({length: 8}, (_, index) => {
    const appid = index + 1;
    return {id: "steam_" + appid, appid, name: "Game " + appid, text: "Description " + appid,
      reviews: 50 + index * 25, steamTagIds: index < 6 ? [19] : [21],
      storeUrl: "https://store.steampowered.com/app/" + appid + "/"};
  });
  return {schemaVersion: 1, catalogueId: "fixture-2026-08-31", collectedAt: "2026-08-31T12:00:00Z",
    minimumReviewCount: 50,
    reviewCountScope: "Steam purchases, all languages, positive and negative, excluding off-topic activity",
    genres: [
      {id: 1, name: "Action", steamTagId: 19, gameIds: games.slice(0, 6).map(game => game.id)},
      {id: 21, name: "Adventure", steamTagId: 21, gameIds: games.slice(6).map(game => game.id)},
    ], games};
}

function settingsFixture() {
  return {description: "My candidate description", tag: "1", minimumReviewCount: 50};
}

function sampleFixture() {
  return {catalogueId: catalogueFixture().catalogueId, genreId: "1", minimumReviewCount: 50,
    descriptionIds: ["steam_3", YOUR_DESCRIPTION_ID, "steam_1", "steam_4", "steam_2"]};
}

function browserContext({catalogue = catalogueFixture(), storage = new Map(), fetchResponse, compare = false, settings = false, realComparisonRenderer = false} = {}) {
  const fetchUrls = [];
  const elements = new Map();
  const storageListeners = [];
  const storageReads = [];
  const storageWrites = [];
  const storageDeletes = [];
  const createElement = () => ({
    innerHTML: "", textContent: "", disabled: false, hidden: false, value: "",
    listeners: new Map(),
    get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); },
    addEventListener(event, callback) {
      const callbacks = this.listeners.get(event) || [];
      callbacks.push(callback);
      this.listeners.set(event, callbacks);
    },
    appendChild(child) { if (child.selected) this.value = String(child.value); },
    click() { if (!this.disabled) for (const callback of this.listeners.get("click") || []) callback(); },
    querySelectorAll() { return []; },
  });
  const element = id => {
    if (!elements.has(id)) {
      const created = createElement();
      created.disabled = ["save-btn", "new-sample-btn"].includes(id);
      elements.set(id, created);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    localStorage: {
      getItem: key => { storageReads.push(key); return storage.has(key) ? storage.get(key) : null; },
      setItem: (key, value) => { storageWrites.push(key); storage.set(key, String(value)); },
      removeItem: key => { storageDeletes.push(key); storage.delete(key); },
    },
    fetch: async url => {
      fetchUrls.push(url);
      return fetchResponse ? fetchResponse() : {ok: true, json: async () => catalogue};
    },
    document: {getElementById: element, querySelectorAll: () => [], createElement},
    window: {location: {href: ""}, addEventListener: (event, callback) => { if (event === "storage") storageListeners.push(callback); }},
    Sortable: function () { this.destroy = () => {}; },
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(fs.readFileSync(path.join(staticDirectory, "script.js"), "utf8"), context);
  if (compare) {
    const compareInlineScript = fs.readFileSync(path.join(staticDirectory, "compare.html"), "utf8")
      .match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/, "");
    vm.runInContext(compareInlineScript, context);
    context.fixtureCatalogue = catalogue;
    vm.runInContext("comparisonCatalogue = fixtureCatalogue;", context);
    if (!realComparisonRenderer) {
      vm.runInContext("renderComparisonPage = message => { globalThis.lastRenderMessage = message; };", context);
    }
  }
  if (settings) {
    const settingsInlineScript = fs.readFileSync(path.join(staticDirectory, "settings.html"), "utf8")
      .match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/, "");
    vm.runInContext(settingsInlineScript, context);
  }
  return {context, storage, fetchUrls, elements, storageListeners, storageReads, storageWrites, storageDeletes};
}

function seedComparison(context, sample = sampleFixture()) {
  context.setSettings(settingsFixture());
  context.saveComparisonSample(sample);
  context.fixtureSample = plain(sample);
  vm.runInContext("currentlyDisplayedComparisonSample = fixtureSample;", context);
  return sample;
}

function setDraggedOrder(context, descriptionIds) {
  context.draggedDescriptionIds = descriptionIds;
  vm.runInContext("descriptionSortable = {toArray: () => draggedDescriptionIds, destroy() {}};", context);
}

test("the catalogue is fetched once with a project-relative URL", async () => {
  const {context, fetchUrls} = browserContext();
  const [catalogue] = await Promise.all([context.fetchCatalogue(), context.fetchTags(), context.fetchCatalogue()]);
  assert.equal(context.chooseSteamGames(catalogue, 1, 50).length, 4);
  assert.deepEqual(fetchUrls, ["catalogue.json"]);
});

test("genre selection, higher minimums, zero, and unique descriptions use the saved catalogue", async () => {
  const {context} = browserContext();
  const catalogue = await context.fetchCatalogue();
  const filtered = context.chooseSteamGames(catalogue, 1, 100);
  assert.equal(filtered.length, 4);
  assert.equal(new Set(filtered.map(game => game.id)).size, 4);
  assert.ok(filtered.every(game => game.reviews >= 100 && game.steamTagIds.includes(19)));
  assert.equal(context.getEligibleGames(catalogue, 1, 0).length, 6);
  assert.throws(() => context.getEligibleGames(catalogue, 999, 50), /selected genre/);
  for (const minimum of [-1, 0.5, 1, 25, 49, 49.5, "50", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => context.validateMinimumReviewCount(minimum), /whole number/);
  }
});

test("selected game copies cannot mutate the catalogue used for later samples", () => {
  const {context} = browserContext();
  const catalogue = catalogueFixture();
  const original = plain(catalogue);
  const chosen = context.chooseSteamGames(catalogue, 1, 50);
  chosen[0].text = "Changed outside the catalogue";
  chosen[0].steamTagIds.push(999);
  assert.deepEqual(catalogue, original);
});

test("catalogue validation rejects review drift, missing text, and invalid identities", () => {
  const {context} = browserContext();
  for (const mutate of [
    catalogue => { catalogue.reviewCountScope = "all reviews"; },
    catalogue => { catalogue.games[0].reviews = 49; },
    catalogue => { catalogue.games[0].reviews = true; },
    catalogue => { catalogue.games[0].id = "steam_2"; },
    catalogue => { catalogue.games[0].storeUrl = "https://example.com"; },
    catalogue => { catalogue.games[0].text = ""; },
    catalogue => { catalogue.catalogueId = ""; },
  ]) {
    const catalogue = catalogueFixture();
    mutate(catalogue);
    assert.throws(() => context.validateCatalogue(catalogue), /catalogue is invalid/);
  }
});

test("catalogue validation rejects unknown games, duplicate memberships, and wrong Steam tags", () => {
  const {context} = browserContext();
  for (const gameIds of [["steam_999"], ["steam_1", "steam_1"], ["steam_7"]]) {
    const catalogue = catalogueFixture();
    catalogue.genres[0].gameIds = gameIds;
    assert.throws(() => context.validateCatalogue(catalogue), /catalogue is invalid/);
  }
});

test("exclusions survive reload, affect replacement selection, and restore individually", () => {
  const storage = new Map();
  const first = browserContext({storage}).context;
  const catalogue = catalogueFixture();
  first.excludeSteamGame("steam_1", catalogue);
  first.excludeSteamGame("steam_1", catalogue);
  const second = browserContext({storage}).context;
  assert.deepEqual(plain(second.getExcludedGameIds()), ["steam_1"]);
  const replacement = second.chooseSteamGames(catalogue, 1, 50, ["steam_2", "steam_3", "steam_4"], 1);
  assert.ok(["steam_5", "steam_6"].includes(replacement[0].id));
  first.restoreSteamGame("steam_1");
  assert.equal(second.getExcludedGameIds().length, 0);
});

test("the candidate cannot be excluded and damaged exclusion storage fails explicitly", () => {
  const {context, storage} = browserContext();
  assert.throws(() => context.excludeSteamGame(YOUR_DESCRIPTION_ID, catalogueFixture()), /Only a Steam game/);
  for (const serialized of ['', '["your-description"]', '["steam_1","steam_1"]', 'null', 'not-json']) {
    storage.set(EXCLUSIONS_KEY, serialized);
    assert.throws(() => context.chooseSteamGames(catalogueFixture(), 1, 0), /excluded games list/);
    assert.equal(storage.get(EXCLUSIONS_KEY), serialized);
  }
});

test("underfilled pools never weaken the review minimum or restore excluded games", () => {
  const {context} = browserContext();
  const catalogue = catalogueFixture();
  assert.throws(() => context.chooseSteamGames(catalogue, 1, 150), /Too few eligible/);
  for (const gameId of ["steam_1", "steam_2", "steam_3"]) context.excludeSteamGame(gameId, catalogue);
  assert.throws(() => context.createComparisonSample(catalogue, settingsFixture()), /restore excluded games/);
  assert.deepEqual(plain(context.getExcludedGameIds()), ["steam_1", "steam_2", "steam_3"]);
  for (const sampleSize of [0, 5, 1.5]) {
    assert.throws(() => context.chooseSteamGames(catalogue, 1, 0, [], sampleSize), /one and four/);
  }
});

test("exclusions added during catalogue loading affect the first comparison sample", async () => {
  let releaseResponse;
  const responsePromise = new Promise(resolve => { releaseResponse = resolve; });
  const {context, storage} = browserContext({fetchResponse: () => responsePromise});
  const samplePromise = context.fetchCatalogue().then(catalogue => context.createComparisonSample(catalogue, settingsFixture()));
  storage.set(EXCLUSIONS_KEY, '["steam_1","steam_2"]');
  releaseResponse({ok: true, json: async () => catalogueFixture()});
  const sample = await samplePromise;
  assert.deepEqual(Array.from(sample.descriptionIds).sort(), ["steam_3", "steam_4", "steam_5", "steam_6", YOUR_DESCRIPTION_ID].sort());
});

test("a new comparison sample contains exactly the candidate and four canonical Steam ids", () => {
  const {context} = browserContext();
  const sample = context.createComparisonSample(catalogueFixture(), settingsFixture());
  assert.equal(sample.catalogueId, catalogueFixture().catalogueId);
  assert.equal(sample.genreId, "1");
  assert.equal(sample.minimumReviewCount, 50);
  assert.equal(sample.descriptionIds.length, 5);
  assert.equal(new Set(sample.descriptionIds).size, 5);
  assert.equal(sample.descriptionIds.filter(id => id === YOUR_DESCRIPTION_ID).length, 1);
  assert.equal(sample.descriptionIds.filter(id => /^steam_[1-9][0-9]*$/.test(id)).length, 4);
  assert.equal(context.comparisonSampleMatchesSettings(sample, settingsFixture(), catalogueFixture()), true);
});

test("sample storage requires all five unique ids and an explicit sample definition", () => {
  const {context, storage} = browserContext();
  context.saveComparisonSample(sampleFixture());
  const previousSample = storage.get(SAMPLE_KEY);
  for (const mutate of [
    sample => { sample.descriptionIds.pop(); },
    sample => { sample.descriptionIds[0] = sample.descriptionIds[2]; },
    sample => { sample.descriptionIds[1] = "steam_5"; },
    sample => { sample.descriptionIds[0] = YOUR_DESCRIPTION_ID; },
    sample => { sample.descriptionIds[0] = "steam_01"; },
    sample => { sample.descriptionIds[0] = 1; },
    sample => { sample.minimumReviewCount = "50"; },
    sample => { sample.catalogueId = ""; },
    sample => { delete sample.genreId; },
  ]) {
    const sample = sampleFixture();
    mutate(sample);
    assert.throws(() => context.saveComparisonSample(sample));
    assert.equal(storage.get(SAMPLE_KEY), previousSample);
    assert.equal(context.comparisonSampleMatchesSettings(sample, settingsFixture(), catalogueFixture()), false);
    storage.set(SAMPLE_KEY, JSON.stringify(sample));
    assert.throws(() => context.getComparisonSample());
    storage.set(SAMPLE_KEY, previousSample);
  }
  storage.set(SAMPLE_KEY, "malformed JSON");
  assert.throws(() => context.getComparisonSample(), /sample/i);
  assert.equal(storage.get(SAMPLE_KEY), "malformed JSON");
});

test("saved comparison order survives reload without copying descriptions into the sample", () => {
  const storage = new Map();
  const first = browserContext({storage}).context;
  first.setSettings(settingsFixture());
  first.saveComparisonSample(sampleFixture());
  const second = browserContext({storage}).context;
  const restored = second.getComparisonSample();
  assert.deepEqual(plain(restored), sampleFixture());
  assert.deepEqual(Array.from(second.comparisonDescriptions(catalogueFixture(), restored, second.getSettings()), card => card.id), sampleFixture().descriptionIds);
  assert.deepEqual(Object.keys(JSON.parse(storage.get(SAMPLE_KEY))).sort(), ["catalogueId", "descriptionIds", "genreId", "minimumReviewCount"].sort());
});

test("changing the candidate text keeps Steam games and their arranged positions", () => {
  const {context} = browserContext();
  const catalogue = catalogueFixture();
  const sample = sampleFixture();
  const settings = {...settingsFixture(), description: "An edited candidate description"};
  assert.equal(context.comparisonSampleMatchesSettings(sample, settings, catalogue), true);
  const descriptions = context.comparisonDescriptions(catalogue, sample, settings);
  assert.deepEqual(Array.from(descriptions, description => description.id), sample.descriptionIds);
  assert.equal(descriptions[1].text, settings.description);
  assert.equal(descriptions[0].text, "Description 3");
  assert.deepEqual(Array.from(context.comparisonGames(catalogue, sample), game => game.id), ["steam_3", "steam_1", "steam_4", "steam_2"]);
  assert.deepEqual(sample, sampleFixture());
});

test("sample matching rejects stale catalogue, changed filters, excluded and missing games", () => {
  const {context} = browserContext();
  const catalogue = catalogueFixture();
  const sample = sampleFixture();
  const settings = settingsFixture();
  assert.equal(context.comparisonSampleMatchesSettings(sample, settings, catalogue), true);
  assert.equal(context.comparisonSampleMatchesSettings({...sample, catalogueId: "another-catalogue"}, settings, catalogue), false);
  assert.equal(context.comparisonSampleMatchesSettings(sample, {...settings, tag: "21"}, catalogue), false);
  assert.equal(context.comparisonSampleMatchesSettings(sample, {...settings, minimumReviewCount: 75}, catalogue), false);
  const unknownGameSample = {...sample, descriptionIds: [YOUR_DESCRIPTION_ID, "steam_999", "steam_2", "steam_3", "steam_4"]};
  assert.equal(context.comparisonSampleMatchesSettings(unknownGameSample, settings, catalogue), false);
  assert.throws(() => context.comparisonGames(catalogue, unknownGameSample));
  assert.throws(() => context.comparisonDescriptions(catalogue, unknownGameSample, settings));
  context.excludeSteamGame("steam_1", catalogue);
  assert.equal(context.comparisonSampleMatchesSettings(sample, settings, catalogue), false);
});

test("sample resolution fails explicitly for malformed samples and invalid settings", () => {
  const {context} = browserContext();
  for (const sample of [null, {}, {...sampleFixture(), descriptionIds: [YOUR_DESCRIPTION_ID]}]) {
    assert.throws(() => context.comparisonGames(catalogueFixture(), sample));
    assert.throws(() => context.comparisonDescriptions(catalogueFixture(), sample, settingsFixture()));
  }
  assert.throws(() => context.comparisonDescriptions(catalogueFixture(), sampleFixture(), {description: null, tag: "1", minimumReviewCount: 50}));
});

test("dragging all five descriptions stores their exact permutation without a submit step", () => {
  const {context, storageWrites} = browserContext({compare: true});
  seedComparison(context);
  const arrangedOrder = ["steam_4", "steam_2", "steam_1", YOUR_DESCRIPTION_ID, "steam_3"];
  setDraggedOrder(context, arrangedOrder);
  const beforeWrites = storageWrites.length;
  context.onDescriptionsReordered();
  assert.deepEqual(Array.from(context.getComparisonSample().descriptionIds), arrangedOrder);
  assert.deepEqual(storageWrites.slice(beforeWrites), [SAMPLE_KEY]);
  const reloaded = browserContext({storage: new Map([[SAMPLE_KEY, JSON.stringify(context.getComparisonSample())]])}).context;
  assert.deepEqual(Array.from(reloaded.getComparisonSample().descriptionIds), arrangedOrder);
});

test("a drag cannot drop, repeat, inject, or substitute a description", () => {
  for (const order of [
    ["steam_3", YOUR_DESCRIPTION_ID, "steam_1", "steam_4"],
    ["steam_3", YOUR_DESCRIPTION_ID, "steam_1", "steam_4", "steam_4"],
    ["steam_3", YOUR_DESCRIPTION_ID, "steam_1", "steam_4", "steam_5"],
    ["steam_3", YOUR_DESCRIPTION_ID, "steam_1", "steam_4", "injected"],
  ]) {
    const {context, storage} = browserContext({compare: true});
    seedComparison(context);
    const saved = storage.get(SAMPLE_KEY);
    setDraggedOrder(context, order);
    context.onDescriptionsReordered();
    assert.equal(storage.get(SAMPLE_KEY), saved);
    assert.ok(context.lastRenderMessage);
  }
});

test("an old drag cannot overwrite a newer sample saved by another tab", () => {
  const {context, storage} = browserContext({compare: true});
  seedComparison(context);
  const newerSample = {...sampleFixture(), descriptionIds: [YOUR_DESCRIPTION_ID, "steam_2", "steam_4", "steam_5", "steam_6"]};
  context.saveComparisonSample(newerSample);
  const saved = storage.get(SAMPLE_KEY);
  setDraggedOrder(context, [...sampleFixture().descriptionIds].reverse());
  context.onDescriptionsReordered();
  assert.equal(storage.get(SAMPLE_KEY), saved);
  assert.ok(context.lastRenderMessage);
});

test("excluding a Steam description replaces only its arranged slot and persists the exclusion", () => {
  const {context, storageWrites} = browserContext({compare: true});
  const sample = seedComparison(context);
  const beforeWrites = storageWrites.length;
  context.onExcludeGame("steam_1");
  const updated = context.getComparisonSample();
  assert.equal(updated.descriptionIds.length, 5);
  assert.equal(new Set(updated.descriptionIds).size, 5);
  assert.ok(["steam_5", "steam_6"].includes(updated.descriptionIds[2]));
  for (const index of [0, 1, 3, 4]) assert.equal(updated.descriptionIds[index], sample.descriptionIds[index]);
  assert.ok(context.getExcludedGameIds().includes("steam_1"));
  assert.ok(storageWrites.slice(beforeWrites).every(key => [SAMPLE_KEY, EXCLUSIONS_KEY].includes(key)));
});

test("exclusion is retained when no valid replacement remains and the stale sample is cleared", () => {
  const {context, elements} = browserContext({compare: true});
  seedComparison(context);
  context.excludeSteamGame("steam_5", catalogueFixture());
  context.excludeSteamGame("steam_6", catalogueFixture());
  context.onExcludeGame("steam_1");
  assert.equal(context.getComparisonSample(), null);
  assert.ok(context.getExcludedGameIds().includes("steam_1"));
  assert.match(elements.get("status-message").innerHTML, /restore excluded games/);
});

test("candidate exclusion cannot change the sample or the excluded-games list", () => {
  const {context, storage, elements} = browserContext({compare: true});
  seedComparison(context);
  const saved = storage.get(SAMPLE_KEY);
  context.onExcludeGame(YOUR_DESCRIPTION_ID);
  assert.equal(context.getExcludedGameIds().length, 0);
  assert.equal(storage.get(SAMPLE_KEY), saved);
  assert.match(elements.get("status-message").innerHTML, /Only a Steam game in the current sample/);
});

test("requesting a new sample keeps the configured description and writes no ranking records", () => {
  const {context, storageReads, storageWrites} = browserContext({compare: true});
  seedComparison(context);
  const beforeReads = storageReads.length;
  const beforeWrites = storageWrites.length;
  context.onNewSample();
  const sample = context.getComparisonSample();
  assert.equal(context.comparisonSampleMatchesSettings(sample, context.getSettings(), catalogueFixture()), true);
  assert.equal(context.getSettings().description, settingsFixture().description);
  assert.ok(storageReads.slice(beforeReads).every(key => [SETTINGS_KEY, SAMPLE_KEY, EXCLUSIONS_KEY].includes(key)));
  assert.ok(storageWrites.slice(beforeWrites).every(key => key === SAMPLE_KEY));
});

test("generic and obsolete ranking storage is neither read nor overwritten", () => {
  const storage = new Map([
    ["settings", '{"description":"Other app private value","tag":"1"}'],
    ["currentBatch", '{"shoppingCart":["private value"]}'],
    ["surveyResults", '["another survey"]'],
    ["excludedSteamGameIds", '["not a Steam id"]'],
    ["steamDescriptionComparer:currentBatch", '{"id":"obsolete-batch"}'],
    ["steamDescriptionComparer:surveyResults", '[{"id":"old-ranking"}]'],
    ["steamDescriptionComparer:legacyImportV1", "imported"],
  ]);
  const originals = [...storage];
  const {context, storageReads, storageWrites, storageDeletes} = browserContext({storage});
  assert.equal(context.getSettings(), null);
  assert.equal(context.getComparisonSample(), null);
  assert.equal(context.getExcludedGameIds().length, 0);
  context.setSettings(settingsFixture());
  context.saveComparisonSample(sampleFixture());
  context.excludeSteamGame("steam_1", catalogueFixture());
  context.clearComparisonSample();
  context.restoreAllSteamGames();
  for (const [key, value] of originals) assert.equal(storage.get(key), value);
  for (const key of [...storageReads, ...storageWrites, ...storageDeletes]) {
    assert.ok([SETTINGS_KEY, SAMPLE_KEY, EXCLUSIONS_KEY].includes(key), "Unexpected storage access: " + key);
  }
});

test("existing namespaced settings and exclusions remain active and unchanged on reload", () => {
  const storage = new Map([
    [SETTINGS_KEY, JSON.stringify(settingsFixture())],
    [EXCLUSIONS_KEY, '["steam_2"]'],
    ["steamDescriptionComparer:currentBatch", '{"items":["obsolete"]}'],
    ["steamDescriptionComparer:surveyResults", '[{"id":"old-ranking"}]'],
  ]);
  const original = [...storage];
  const {context, storageWrites, storageDeletes} = browserContext({storage});
  assert.deepEqual(plain(context.getSettings()), settingsFixture());
  assert.deepEqual(plain(context.getExcludedGameIds()), ["steam_2"]);
  assert.equal(context.getComparisonSample(), null);
  assert.deepEqual([...storage], original);
  assert.equal(storageWrites.length, 0);
  assert.equal(storageDeletes.length, 0);
});

test("unrelated storage events cannot clear or replace the displayed comparison sample", () => {
  const {context, storage, storageListeners} = browserContext({compare: true});
  seedComparison(context);
  const saved = storage.get(SAMPLE_KEY);
  for (const key of ["settings", "currentBatch", "excludedSteamGameIds", "steamDescriptionComparer:surveyResults"]) {
    for (const listener of storageListeners) listener({key});
  }
  assert.equal(storage.get(SAMPLE_KEY), saved);
  assert.equal(context.lastRenderMessage, undefined);
});

test("Steam source markup derives its URL from the canonical id and escapes visible text", () => {
  const {context} = browserContext();
  const markup = context.steamSourceMarkup({id: "steam_123", name: '<bad> & "quoted"', storeUrl: "javascript:alert(1)"});
  assert.ok(markup.includes("https://store.steampowered.com/app/123/"));
  assert.ok(markup.includes("&lt;bad&gt; &amp; &quot;quoted&quot;"));
  assert.ok(!markup.includes("javascript:"));
  for (const game of [{id: YOUR_DESCRIPTION_ID, name: "Candidate"}, {id: "steam_01", name: "Bad id"}, {id: "steam_123"}]) {
    assert.throws(() => context.steamSourceMarkup(game));
  }
});

test("catalogue HTTP failures remain explicit without using a substitute catalogue", async () => {
  const {context, fetchUrls} = browserContext({fetchResponse: () => ({ok: false, status: 404})});
  await assert.rejects(context.fetchCatalogue(), /HTTP 404/);
  await assert.rejects(context.fetchCatalogue(), /HTTP 404/);
  assert.deepEqual(fetchUrls, ["catalogue.json"]);
});

test("public pages and dependencies use relative URLs and no private API endpoints", () => {
  for (const filename of ["index.html", "settings.html", "compare.html", "script.js"]) {
    const contents = fs.readFileSync(path.join(staticDirectory, filename), "utf8");
    assert.doesNotMatch(contents, /["']\/api\//);
    assert.doesNotMatch(contents, /(?:href|src)=["']\//);
    assert.doesNotMatch(contents, /admin-link/);
    if (filename.endsWith(".html")) {
      for (const match of contents.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(match[1]));
    }
  }
});



test("a drag cannot save descriptions made ineligible by changed filters or exclusions", () => {
  for (const invalidateSample of [
    context => context.setSettings({...settingsFixture(), minimumReviewCount: 75}),
    context => context.excludeSteamGame("steam_1", catalogueFixture()),
  ]) {
    const {context, storage, storageWrites} = browserContext({compare: true});
    seedComparison(context);
    invalidateSample(context);
    const saved = storage.get(SAMPLE_KEY);
    const beforeWrites = storageWrites.length;
    setDraggedOrder(context, [...sampleFixture().descriptionIds].reverse());
    context.onDescriptionsReordered();
    assert.equal(storage.get(SAMPLE_KEY), saved);
    assert.equal(storageWrites.length, beforeWrites);
    assert.ok(context.lastRenderMessage);
  }
});

test("an exclusion click from an old display cannot change a newer sample or exclusions", () => {
  const {context, storage, storageWrites} = browserContext({compare: true});
  seedComparison(context);
  const newerSample = {...sampleFixture(), descriptionIds: ["steam_5", YOUR_DESCRIPTION_ID, "steam_1", "steam_4", "steam_2"]};
  context.saveComparisonSample(newerSample);
  const saved = storage.get(SAMPLE_KEY);
  const beforeWrites = storageWrites.length;
  context.onExcludeGame("steam_1");
  assert.equal(storage.get(SAMPLE_KEY), saved);
  assert.equal(context.getExcludedGameIds().length, 0);
  assert.equal(storageWrites.length, beforeWrites);
  assert.ok(context.lastRenderMessage);
});


test("a settings change during catalogue loading keeps the old draft from overwriting the newer draft", async () => {
  let releaseResponse;
  const responsePromise = new Promise(resolve => { releaseResponse = resolve; });
  const olderSettings = settingsFixture();
  const newerSettings = {...olderSettings, description: "A newer draft saved in another tab"};
  const storage = new Map([[SETTINGS_KEY, JSON.stringify(olderSettings)]]);
  const {context, elements, storageListeners, storageWrites} = browserContext({settings: true, storage, fetchResponse: () => responsePromise});
  const initialization = context.init();
  assert.equal(elements.get("description").value, olderSettings.description);
  assert.equal(elements.get("save-btn").disabled, true);
  storage.set(SETTINGS_KEY, JSON.stringify(newerSettings));
  for (const listener of storageListeners) listener({key: SETTINGS_KEY});
  releaseResponse({ok: true, json: async () => catalogueFixture()});
  await initialization;
  assert.match(elements.get("catalogue-details").textContent, /8 games across 2 genres/);
  assert.equal(elements.get("tag").value, "1");
  assert.equal(elements.get("save-btn").disabled, true);
  assert.match(elements.get("status-message").innerHTML, /Settings changed in another tab/);
  elements.get("save-btn").click();
  assert.deepEqual(plain(context.getSettings()), newerSettings);
  assert.equal(storageWrites.length, 0);
  assert.equal(context.window.location.href, "");
});

test("same-catalogue corrupt sample references fail visibly and stay saved until explicit New sample", () => {
  for (const mutate of [
    sample => { sample.descriptionIds[0] = "steam_999"; },
    sample => { sample.descriptionIds[0] = "steam_7"; },
    sample => { sample.minimumReviewCount = 100; },
  ]) {
    const {context, storage, elements, storageWrites, storageDeletes} = browserContext({compare: true, realComparisonRenderer: true});
    context.setSettings(settingsFixture());
    const corruptedSample = sampleFixture();
    mutate(corruptedSample);
    context.saveComparisonSample(corruptedSample);
    const saved = storage.get(SAMPLE_KEY);
    const beforeWrites = storageWrites.length;
    const beforeDeletes = storageDeletes.length;
    assert.throws(() => context.comparisonGames(catalogueFixture(), corruptedSample));
    context.renderComparisonPage();
    assert.equal(storage.get(SAMPLE_KEY), saved);
    assert.equal(storageWrites.length, beforeWrites);
    assert.equal(storageDeletes.length, beforeDeletes);
    assert.match(elements.get("status-message").innerHTML, /comparison|sample|genre|minimum/i);
    assert.match(elements.get("main-area").innerHTML, /New sample/);
    assert.equal(vm.runInContext("currentlyDisplayedComparisonSample", context), null);
    context.onNewSample();
    const replacement = context.getComparisonSample();
    assert.equal(context.comparisonSampleMatchesSettings(replacement, context.getSettings(), catalogueFixture()), true);
    assert.notEqual(storage.get(SAMPLE_KEY), saved);
    assert.doesNotMatch(elements.get("main-area").innerHTML, /No comparison sample to show/);
  }
});


test("review minima must be zero or at least fifty across settings, sampling and saved comparisons", () => {
  const {context, storage} = browserContext();
  for (const minimum of [0, 50, 51, 100]) {
    context.setSettings({...settingsFixture(), minimumReviewCount: minimum});
    context.saveComparisonSample({...sampleFixture(), minimumReviewCount: minimum});
    assert.equal(context.getSettings().minimumReviewCount, minimum);
    assert.equal(context.getComparisonSample().minimumReviewCount, minimum);
  }
  const savedSettings = storage.get(SETTINGS_KEY);
  const savedSample = storage.get(SAMPLE_KEY);
  for (const minimum of [1, 25, 49]) {
    assert.throws(() => context.setSettings({...settingsFixture(), minimumReviewCount: minimum}), /50 or more/);
    assert.throws(() => context.getEligibleGames(catalogueFixture(), 1, minimum), /50 or more/);
    assert.throws(() => context.createComparisonSample(catalogueFixture(), {...settingsFixture(), minimumReviewCount: minimum}), /50 or more/);
    assert.throws(() => context.saveComparisonSample({...sampleFixture(), minimumReviewCount: minimum}), /sample is invalid/);
    assert.equal(storage.get(SETTINGS_KEY), savedSettings);
    assert.equal(storage.get(SAMPLE_KEY), savedSample);
  }
});

test("previously saved minima below fifty stay editable but cannot be used until corrected", async () => {
  for (const minimum of [1, 49]) {
    for (const correctedMinimum of [0, 50]) {
      const previousSettings = {...settingsFixture(), minimumReviewCount: minimum};
      const previousSample = {...sampleFixture(), minimumReviewCount: minimum};
      const storage = new Map([[SETTINGS_KEY, JSON.stringify(previousSettings)], [SAMPLE_KEY, JSON.stringify(previousSample)]]);
      const {context, elements, storageWrites} = browserContext({settings: true, storage});
      await context.init();
      assert.equal(elements.get("description").value, previousSettings.description);
      assert.equal(elements.get("minimum-review-count").valueAsNumber, minimum);
      assert.equal(elements.get("save-btn").disabled, false);
      assert.match(elements.get("eligible-game-count").textContent, /50 or more/);
      assert.throws(() => context.getSettings(), /50 or more/);
      assert.throws(() => context.getComparisonSample(), /sample is invalid/);
      assert.equal(storageWrites.length, 0);
      elements.get("save-btn").click();
      assert.equal(storageWrites.length, 0);
      assert.equal(context.window.location.href, "");
      elements.get("minimum-review-count").value = String(correctedMinimum);
      elements.get("save-btn").click();
      assert.equal(context.getSettings().minimumReviewCount, correctedMinimum);
      assert.equal(context.getSettings().description, previousSettings.description);
      assert.equal(context.getComparisonSample(), null);
      assert.equal(context.window.location.href, "compare.html");
    }
  }
});
