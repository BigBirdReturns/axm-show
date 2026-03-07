#!/usr/bin/env python3
"""
axm-show/src/axm_show/show_compile.py

Show Shard Compiler
===================

Compiles a show_spec.json into a genesis-verifiable shard.

This follows the exact same pattern as compile.py and bounds.py:
  1. Parse domain-specific input (show_spec.json)
  2. Extract candidates (subject/predicate/object/tier/evidence triples)
  3. Delegate to compile_generic_shard (the only path to a verifiable shard)
  4. Self-verify before emitting

Usage:
    axm-show-compile <show_spec.json> <out_dir>
    axm-show-compile show_spec.json show_shard/ --suite ed25519
    axm-show-compile show_spec.json show_shard/ --gold

The output shard passes: axm-verify shard <out_dir>

Dependency chain:
    planner UI (or CLI)        ->  show_spec.json
    show_compile.py            ->  show_shard/      (this file)
    show_schema.py                                  (validation + parsing)
    axm_build.compiler_generic                      (canonical shard compilation)
    axm_verify.logic                                (self-verification gate)
"""
from __future__ import annotations

import json
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path

import click

# Genesis compiler: the only path to a verifiable shard
from axm_build.compiler_generic import CompilerConfig, compile_generic_shard
from axm_build.sign import (
    SUITE_ED25519,
    SUITE_MLDSA44,
    mldsa44_keygen,
    signing_key_from_private_key_bytes,
)
from axm_verify.logic import verify_shard as _verify_shard

# Show schema: validation and parsing
from axm_show.show_schema import validate_show_spec, parse_show_spec

# Canonical demo key (Ed25519, matches governance/trust_store.json)
_CANONICAL_PUBLISHER_SEED = bytes.fromhex(
    "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3"
)
GOLD_TIMESTAMP = "2026-01-01T00:00:00Z"

_NAMESPACE = "embodied/show"
_PUBLISHER_ID = "@axm_show"
_PUBLISHER_NAME = "AXM Show Compiler"


# ---------------------------------------------------------------------------
# Candidate extraction
# ---------------------------------------------------------------------------

