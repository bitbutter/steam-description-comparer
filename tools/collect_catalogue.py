"""Collect a fixed Steam description catalogue; never run by the public website."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import random
from time import monotonic, sleep

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STEAM_SEARCH = "https://store.steampowered.com/search/results/"
STEAM_ITEMS = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/"
STEAM_TAGS = "https://store.steampowered.com/tagdata/populartags/english/"
REVIEW_COUNT_SCOPE = "Steam purchases, all languages, positive and negative, excluding off-topic activity"
ADULT_ONLY_SEXUAL_CONTENT_DESCRIPTOR_ID = 3
HENTAI_STEAM_TAG_ID = 9130
DEMO_PATTERN = re.compile(r"\bdemo\b", re.IGNORECASE)


class DescriptionText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fragments = []

    def handle_data(self, text):
        self.fragments.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div"}:
            self.fragments.append(" ")

    def handle_endtag(self, tag):
        if tag in {"p", "div"}:
            self.fragments.append(" ")


def anonymize_description(name, description):
    description_text = DescriptionText()
    description_text.feed(unescape(description))
    text = re.sub(r"\s+", " ", "".join(description_text.fragments)).strip()
    short_name = re.split(r"\s*[:|\u2014\u2013]\s*|\s+-\s+", name, maxsplit=1)[0].strip()
    title_aliases = sorted({name.strip(), short_name}, key=len, reverse=True)
    for title_alias in title_aliases:
        title_words = re.findall(r"\w+", title_alias, flags=re.UNICODE)
        if title_words:
            title_pattern = r"(?<!\w)" + r"[\W_]*".join(re.escape(word) for word in title_words) + r"(?!\w)"
            text = re.sub(title_pattern, "\u2014\u2014\u2014", text, flags=re.IGNORECASE)
    return text


def qualifying_catalogue_game(steam_item, minimum_review_count):
    if steam_item.get("success") != 1 or steam_item.get("visible") is not True:
        return None, "unavailable"
    if steam_item.get("item_type") != 0 or steam_item.get("type") != 0:
        return None, "not_a_game"
    appid = steam_item.get("appid")
    if type(appid) is not int or appid <= 0:
        raise ValueError("Steam returned a game without a valid app id")
    name = steam_item.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"Steam returned no title for app {appid}")
    if DEMO_PATTERN.search(name):
        return None, "demo"
    if (ADULT_ONLY_SEXUAL_CONTENT_DESCRIPTOR_ID in steam_item.get("content_descriptorids", [])
            or HENTAI_STEAM_TAG_ID in steam_item.get("tagids", [])):
        return None, "adult_sexual_content"
    review_summaries = steam_item.get("reviews")
    # An unreported count is excluded, never converted into a made-up zero.
    if not isinstance(review_summaries, dict) or "summary_filtered" not in review_summaries:
        return None, "no_reported_review_summary"
    summary = review_summaries["summary_filtered"]
    if not isinstance(summary, dict):
        raise ValueError(f"Steam returned malformed reviews for app {appid}")
    review_count = summary.get("review_count")
    if review_count is None:
        return None, "no_reported_review_count"
    if type(review_count) is not int or review_count < 0:
        raise ValueError(f"Steam returned an invalid review count for app {appid}")
    if review_count < minimum_review_count:
        return None, "under_minimum_reviews"
    basic_info = steam_item.get("basic_info")
    if not isinstance(basic_info, dict):
        return None, "no_description"
    description = basic_info.get("short_description")
    if not isinstance(description, str) or not description.strip():
        return None, "no_description"
    text = anonymize_description(name, description)
    if not text:
        return None, "empty_description"
    steam_tag_ids = steam_item.get("tagids")
    if not isinstance(steam_tag_ids, list) or any(type(tagid) is not int for tagid in steam_tag_ids):
        raise ValueError(f"Steam returned invalid genre tags for app {appid}")
    return {
        "id": f"steam_{appid}", "appid": appid, "name": name, "text": text,
        "reviews": review_count, "steamTagIds": sorted(set(steam_tag_ids)),
        "storeUrl": f"https://store.steampowered.com/app/{appid}/",
    }, None


class SteamCatalogueCollection:
    def __init__(self, progress_directory, request_interval_seconds=3.0):
        self.progress_directory = progress_directory
        progress_directory.mkdir(parents=True, exist_ok=True)
        self.request_interval_seconds = request_interval_seconds
        self.previous_request_at = 0
        self.request_count = 0
        self.steam_session = requests.Session()
        self.steam_session.headers.update({"User-Agent": "SteamDescriptionComparer/1.0 (one-time public catalogue)",
                                          "Accept-Language": "en-US,en;q=0.9"})
        self.steam_items = {}
        self.search_pages = {}
        for record in self.read_records("steam-items.jsonl"):
            self.steam_items[record["id"]] = record
        for record in self.read_records("search-pages.jsonl"):
            self.search_pages[(record["steamTagId"], record["start"])] = record

    def read_records(self, filename):
        path = self.progress_directory / filename
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def append_records(self, filename, records):
        with (self.progress_directory / filename).open("a", encoding="utf-8") as output:
            for record in records:
                output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def request_json(self, url, params=None):
        remaining_interval = self.request_interval_seconds - (monotonic() - self.previous_request_at)
        if remaining_interval > 0:
            sleep(remaining_interval)
        self.previous_request_at = monotonic()
        response = self.steam_session.get(url, params=params, timeout=30)
        self.request_count += 1
        response.raise_for_status()
        return response.json()

    def resolve_genres(self, genre_targets):
        tag_path = self.progress_directory / "steam-tags.json"
        if tag_path.exists():
            tags = json.loads(tag_path.read_text(encoding="utf-8"))
        else:
            tags = self.request_json(STEAM_TAGS)
            if not isinstance(tags, list):
                raise ValueError("Steam tag response is not a list")
            tag_path.write_text(json.dumps(tags, ensure_ascii=False), encoding="utf-8")
        tags_by_name = {tag["name"]: tag["tagid"] for tag in tags}
        return [{"id": genre["id"], "name": genre["name"],
                 "steamTagId": tags_by_name[genre["name"]], "gameIds": []} for genre in genre_targets]

    def search_appids(self, steam_tag_id, start):
        key = (steam_tag_id, start)
        if key in self.search_pages:
            return self.search_pages[key]
        page = self.request_json(STEAM_SEARCH, {
            "tags": steam_tag_id, "category1": 998, "count": 100, "start": start,
            "infinite": 1, "l": "english", "cc": "us", "supportedlang": "english",
            "ignore_preferences": 1,
        })
        if not isinstance(page, dict) or page.get("success") != 1 or not isinstance(page.get("results_html"), str):
            raise ValueError(f"Invalid Steam search page for tag {steam_tag_id} at {start}")
        appids = list(dict.fromkeys(int(appid) for appid in re.findall(r'data-ds-appid="(\d+)"', page["results_html"])))
        total_count = page.get("total_count")
        if type(total_count) is not int or total_count < 0:
            raise ValueError(f"Missing Steam search total for tag {steam_tag_id}")
        if not appids and start < total_count:
            raise ValueError(f"Steam search returned an empty page before its end for tag {steam_tag_id} at {start}")
        record = {"steamTagId": steam_tag_id, "start": start, "totalCount": total_count, "appids": appids}
        self.search_pages[key] = record
        self.append_records("search-pages.jsonl", [record])
        return record

    def fetch_app_details(self, appids):
        unknown_appids = [appid for appid in appids if appid not in self.steam_items]
        for offset in range(0, len(unknown_appids), 100):
            requested_appids = unknown_appids[offset:offset + 100]
            query = {
                "ids": [{"appid": appid} for appid in requested_appids],
                "context": {"language": "english", "country_code": "US"},
                "data_request": {"include_basic_info": True, "include_reviews": True, "include_tag_count": 100},
            }
            reply = self.request_json(STEAM_ITEMS, {"input_json": json.dumps(query, separators=(",", ":"))})
            store_items = reply.get("response", {}).get("store_items")
            if not isinstance(store_items, list):
                raise ValueError("Steam batch response is missing its store items")
            returned_appids = [item.get("id") for item in store_items]
            if len(returned_appids) != len(set(returned_appids)) or set(returned_appids) != set(requested_appids):
                raise ValueError("Steam batch response does not match the requested app ids")
            self.append_records("steam-items.jsonl", store_items)
            self.steam_items.update({item["id"]: item for item in store_items})
        return [self.steam_items[appid] for appid in appids]


def collect_catalogue(genre_targets, target_per_genre, minimum_review_count, progress_directory):
    collection = SteamCatalogueCollection(progress_directory)
    genres = collection.resolve_genres(genre_targets)
    evaluated_games = {}
    eligible_ids_by_genre = {genre["id"]: [] for genre in genres}
    rejected_games = Counter()

    def include_collected_game(steam_item):
        appid = steam_item["id"]
        if appid in evaluated_games:
            return
        game, rejection_reason = qualifying_catalogue_game(steam_item, minimum_review_count)
        evaluated_games[appid] = game
        if rejection_reason:
            rejected_games[rejection_reason] += 1
        if game is not None:
            for matching_genre in genres:
                if matching_genre["steamTagId"] in game["steamTagIds"]:
                    eligible_ids_by_genre[matching_genre["id"]].append(appid)

    # A game's verified tags count towards every matching genre from the outset.
    for steam_item in collection.steam_items.values():
        include_collected_game(steam_item)

    for genre in genres:
        search_start = 0
        while len(eligible_ids_by_genre[genre["id"]]) < target_per_genre:
            page = collection.search_appids(genre["steamTagId"], search_start)
            for steam_item in collection.fetch_app_details(page["appids"]):
                include_collected_game(steam_item)
            eligible_count = len(eligible_ids_by_genre[genre["id"]])
            print(f'{genre["name"]}: {eligible_count}/{target_per_genre} qualifying games with verified tags; '
                  f'{sum(game is not None for game in evaluated_games.values())} distinct collected', flush=True)
            search_start += 100
            if search_start >= page["totalCount"]:
                break
        print(f'{genre["name"]}: {len(eligible_ids_by_genre[genre["id"]])} eligible in collected pool', flush=True)

    catalogue_games = {}
    for genre in genres:
        eligible_appids = sorted(eligible_ids_by_genre[genre["id"]])
        genre_random = random.Random(f'steam-comparer:{genre["id"]}:{target_per_genre}')
        selected_appids = genre_random.sample(eligible_appids, min(target_per_genre, len(eligible_appids)))
        genre["gameIds"] = [f"steam_{appid}" for appid in selected_appids]
        catalogue_games.update({f"steam_{appid}": evaluated_games[appid] for appid in selected_appids})
    searched_candidates = {
        str(genre["id"]): len({appid for page in collection.search_pages.values()
                               if page["steamTagId"] == genre["steamTagId"] for appid in page["appids"]})
        for genre in genres
    }
    games = sorted(catalogue_games.values(), key=lambda game: game["appid"])
    contents_hash = hashlib.sha256(json.dumps({"genres": genres, "games": games}, sort_keys=True,
                                              ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
    return {
        "schemaVersion": 1, "catalogueId": f"steam-catalogue-{contents_hash}",
        "collectedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "minimumReviewCount": minimum_review_count, "reviewCountScope": REVIEW_COUNT_SCOPE,
        "genres": genres, "games": games,
        "collection": {
            "targetPerGenre": target_per_genre,
            "selectionMethod": f"Candidates from Steam tag search relevance order, assigned to all verified genres; fixed-seed random selection of up to {target_per_genre} per genre. Browser samples randomly within each final genre pool.",
            "sourceCountry": "US", "sourceLanguage": "english",
            "reviewSource": "IStoreBrowseService/GetItems summary_filtered.review_count",
            "requestCount": collection.request_count,
            "searchCandidatesByGenre": searched_candidates,
            "rejectedGamesByReason": dict(rejected_games),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-per-genre", type=int, default=600)
    parser.add_argument("--minimum-reviews", type=int, default=50)
    parser.add_argument("--genres", type=Path, default=PROJECT_ROOT / "tools/genre_targets.json")
    parser.add_argument("--progress-directory", type=Path, default=PROJECT_ROOT / ".catalogue-build")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "static/catalogue.json")
    args = parser.parse_args()
    if args.target_per_genre < 4 or args.minimum_reviews < 0:
        parser.error("Target must be at least4 and minimum reviews must be non-negative")
    genre_targets = json.loads(args.genres.read_text(encoding="utf-8"))
    catalogue = collect_catalogue(genre_targets, args.target_per_genre, args.minimum_reviews, args.progress_directory)
    shortfalls = [genre for genre in catalogue["genres"] if len(genre["gameIds"]) < args.target_per_genre]
    if shortfalls:
        report_path = args.progress_directory / "shortfall-catalogue.json"
        report_path.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit("Catalogue target not met: " + ", ".join(f'{g["name"]}={len(g["gameIds"])}' for g in shortfalls)
                         + f". Review the collected catalogue at {report_path}; nothing published.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f'Wrote {len(catalogue["games"])} distinct games; {args.target_per_genre} in each of {len(catalogue["genres"])} genres to {args.output}', flush=True)


if __name__ == "__main__":
    main()
