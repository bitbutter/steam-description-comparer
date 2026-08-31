// Settings, samples, rankings, and excluded games stay in this browser.
const SETTINGS_STORAGE_KEY = "steamDescriptionComparer:settings";
const BATCH_STORAGE_KEY = "steamDescriptionComparer:currentBatch";
const RESULTS_STORAGE_KEY = "steamDescriptionComparer:surveyResults";
const EXCLUDED_GAMES_STORAGE_KEY = "steamDescriptionComparer:excludedSteamGameIds";
const LEGACY_IMPORT_STORAGE_KEY = "steamDescriptionComparer:legacyImportV1";

function isKnownLegacyGenre(genreId) {
  return [1, 21, 9, 122, 23, 32, 28, 12, 43, 492, 1131, 4182, 114, 493, 534]
    .some(knownId => genreId === knownId || genreId === String(knownId));
}

function hasOnlyKnownFields(value, fieldNames) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(fieldName => fieldNames.includes(fieldName)));
}

function isVerifiedLegacySettings(settings) {
  return hasOnlyKnownFields(settings, ["description", "tag", "minimumReviewCount"]) &&
    typeof settings.description === "string" && Boolean(settings.description.trim()) &&
    isKnownLegacyGenre(settings.tag) &&
    (settings.minimumReviewCount === undefined ||
      (Number.isSafeInteger(settings.minimumReviewCount) && settings.minimumReviewCount >= 0));
}

function isVerifiedLegacyDescription(description) {
  if (!hasOnlyKnownFields(description, ["id", "text", "reviews", "name", "storeUrl", "appid", "steamTagIds"]) ||
      typeof description.id !== "string" || typeof description.text !== "string" || !description.text.trim()) return false;
  if (description.id === "experimental" || description.id === hashStr(description.text)) {
    return description.reviews === undefined || (Number.isSafeInteger(description.reviews) && description.reviews >= 0);
  }
  if (!/^steam_[1-9][0-9]*$/.test(description.id) ||
      !Number.isSafeInteger(description.reviews) || description.reviews < 0) return false;
  if (description.name !== undefined && typeof description.name !== "string") return false;
  if (description.appid !== undefined && description.id !== "steam_" + description.appid) return false;
  if (description.storeUrl !== undefined &&
      description.storeUrl !== "https://store.steampowered.com/app/" + description.id.slice(6) + "/") return false;
  if (description.steamTagIds !== undefined &&
      (!Array.isArray(description.steamTagIds) || description.steamTagIds.some(id => !Number.isSafeInteger(id) || id <= 0))) return false;
  return true;
}

function isVerifiedLegacySampleItems(items) {
  return Array.isArray(items) && items.length === 5 && items.every(isVerifiedLegacyDescription) &&
    new Set(items.map(item => item.id)).size === 5 && items.filter(isCandidateDescription).length === 1;
}

function hasValidLegacySamplingMetadata(sample) {
  return (sample.minimumReviewCount === undefined ||
      (Number.isSafeInteger(sample.minimumReviewCount) && sample.minimumReviewCount >= 0)) &&
    (sample.catalogueId === undefined || (typeof sample.catalogueId === "string" && Boolean(sample.catalogueId.trim())));
}

function isVerifiedLegacyBatch(batch) {
  return hasOnlyKnownFields(batch, ["id", "tag", "minimumReviewCount", "items", "catalogueId"]) &&
    typeof batch.id === "string" && batch.id.startsWith("batch_") && isKnownLegacyGenre(batch.tag) &&
    hasValidLegacySamplingMetadata(batch) && isVerifiedLegacySampleItems(batch.items);
}