def _extract_candidates(spec_raw: dict, source_text: str) -> list[dict]:
    """Extract genesis-compatible candidates from a show spec.

    Each candidate has: subject, predicate, object, object_type, tier, evidence.
    Evidence must appear exactly once in the source text.
    compile_generic_shard enforces this.
    """
    candidates: list[dict] = []

    # We need evidence strings that are unique substrings of source_text.
    # Since source_text IS the JSON, we use carefully constructed key:value
    # pairs that appear exactly once in the serialized document.

    venue = spec_raw.get("venue", {})
    config = spec_raw.get("config", {})
    safety = spec_raw.get("safety", {})

    def _add(subj: str, pred: str, obj: str, obj_type: str, tier: int, evidence: str) -> None:
        # Only add if evidence actually appears in source
        if evidence in source_text:
            candidates.append({
                "subject": subj,
                "predicate": pred,
                "object": obj,
                "object_type": obj_type,
                "tier": tier,
                "evidence": evidence,
            })

    # --- Tier 0: Venue / Regulatory (facts, not choices) ---

    # Each evidence string is a unique JSON fragment from the source
    _add("show/venue", "name", venue["name"], "literal:string", 0,
         f'"name": "{venue["name"]}"')

    _add("show/venue", "airspace_class", venue["airspace_class"], "literal:string", 0,
         f'"airspace_class": "{venue["airspace_class"]}"')

    _add("show/venue", "max_altitude_agl_ft", str(venue["max_altitude_agl_ft"]),
         "literal:decimal", 0,
         f'"max_altitude_agl_ft": {venue["max_altitude_agl_ft"]}')

    _add("show/venue", "laanc_available", str(venue["laanc_available"]).lower(),
         "literal:string", 0,
         f'"laanc_available": {str(venue["laanc_available"]).lower()}')

    _add("show/venue", "laanc_ceiling_ft", str(venue.get("laanc_ceiling_ft", "")),
         "literal:decimal", 0,
         f'"laanc_ceiling_ft": {venue.get("laanc_ceiling_ft", 0)}')

    _add("show/venue", "authorization_required",
         str(venue["authorization_required"]).lower(), "literal:string", 0,
         f'"authorization_required": {str(venue["authorization_required"]).lower()}')

    _add("show/venue", "latitude", str(venue["latitude"]), "literal:decimal", 0,
         f'"latitude": {venue["latitude"]}')

    _add("show/venue", "longitude", str(venue["longitude"]), "literal:decimal", 0,
         f'"longitude": {venue["longitude"]}')

    if venue.get("data_source"):
        _add("show/venue", "data_source", venue["data_source"], "literal:string", 0,
             f'"data_source": "{venue["data_source"]}"')

    if venue.get("data_retrieved_utc"):
        _add("show/venue", "data_retrieved_utc", venue["data_retrieved_utc"],
             "literal:string", 0,
             f'"data_retrieved_utc": "{venue["data_retrieved_utc"]}"')

    # --- Tier 1: Config / Operational (what the operator chose) ---

    _add("show/config", "show_name", config["show_name"], "literal:string", 1,
         f'"show_name": "{config["show_name"]}"')

    _add("show/config", "drone_count", str(config["drone_count"]),
         "literal:decimal", 1,
         f'"drone_count": {config["drone_count"]}')

    _add("show/config", "formation_type", config["formation_type"],
         "literal:string", 1,
         f'"formation_type": "{config["formation_type"]}"')

    _add("show/config", "max_altitude_ft", str(config["max_altitude_ft"]),
         "literal:decimal", 1,
         f'"max_altitude_ft": {config["max_altitude_ft"]}')

    _add("show/config", "duration_seconds", str(config["duration_seconds"]),
         "literal:decimal", 1,
         f'"duration_seconds": {config["duration_seconds"]}')

    if config.get("geofence_radius_m"):
        _add("show/config", "geofence_radius_m", str(config["geofence_radius_m"]),
             "literal:decimal", 1,
             f'"geofence_radius_m": {config["geofence_radius_m"]}')

    if config.get("min_separation_m"):
        _add("show/config", "min_separation_m", str(config["min_separation_m"]),
             "literal:decimal", 1,
             f'"min_separation_m": {config["min_separation_m"]}')

    if config.get("launch_time_utc"):
        _add("show/config", "launch_time_utc", config["launch_time_utc"],
             "literal:string", 1,
             f'"launch_time_utc": "{config["launch_time_utc"]}"')

    # --- Tier 2: Safety / Contingency (what happens when things go wrong) ---

    fallback_fields = [
        ("wind_gust_fallback", "wind_gust"),
        ("rf_jam_fallback", "rf_jam"),
        ("drone_failure_fallback", "drone_failure"),
        ("gps_spoof_fallback", "gps_spoof"),
        ("battery_low_fallback", "battery_low"),
        ("crowd_incursion_fallback", "crowd_incursion"),
        ("full_disconnect_fallback", "full_disconnect"),
    ]

    for field_key, condition in fallback_fields:
        val = safety.get(field_key, "")
        if val:
            _add("show/safety", f"{condition}_fallback", val, "literal:string", 2,
                 f'"{field_key}": "{val}"')

    # Communication degradation tiers
    tiers = safety.get("comm_degradation_tiers", {})
    for tier_key, tier_action in tiers.items():
        _add("show/safety", tier_key, tier_action, "literal:string", 2,
             f'"{tier_key}": "{tier_action}"')

    return candidates


# ---------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------

