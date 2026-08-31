// The current comparison and excluded games stay in this browser.
const SETTINGS_STORAGE_KEY = "steamDescriptionComparer:settings";
const COMPARISON_SAMPLE_STORAGE_KEY = "steamDescriptionComparer:comparisonSample";
const EXCLUDED_GAMES_STORAGE_KEY = "steamDescriptionComparer:excludedSteamGameIds";
const YOUR_DESCRIPTION_ID = "your-description";
const REVIEW_COUNT_SCOPE = "Steam purchases, all languages, positive and negative, excluding off-topic activity";
let catalogueRequest = null;

function validateMinimumReviewCount(minimumReviewCount) {
  if (!Number.isSafeInteger(minimumReviewCount) || minimumReviewCount < 0) {
    throw new Error("Minimum Steam reviews must be a whole number of 0 or more.");
  }
}

function validateComparisonSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      typeof settings.description !== "string" || !settings.description.trim() ||
      !["string", "number"].includes(typeof settings.tag) ||
      !/^[1-9][0-9]*$/.test(String(settings.tag)) || !Number.isSafeInteger(Number(settings.tag))) {
    throw new Error("The saved description or genre is invalid. Check your settings.");
  }
  validateMinimumReviewCount(settings.minimumReviewCount);
}

function getSettings() {
  const serializedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (serializedSettings === null) return null;
  let settings;
  try { settings = JSON.parse(serializedSettings); }
  catch { throw new Error("Saved settings could not be read. They have not been changed."); }
  validateComparisonSettings(settings);
  return settings;
}