function isVerifiedLegacyRanking(ranking) {
  if (!hasOnlyKnownFields(ranking, ["id", "timestamp", "batchId", "tag", "minimumReviewCount", "items", "rank",
      "catalogueId", "catalogueCollectedAt", "catalogueMinimumReviewCount", "reviewCountScope"]) ||
      typeof ranking.id !== "string" || !ranking.id.startsWith("s_") ||
      typeof ranking.timestamp !== "string" || !Number.isFinite(Date.parse(ranking.timestamp)) ||
      typeof ranking.batchId !== "string" || !ranking.batchId.startsWith("batch_") ||
      (ranking.tag !== undefined && !isKnownLegacyGenre(ranking.tag)) ||
      !hasValidLegacySamplingMetadata(ranking) || !isVerifiedLegacySampleItems(ranking.items) ||
      !Array.isArray(ranking.rank) || ranking.rank.length !== 5 || new Set(ranking.rank).size !== 5 ||
      !ranking.rank.every(id => ranking.items.some(item => item.id === id))) return false;
  return (ranking.catalogueCollectedAt === undefined ||
      (typeof ranking.catalogueCollectedAt === "string" && Number.isFinite(Date.parse(ranking.catalogueCollectedAt)))) &&
    (ranking.catalogueMinimumReviewCount === undefined || ranking.catalogueMinimumReviewCount === 50) &&
    (ranking.reviewCountScope === undefined || ranking.reviewCountScope === REVIEW_COUNT_SCOPE);
}

// Only this one-time data upgrade reads shared keys from older installations.
// Generic values are never deleted, overwritten, or used as ongoing aliases.
function migratePreviousLocalData() {
  const importNotices = {
    none: "",
    imported: "Verified previous Steam Comparer data was copied into this tool's own browser storage. The original entries were left unchanged.",
    skipped: "Older browser data could not be safely imported into this tool, or current data already exists. No older entries were changed or displayed.",
    partial: "Verified previous Steam Comparer data was imported. Other older entries were ambiguous or already had current replacements; those entries were left unchanged and were not displayed.",
  };
  const priorOutcome = localStorage.getItem(LEGACY_IMPORT_STORAGE_KEY);
  if (priorOutcome !== null) {
    if (!Object.prototype.hasOwnProperty.call(importNotices, priorOutcome)) throw new Error("The previous-data import record is invalid.");
    return importNotices[priorOutcome];
  }
  const legacyKeys = ["settings", "currentBatch", "surveyResults", "excludedSteamGameIds"];
  const legacyEntries = legacyKeys.map(key => {
    const serializedValue = localStorage.getItem(key);
    if (serializedValue === null) return {key, present: false};
    try { return {key, present: true, value: JSON.parse(serializedValue)}; }
    catch { return {key, present: true}; }
  });
  const legacyBatch = legacyEntries[1].value;
  const legacyRankings = legacyEntries[2].value;
  const verifiedBatch = isVerifiedLegacyBatch(legacyBatch);
  const verifiedRankings = Array.isArray(legacyRankings) && legacyRankings.length > 0 &&
    legacyRankings.every(isVerifiedLegacyRanking);
  const hasSteamComparerEvidence = verifiedBatch || verifiedRankings;
  const legacyExclusions = legacyEntries[3].value;
  const verifiedExclusions = hasSteamComparerEvidence && Array.isArray(legacyExclusions) &&
    legacyExclusions.every(id => typeof id === "string" && /^steam_[1-9][0-9]*$/.test(id)) &&
    new Set(legacyExclusions).size === legacyExclusions.length;
  const verifiedEntries = [
    hasSteamComparerEvidence && isVerifiedLegacySettings(legacyEntries[0].value),
    verifiedBatch, verifiedRankings, verifiedExclusions,
  ];
  const currentKeys = [SETTINGS_STORAGE_KEY, BATCH_STORAGE_KEY, RESULTS_STORAGE_KEY, EXCLUDED_GAMES_STORAGE_KEY];
  let importedCount = 0;
  let skippedCount = 0;
  legacyEntries.forEach((entry, index) => {
    if (!entry.present) return;
    if (!verifiedEntries[index] || localStorage.getItem(currentKeys[index]) !== null) {
      skippedCount++;
      return;
    }
    const value = index === 0 && entry.value.minimumReviewCount === undefined ?
      {...entry.value, minimumReviewCount: 50} : entry.value;
    localStorage.setItem(currentKeys[index], JSON.stringify(value));
    importedCount++;
  });
  const outcome = importedCount > 0 ? (skippedCount > 0 ? "partial" : "imported") : (skippedCount > 0 ? "skipped" : "none");
  localStorage.setItem(LEGACY_IMPORT_STORAGE_KEY, outcome);
  return importNotices[outcome];
}

