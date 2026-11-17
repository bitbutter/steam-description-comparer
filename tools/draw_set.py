#!/usr/bin/env python
"""draw_set.py — CLI blind-set draw from the steam_comparer catalogue.

Usage:
  python scripts/draw_set.py puzzle --desc "Your short description here"
  python scripts/draw_set.py puzzle --file desc.txt
  echo "text" | python scripts/draw_set.py puzzle
  python scripts/draw_set.py --list-genres
  python scripts/draw_set.py puzzle --desc "..." --seed 42   (reproducible)

Prints a paste-ready blind set (your draft shuffled among four real Steam
short descriptions from the genre pool, labelled A-E, no marker) followed by
a private key (your letter + the four source games). Paste everything above
the separator line into another LLM; keep the key to yourself.
"""
import argparse
import json
import os
import random
import sys
import re

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE = os.path.join(HERE, "..", "static", "catalogue.json")


def load():
    with open(CATALOGUE, encoding="utf-8") as f:
        d = json.load(f)
    games = {g["id"]: g for g in d["games"]}
    return d["genres"], games


def clean_text(game):
    """Some catalogue texts start with a dash-run where the game title stood
    (collection artifact). Reattach the name when what follows reads as a
    continuation; otherwise just drop the dashes."""
    t = game["text"]
    m = re.match(r"^([—–-]{2,})\s*(.+)$", t, re.S)
    if m:
        rest = m.group(2)
        return f"{game['name']} {rest}" if rest[:1].islower() else rest
    return t


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("genre", nargs="?", help="genre pool to draw from (fuzzy match, e.g. puzzle)")
    ap.add_argument("--desc", help="your short description text")
    ap.add_argument("--file", help="read the description from a file instead")
    ap.add_argument("--seed", type=int, default=None, help="reproducible draw")
    ap.add_argument("--position", choices=list("ABCDE"), default=None, help="seat for your draft (default: random of D or E, so wins are conservative against LLM position bias)")
    ap.add_argument("--list-genres", action="store_true")
    a = ap.parse_args()

    genres, games = load()
    if a.list_genres or not a.genre:
        names = ", ".join(g["name"] for g in genres)
        print(f"genres ({len(genres)}): {names}")
        if not a.list_genres:
            sys.exit("error: genre required (or --list-genres)")
        return

    genre = next(
        (g for g in genres if a.genre.lower() == g["name"].lower()),
        None,
    ) or next((g for g in genres if a.genre.lower() in g["name"].lower()), None)
    if not genre:
        sys.exit(f"error: no genre matches '{a.genre}'. Available: " + ", ".join(g["name"] for g in genres))

    if a.file:
        desc = open(a.file, encoding="utf-8").read().strip()
    elif a.desc:
        desc = a.desc.strip()
    elif not sys.stdin.isatty():
        desc = sys.stdin.read().strip()
    else:
        sys.exit("error: provide --desc, --file, or stdin")

    rng = random.Random(a.seed)
    picks = rng.sample(genre["gameIds"], 4)
    seat = a.position or rng.choice("DE")
    order = list("ABCDE")
    slots = {}
    for s_ in [x for x in order if x != seat]:
        slots[s_] = ("GAME", games[picks.pop()])
    slots[seat] = ("YOURS", desc)
    entries = [slots[x] for x in order]

    lines = []
    lines.append(
        "Five Steam short descriptions, labelled A to E. Rank them by how much each one makes you want to learn more about the game. Give the ranking first, then one sentence on each."
    )
    lines.append("")
    for label, (kind, payload) in zip("ABCDE", entries):
        lines.append(f"{label}. {payload if kind == 'YOURS' else clean_text(payload)}")
        lines.append("")
    block = "\n".join(lines)

    print(block)
    print("=" * 60)
    print("PRIVATE KEY (do not paste):")
    yours = seat
    print(f"  your draft is: {yours}")
    for label, (kind, payload) in zip("ABCDE", entries):
        if kind == "GAME":
            print(f"  {label} = {payload['name']} ({payload['reviews']:,} reviews)")


if __name__ == "__main__":
    main()
