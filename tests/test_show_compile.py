"""
tests/test_show_compile.py

The conformance habit for the show spoke (axm-genesis docs/ADOPTING.md §5):
build → verify PASS → tamper → FAIL, plus the show-domain validation rules.

Keys are throwaway, generated fresh per run — they prove the pipeline,
never authenticity. Real keys live offline, never in tests or CI.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from axm_build.sign import HYBRID1_PK_LEN, HYBRID1_SK_LEN, hybrid1_keygen
from axm_verify.logic import verify_shard

EXAMPLES_DIR = Path(__file__).resolve().parents[1] / "examples"
KEMT_SPEC = EXAMPLES_DIR / "kemt_show_spec.json"
SHARD_ID_RE = re.compile(r"^sh1_[0-9a-f]{64}$")


@pytest.fixture()
def keypair(tmp_path: Path) -> tuple[Path, Path]:
    """Throwaway keypair in tmp; proves the pipeline, never authenticity."""
    public_key, secret_key = hybrid1_keygen()
    assert len(secret_key) == HYBRID1_SK_LEN
    assert len(public_key) == HYBRID1_PK_LEN
    key_path = tmp_path / "test_publisher.key"
    pub_path = tmp_path / "test_publisher.pub"
    key_path.write_bytes(secret_key)
    pub_path.write_bytes(public_key)
    return key_path, pub_path


def test_kemt_spec_validates():
    """kemt_show_spec.json passes schema validation with no errors."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    errors = validate_show_spec(raw)
    assert errors == [], f"Validation errors: {errors}"


def test_build_verify_tamper_roundtrip(tmp_path, keypair):
    """show_spec.json → shard → verify PASS → tamper one byte → FAIL."""
    from axm_show.show_compile import compile_show

    key_path, pub_path = keypair
    out = tmp_path / "kemt_shard"

    shard_id = compile_show(KEMT_SPEC, out, key_path)
    assert SHARD_ID_RE.match(shard_id), shard_id

    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["spec_version"] == "1.0.0"
    assert manifest["suite"] == "axm-hybrid1"
    assert "shard_id" not in manifest  # identity is derived, never stored
    assert manifest["statistics"]["claims"] > 0

    # Verify with the trusted key supplied out of band.
    result = verify_shard(out, trusted_key_path=pub_path)
    assert result["status"] == "PASS", result["errors"]
    assert result["error_count"] == 0
    # Unchecked is not passed — this shard declares no profiles, so both
    # arrays must be present and empty (spec section 13.3).
    assert result["profiles_checked"] == []
    assert result["profiles_unchecked"] == []

    # Tamper one byte of sealed content: verification must FAIL.
    content = out / "content" / "source.txt"
    raw = bytearray(content.read_bytes())
    raw[0] ^= 0x01
    content.write_bytes(bytes(raw))

    tampered = verify_shard(out, trusted_key_path=pub_path)
    assert tampered["status"] == "FAIL"
    codes = {e["code"] for e in tampered["errors"]}
    assert "E_MERKLE_MISMATCH" in codes, codes


def test_wrong_trusted_key_fails(tmp_path, keypair):
    """Trust is anchored out of band: a different key must be rejected."""
    from axm_show.show_compile import compile_show

    key_path, _ = keypair
    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, key_path)

    other_pub, _ = hybrid1_keygen()
    other_path = tmp_path / "other.pub"
    other_path.write_bytes(other_pub)

    result = verify_shard(out, trusted_key_path=other_path)
    assert result["status"] == "FAIL"
    assert {e["code"] for e in result["errors"]} == {"E_SIG_INVALID"}


def test_no_key_refuses(tmp_path):
    """There is deliberately no default signing key."""
    from axm_show.show_compile import compile_show

    with pytest.raises(ValueError, match="no default key"):
        compile_show(KEMT_SPEC, tmp_path / "shard")


def test_bad_key_length_refuses(tmp_path):
    """Unexpected key material must raise, never be coerced or replaced."""
    from axm_show.show_compile import compile_show

    bad_key = tmp_path / "bad.key"
    bad_key.write_bytes(b"\x00" * 64)
    with pytest.raises(ValueError, match="axm-hybrid1"):
        compile_show(KEMT_SPEC, tmp_path / "shard", bad_key)


def test_altitude_ceiling_enforcement():
    """show_spec with max_altitude_ft exceeding LAANC ceiling fails validation."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    raw["config"]["max_altitude_ft"] = 999  # exceeds laanc_ceiling_ft: 200
    errors = validate_show_spec(raw)
    assert any("ceiling" in e.lower() or "altitude" in e.lower() for e in errors), \
        f"Expected ceiling violation error, got: {errors}"


def test_candidate_count(tmp_path, keypair):
    """KEMT spec produces expected number of claims (venue + config + safety + fleet)."""
    from axm_show.show_compile import compile_show

    key_path, _ = keypair
    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, key_path)

    manifest = json.loads((out / "manifest.json").read_text())
    # KEMT spec has ~10 venue + ~8 config + ~11 safety + 2 fleet = ~31 claims
    assert manifest["statistics"]["claims"] >= 20, \
        f"Expected >=20 claims, got {manifest['statistics']['claims']}"


def test_fleet_reference_validates():
    """The KEMT spec's fleet section (axm-fleet node record shard ids) is valid."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    assert len(raw["fleet"]) == 2
    errors = validate_show_spec(raw)
    assert errors == [], f"Validation errors: {errors}"


def test_fleet_bad_shard_id_rejected():
    """A malformed node_record_shard_id must fail validation, not be silently
    dropped — the show shard would otherwise cite a reference nothing can
    verify."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    raw["fleet"][0]["node_record_shard_id"] = "not-a-shard-id"
    errors = validate_show_spec(raw)
    assert any("shard id" in e.lower() for e in errors), errors


def test_fleet_duplicate_asset_id_rejected():
    """Two fleet entries cannot claim the same physical asset_id."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    raw["fleet"][1]["asset_id"] = raw["fleet"][0]["asset_id"]
    errors = validate_show_spec(raw)
    assert any("duplicate asset_id" in e for e in errors), errors


def test_fleet_claims_are_tier_0(tmp_path, keypair):
    """Fleet claims land in the manifest as Tier-0 (facts, not choices) —
    same discipline as the venue's regulatory claims."""
    from axm_show.show_compile import _extract_candidates
    from axm_build.common import normalize_source_text

    raw = json.loads(KEMT_SPEC.read_text())
    source_text = normalize_source_text(
        json.dumps(raw, indent=2, ensure_ascii=False, sort_keys=True)
    )
    candidates = _extract_candidates(raw, source_text)
    fleet_candidates = [c for c in candidates if c["subject"].startswith("show/fleet/")]
    assert len(fleet_candidates) == 2
    assert all(c["tier"] == 0 for c in fleet_candidates)
    assert all(c["object_type"] == "reference:shard_id" for c in fleet_candidates)


def test_reproducible_build(tmp_path, keypair):
    """Same spec + same key + same created_at → byte-identical manifest."""
    from axm_show.show_compile import compile_show

    key_path, _ = keypair
    ts = "2026-07-02T00:00:00Z"
    id_a = compile_show(KEMT_SPEC, tmp_path / "a", key_path, created_at=ts)
    id_b = compile_show(KEMT_SPEC, tmp_path / "b", key_path, created_at=ts)
    assert id_a == id_b
    assert (tmp_path / "a" / "manifest.json").read_bytes() == \
           (tmp_path / "b" / "manifest.json").read_bytes()