function initializeBrowserStorage() {
  const notice = migratePreviousLocalData();
  document.getElementById("legacy-import-notice").textContent = notice;
}

const REVIEW_COUNT_SCOPE = "Steam purchases, all languages, positive and negative, excluding off-topic activity";
let catalogueRequest = null;

function getSettings() {
  const storedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!storedSettings) return null;
  let settings;
  try { settings = JSON.parse(storedSettings); }
  catch { throw new Error("Saved settings could not be read. Clear this site's browser storage to start again."); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Saved settings are invalid. Clear this site's browser storage to start again.");
  }
  // Older local installations did not store a review minimum.
  if (!Object.prototype.hasOwnProperty.call(settings, "minimumReviewCount")) settings.minimumReviewCount = 50;
  return settings;
}

function setSettings(settings) {
  validateMinimumReviewCount(settings.minimumReviewCount);
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function validateMinimumReviewCount(minimumReviewCount) {
  if (!Number.isSafeInteger(minimumReviewCount) || minimumReviewCount < 0) {
    throw new Error("Minimum Steam reviews must be a valid whole number of 0 or more.");
  }
}

function batchMatchesSamplingSettings(batch, settings) {
  return Boolean(batch && settings && String(batch.tag) === String(settings.tag) &&
    batch.minimumReviewCount === settings.minimumReviewCount);
}

function getBatch() {
  const storedBatch = localStorage.getItem(BATCH_STORAGE_KEY);
  if (!storedBatch) return null;
  try { return JSON.parse(storedBatch); }
  catch { throw new Error("The saved sample could not be read. Use New sample to clear it."); }
}

function setBatch(batch) { localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batch)); }
function clearBatch() { localStorage.removeItem(BATCH_STORAGE_KEY); }

function getResults() {
  const storedResults = localStorage.getItem(RESULTS_STORAGE_KEY);
  if (!storedResults) return [];
  let results;
  try { results = JSON.parse(storedResults); }
  catch { throw new Error("Saved rankings could not be read. They have not been changed."); }
  if (!Array.isArray(results)) throw new Error("Saved rankings are invalid. They have not been changed.");
  return results;
}

function addResult(ranking) {
  const results = getResults();
  results.push(ranking);
  localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
}

function clearResults() { localStorage.removeItem(RESULTS_STORAGE_KEY); }

function getExcludedGameIds() {
  const storedExclusions = localStorage.getItem(EXCLUDED_GAMES_STORAGE_KEY);
  if (!storedExclusions) return [];
  let gameIds;
  try { gameIds = JSON.parse(storedExclusions); }
  catch { throw new Error("The excluded games list could not be read. No games will be sampled until it is repaired."); }
  if (!Array.isArray(gameIds) || gameIds.some(id => typeof id !== "string" || !/^steam_[1-9][0-9]*$/.test(id)) ||
      new Set(gameIds).size !== gameIds.length) {
    throw new Error("The excluded games list is invalid. No games will be sampled until it is repaired.");
  }
  return gameIds;
}

function excludeSteamGame(gameId, catalogue) {
  if (!catalogue.games.some(game => game.id === gameId)) throw new Error("Only a Steam game from this catalogue can be excluded.");
  const excludedGameIds = getExcludedGameIds();
  if (!excludedGameIds.includes(gameId)) {
    localStorage.setItem(EXCLUDED_GAMES_STORAGE_KEY, JSON.stringify([...excludedGameIds, gameId]));
  }
}

function restoreSteamGame(gameId) {
  localStorage.setItem(EXCLUDED_GAMES_STORAGE_KEY,
    JSON.stringify(getExcludedGameIds().filter(excludedId => excludedId !== gameId)));
}

function restoreAllSteamGames() {
  getExcludedGameIds();
  localStorage.removeItem(EXCLUDED_GAMES_STORAGE_KEY);
}

function isCandidateDescription(description) {
  return description.id === "experimental" || description.id.startsWith("exp_");
}

// Existing ranking scores: first place is five points, last place is one.
function scoreFromPosition(index) { return 5 - index; }

