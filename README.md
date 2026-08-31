# Steam description comparer

[Use the free public tool](https://bitbutter.github.io/steam-description-comparer/).

Compare your game description with descriptions from Steam games that have found an audience. Choose a genre, mix your description with four others, and ask people to rank them.

The catalogue is a one-time snapshot of 4,213 distinct games, with exactly 600 in each of 15 genres. Every game had at least 50 reviews when collected. Games can appear in more than one genre. Review count is a rough measure of traction; it does not say how good the game or its description is.

Use **Edit sample** to exclude a familiar game. Exclusions stay in your browser and can be restored in Settings. Normal ranking hides the Steam game names and review counts.

Your description, rankings and exclusions stay in this browser. They are not uploaded. Browser data does not carry across devices or website addresses; clearing site data removes it. Download the results JSON to keep a copy. GitHub Pages receives normal page requests and logs visitor IP addresses under its own privacy policy.

## Catalogue

The collector resolves genres against Steam's public tag list and reads English descriptions from Steam's Store Browse service. It uses the overall filtered review count for Steam purchases across all languages, including positive and negative reviews. Off-topic reviews are excluded by Steam. It skips demos, non-game products, unavailable entries and entries without a usable description or reported review count. Games marked as Adult Only Sexual Content or tagged Hentai on Steam are excluded from this public catalogue.

Candidates come from Steam's tag search in relevance order. Each game counts towards all of its verified genres. A fixed random seed selects 600 qualifying games per genre from the collected pool. This is a fixed comparison pool, not a representative sample of every game on Steam. The browser draws randomly from that pool after applying your review minimum and exclusions. Raising the minimum can leave fewer than four eligible games; the tool reports that without lowering the requirement.

There are no scheduled refreshes or live Steam calls from the website. The collection date and actual counts appear in the tool. Previously recorded rankings are retained, including rankings made with different samples or review minima.

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

The collector makes at most one Steam request every three seconds and saves raw collection progress under `.catalogue-build/`. Running it again continues from those collected records. Use a new `--progress-directory` for a new snapshot. HTTP or schema errors stop collection. If a genre falls short, the collector reports the count and does not replace the public catalogue.

Only the static site is uploaded by the GitHub Pages workflow. The workflow checks the bundled catalogue; it never collects data from Steam. Private server files and local collection records are excluded from this repository.
