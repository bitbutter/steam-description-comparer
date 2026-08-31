const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticDirectory = path.join(__dirname, "..", "static");
const sharedScript = fs.readFileSync(path.join(staticDirectory, "script.js"), "utf8");
const compareInlineScript = fs.readFileSync(path.join(staticDirectory, "compare.html"), "utf8")
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/, "");

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

function browserContext({catalogue = catalogueFixture(), storage = new Map(), fetchResponse, compare = false} = {}) {
  const fetchUrls = [];
  const elements = new Map();
  const storageListeners = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", disabled: false,
      addEventListener() {}, querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    fetch: async url => {
      fetchUrls.push(url);
      return fetchResponse ? fetchResponse() : {ok: true, json: async () => catalogue};
    },
    document: {getElementById: element, querySelectorAll: () => []},
    window: {addEventListener: (event, callback) => { if (event === "storage") storageListeners.push(callback); }},
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(sharedScript, context);
  if (compare) {
    vm.runInContext(compareInlineScript, context);
    context.fixtureCatalogue = catalogue;
    vm.runInContext("comparisonCatalogue = fixtureCatalogue; renderPage = message => { globalThis.lastRenderMessage = message; };", context);
  }
  return {context, storage, fetchUrls, elements, storageListeners};
}

function seedComparison(context, catalogue = catalogueFixture()) {
  context.setSettings({description: "My candidate description", tag: "1", minimumReviewCount: 50});
  const candidate = {id: context.hashStr("My candidate description"), text: "My candidate description"};
  const batch = {id: "fixture-batch", catalogueId: catalogue.catalogueId, tag: "1", minimumReviewCount: 50,
    items: [...catalogue.games.slice(0, 4), candidate]};
  context.setBatch(batch);
  context.fixtureBatch = batch;
  vm.runInContext("currentlyDisplayedBatchId = fixtureBatch.id; getRankOrder = () => fixtureBatch.items.map(item => item.id);", context);
  return batch;
}

test("catalogue is fetched once with a project-relative URL", async () => {
  const {context, fetchUrls} = browserContext();
  await Promise.all([context.fetchCatalogue(), context.fetchTags(), context.fetchGames(1, 50)]);
  assert.deepEqual(fetchUrls, ["catalogue.json"]);
});

test("genre selection, higher minimums, explicit zero, and unique cards use the saved catalogue", async () => {
  const {context} = browserContext();
  const filtered = await context.fetchGames(1, 100);
  assert.equal(filtered.length, 4);
  assert.equal(new Set(filtered.map(game => game.id)).size, 4);
  assert.ok(filtered.every(game => game.reviews >= 100 && game.steamTagIds.includes(19)));
  const catalogue = await context.fetchCatalogue();
  assert.equal(context.getEligibleGames(catalogue, 1, 0).length, 6);
  assert.throws(() => context.getEligibleGames(catalogue, 1, -1), /whole number/);
  assert.throws(() => context.getEligibleGames(catalogue, 999, 50), /selected genre/);
});

