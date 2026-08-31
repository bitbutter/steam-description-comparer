"""Public catalogue integrity checks using small synthetic games."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_catalogue import CatalogueValidationError, main, read_json, validate_catalogue


def catalogue_fixture():
    genres = [
        {"id": index, "name": f"Genre {index}", "steamTagId": 1000 + index,
         "gameIds": ["steam_10", "steam_20"]}
        for index in range(1, 16)
    ]
    games = [
        {"id": f"steam_{appid}", "appid": appid, "name": f"Synthetic Game {appid}",
         "text": "A plain description with <3 hearts & careful choices.", "reviews": review_count,
         "steamTagIds": [genre["steamTagId"] for genre in genres],
         "storeUrl": f"https://store.steampowered.com/app/{appid}/"}
        for appid, review_count in [(10, 50), (20, 100)]
    ]
    return {
        "schemaVersion": 1, "catalogueId": "steam-one-time-2026-08-31",
        "collectedAt": "2026-08-31T12:00:00Z", "minimumReviewCount": 50,
        "reviewCountScope": "Steam-purchase reviews in all languages.",
        "genres": genres, "games": games,
        "collection": {
            "targetPerGenre": 600, "selectionMethod": "Qualifying Steam tag search results.",
            "sourceCountry": "US", "sourceLanguage": "english",
            "reviewSource": "Steam summary_filtered.review_count", "requestCount": 20,
            "searchCandidatesByGenre": {str(genre["id"]): 4 for genre in genres},
            "rejectedGamesByReason": {"under_minimum_reviews": 10},
        },
    }


class PublicCatalogueTests(unittest.TestCase):
    def validate(self, catalogue, **options):
        return validate_catalogue(catalogue, minimum_per_genre=options.pop("minimum_per_genre", 2),
                                  minimum_unique_games=options.pop("minimum_unique_games", 2), **options)

    def test_counts_distinct_games_and_permits_genuine_cross_genre_membership(self):
        report = self.validate(catalogue_fixture())
        self.assertEqual(report["uniqueGameCount"], 2)
        self.assertEqual(len(report["genres"]), 15)
        self.assertTrue(all(genre["count"] == 2 for genre in report["genres"]))
        self.assertEqual(report["minimumReviewCount"], 50)

    def test_default_publication_requirements_do_not_accept_small_fixtures(self):
        with self.assertRaisesRegex(CatalogueValidationError, "at least 600 required"):
            validate_catalogue(catalogue_fixture())
        with self.assertRaisesRegex(CatalogueValidationError, "at least 2000 required"):
            validate_catalogue(catalogue_fixture(), minimum_per_genre=2)

    def test_duplicate_games_never_inflate_sampling_counts(self):
        catalogue = catalogue_fixture()
        catalogue["games"].append(copy.deepcopy(catalogue["games"][0]))
        with self.assertRaisesRegex(CatalogueValidationError, "Duplicate game id"):
            self.validate(catalogue)
        catalogue = catalogue_fixture()
        catalogue["genres"][0]["gameIds"].append("steam_10")
        with self.assertRaisesRegex(CatalogueValidationError, "duplicate game"):
            self.validate(catalogue)

    def test_unknown_games_and_wrong_steam_tags_are_rejected(self):
        catalogue = catalogue_fixture()
        catalogue["genres"][0]["gameIds"][0] = "steam_999"
        with self.assertRaisesRegex(CatalogueValidationError, "unknown game"):
            self.validate(catalogue)
        catalogue = catalogue_fixture()
        catalogue["games"][0]["steamTagIds"].remove(1001)
        with self.assertRaisesRegex(CatalogueValidationError, "does not have Genre 1's Steam tag"):
            self.validate(catalogue)

    def test_insufficient_review_counts_are_never_replaced_by_a_default(self):
        for reviews in [0, 49, -1, None, True, 50.0, "50"]:
            with self.subTest(reviews=reviews):
                catalogue = catalogue_fixture()
                catalogue["games"][0]["reviews"] = reviews
                with self.assertRaisesRegex(CatalogueValidationError, "reviews must be a whole number"):
                    self.validate(catalogue)
        catalogue = catalogue_fixture()
        del catalogue["games"][0]["reviews"]
        with self.assertRaisesRegex(CatalogueValidationError, "missing required fields"):
            self.validate(catalogue)

    def test_declared_review_floor_applies_to_every_game(self):
        catalogue = catalogue_fixture()
        catalogue["minimumReviewCount"] = 100
        with self.assertRaisesRegex(CatalogueValidationError, "reviews must be a whole number from 100"):
            self.validate(catalogue)
        catalogue["minimumReviewCount"] = 49
        with self.assertRaisesRegex(CatalogueValidationError, "minimumReviewCount"):
            self.validate(catalogue)

    def test_genre_shortfalls_are_errors_even_when_other_genres_are_full(self):
        catalogue = catalogue_fixture()
        catalogue["genres"][4]["gameIds"].pop()
        with self.assertRaisesRegex(CatalogueValidationError, "Genre 5 contains 1 games; at least 2 required"):
            self.validate(catalogue)

    def test_duplicate_genre_identity_is_rejected(self):
        for field in ("id", "name", "steamTagId"):
            with self.subTest(field=field):
                catalogue = catalogue_fixture()
                catalogue["genres"][1][field] = catalogue["genres"][0][field]
                with self.assertRaisesRegex(CatalogueValidationError, "Duplicate genre"):
                    self.validate(catalogue)

    def test_genre_manifest_detects_silent_id_or_name_drift(self):
        catalogue = catalogue_fixture()
        manifest = [{"id": genre["id"], "name": genre["name"]} for genre in catalogue["genres"]]
        self.validate(catalogue, expected_genres=manifest)
        catalogue["genres"][0]["name"] = "Different Genre"
        with self.assertRaisesRegex(CatalogueValidationError, "do not match"):
            self.validate(catalogue, expected_genres=manifest)
        catalogue = catalogue_fixture()
        catalogue["genres"].pop()
        with self.assertRaisesRegex(CatalogueValidationError, "Expected 15 genres"):
            self.validate(catalogue)

    def test_unreferenced_games_cannot_inflate_the_distinct_game_total(self):
        catalogue = catalogue_fixture()
        additional_game = dict(catalogue["games"][0], id="steam_30", appid=30,
                               storeUrl="https://store.steampowered.com/app/30/")
        catalogue["games"].append(additional_game)
        with self.assertRaisesRegex(CatalogueValidationError, "outside every supported genre"):
            self.validate(catalogue)

    def test_public_descriptions_must_be_real_plain_text(self):
        for description in ["", " \t", None, "<b>Fight</b>", "&lt;script&gt;bad&lt;/script&gt;", "a\x00b"]:
            with self.subTest(description=description):
                catalogue = catalogue_fixture()
                catalogue["games"][0]["text"] = description
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)
        catalogue = catalogue_fixture()
        catalogue["games"][0]["text"] = "Count < 3, go > 1. A <3 story & adventure."
        self.validate(catalogue)

    def test_game_identity_and_links_cannot_point_outside_steam(self):
        for field, value in [("appid", True), ("id", "steam_20"), ("storeUrl", "javascript:alert(1)"),
                             ("storeUrl", "https://store.steampowered.com/app/10/?email=private"),
                             ("storeUrl", "https://example.com/app/10/")]:
            with self.subTest(field=field, value=value):
                catalogue = catalogue_fixture()
                catalogue["games"][0][field] = value
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)

    def test_tag_ids_must_be_real_unique_integers(self):
        for tags in [[], [True], ["1001"], [1001, 1001], [1001.0]]:
            with self.subTest(tags=tags):
                catalogue = catalogue_fixture()
                catalogue["games"][0]["steamTagIds"] = tags
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)

    def test_public_schema_rejects_private_or_unexpected_metadata(self):
        for location, field, value in [([], "privateCheckpoint", "C:/Users/private"),
                                       (["games", 0], "accountEmail", "private@example.com"),
                                       (["genres", 0], "accessToken", "not-public"),
                                       (["collection"], "authorization", "not-public"),
                                       (["collection", "rejectedGamesByReason"], "password", "not-public")]:
            with self.subTest(location=location, field=field):
                catalogue = catalogue_fixture()
                container = catalogue
                for key in location:
                    container = container[key]
                container[field] = value
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)

    def test_collection_counts_do_not_accept_booleans_or_unknown_genres(self):
        for field, value in [("requestCount", True), ("searchCandidatesByGenre", {"999": 2}),
                             ("rejectedGamesByReason", {"under_minimum_reviews": -1})]:
            with self.subTest(field=field):
                catalogue = catalogue_fixture()
                catalogue["collection"][field] = value
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)

    def test_timestamp_and_schema_version_are_explicit(self):
        for field, value in [("schemaVersion", True), ("schemaVersion", 2), ("collectedAt", "2026-08-31"),
                             ("collectedAt", "2026-08-31T12:00:00"), ("collectedAt", "yesterday")]:
            with self.subTest(field=field, value=value):
                catalogue = catalogue_fixture()
                catalogue[field] = value
                with self.assertRaises(CatalogueValidationError):
                    self.validate(catalogue)

    def test_json_duplicate_object_keys_are_not_silently_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalogue.json"
            path.write_text('{"minimumReviewCount":50,"minimumReviewCount":0}', encoding="utf-8")
            with self.assertRaisesRegex(CatalogueValidationError, "repeated object key"):
                read_json(path)

    def test_cli_reports_counts_and_returns_nonzero_on_shortfalls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalogue.json"
            path.write_text(json.dumps(catalogue_fixture()), encoding="utf-8")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                status = main([str(path), "--minimum-per-genre", "2", "--minimum-unique-games", "2"])
            self.assertEqual(status, 0)
            self.assertIn("Distinct games: 2", stdout.getvalue())
            self.assertIn("Genre 15: 2", stdout.getvalue())
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                status = main([str(path)])
            self.assertEqual(status, 1)
            self.assertIn("at least 600 required", stderr.getvalue())




def steam_item_fixture():
    return {
        "item_type": 0, "id": 101, "success": 1, "visible": True,
        "name": "Signal & Stone: Origins", "appid": 101, "type": 0,
        "tagids": [32322, 19],
        "reviews": {
            "summary_filtered": {"review_count": 50},
            "summary_language_specific": {"review_count": 3},
        },
        "basic_info": {
            "short_description": "A <b>Signal &amp; Stone</b> mystery.<br>Build &amp; explore.",
            "developers": [{"name": "Example developer"}],
        },
    }


class SteamCatalogueCollectionTests(unittest.TestCase):
    def test_collection_preserves_all_language_steam_review_counts_at_the_boundary(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        steam_item = steam_item_fixture()
        game, rejection = qualifying_catalogue_game(steam_item, 50)
        self.assertIsNone(rejection)
        self.assertEqual(game["reviews"], 50)
        self.assertEqual(game["text"], "A \u2014\u2014\u2014 mystery. Build & explore.")
        self.assertEqual(game["steamTagIds"], [19, 32322])
        self.assertNotIn("developers", game)
        self.assertEqual(game["storeUrl"], "https://store.steampowered.com/app/101/")
        steam_item["reviews"]["summary_filtered"]["review_count"] = 49
        steam_item["reviews"]["summary_language_specific"]["review_count"] = 2000
        game, rejection = qualifying_catalogue_game(steam_item, 50)
        self.assertIsNone(game)
        self.assertEqual(rejection, "under_minimum_reviews")

    def test_missing_review_summary_cannot_borrow_a_different_scope_or_invent_zero(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for summaries in [None, {}, {"summary_language_specific": {"review_count": 2000}},
                          {"summary_filtered": {}}]:
            with self.subTest(summaries=summaries):
                steam_item = steam_item_fixture()
                steam_item["reviews"] = summaries
                game, rejection = qualifying_catalogue_game(steam_item, 0)
                self.assertIsNone(game)
                self.assertIn(rejection, {"no_reported_review_summary", "no_reported_review_count"})
        steam_item = steam_item_fixture()
        steam_item["reviews"]["summary_filtered"]["review_count"] = 0
        game, rejection = qualifying_catalogue_game(steam_item, 0)
        self.assertIsNone(rejection)
        self.assertEqual(game["reviews"], 0)

    def test_malformed_review_counts_fail_at_the_steam_conversion_boundary(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for reviews in [True, -1, 50.0, "50", []]:
            with self.subTest(reviews=reviews):
                steam_item = steam_item_fixture()
                steam_item["reviews"]["summary_filtered"]["review_count"] = reviews
                with self.assertRaisesRegex(ValueError, "invalid review count"):
                    qualifying_catalogue_game(steam_item, 50)

    def test_demos_non_games_and_unavailable_items_do_not_enter_the_catalogue(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for field, value, reason in [("type", 1, "not_a_game"), ("item_type", 1, "not_a_game"),
                                     ("visible", False, "unavailable"), ("success", 0, "unavailable"),
                                     ("name", "Signal Demo", "demo")]:
            with self.subTest(field=field):
                steam_item = steam_item_fixture()
                steam_item[field] = value
                game, rejection = qualifying_catalogue_game(steam_item, 50)
                self.assertIsNone(game)
                self.assertEqual(rejection, reason)

    def test_missing_descriptions_do_not_produce_comparison_placeholders(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for description in [None, "", " ", "<br>"]:
            with self.subTest(description=description):
                steam_item = steam_item_fixture()
                steam_item["basic_info"]["short_description"] = description
                game, rejection = qualifying_catalogue_game(steam_item, 50)
                self.assertIsNone(game)
                self.assertIn(rejection, {"no_description", "empty_description"})

    def test_actual_steam_tag_membership_is_used_after_search_and_review_filtering(self):
        from unittest.mock import Mock, patch
        from tools.collect_catalogue import collect_catalogue

        wrong_genre_game = steam_item_fixture()
        wrong_genre_game["tagids"] = [1131]  # Existing UI id is not Steam's Deckbuilding tag.
        low_review_game = copy.deepcopy(steam_item_fixture())
        low_review_game.update(id=102, appid=102)
        low_review_game["reviews"]["summary_filtered"]["review_count"] = 49
        qualifying_game = copy.deepcopy(steam_item_fixture())
        qualifying_game.update(id=103, appid=103)
        steam_collection = Mock()
        steam_collection.steam_items = {}
        steam_collection.search_pages = {}
        steam_collection.resolve_genres.return_value = [
            {"id": 1131, "name": "Deckbuilding", "steamTagId": 32322, "gameIds": []},
        ]
        steam_collection.search_appids.return_value = {"appids": [101, 102, 103], "totalCount": 3}
        steam_collection.fetch_app_details.return_value = [wrong_genre_game, low_review_game, qualifying_game]
        steam_collection.request_count = 2
        with patch("tools.collect_catalogue.SteamCatalogueCollection", return_value=steam_collection):
            with redirect_stdout(io.StringIO()):
                catalogue = collect_catalogue([{"id": 1131, "name": "Deckbuilding"}], 1, 50, Path("unused"))
        self.assertEqual(catalogue["genres"][0]["gameIds"], ["steam_103"])
        self.assertEqual([game["id"] for game in catalogue["games"]], ["steam_103"])
        steam_collection.search_appids.assert_called_once_with(32322, 0)
        self.assertEqual(catalogue["collection"]["rejectedGamesByReason"], {"under_minimum_reviews": 1})
        validate_catalogue(catalogue, minimum_per_genre=1, minimum_unique_games=1,
                           expected_genres=[{"id": 1131, "name": "Deckbuilding"}])

    def test_anonymizing_a_short_title_does_not_change_words_that_contain_it(self):
        from tools.collect_catalogue import anonymize_description

        description = anonymize_description("Rust", "Rust rewards trust, crusty survivors, and resourcefulness.")
        self.assertEqual(description, "\u2014\u2014\u2014 rewards trust, crusty survivors, and resourcefulness.")

    def test_anonymizing_punctuated_titles_does_not_leave_the_recognizable_title(self):
        from tools.collect_catalogue import anonymize_description

        description = anonymize_description("Baldur's Gate 3", "Enter Baldur's Gate 3 and choose your path.")
        self.assertEqual(description, "Enter \u2014\u2014\u2014 and choose your path.")

    def test_hyphenated_titles_do_not_redact_unrelated_half_titles(self):
        from tools.collect_catalogue import anonymize_description

        description = anonymize_description("Counter-Strike", "Counter-Strike is a counter to your everyday shooter.")
        self.assertEqual(description, "\u2014\u2014\u2014 is a counter to your everyday shooter.")

    def test_both_full_and_subtitle_free_names_are_hidden(self):
        from tools.collect_catalogue import anonymize_description

        for title in ["Signal & Stone: Origins", "Signal & Stone - Origins", "Signal & Stone \u2014 Origins"]:
            with self.subTest(title=title):
                description = anonymize_description(title, f"Play {title}. Signal & Stone offers difficult choices.")
                self.assertEqual(description, "Play \u2014\u2014\u2014. \u2014\u2014\u2014 offers difficult choices.")



    def test_precollected_games_fill_every_verified_genre_without_more_steam_requests(self):
        from unittest.mock import Mock, patch
        from tools.collect_catalogue import collect_catalogue

        genre_manifest = [{"id": 1131, "name": "Deckbuilding"}, {"id": 1, "name": "Action"}]
        steam_collection = Mock()
        steam_collection.steam_items = {101: steam_item_fixture()}
        steam_collection.search_pages = {}
        steam_collection.request_count = 0
        steam_collection.resolve_genres.return_value = [
            {"id": 1131, "name": "Deckbuilding", "steamTagId": 32322, "gameIds": []},
            {"id": 1, "name": "Action", "steamTagId": 19, "gameIds": []},
        ]
        with patch("tools.collect_catalogue.SteamCatalogueCollection", return_value=steam_collection):
            with redirect_stdout(io.StringIO()):
                catalogue = collect_catalogue(genre_manifest, 1, 50, Path("unused"))
        self.assertEqual([genre["gameIds"] for genre in catalogue["genres"]], [["steam_101"], ["steam_101"]])
        self.assertEqual(len(catalogue["games"]), 1)
        self.assertEqual(catalogue["collection"]["requestCount"], 0)
        steam_collection.search_appids.assert_not_called()
        steam_collection.fetch_app_details.assert_not_called()
        validate_catalogue(catalogue, minimum_per_genre=1, minimum_unique_games=1,
                           expected_genres=genre_manifest)

    def test_a_fetched_game_also_fills_later_matching_genres(self):
        from unittest.mock import Mock, patch
        from tools.collect_catalogue import collect_catalogue

        genre_manifest = [{"id": 1131, "name": "Deckbuilding"}, {"id": 1, "name": "Action"}]
        steam_collection = Mock()
        steam_collection.steam_items = {}
        steam_collection.search_pages = {}
        steam_collection.request_count = 2
        steam_collection.resolve_genres.return_value = [
            {"id": 1131, "name": "Deckbuilding", "steamTagId": 32322, "gameIds": []},
            {"id": 1, "name": "Action", "steamTagId": 19, "gameIds": []},
        ]
        steam_collection.search_appids.return_value = {"appids": [101], "totalCount": 1}
        steam_collection.fetch_app_details.return_value = [steam_item_fixture()]
        with patch("tools.collect_catalogue.SteamCatalogueCollection", return_value=steam_collection):
            with redirect_stdout(io.StringIO()):
                catalogue = collect_catalogue(genre_manifest, 1, 50, Path("unused"))
        self.assertEqual([genre["gameIds"] for genre in catalogue["genres"]], [["steam_101"], ["steam_101"]])
        steam_collection.search_appids.assert_called_once_with(32322, 0)
        steam_collection.fetch_app_details.assert_called_once_with([101])
        self.assertEqual(len(catalogue["games"]), 1)

    def test_genre_sampling_is_balanced_and_unchanged_by_checkpoint_record_order(self):
        from unittest.mock import Mock, patch
        from tools.collect_catalogue import collect_catalogue

        genre_manifest = [{"id": 1131, "name": "Deckbuilding"}, {"id": 1, "name": "Action"}]
        steam_items = [dict(steam_item_fixture(), id=appid, appid=appid) for appid in range(101, 109)]
        catalogues = []
        for raw_items in (steam_items, list(reversed(steam_items))):
            steam_collection = Mock()
            steam_collection.steam_items = {item["id"]: item for item in raw_items}
            steam_collection.search_pages = {}
            steam_collection.request_count = 0
            steam_collection.resolve_genres.return_value = [
                {"id": 1131, "name": "Deckbuilding", "steamTagId": 32322, "gameIds": []},
                {"id": 1, "name": "Action", "steamTagId": 19, "gameIds": []},
            ]
            with patch("tools.collect_catalogue.SteamCatalogueCollection", return_value=steam_collection):
                with redirect_stdout(io.StringIO()):
                    catalogue = collect_catalogue(genre_manifest, 2, 50, Path("unused"))
            catalogues.append(catalogue)
            self.assertEqual([len(genre["gameIds"]) for genre in catalogue["genres"]], [2, 2])
            self.assertTrue(all(len(set(genre["gameIds"])) == 2 for genre in catalogue["genres"]))
            steam_collection.search_appids.assert_not_called()
            steam_collection.fetch_app_details.assert_not_called()
            validate_catalogue(catalogue, minimum_per_genre=2, minimum_unique_games=2,
                               expected_genres=genre_manifest)
        self.assertEqual(catalogues[0]["catalogueId"], catalogues[1]["catalogueId"])
        self.assertEqual(catalogues[0]["genres"], catalogues[1]["genres"])
        self.assertEqual(catalogues[0]["games"], catalogues[1]["games"])



    def test_explicit_adult_sexual_content_does_not_enter_the_public_catalogue(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for descriptors, tags in [([3], [32322, 19]), ([2, 3, 5], [32322]),
                                   ([], [32322, 9130]), ([2, 5], [19, 9130])]:
            with self.subTest(descriptors=descriptors, tags=tags):
                steam_item = steam_item_fixture()
                steam_item["content_descriptorids"] = descriptors
                steam_item["tagids"] = tags
                game, rejection = qualifying_catalogue_game(steam_item, 50)
                self.assertIsNone(game)
                self.assertEqual(rejection, "adult_sexual_content")

    def test_ordinary_mature_violent_and_nudity_labels_are_not_blanket_exclusions(self):
        from tools.collect_catalogue import qualifying_catalogue_game

        for descriptors, tags in [([2], [32322, 19]), ([5], [32322, 19]),
                                   ([2, 5], [32322, 19]), ([], [32322, 6650]),
                                   ([2, 5], [32322, 19, 6650])]:
            with self.subTest(descriptors=descriptors, tags=tags):
                steam_item = steam_item_fixture()
                steam_item["content_descriptorids"] = descriptors
                steam_item["tagids"] = tags
                game, rejection = qualifying_catalogue_game(steam_item, 50)
                self.assertIsNone(rejection)
                self.assertEqual(game["id"], "steam_101")
                self.assertEqual(game["reviews"], 50)
                self.assertEqual(game["steamTagIds"], sorted(tags))


if __name__ == "__main__":
    unittest.main()
