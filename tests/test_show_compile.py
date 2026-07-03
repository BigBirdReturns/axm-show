"""
tests/test_show_compile.py

Smoke tests for the show spoke. Validates the full pipeline:
  show_spec.json -> compile_show() -> shard -> axm-verify PASS

Keys are throwaway axm-hybrid1 keypairs generated per run — a signature under a
published key proves integrity, never authenticity, and the spoke embeds none.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

EXAMPLES_DIR = Path(__file__).resolve().parents[1] / "examples"
KEMT_SPEC = EXAMPLES_DIR / "kemt_show_spec.json"


@pytest.fixture(scope="session")
def signing_key() -> bytes:
    """A throwaway 3904-byte axm-hybrid1 secret blob (proves nothing)."""
    from axm_build.sign import hybrid1_keygen
    _pub, sec = hybrid1_keygen()
    return sec


def test_kemt_spec_validates():
    """kemt_show_spec.json passes schema validation with no errors."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    errors = validate_show_spec(raw)
    assert errors == [], f"Validation errors: {errors}"


def test_kemt_spec_compiles(tmp_path, signing_key):
    """kemt_show_spec.json compiles to a v1 (axm-hybrid1) shard."""
    from axm_show.show_compile import compile_show

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, signing_key=signing_key)

    assert (out / "manifest.json").exists()
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["spec_version"] == "1.0.0"
    assert manifest["suite"] == "axm-hybrid1"
    assert "shard_id" not in manifest          # identity is derived, never stored
    assert manifest["statistics"]["claims"] > 0


def test_show_shard_verifies(tmp_path, signing_key):
    """Compiled show shard passes axm-verify."""
    from axm_show.show_compile import compile_show
    from axm_verify.logic import verify_shard

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, signing_key=signing_key)

    result = verify_shard(out, out / "sig" / "publisher.pub")
    assert result["status"] == "PASS", f"axm-verify failed: {result}"


def test_tamper_roundtrip(tmp_path, signing_key):
    """The minimum every spoke ships (ADOPTING §5): flip one sealed byte,
    verification must FAIL with E_MERKLE_MISMATCH."""
    from axm_show.show_compile import compile_show
    from axm_verify.logic import verify_shard

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, signing_key=signing_key)
    pub = out / "sig" / "publisher.pub"
    assert verify_shard(out, pub)["status"] == "PASS"

    src = out / "content" / "source.txt"
    b = bytearray(src.read_bytes())
    b[0] ^= 0xFF
    src.write_bytes(bytes(b))

    result = verify_shard(out, pub)
    assert result["status"] == "FAIL"
    assert any(e["code"] == "E_MERKLE_MISMATCH" for e in result["errors"])


def test_altitude_ceiling_enforcement():
    """show_spec with max_altitude_ft exceeding LAANC ceiling fails validation."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    raw["config"]["max_altitude_ft"] = 999  # exceeds laanc_ceiling_ft: 200
    errors = validate_show_spec(raw)
    assert any("ceiling" in e.lower() or "altitude" in e.lower() for e in errors), \
        f"Expected ceiling violation error, got: {errors}"


def test_candidate_count(tmp_path, signing_key):
    """KEMT spec produces expected number of claims (venue + config + safety)."""
    from axm_show.show_compile import compile_show

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, signing_key=signing_key)

    manifest = json.loads((out / "manifest.json").read_text())
    # KEMT spec has ~11 venue + ~8 config + ~11 safety = ~30 claims
    assert manifest["statistics"]["claims"] >= 20, \
        f"Expected >=20 claims, got {manifest['statistics']['claims']}"