def compile_show(
    spec_path: "Path | None",
    out_path: Path,
    signing_key: "bytes | None" = None,
    timestamp: "str | None" = None,
    suite: str = SUITE_MLDSA44,
    _spec_raw: "dict | None" = None,
) -> None:
    """Compile a show_spec.json into a genesis-verifiable shard.

    Output passes: axm-verify shard <out_path>

    Args:
        spec_path:  Path to show_spec.json on disk. Ignored if _spec_raw is provided.
        _spec_raw:  Pre-parsed spec dict. When provided, spec_path is not read.
                    Used by the HTTP server to avoid a round-trip through the filesystem.
    """
    if _spec_raw is not None:
        spec_raw = _spec_raw
        print(f"Show Compiler: spec from caller (HTTP)")
    else:
        print(f"Show Compiler: reading {spec_path}")
        with open(spec_path, "r", encoding="utf-8") as f:
            spec_raw = json.load(f)

    print(f"  Suite: {suite}")

    errors = validate_show_spec(spec_raw)
    if errors:
        for e in errors:
            print(f"  VALIDATION ERROR: {e}")
        raise ValueError(f"Show spec validation failed with {len(errors)} errors")

    print(f"  Validation: PASS")

    if timestamp is None:
        timestamp = (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

    # Build key material (same pattern as compile.py)
    if suite == SUITE_MLDSA44:
        kp = mldsa44_keygen()
        sk_raw = kp.secret_key
        pk_raw = kp.public_key
        private_key_for_cfg = sk_raw + pk_raw
    else:
        nacl_sk = signing_key_from_private_key_bytes(
            signing_key or _CANONICAL_PUBLISHER_SEED
        )
        sk_raw = bytes(nacl_sk)
        pk_raw = bytes(nacl_sk.verify_key)
        private_key_for_cfg = sk_raw

    # Serialize spec as canonical source document
    # This becomes content/source.txt in the shard
    # Every claim cites a fragment from this document
    source_text = json.dumps(spec_raw, indent=2, ensure_ascii=False, sort_keys=True)

    work_dir = Path(tempfile.mkdtemp(prefix="axm_show_"))
    try:
        source_path = work_dir / "source.txt"
        source_path.write_text(source_text, encoding="utf-8")

        candidates = _extract_candidates(spec_raw, source_text)
        if not candidates:
            raise ValueError("No candidates extracted from show spec")

        print(f"  Candidates: {len(candidates)}")

        candidates_path = work_dir / "candidates.jsonl"
        with candidates_path.open("w") as f:
            for c in candidates:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")

        # Build shard title
        show_name = spec_raw.get("config", {}).get("show_name", "Untitled Show")
        venue_name = spec_raw.get("venue", {}).get("name", "Unknown Venue")

        cfg = CompilerConfig(
            source_path=source_path,
            candidates_path=candidates_path,
            out_dir=out_path,
            private_key=private_key_for_cfg,
            publisher_id=_PUBLISHER_ID,
            publisher_name=_PUBLISHER_NAME,
            namespace=_NAMESPACE,
            created_at=timestamp,
            suite=suite,
        )

        ok = compile_generic_shard(cfg)
        if not ok:
            raise RuntimeError(
                "compile_generic_shard returned False (no claims compiled)"
            )

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    # Self-verify (hard invariant: never emit a failing shard)
    result = _verify_shard(
        out_path, trusted_key_path=out_path / "sig" / "publisher.pub"
    )
    if result["status"] != "PASS":
        raise RuntimeError(
            f"Show shard failed self-verification: {result['errors']}"
        )

    # Summary
    manifest = json.loads((out_path / "manifest.json").read_bytes())
    stats = manifest.get("statistics", {})
    merkle = manifest.get("integrity", {}).get("merkle_root", "?")

    print(f"\nPASS: Show Shard written to {out_path}")
    print(f"  Show:     {show_name}")
    print(f"  Venue:    {venue_name}")
    print(f"  Entities: {stats.get('entities', 0)}")
    print(f"  Claims:   {stats.get('claims', 0)}")
    print(f"  Suite:    {manifest.get('suite', suite)}")
    print(f"  Merkle:   {merkle[:32]}...")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.argument("spec", type=click.Path(exists=True, path_type=Path))
@click.argument("out", type=click.Path(path_type=Path))
@click.option(
    "--suite", "suite_name",
    type=click.Choice([SUITE_MLDSA44, SUITE_ED25519]),
    default=SUITE_MLDSA44, show_default=True,
    help="Cryptographic suite.",
)
@click.option("--legacy", is_flag=True, default=False,
              help=f"Alias for --suite {SUITE_ED25519}.")
@click.option("--gold", is_flag=True,
              help="Use canonical test key + timestamp (reproducible gold shards, ed25519).")
def main(spec: Path, out: Path, suite_name: str, legacy: bool, gold: bool) -> None:
    """Compile a show_spec.json into a Genesis shard.

    Output passes axm-verify shard with a clean PASS.
    """
    effective_suite = (
        SUITE_ED25519 if (legacy or suite_name == SUITE_ED25519) else SUITE_MLDSA44
    )
    try:
        compile_show(
            spec, out,
            signing_key=_CANONICAL_PUBLISHER_SEED if gold else None,
            timestamp=GOLD_TIMESTAMP if gold else None,
            suite=effective_suite,
        )
    except Exception as e:
        print(f"FATAL: {e}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