test("catalogue refuses review-definition drift, below-floor games, and invalid identities", () => {
  const {context} = browserContext();
  for (const mutate of [
    catalogue => { catalogue.reviewCountScope = "all reviews"; },
    catalogue => { catalogue.games[0].reviews = 49; },
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

test("catalogue rejects absent games, duplicate memberships, and mismatched Steam tags", () => {
  const {context} = browserContext();
  for (const gameIds of [["steam_999"], ["steam_1", "steam_1"], ["steam_7"]]) {
    const catalogue = catalogueFixture();
    catalogue.genres[0].gameIds = gameIds;
    assert.throws(() => context.validateCatalogue(catalogue), /catalogue is invalid/);
  }
});

test("exclusions persist across browser contexts, exclude replacements, and restore individually", async () => {
  const storage = new Map();
  const first = browserContext({storage}).context;
  const catalogue = await first.fetchCatalogue();
  first.excludeSteamGame("steam_1", catalogue);
  first.excludeSteamGame("steam_1", catalogue);
  const second = browserContext({storage}).context;
  assert.deepEqual(JSON.parse(JSON.stringify(second.getExcludedGameIds())), ["steam_1"]);
  const replacement = await second.fetchGames(1, 50, ["steam_2", "steam_3", "steam_4"], 1);
  assert.ok(["steam_5", "steam_6"].includes(replacement[0].id));
  first.restoreSteamGame("steam_1");
  assert.equal(second.getExcludedGameIds().length, 0);
});

test("own candidate cannot enter exclusions and damaged exclusion storage fails explicitly", async () => {
  const {context, storage} = browserContext();
  assert.throws(() => context.excludeSteamGame("exp_candidate", catalogueFixture()), /Only a Steam game/);
  storage.set("steamDescriptionComparer:excludedSteamGameIds", '["exp_candidate"]');
  await assert.rejects(context.fetchGames(1, 0), /excluded games list is invalid/);
  storage.set("steamDescriptionComparer:excludedSteamGameIds", '["steam_1","steam_1"]');
  assert.throws(() => context.getExcludedGameIds(), /excluded games list is invalid/);
});

test("underfilled pools never lower the minimum or return excluded games", async () => {
  const {context} = browserContext();
  await assert.rejects(context.fetchGames(1, 150), /Too few eligible/);
  context.excludeSteamGame("steam_1", catalogueFixture());
  context.excludeSteamGame("steam_2", catalogueFixture());
  context.excludeSteamGame("steam_3", catalogueFixture());
  await assert.rejects(context.fetchGames(1, 0), /restore excluded games/);
});

test("exclusions added while the catalogue request is in flight affect the first sample", async () => {
  let releaseResponse;
  const responsePromise = new Promise(resolve => { releaseResponse = resolve; });
  const {context, storage} = browserContext({fetchResponse: () => responsePromise});
  const samplePromise = context.fetchGames(1, 0);
  storage.set("steamDescriptionComparer:excludedSteamGameIds", '["steam_1","steam_2"]');
  releaseResponse({ok: true, json: async () => catalogueFixture()});
  const games = await samplePromise;
  assert.deepEqual(Array.from(games.map(game => game.id)).sort(), ["steam_3", "steam_4", "steam_5", "steam_6"]);
});

test("legacy and foreign catalogue batches are incompatible while old rankings remain intact", () => {
  const {context, storage} = browserContext({compare: true});
  const batch = seedComparison(context);
  const settings = context.getSettings();
  storage.set("steamDescriptionComparer:surveyResults", JSON.stringify([{id: "legacy", items: [], rank: []}]));
  assert.equal(context.batchMatchesCatalogueSettings(batch, settings, catalogueFixture()), true);
  delete batch.catalogueId;
  assert.equal(context.batchMatchesCatalogueSettings(batch, settings, catalogueFixture()), false);
  batch.catalogueId = "another-catalogue";
  assert.equal(context.batchMatchesCatalogueSettings(batch, settings, catalogueFixture()), false);
  assert.equal(context.getResults()[0].id, "legacy");
});

test("editing blocks ranking and excluding a Steam card persists, replaces once, and changes batch identity", async () => {
  const {context} = browserContext({compare: true});
  const originalBatch = seedComparison(context);
  vm.runInContext("sampleEditMode = true;", context);
  context.onDone();
  assert.equal(context.getResults().length, 0);
  await context.onExcludeGame("steam_1");
  const updatedBatch = context.getBatch();
  assert.notEqual(updatedBatch.id, originalBatch.id);
  assert.equal(updatedBatch.items.length, 5);
  assert.equal(new Set(updatedBatch.items.map(item => item.id)).size, 5);
  assert.equal(updatedBatch.items.filter(item => context.isCandidateDescription(item)).length, 1);
  assert.ok(!updatedBatch.items.some(item => item.id === "steam_1"));
  assert.ok(context.getExcludedGameIds().includes("steam_1"));
});

test("excluding the last available replacement clears stale sample but preserves the exclusion", async () => {
  const {context} = browserContext({compare: true});
  seedComparison(context);
  context.excludeSteamGame("steam_5", catalogueFixture());
  context.excludeSteamGame("steam_6", catalogueFixture());
  vm.runInContext("sampleEditMode = true;", context);
  await context.onExcludeGame("steam_1");
  assert.equal(context.getBatch(), null);
  assert.ok(context.getExcludedGameIds().includes("steam_1"));
  assert.match(context.lastRenderMessage, /restore excluded games/);
});

test("candidate exclusion is rejected without changing sample or exclusion storage", async () => {
  const {context} = browserContext({compare: true});
  const batch = seedComparison(context);
  vm.runInContext("sampleEditMode = true;", context);
  await context.onExcludeGame(batch.items[4].id);
  assert.equal(context.getExcludedGameIds().length, 0);
  assert.equal(context.getBatch().id, batch.id);
  assert.match(context.lastRenderMessage, /own description cannot be excluded/);
});

test("recording rechecks current exclusions and current candidate text before saving", () => {
  const {context} = browserContext({compare: true});
  seedComparison(context);
  context.excludeSteamGame("steam_1", catalogueFixture());
  context.onDone();
  assert.equal(context.getResults().length, 0);
  context.restoreAllSteamGames();
  context.setSettings({description: "Changed candidate", tag: "1", minimumReviewCount: 50});
  context.onDone();
  assert.equal(context.getResults().length, 0);
});

test("valid rankings retain catalogue provenance and require a complete permutation", () => {
  const {context} = browserContext({compare: true});
  seedComparison(context);
  vm.runInContext('getRankOrder = () => ["steam_1", "steam_1", "steam_2", "steam_3", "steam_4"];', context);
  context.onDone();
  assert.equal(context.getResults().length, 0);
  vm.runInContext("getRankOrder = () => fixtureBatch.items.map(item => item.id);", context);
  context.onDone();
  const ranking = context.getResults()[0];
  assert.equal(ranking.catalogueId, catalogueFixture().catalogueId);
  assert.equal(ranking.catalogueMinimumReviewCount, 50);
  assert.equal(ranking.reviewCountScope, catalogueFixture().reviewCountScope);
});

test("another-tab storage change cancels a sample that is still loading", async () => {
  let releaseResponse;
  const responsePromise = new Promise(resolve => { releaseResponse = resolve; });
  const {context, storageListeners} = browserContext({compare: true, fetchResponse: () => responsePromise});
  context.setSettings({description: "Candidate", tag: "1", minimumReviewCount: 50});
  const samplePromise = context.onLoadSample();
  storageListeners[0]({key: "steamDescriptionComparer:excludedSteamGameIds"});
  releaseResponse({ok: true, json: async () => catalogueFixture()});
  await samplePromise;
  assert.equal(context.getBatch(), null);
});

test("Steam source markup cannot use injected URLs or unescaped names", () => {
  const {context} = browserContext();
  const markup = context.steamSourceMarkup({id: "steam_123", name: "<bad>", storeUrl: "javascript:alert(1)"});
  assert.ok(markup.includes("https://store.steampowered.com/app/123/"));
  assert.ok(markup.includes("&lt;bad&gt;"));
  assert.ok(!markup.includes("javascript:"));
});

test("public pages and dependencies use relative URLs and no private API endpoints", () => {
  for (const filename of ["index.html", "settings.html", "compare.html", "results.html", "script.js"]) {
    const contents = fs.readFileSync(path.join(staticDirectory, filename), "utf8");
    assert.doesNotMatch(contents, /["']\/api\//);
    assert.doesNotMatch(contents, /(?:href|src)=["']\//);
    assert.doesNotMatch(contents, /admin-link/);
    if (filename.endsWith(".html")) {
      for (const match of contents.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(match[1]));
    }
  }
});


function legacySteamRecords(context) {
  const description = "A previous Steam Comparer candidate";
  const items = [...catalogueFixture().games.slice(0, 4), {id: context.hashStr(description), text: description}];
  const batch = {id: "batch_legacy_1", tag: "1", items};
  const ranking = {id: "s_legacy_1", batchId: batch.id, timestamp: "2026-07-01T12:00:00Z",
    tag: "1", items, rank: items.map(item => item.id)};
  return {settings: {description, tag: "1"}, batch, ranking};
}

test("shared generic keys from another project are never read as active data or overwritten", () => {
  const storage = new Map([
    ["settings", '{"theme":"light","privateOtherAppField":"do not expose"}'],
    ["currentBatch", '{"shoppingCart":["private value"]}'],
    ["surveyResults", '["another survey"]'],
    ["excludedSteamGameIds", '["not a Steam id"]'],
  ]);
  const originalEntries = [...storage];
  const {context} = browserContext({storage});
  const notice = context.migratePreviousLocalData();
  assert.match(notice, /could not be safely imported/);
  assert.doesNotMatch(notice, /privateOtherAppField|shoppingCart|private value|another survey/);
  assert.equal(context.getSettings(), null);
  assert.equal(context.getBatch(), null);
  assert.equal(context.getResults().length, 0);
  assert.equal(context.getExcludedGameIds().length, 0);
  context.setSettings({description: "New candidate", tag: "1", minimumReviewCount: 50});
  context.setBatch({id: "new-batch"});
  context.addResult({id: "new-ranking"});
  context.excludeSteamGame("steam_1", catalogueFixture());
  context.clearBatch();
  context.clearResults();
  context.restoreAllSteamGames();
  for (const [key, value] of originalEntries) assert.equal(storage.get(key), value);
  for (const key of storage.keys()) assert.ok(originalEntries.some(([original]) => original === key) || key.startsWith("steamDescriptionComparer:"));
});

test("a verified previous Steam sample and rankings migrate once without deleting originals", () => {
  const {context, storage} = browserContext();
  const legacy = legacySteamRecords(context);
  storage.set("settings", JSON.stringify(legacy.settings));
  storage.set("currentBatch", JSON.stringify(legacy.batch));
  storage.set("surveyResults", JSON.stringify([legacy.ranking]));
  storage.set("excludedSteamGameIds", '["steam_2"]');
  const originals = [...storage];
  assert.match(context.migratePreviousLocalData(), /Verified previous Steam Comparer data was copied/);
  assert.equal(context.getSettings().minimumReviewCount, 50);
  assert.equal(context.getBatch().id, legacy.batch.id);
  assert.equal(context.getResults()[0].id, legacy.ranking.id);
  assert.equal(context.getExcludedGameIds()[0], "steam_2");
  for (const [key, value] of originals) assert.equal(storage.get(key), value);
  context.clearResults();
  storage.set("surveyResults", JSON.stringify([{...legacy.ranking, id: "s_added_later"}]));
  context.migratePreviousLocalData();
  assert.equal(context.getResults().length, 0, "generic values cannot reappear after the one-time upgrade");
});

test("a plausible settings object alone is insufficient evidence to import shared data", () => {
  const {context, storage} = browserContext();
  storage.set("settings", JSON.stringify({description: "A game", tag: "1", minimumReviewCount: 50}));
  assert.match(context.migratePreviousLocalData(), /could not be safely imported/);
  assert.equal(context.getSettings(), null);
});

test("malformed Steam ranking history is not imported and its contents are not revealed", () => {
  const {context, storage} = browserContext();
  const legacy = legacySteamRecords(context);
  legacy.ranking.rank[4] = legacy.ranking.rank[0];
  storage.set("settings", JSON.stringify(legacy.settings));
  storage.set("surveyResults", JSON.stringify([legacy.ranking]));
  const notice = context.migratePreviousLocalData();
  assert.match(notice, /could not be safely imported/);
  assert.doesNotMatch(notice, /previous Steam Comparer candidate/);
  assert.equal(context.getResults().length, 0);
  assert.equal(context.getSettings(), null);
});

test("verified Steam history is preserved without claiming ambiguous shared settings", () => {
  const {context, storage} = browserContext();
  const legacy = legacySteamRecords(context);
  storage.set("settings", '{"description":"Secret from other project","tag":"1","theme":"dark"}');
  storage.set("surveyResults", JSON.stringify([legacy.ranking]));
  const originalSettings = storage.get("settings");
  assert.match(context.migratePreviousLocalData(), /Other older entries were ambiguous/);
  assert.equal(context.getResults()[0].id, legacy.ranking.id);
  assert.equal(context.getSettings(), null);
  assert.equal(storage.get("settings"), originalSettings);
});

test("one-time migration never overwrites existing namespaced rankings or settings", () => {
  const {context, storage} = browserContext();
  const legacy = legacySteamRecords(context);
  storage.set("settings", JSON.stringify(legacy.settings));
  storage.set("surveyResults", JSON.stringify([legacy.ranking]));
  context.setSettings({description: "Current candidate", tag: "21", minimumReviewCount: 200});
  context.addResult({id: "already-saved"});
  assert.match(context.migratePreviousLocalData(), /current data already exists/);
  assert.equal(context.getSettings().description, "Current candidate");
  assert.equal(context.getResults()[0].id, "already-saved");
});

test("generic storage events from another project do not cancel this tool's sample", async () => {
  let releaseResponse;
  const responsePromise = new Promise(resolve => { releaseResponse = resolve; });
  const {context, storageListeners} = browserContext({compare: true, fetchResponse: () => responsePromise});
  context.setSettings({description: "Candidate", tag: "1", minimumReviewCount: 50});
  const samplePromise = context.onLoadSample();
  storageListeners[0]({key: "settings"});
  storageListeners[0]({key: "currentBatch"});
  storageListeners[0]({key: "excludedSteamGameIds"});
  releaseResponse({ok: true, json: async () => catalogueFixture()});
  await samplePromise;
  assert.equal(context.getBatch().items.length, 5);
});
