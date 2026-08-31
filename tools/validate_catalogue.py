"""Validate the public Steam description catalogue without network access.

Only the Python standard library is required. The validator rejects incomplete
catalogues instead of quietly reducing the review or genre-size requirements.
"""
import argparse
from datetime import datetime
import html
import json
from pathlib import Path
import re
import sys


class CatalogueValidationError(ValueError):
    """A public catalogue violates its declared sampling requirements."""


MAX_SAFE_INTEGER = 9007199254740991
HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*|\s*/?)>|<!--|<!DOCTYPE", re.IGNORECASE)
CONTROL_CHARACTER = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CATALOGUE_FIELDS = {
    "schemaVersion", "catalogueId", "collectedAt", "minimumReviewCount",
    "reviewCountScope", "genres", "games", "collection",
}
GAME_FIELDS = {"id", "appid", "name", "text", "reviews", "steamTagIds", "storeUrl"}
GENRE_FIELDS = {"id", "name", "steamTagId", "gameIds"}
COLLECTION_FIELDS = {
    "targetPerGenre", "selectionMethod", "sourceCountry", "sourceLanguage",
    "reviewSource", "requestCount", "searchCandidatesByGenre", "rejectedGamesByReason",
}


def _require(condition, message):
    if not condition:
        raise CatalogueValidationError(message)


def _whole_number(value, label, minimum=0):
    _require(type(value) is int and minimum <= value <= MAX_SAFE_INTEGER,
             f"{label} must be a whole number from {minimum} to {MAX_SAFE_INTEGER}.")
    return value


def _public_text(value, label, maximum_length=10000):
    _require(isinstance(value, str) and bool(value.strip()), f"{label} must be non-empty text.")
    _require(len(value) <= maximum_length, f"{label} is unexpectedly long.")
    _require(not CONTROL_CHARACTER.search(value), f"{label} contains control characters.")
    _require(not HTML_TAG.search(html.unescape(value)), f"{label} must be plain text, without HTML.")
    return value


def _fields(record, allowed_fields, required_fields, label):
    _require(isinstance(record, dict), f"{label} must be an object.")
    unknown_fields = set(record) - allowed_fields
    _require(not unknown_fields, f"{label} contains non-public or unknown fields: {sorted(unknown_fields)}.")
    missing_fields = required_fields - set(record)
    _require(not missing_fields, f"{label} is missing required fields: {sorted(missing_fields)}.")


