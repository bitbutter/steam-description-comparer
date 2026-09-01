# Steam description comparer

[Open Steam Comparer](https://bitbutter.github.io/steam-description-comparer/).

Paste your current Steam description and choose a Steam genre or tag that fits the game. Steam Comparer shuffles your draft into a set with four descriptions from games under your selection, without marking which one is yours.

Copy the A–E list for other people to rank by how much each makes them want to learn more. Edit your draft and test it again against the same four games. Draw another set when you want different comparisons. A new set can include games you have seen before.

The catalogue is a one-time snapshot of 4,213 distinct games, with exactly 600 under each of 15 selected Steam genres and tags. Every game had at least 50 reviews when collected. Games can appear in more than one comparison pool. Review count is a rough measure of traction; it does not say how good the game or its description is.

Descriptions appear in one column under headings A–E, without marking your draft. **Show source details** displays Steam titles, review counts, store links and Exclude buttons. **Exclude** replaces that game and keeps it out of future sets. Exclusions can be restored in Settings. **Draw another set** selects four games and shuffles all five descriptions. **Copy A–E list** copies the displayed descriptions in order, without source details.

Your draft, card order and exclusions stay in this browser. Clearing site data removes them. GitHub Pages receives normal page requests and logs visitor IP addresses under its own privacy policy.

## Catalogue

The collector resolves the selected Steam genres and tags against Steam's public tag list and reads English descriptions from Steam's Store Browse service. It uses the overall filtered review count for Steam purchases across all languages, including positive and negative reviews. Off-topic reviews are excluded by Steam. It skips demos, non-game products, unavailable entries and entries without a usable description or reported review count. Games marked as Adult Only Sexual Content or tagged Hentai on Steam are excluded from this public catalogue.

Candidates come from Steam's tag search in relevance order. Each game counts towards all of its verified Steam tags. A fixed random seed selects 600 qualifying games per tag from the collected pool. This is a fixed comparison pool, not a representative sample of every game on Steam. The browser draws randomly from that pool after applying your review minimum and exclusions. Raising the minimum can leave fewer than four eligible games; the tool reports that without lowering the requirement.

There are no scheduled refreshes or live Steam calls from the website. The collection metadata is saved in the catalogue. Some game names within the saved descriptions are blanked out; source titles are available through Show source details.

Game descriptions and titles belong to their respective creators. Source Steam store links are included in the catalogue. This project is not affiliated with Valve. SortableJS is bundled under its [MIT licence](static/vendor/sortable.LICENSE.txt).

## Run locally

From this directory:

```sh
python -m http.server 8080 --directory static
```

Open http://localhost:8080. No backend or account setup is required.

## Check the catalogue and behaviour

```sh
python -m pip install -r tools/requirements.txt
python tools/validate_catalogue.py
python -m unittest discover -s tests -p test_catalogue.py -v
node --test tests/test_static_catalogue.cjs
```

## Collect a catalogue manually

The published catalogue is already bundled. To deliberately build another snapshot:

```sh
python tools/collect_catalogue.py --target-per-genre 600 --minimum-reviews 50
python tools/validate_catalogue.py
```

The collector makes at most one Steam request every three seconds and saves raw collection progress under `.catalogue-build/`. Running it again continues from those collected records. Use a new `--progress-directory` for a new snapshot. HTTP or schema errors stop collection. If a Steam tag falls short, the collector reports the count and does not replace the public catalogue.

Only the static site is uploaded by the GitHub Pages workflow. The workflow checks the bundled catalogue; it never collects data from Steam. Private server files and local collection records are excluded from this repository.