function computeItemStats(results) {
  const stats = {};
  for (const session of results) {
    for (const item of session.items) {
      if (!stats[item.id]) {
        stats[item.id] = {
          id: item.id, text: item.text, reviews: item.reviews || 0,
          name: item.name, storeUrl: item.storeUrl,
          isExperimental: isCandidateDescription(item), scores: [], positions: [],
        };
      }
    }
    for (let i = 0; i < session.rank.length; i++) {
      const id = session.rank[i];
      if (stats[id]) {
        stats[id].scores.push(scoreFromPosition(i));
        stats[id].positions.push(i + 1);
      }
    }
  }
  return Object.values(stats);
}

function itemSummary(stat) {
  const n = stat.scores.length;
  if (n === 0) return null;
  const totalScore = stat.scores.reduce((a, b) => a + b, 0);
  const avgScore = totalScore / n;
  const avgPos = stat.positions.reduce((a, b) => a + b, 0) / n;
  const variance = stat.positions.reduce((a, b) => a + (b - avgPos) ** 2, 0) / n;
  const dist = [0, 0, 0, 0, 0];
  for (const p of stat.positions) dist[p - 1]++;
  return {
    id: stat.id, text: stat.text, reviews: stat.reviews || 0,
    name: stat.name, storeUrl: stat.storeUrl, isExperimental: stat.isExperimental,
    n, totalScore, avgScore: Math.round(avgScore * 10) / 10,
    avgPos: Math.round(avgPos * 10) / 10, variance: Math.round(variance * 10) / 10, dist,
  };
}

function hashStr(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) { hash = ((hash << 5) - hash) + text.charCodeAt(i); hash |= 0; }
  return "exp_" + Math.abs(hash).toString(36);
}

function shuffleArray(descriptions) {
  for (let i = descriptions.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [descriptions[i], descriptions[randomIndex]] = [descriptions[randomIndex], descriptions[i]];
  }
  return descriptions;
}

function createId(prefix) { return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8); }
function formatTimestamp(timestamp) { return new Date(timestamp).toLocaleString(); }
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function validateCatalogue(catalogue) {
  const fail = detail => { throw new Error("The game catalogue is invalid: " + detail + "."); };
  if (!catalogue || catalogue.schemaVersion !== 1) fail("unsupported format");
  if (typeof catalogue.catalogueId !== "string" || !catalogue.catalogueId.trim()) fail("missing catalogue identity");
  if (typeof catalogue.collectedAt !== "string" || !Number.isFinite(Date.parse(catalogue.collectedAt))) fail("missing collection date");
  if (catalogue.minimumReviewCount !== 50 || catalogue.reviewCountScope !== REVIEW_COUNT_SCOPE) fail("unexpected review count definition");
  if (!Array.isArray(catalogue.games) || !catalogue.games.length) fail("no games");
  if (!Array.isArray(catalogue.genres) || !catalogue.genres.length) fail("no genres");
  const gamesById = new Map();
  for (const game of catalogue.games) {
    if (!game || !Number.isSafeInteger(game.appid) || game.appid <= 0 ||
        game.id !== "steam_" + game.appid || gamesById.has(game.id)) fail("invalid or duplicate Steam game identity");
    if (typeof game.name !== "string" || !game.name.trim() || typeof game.text !== "string" || !game.text.trim()) fail("missing game name or description");
    if (!Number.isSafeInteger(game.reviews) || game.reviews < catalogue.minimumReviewCount) fail("a game does not meet the library review minimum");
    if (game.storeUrl !== "https://store.steampowered.com/app/" + game.appid + "/") fail("invalid Steam store link");
    if (!Array.isArray(game.steamTagIds) || !game.steamTagIds.length ||
        game.steamTagIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(game.steamTagIds).size !== game.steamTagIds.length) fail("invalid game tags");
    gamesById.set(game.id, game);
  }
  const genreIds = new Set();
  for (const genre of catalogue.genres) {
    if (!genre || !Number.isSafeInteger(genre.id) || genre.id <= 0 || genreIds.has(genre.id) ||
        typeof genre.name !== "string" || !genre.name.trim() ||
        !Number.isSafeInteger(genre.steamTagId) || genre.steamTagId <= 0) fail("invalid or duplicate genre");
    if (!Array.isArray(genre.gameIds) || !genre.gameIds.length || new Set(genre.gameIds).size !== genre.gameIds.length) fail("invalid genre game list");
    for (const gameId of genre.gameIds) {
      const game = gamesById.get(gameId);
      if (!game || !game.steamTagIds.includes(genre.steamTagId)) fail("genre membership does not match game tags");
    }
    genreIds.add(genre.id);
  }
  return catalogue;
}

