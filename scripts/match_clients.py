#!/usr/bin/env python3
"""
Match ServiceM8 clients to SAP Business Partners.

Inputs:
    --sm8 servicem8_clients.csv   columns: uuid, name, abn, email, phone, address
    --sap sap_partners.csv        columns: cardcode, cardname, abn, email, phone, address

Outputs (written to --out-dir):
    mapping.csv      every ServiceM8 client that found at least one match
    review.csv       medium-confidence matches that need a human eye
    unmatched.csv    ServiceM8 clients with no match at all

Usage:
    python match_clients.py --sm8 sm8.csv --sap sap.csv --out-dir ./out
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

try:
    from rapidfuzz import fuzz, process
except ImportError:
    sys.exit("rapidfuzz is required. Install with:  pip install rapidfuzz")


# Confidence levels. HIGH = trust it, MEDIUM = human review, LOW = unused (becomes unmatched).
CONF_HIGH = "high"
CONF_MEDIUM = "medium"

# Tokens stripped from company names before comparing. Order matters: longer first.
NAME_NOISE = [
    "proprietary limited",
    "pty limited",
    "pty ltd",
    "p/l",
    "p.l.",
    "limited",
    "ltd",
    "incorporated",
    "inc",
    "the",
    "australia",
    "aust",
    "co",
    "company",
    "group",
    "services",
    "service",
    "trading as",
    "t/a",
]

# Street-type abbreviations to expand for address comparison.
STREET_TYPES = {
    "st": "street", "str": "street",
    "rd": "road",
    "ave": "avenue", "av": "avenue",
    "blvd": "boulevard", "bvd": "boulevard",
    "ct": "court",
    "cres": "crescent", "cr": "crescent",
    "dr": "drive", "drv": "drive",
    "hwy": "highway",
    "ln": "lane",
    "pde": "parade",
    "pl": "place",
    "tce": "terrace",
    "cl": "close",
    "qld": "queensland", "nsw": "newsouthwales", "vic": "victoria",
    "wa": "westernaustralia", "sa": "southaustralia", "tas": "tasmania",
    "act": "act", "nt": "northernterritory",
}


@dataclass
class Match:
    sap_cardcode: str
    confidence: str
    method: str


def normalise_name(s: str) -> str:
    if not s:
        return ""
    s = s.lower().strip()
    s = re.sub(r"[^\w\s&]", " ", s)
    s = re.sub(r"\s+", " ", s)
    # Strip noise tokens. Done as whole-word replacements so "pty ltd" inside a
    # name like "ptyltd holdings" doesn't get mangled.
    for token in NAME_NOISE:
        s = re.sub(rf"\b{re.escape(token)}\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalise_abn(s: str) -> str:
    if not s:
        return ""
    digits = re.sub(r"\D", "", s)
    # A valid Australian ABN is 11 digits; anything else is treated as unusable
    # rather than risk matching on a partial or mistyped value.
    return digits if len(digits) == 11 else ""


def normalise_email(s: str) -> str:
    return (s or "").strip().lower()


def normalise_address(s: str) -> str:
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s)
    tokens = s.split()
    expanded = [STREET_TYPES.get(t, t) for t in tokens]
    return " ".join(expanded).strip()


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def pick(row: dict, *candidates: str) -> str:
    """Case-insensitive lookup of the first matching column name."""
    lowered = {k.lower().strip(): v for k, v in row.items() if k}
    for c in candidates:
        v = lowered.get(c.lower())
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def build_sap_indexes(sap_rows: list[dict]):
    """Build lookup tables over SAP for each matching pass."""
    by_abn: dict[str, list[str]] = defaultdict(list)
    by_email: dict[str, list[str]] = defaultdict(list)
    by_name: dict[str, list[str]] = defaultdict(list)
    by_address: dict[str, list[str]] = defaultdict(list)
    name_choices: dict[str, str] = {}  # normalised name -> cardcode (for fuzzy)

    for r in sap_rows:
        cardcode = pick(r, "cardcode", "card_code", "code")
        if not cardcode:
            continue
        abn = normalise_abn(pick(r, "abn"))
        email = normalise_email(pick(r, "email", "e_mail", "emailaddress"))
        name = normalise_name(pick(r, "cardname", "card_name", "name"))
        addr = normalise_address(pick(r, "address", "billto", "shipto"))

        if abn:
            by_abn[abn].append(cardcode)
        if email:
            by_email[email].append(cardcode)
        if name:
            by_name[name].append(cardcode)
            name_choices[name] = cardcode
        if addr:
            by_address[addr].append(cardcode)

    return by_abn, by_email, by_name, by_address, name_choices


def match_one(sm8: dict, idx, fuzzy_threshold: int) -> Match | None:
    by_abn, by_email, by_name, by_address, name_choices = idx

    abn = normalise_abn(pick(sm8, "abn"))
    if abn and abn in by_abn:
        hits = by_abn[abn]
        # Multiple SAP partners with the same ABN => ambiguous, send to review.
        if len(hits) == 1:
            return Match(hits[0], CONF_HIGH, "abn_exact")
        return Match("|".join(hits), CONF_MEDIUM, "abn_ambiguous")

    email = normalise_email(pick(sm8, "email", "e_mail", "emailaddress"))
    if email and email in by_email:
        hits = by_email[email]
        if len(hits) == 1:
            return Match(hits[0], CONF_HIGH, "email_exact")
        return Match("|".join(hits), CONF_MEDIUM, "email_ambiguous")

    name = normalise_name(pick(sm8, "name", "cardname", "client_name"))
    if name and name in by_name:
        hits = by_name[name]
        if len(hits) == 1:
            return Match(hits[0], CONF_HIGH, "name_exact")
        return Match("|".join(hits), CONF_MEDIUM, "name_ambiguous")

    addr = normalise_address(pick(sm8, "address", "billing_address"))
    if addr and addr in by_address:
        hits = by_address[addr]
        # Address alone is never high-confidence — two businesses can share an
        # address (shared office, franchise, holding company).
        return Match("|".join(hits) if len(hits) > 1 else hits[0],
                     CONF_MEDIUM, "address_exact")

    if name and name_choices:
        best = process.extractOne(
            name, name_choices.keys(), scorer=fuzz.token_sort_ratio,
            score_cutoff=fuzzy_threshold,
        )
        if best:
            matched_name, score, _ = best
            return Match(
                name_choices[matched_name],
                CONF_MEDIUM,
                f"name_fuzzy_{int(score)}",
            )

    return None


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sm8", required=True, type=Path, help="ServiceM8 clients CSV")
    ap.add_argument("--sap", required=True, type=Path, help="SAP Business Partners CSV")
    ap.add_argument("--out-dir", default=Path("."), type=Path, help="Output directory")
    ap.add_argument("--fuzzy-threshold", type=int, default=92,
                    help="rapidfuzz token_sort_ratio cutoff (default 92)")
    args = ap.parse_args()

    sm8_rows = read_csv(args.sm8)
    sap_rows = read_csv(args.sap)
    idx = build_sap_indexes(sap_rows)

    mapping: list[dict] = []
    review: list[dict] = []
    unmatched: list[dict] = []

    for r in sm8_rows:
        uuid = pick(r, "uuid", "id", "servicem8_uuid")
        if not uuid:
            continue
        name = pick(r, "name", "client_name")
        m = match_one(r, idx, args.fuzzy_threshold)

        if m is None:
            unmatched.append({
                "serviceM8_uuid": uuid,
                "serviceM8_name": name,
                "abn": pick(r, "abn"),
                "email": pick(r, "email"),
            })
            continue

        row_out = {
            "serviceM8_uuid": uuid,
            "serviceM8_name": name,
            "sap_cardcode": m.sap_cardcode,
            "confidence_level": m.confidence,
            "match_method": m.method,
        }
        mapping.append(row_out)
        if m.confidence == CONF_MEDIUM:
            review.append(row_out)

    out = args.out_dir
    write_csv(out / "mapping.csv", mapping,
              ["serviceM8_uuid", "serviceM8_name", "sap_cardcode",
               "confidence_level", "match_method"])
    write_csv(out / "review.csv", review,
              ["serviceM8_uuid", "serviceM8_name", "sap_cardcode",
               "confidence_level", "match_method"])
    write_csv(out / "unmatched.csv", unmatched,
              ["serviceM8_uuid", "serviceM8_name", "abn", "email"])

    high = sum(1 for m in mapping if m["confidence_level"] == CONF_HIGH)
    med = len(review)
    print(f"ServiceM8 clients read: {len(sm8_rows)}")
    print(f"SAP partners read:      {len(sap_rows)}")
    print(f"High-confidence:        {high}")
    print(f"Needs review:           {med}")
    print(f"Unmatched:              {len(unmatched)}")
    print(f"Files written to:       {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
