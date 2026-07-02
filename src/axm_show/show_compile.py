#!/usr/bin/env python3
"""
axm-show/src/axm_show/show_compile.py

Show Shard Compiler
===================

Compiles a show_spec.json into a genesis-verifiable shard.

The spoke owns exactly three things (docs/ADOPTING.md in axm-genesis):
domain extraction, its CLI, and its dependency declarations. Everything
else — compilation, signing, Merkle construction, identity derivation —
is the kernel's:

  1. Parse domain-specific input (show_spec.json)
  2. Extract candidates (subject/predicate/object/tier/evidence)
  3. Delegate to compile_generic_shard (the only path to a verifiable shard;
     it writes the shard AND self-verifies it against the publisher key)

Usage:
    axm-show-compile <show_spec.json> <out_dir> --key <publisher.key>

The output shard passes:
    axm-verify shard <out_dir> --trusted-key <publisher.pub>

There is deliberately no default signing key. A signature under a
published key proves integrity, never authenticity — generate a keypair
with `axm-build keygen` and keep the secret blob out of the repository.
"""
from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import blake3
import click

# Genesis kernel: the only path to a verifiable shard
from axm_build.common import normalize_source_text
from axm_build.compiler_generic import CompilerConfig, compile_generic_shard
from axm_build.sign import HYBRID1_SK_LEN

# Show schema: validation and parsing
from axm_show.show_schema import validate_show_spec

_NAMESPACE = "embodied/show"
_PUBLISHER_ID = "@axm_show"
_PUBLISHER_NAME = "AXM Show Compiler"


# ---------------------------------------------------------------------------
# Candidate extraction
# ---------------------------------------------------------------------------