function setSettings(settings) {
  validateComparisonSettings(settings);
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function isComparisonSampleStructureValid(sample) {
  return Boolean(sample && typeof sample === "object" && !Array.isArray(sample) &&
    Object.keys(sample).every(key => ["catalogueId", "genreId", "minimumReviewCount", "descriptionIds"].includes(key)) &&
    typeof sample.catalogueId === "string" && sample.catalogueId.trim() &&
    typeof sample.genreId === "string" && /^[1-9][0-9]*$/.test(sample.genreId) &&
    Number.isSafeInteger(Number(sample.genreId)) &&
    Number.isSafeInteger(sample.minimumReviewCount) && sample.minimumReviewCount >= 0 &&
    Array.isArray(sample.descriptionIds) && sample.descriptionIds.length === 5 &&
    new Set(sample.descriptionIds).size === 5 &&
    sample.descriptionIds.filter(id => id === YOUR_DESCRIPTION_ID).length === 1 &&
    sample.descriptionIds.every(id => typeof id === "string" &&
      (id === YOUR_DESCRIPTION_ID || /^steam_[1-9][0-9]*$/.test(id))));
}

function validateComparisonSampleStructure(sample) {
  if (!isComparisonSampleStructureValid(sample)) {
    throw new Error("The saved comparison sample is invalid. Choose New sample to replace it.");
  }
}

function getComparisonSample() {
  const serializedSample = localStorage.getItem(COMPARISON_SAMPLE_STORAGE_KEY);
  if (serializedSample === null) return null;
  let sample;
  try { sample = JSON.parse(serializedSample); }
  catch { throw new Error("The saved comparison sample could not be read. Choose New sample to replace it."); }
  validateComparisonSampleStructure(sample);
  return sample;
}

function saveComparisonSample(sample) {
  validateComparisonSampleStructure(sample);
  localStorage.setItem(COMPARISON_SAMPLE_STORAGE_KEY, JSON.stringify(sample));
}

function clearComparisonSample() { localStorage.removeItem(COMPARISON_SAMPLE_STORAGE_KEY); }

function comparisonSampleMatchesSettings(sample, settings, catalogue) {
  if (!isComparisonSampleStructureValid(sample) || !settings || !catalogue ||
      sample.catalogueId !== catalogue.catalogueId || sample.genreId !== String(settings.tag) ||
      sample.minimumReviewCount !== settings.minimumReviewCount ||
      !catalogue.genres.some(genre => String(genre.id) === sample.genreId)) return false;
  const eligibleIds = new Set(getEligibleGames(catalogue, settings.tag, settings.minimumReviewCount).map(game => game.id));
  return sample.descriptionIds.every(id => id === YOUR_DESCRIPTION_ID || eligibleIds.has(id));
}

function comparisonGames(catalogue, sample) {
  validateComparisonSampleStructure(sample);
  if (sample.catalogueId !== catalogue.catalogueId) throw new Error("The comparison sample belongs to another catalogue.");
  const genre = catalogue.genres.find(genre => String(genre.id) === sample.genreId);
  if (!genre) throw new Error("The saved comparison genre is missing from the catalogue. Choose New sample to replace it.");
  const genreGameIds = new Set(genre.gameIds);
  const gamesById = new Map(catalogue.games.map(game => [game.id, game]));
  return sample.descriptionIds.filter(id => id !== YOUR_DESCRIPTION_ID).map(id => {
    const game = gamesById.get(id);
    if (!game) throw new Error("The comparison sample contains a game missing from the catalogue. Choose New sample to replace it.");
    if (!genreGameIds.has(id) || game.reviews < sample.minimumReviewCount) {
      throw new Error("The comparison sample does not match its saved genre or review minimum. Choose New sample to replace it.");
    }
    return game;
  });
}

function comparisonDescriptions(catalogue, sample, settings) {
  validateComparisonSettings(settings);
  const gamesById = new Map(comparisonGames(catalogue, sample).map(game => [game.id, game]));
  return sample.descriptionIds.map(id => id === YOUR_DESCRIPTION_ID ?
    {id: YOUR_DESCRIPTION_ID, text: settings.description} : gamesById.get(id));
}

function createComparisonSample(catalogue, settings) {
  validateComparisonSettings(settings);
  const games = chooseSteamGames(catalogue, settings.tag, settings.minimumReviewCount);
  return {catalogueId: catalogue.catalogueId, genreId: String(settings.tag),
    minimumReviewCount: settings.minimumReviewCount,
    descriptionIds: [YOUR_DESCRIPTION_ID, ...games.map(game => game.id)]};
}

function shuffleSteamGames(games) {
  for (let index = games.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [games[index], games[randomIndex]] = [games[randomIndex], games[index]];
  }
  return games;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function getExcludedGameIds() {
  const storedExclusions = localStorage.getItem(EXCLUDED_GAMES_STORAGE_KEY);
  if (storedExclusions === null) return [];
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

function getEligibleGames(catalogue, genreId, minimumReviewCount, additionallyExcludedGameIds = []) {
  validateMinimumReviewCount(minimumReviewCount);
  const genre = catalogue.genres.find(genre => String(genre.id) === String(genreId));
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

function chooseSteamGames(catalogue, genreId, minimumReviewCount, additionallyExcludedGameIds = [], sampleSize = 4) {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 4) {
    throw new Error("A sample must request between one and four Steam games.");
  }
  const eligibleGames = getEligibleGames(catalogue, genreId, minimumReviewCount, additionallyExcludedGameIds);
  if (eligibleGames.length < sampleSize) {
    throw new Error("Too few eligible games remain for a complete comparison. Lower the review minimum, choose another genre, or restore excluded games in Settings.");
  }
  return shuffleSteamGames(eligibleGames).slice(0, sampleSize).map(game => ({...game, steamTagIds: [...game.steamTagIds]}));
}

function steamSourceMarkup(game) {
  if (!game || typeof game.id !== "string" || !/^steam_[1-9][0-9]*$/.test(game.id) ||
      typeof game.name !== "string" || !game.name.trim()) throw new Error("The Steam game source is invalid.");
  const steamUrl = "https://store.steampowered.com/app/" + game.id.slice(6) + "/";
  return '<a href="' + steamUrl + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(game.name) + '</a>';
}

function catalogueSummary(catalogue) {
  return catalogue.games.length.toLocaleString() + " games across " + catalogue.genres.length +
    " genres. Collected " + new Date(catalogue.collectedAt).toLocaleDateString() +
    ". Every game had at least " + catalogue.minimumReviewCount.toLocaleString() + " qualifying reviews.";
}