def _validate_collection(collection, genre_ids):
    _fields(collection, COLLECTION_FIELDS, set(), "collection")
    for field in ("targetPerGenre", "requestCount"):
        if field in collection:
            _whole_number(collection[field], f"collection.{field}", minimum=1 if field == "targetPerGenre" else 0)
    for field in ("selectionMethod", "reviewSource"):
        if field in collection:
            _public_text(collection[field], f"collection.{field}", maximum_length=2000)
    if "sourceCountry" in collection:
        _require(isinstance(collection["sourceCountry"], str)
                 and re.fullmatch(r"[A-Z]{2}", collection["sourceCountry"]),
                 "collection.sourceCountry must be a two-letter uppercase country code.")
    if "sourceLanguage" in collection:
        _require(isinstance(collection["sourceLanguage"], str)
                 and re.fullmatch(r"[a-z][a-z_-]{1,39}", collection["sourceLanguage"]),
                 "collection.sourceLanguage must be a language name or code.")
    for field in ("searchCandidatesByGenre", "rejectedGamesByReason"):
        if field not in collection:
            continue
        counts = collection[field]
        _require(isinstance(counts, dict), f"collection.{field} must be an object of counts.")
        for count_key, count in counts.items():
            if field == "searchCandidatesByGenre":
                _require(count_key in {str(genre_id) for genre_id in genre_ids},
                         f"collection.{field} references an unknown genre: {count_key!r}.")
            else:
                _require(isinstance(count_key, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", count_key),
                         f"collection.{field} has an invalid reason name.")
            _whole_number(count, f"collection.{field}.{count_key}")


def validate_catalogue(catalogue, *, minimum_per_genre=600, minimum_unique_games=2000,
                       expected_genres=None):
    """Return a count report, or raise CatalogueValidationError.

    An optional genre manifest is a list of {id, name} objects such as tags.json.
    Without one, the public catalogue must contain 15 distinct genres.
    """
    _whole_number(minimum_per_genre, "minimum_per_genre", minimum=1)
    _whole_number(minimum_unique_games, "minimum_unique_games", minimum=1)
    _fields(catalogue, CATALOGUE_FIELDS, CATALOGUE_FIELDS - {"collection"}, "catalogue")
    _require(type(catalogue["schemaVersion"]) is int and catalogue["schemaVersion"] == 1,
             "Unsupported catalogue schemaVersion; expected 1.")
    catalogue_id = catalogue["catalogueId"]
    _require(isinstance(catalogue_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", catalogue_id),
             "catalogueId must be a short public identifier.")
    collected_at = catalogue["collectedAt"]
    _require(isinstance(collected_at, str), "collectedAt must be an ISO timestamp with a timezone.")
    try:
        timestamp = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise CatalogueValidationError("collectedAt must be an ISO timestamp with a timezone.") from error
    _require(timestamp.tzinfo is not None and "T" in collected_at,
             "collectedAt must be an ISO timestamp with a timezone.")
    review_floor = _whole_number(catalogue["minimumReviewCount"], "minimumReviewCount", minimum=50)
    _public_text(catalogue["reviewCountScope"], "reviewCountScope", maximum_length=1000)
    _require(isinstance(catalogue["games"], list), "games must be a list.")
    _require(isinstance(catalogue["genres"], list), "genres must be a list.")

    games_by_id = {}
    for position, game in enumerate(catalogue["games"]):
        label = f"games[{position}]"
        _fields(game, GAME_FIELDS, GAME_FIELDS, label)
        appid = _whole_number(game["appid"], f"{label}.appid", minimum=1)
        expected_game_id = f"steam_{appid}"
        _require(game["id"] == expected_game_id, f"{label}.id must match its appid: {expected_game_id}.")
        _require(expected_game_id not in games_by_id, f"Duplicate game id: {expected_game_id}.")
        _public_text(game["name"], f"{expected_game_id}.name", maximum_length=500)
        _public_text(game["text"], f"{expected_game_id}.text")
        _whole_number(game["reviews"], f"{expected_game_id}.reviews", minimum=review_floor)
        _require(game["storeUrl"] == f"https://store.steampowered.com/app/{appid}/",
                 f"{expected_game_id}.storeUrl must be the canonical Steam URL for its appid.")
        steam_tag_ids = game["steamTagIds"]
        _require(isinstance(steam_tag_ids, list) and bool(steam_tag_ids),
                 f"{expected_game_id}.steamTagIds must be a non-empty list.")
        for tag_id in steam_tag_ids:
            _whole_number(tag_id, f"{expected_game_id}.steamTagIds entry", minimum=1)
        _require(len(steam_tag_ids) == len(set(steam_tag_ids)),
                 f"{expected_game_id}.steamTagIds contains duplicate tag ids.")
        games_by_id[expected_game_id] = game

    genre_ids = set()
    genre_names = set()
    genre_tag_ids = set()
    referenced_game_ids = set()
    genre_counts = []
    for position, genre in enumerate(catalogue["genres"]):
        label = f"genres[{position}]"
        _fields(genre, GENRE_FIELDS, GENRE_FIELDS, label)
        genre_id = _whole_number(genre["id"], f"{label}.id", minimum=1)
        genre_name = _public_text(genre["name"], f"{label}.name", maximum_length=100)
        steam_tag_id = _whole_number(genre["steamTagId"], f"{label}.steamTagId", minimum=1)
        _require(genre_id not in genre_ids, f"Duplicate genre id: {genre_id}.")
        _require(genre_name.casefold() not in genre_names, f"Duplicate genre name: {genre_name}.")
        _require(steam_tag_id not in genre_tag_ids, f"Duplicate genre Steam tag id: {steam_tag_id}.")
        genre_ids.add(genre_id)
        genre_names.add(genre_name.casefold())
        genre_tag_ids.add(steam_tag_id)
        game_ids = genre["gameIds"]
        _require(isinstance(game_ids, list), f"{genre_name}.gameIds must be a list.")
        members = set()
        for game_id in game_ids:
            _require(isinstance(game_id, str) and game_id in games_by_id,
                     f"{genre_name} references an unknown game: {game_id!r}.")
            _require(game_id not in members, f"{genre_name} contains a duplicate game: {game_id}.")
            _require(steam_tag_id in games_by_id[game_id]["steamTagIds"],
                     f"{game_id} does not have {genre_name}'s Steam tag {steam_tag_id}.")
            members.add(game_id)
        _require(len(members) >= minimum_per_genre,
                 f"{genre_name} contains {len(members)} games; at least {minimum_per_genre} required.")
        referenced_game_ids.update(members)
        genre_counts.append({"id": genre_id, "name": genre_name, "count": len(members)})

    if expected_genres is None:
        _require(len(genre_counts) == 15, f"Expected 15 genres; found {len(genre_counts)}.")
    else:
        _require(isinstance(expected_genres, list) and bool(expected_genres),
                 "The expected genre manifest must be a non-empty list.")
        expected_genre_names = {}
        for genre in expected_genres:
            _require(isinstance(genre, dict) and "id" in genre and "name" in genre,
                     "The expected genre manifest must contain id/name objects.")
            genre_id = _whole_number(genre["id"], "Expected genre id", minimum=1)
            genre_name = _public_text(genre["name"], "Expected genre name", maximum_length=100)
            _require(genre_id not in expected_genre_names, f"Expected genre manifest repeats id {genre_id}.")
            expected_genre_names[genre_id] = genre_name
        _require({genre["id"]: genre["name"] for genre in catalogue["genres"]} == expected_genre_names,
                 "Catalogue genres do not match the expected genre manifest.")

    unreferenced_game_ids = set(games_by_id) - referenced_game_ids
    _require(not unreferenced_game_ids,
             f"Catalogue contains {len(unreferenced_game_ids)} games outside every supported genre.")
    _require(len(games_by_id) >= minimum_unique_games,
             f"Catalogue contains {len(games_by_id)} distinct games; at least {minimum_unique_games} required.")
    if "collection" in catalogue:
        _validate_collection(catalogue["collection"], genre_ids)
    return {
        "catalogueId": catalogue_id,
        "minimumReviewCount": review_floor,
        "uniqueGameCount": len(games_by_id),
        "genres": genre_counts,
    }


def _unique_json_keys(pairs):
    record = {}
    for key, value in pairs:
        _require(key not in record, f"JSON contains a repeated object key: {key!r}.")
        record[key] = value
    return record


def read_json(path):
    with Path(path).open(encoding="utf-8-sig") as catalogue_file:
        return json.load(catalogue_file, object_pairs_hook=_unique_json_keys)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalogue", nargs="?", default="static/catalogue.json")
    parser.add_argument("--minimum-per-genre", type=int, default=600)
    parser.add_argument("--minimum-unique-games", type=int, default=2000)
    parser.add_argument("--genres", help="Optional JSON genre manifest containing id/name objects.")
    arguments = parser.parse_args(argv)
    try:
        report = validate_catalogue(
            read_json(arguments.catalogue),
            minimum_per_genre=arguments.minimum_per_genre,
            minimum_unique_games=arguments.minimum_unique_games,
            expected_genres=read_json(arguments.genres) if arguments.genres else None,
        )
    except (CatalogueValidationError, OSError, json.JSONDecodeError) as error:
        print(f"Catalogue validation failed: {error}", file=sys.stderr)
        return 1
    print(f"Catalogue: {report['catalogueId']}")
    print(f"Distinct games: {report['uniqueGameCount']}")
    print(f"Minimum reviews: {report['minimumReviewCount']}")
    for genre in report["genres"]:
        print(f"  {genre['name']}: {genre['count']}")
    print("Catalogue validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