def _extract_candidates(spec_raw: dict, source_text: str) -> list[dict]:
    """Extract genesis-compatible candidates from a show spec.

    Each candidate has: subject, predicate, object, object_type, tier, evidence.
    Evidence must appear exactly once in the normalized source text;
    compile_generic_shard enforces this.
    """
    candidates: list[dict] = []

    # We need evidence strings that are unique substrings of source_text.
    # Since source_text IS the (normalized) JSON, we use key:value pairs
    # that appear exactly once in the serialized document.

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

    def _json_bool(value: bool) -> str:
        return "true" if value else "false"

    # --- Tier 0: Venue / Regulatory (facts, not choices) ---

    # Each evidence string is a unique JSON fragment from the source
    _add("show/venue", "name", venue["name"], "literal:string", 0,
         f'"name": "{venue["name"]}"')

    _add("show/venue", "airspace_class", venue["airspace_class"], "literal:string", 0,
         f'"airspace_class": "{venue["airspace_class"]}"')

    _add("show/venue", "max_altitude_agl_ft", str(venue["max_altitude_agl_ft"]),
         "literal:integer", 0,
         f'"max_altitude_agl_ft": {venue["max_altitude_agl_ft"]}')

    _add("show/venue", "laanc_available", _json_bool(venue["laanc_available"]),
         "literal:boolean", 0,
         f'"laanc_available": {_json_bool(venue["laanc_available"])}')

    _add("show/venue", "laanc_ceiling_ft", str(venue.get("laanc_ceiling_ft", "")),
         "literal:integer", 0,
         f'"laanc_ceiling_ft": {venue.get("laanc_ceiling_ft", 0)}')

    _add("show/venue", "authorization_required",
         _json_bool(venue["authorization_required"]), "literal:boolean", 0,
         f'"authorization_required": {_json_bool(venue["authorization_required"])}')

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
         "literal:integer", 1,
         f'"drone_count": {config["drone_count"]}')

    _add("show/config", "formation_type", config["formation_type"],
         "literal:string", 1,
         f'"formation_type": "{config["formation_type"]}"')

    _add("show/config", "max_altitude_ft", str(config["max_altitude_ft"]),
         "literal:integer", 1,
         f'"max_altitude_ft": {config["max_altitude_ft"]}')

    _add("show/config", "duration_seconds", str(config["duration_seconds"]),
         "literal:integer", 1,
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

def _load_secret_key(key_path: "Path | None", secret_key: "bytes | None") -> bytes:
    if secret_key is None:
        if key_path is None:
            raise ValueError(
                "A signing key is required: pass key_path (the 3904-byte "
                "axm-hybrid1 secret key blob written by `axm-build keygen`) "
                "or secret_key bytes. There is deliberately no default key."
            )
        secret_key = Path(key_path).read_bytes()
    if len(secret_key) != HYBRID1_SK_LEN:
        raise ValueError(
            f"Signing key is not a {HYBRID1_SK_LEN}-byte axm-hybrid1 secret "
            f"key blob (got {len(secret_key)} bytes). Generate one with: "
            f"axm-build keygen <outdir> --name <publisher>"
        )
    return secret_key


def compile_show(
    spec_path: "Path | None",
    out_path: Path,
    key_path: "Path | None" = None,
    *,
    secret_key: "bytes | None" = None,
    created_at: "str | None" = None,
    _spec_raw: "dict | None" = None,
) -> str:
    """Compile a show_spec.json into a genesis-verifiable shard.

    Returns the derived shard identity ("sh1_" + BLAKE3 of the manifest
    bytes — spec §9: identity is derived, never stored).

    Output passes: axm-verify shard <out_path> --trusted-key <publisher.pub>

    Args:
        spec_path:  Path to show_spec.json on disk. Ignored if _spec_raw is provided.
        key_path:   Path to the 3904-byte axm-hybrid1 secret key blob
                    (axm-build keygen). The blob stays outside the repository.
        secret_key: The key blob itself, for callers that hold it in memory
                    (e.g. the HTTP server). Takes precedence over key_path.
        created_at: RFC 3339 UTC timestamp with Z suffix. Defaults to now;
                    pass a fixed value for reproducible builds.
        _spec_raw:  Pre-parsed spec dict. When provided, spec_path is not read.
                    Used by the HTTP server to avoid a filesystem round-trip.
    """
    if _spec_raw is not None:
        spec_raw = _spec_raw
        print("Show Compiler: spec from caller (HTTP)")
    else:
        print(f"Show Compiler: reading {spec_path}")
        with open(spec_path, "r", encoding="utf-8") as f:
            spec_raw = json.load(f)

    key_blob = _load_secret_key(key_path, secret_key)

    errors = validate_show_spec(spec_raw)
    if errors:
        for e in errors:
            print(f"  VALIDATION ERROR: {e}")
        raise ValueError(f"Show spec validation failed with {len(errors)} errors")

    print("  Validation: PASS")

    if created_at is None:
        created_at = (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

    # Serialize spec as canonical source document. This becomes
    # content/source.txt in the shard; every claim cites a fragment of it.
    # Normalize exactly as the kernel will, so evidence uniqueness is
    # checked against the same bytes the shard seals.
    source_text = normalize_source_text(
        json.dumps(spec_raw, indent=2, ensure_ascii=False, sort_keys=True)
    )

    candidates = _extract_candidates(spec_raw, source_text)
    if not candidates:
        raise ValueError("No candidates extracted from show spec")

    print(f"  Candidates: {len(candidates)}")

    show_name = spec_raw.get("config", {}).get("show_name", "Untitled Show")
    venue_name = spec_raw.get("venue", {}).get("name", "Unknown Venue")

    out_path = Path(out_path)

    with tempfile.TemporaryDirectory(prefix="axm_show_") as tmp:
        work_dir = Path(tmp)
        source_path = work_dir / "source.txt"
        source_path.write_text(source_text, encoding="utf-8")

        candidates_path = work_dir / "candidates.jsonl"
        with candidates_path.open("w", encoding="utf-8") as f:
            for c in candidates:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")

        cfg = CompilerConfig(
            source_path=source_path,
            candidates_path=candidates_path,
            out_dir=out_path,
            private_key=key_blob,
            publisher_id=_PUBLISHER_ID,
            publisher_name=_PUBLISHER_NAME,
            namespace=_NAMESPACE,
            created_at=created_at,
            title=show_name,
        )

        # compile_generic_shard writes the shard AND self-verifies it against
        # the publisher key; False means the kernel rejected its own output.
        if not compile_generic_shard(cfg):
            raise RuntimeError(f"Shard failed kernel self-verification: {out_path}")

    manifest_bytes = (out_path / "manifest.json").read_bytes()
    shard_id = "sh1_" + blake3.blake3(manifest_bytes).hexdigest()

    manifest = json.loads(manifest_bytes)
    stats = manifest.get("statistics", {})
    merkle = manifest.get("integrity", {}).get("merkle_root", "?")

    print(f"\nPASS: Show Shard written to {out_path}")
    print(f"  Show:     {show_name}")
    print(f"  Venue:    {venue_name}")
    print(f"  Entities: {stats.get('entities', 0)}")
    print(f"  Claims:   {stats.get('claims', 0)}")
    print(f"  Suite:    {manifest.get('suite', '?')}")
    print(f"  Merkle:   {merkle[:32]}...")
    print(f"  Shard id: {shard_id}")

    return shard_id


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("compile")
@click.argument("spec", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.argument("out", type=click.Path(file_okay=False, path_type=Path))
@click.option(
    "--key", "key_path", required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="3904-byte axm-hybrid1 secret key blob (axm-build keygen). "
         "No default: a shard signed with a published key proves "
         "integrity, never authenticity.",
)
@click.option(
    "--created-at", "created_at", default=None,
    help="RFC 3339 UTC timestamp with Z suffix (default: now). "
         "Pass a fixed value for reproducible builds.",
)
def main(spec: Path, out: Path, key_path: Path, created_at: "str | None") -> None:
    """Compile a show_spec.json into a Genesis shard.

    Output passes `axm-verify shard OUT --trusted-key <publisher.pub>`
    with a clean PASS. Prints the derived sh1_ shard identity.
    """
    try:
        compile_show(spec, out, key_path, created_at=created_at)
    except Exception as e:
        print(f"FATAL: {e}")
        raise SystemExit(1)


@click.group("show")
def show_group() -> None:
    """Drone show spoke: show_spec.json in, signed AXM shard out."""


show_group.add_command(main)


if __name__ == "__main__":
    main()