async function fetchCatalogue() {
  if (!catalogueRequest) {
    catalogueRequest = (async () => {
      const response = await fetch("catalogue.json");
      if (!response.ok) throw new Error("The game catalogue could not be loaded (HTTP " + response.status + "). Refresh to try again.");
      return validateCatalogue(await response.json());
    })();
  }
  return catalogueRequest;
}

function getEligibleGames(catalogue, tagId, minimumReviewCount, additionallyExcludedGameIds = []) {
  validateMinimumReviewCount(minimumReviewCount);
  const genre = catalogue.genres.find(genre => String(genre.id) === String(tagId));
  if (!genre) throw new Error("The selected genre is not in this catalogue. Choose a genre in Settings.");
  const excludedGameIds = new Set([...getExcludedGameIds(), ...additionallyExcludedGameIds]);
  const genreGameIds = new Set(genre.gameIds);
  return catalogue.games.filter(game => genreGameIds.has(game.id) &&
    game.reviews >= minimumReviewCount && !excludedGameIds.has(game.id));
}

async function fetchTags() {
  const catalogue = await fetchCatalogue();
  return catalogue.genres.map(genre => ({
    id: genre.id, name: genre.name, availableCount: getEligibleGames(catalogue, genre.id, 0).length,
    catalogueCount: genre.gameIds.length,
  }));
}

async function fetchGames(tagId, minimumReviewCount, additionallyExcludedGameIds = [], sampleSize = 4) {
  validateMinimumReviewCount(minimumReviewCount);
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 4) throw new Error("A sample must request between one and four Steam games.");
  const catalogue = await fetchCatalogue();
  const eligibleGames = getEligibleGames(catalogue, tagId, minimumReviewCount, additionallyExcludedGameIds);
  if (eligibleGames.length < sampleSize) {
    throw new Error("Too few eligible games remain for a complete sample of four. Lower the review minimum, choose another genre, or restore excluded games in Settings.");
  }
  return shuffleArray(eligibleGames).slice(0, sampleSize).map(game => ({ ...game, steamTagIds: [...game.steamTagIds] }));
}

function batchMatchesCatalogueSettings(batch, settings, catalogue) {
  if (!batchMatchesSamplingSettings(batch, settings) || batch.catalogueId !== catalogue.catalogueId ||
      typeof batch.id !== "string" || !batch.id || !Array.isArray(batch.items) || batch.items.length !== 5 ||
      batch.items.some(item => !item || typeof item.id !== "string" || typeof item.text !== "string") ||
      new Set(batch.items.map(item => item.id)).size !== 5) return false;
  const candidateDescriptions = batch.items.filter(isCandidateDescription);
  if (candidateDescriptions.length !== 1 || candidateDescriptions[0].id !== hashStr(candidateDescriptions[0].text)) return false;
  const eligibleGamesById = new Map(getEligibleGames(catalogue, settings.tag, settings.minimumReviewCount).map(game => [game.id, game]));
  return batch.items.filter(item => !isCandidateDescription(item)).every(item => {
    const game = eligibleGamesById.get(item.id);
    return game && item.text === game.text && item.reviews === game.reviews &&
      item.name === game.name && item.storeUrl === game.storeUrl;
  });
}

function catalogueSummary(catalogue) {
  return catalogue.games.length.toLocaleString() + " games across " + catalogue.genres.length +
    " genres. Collected " + new Date(catalogue.collectedAt).toLocaleDateString() +
    ". Every game had at least " + catalogue.minimumReviewCount.toLocaleString() + " qualifying reviews.";
}

function steamSourceMarkup(game) {
  if (typeof game.id !== "string" || !/^steam_[1-9][0-9]*$/.test(game.id)) return "";
  const steamUrl = "https://store.steampowered.com/app/" + game.id.slice(6) + "/";
  return '<a href="' + steamUrl + '" target="_blank" rel="noopener noreferrer">' +
    escapeHtml(game.name || "View on Steam") + '</a>';
}
