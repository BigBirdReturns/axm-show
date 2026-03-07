"""
tests/test_show_compile.py

Smoke tests for the show spoke. Validates the full pipeline:
  show_spec.json → compile_show() → shard → axm-verify PASS
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


def test_kemt_spec_validates(tmp_path):
    """kemt_show_spec.json passes schema validation with no errors."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    errors = validate_show_spec(raw)
    assert errors == [], f"Validation errors: {errors}"


def test_kemt_spec_compiles(tmp_path):
    """kemt_show_spec.json compiles to a shard that passes axm-verify."""
    from axm_show.show_compile import compile_show
    from axm_build.sign import SUITE_ED25519

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, suite=SUITE_ED25519)

    assert (out / "manifest.json").exists()
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["spec_version"] == "1.0.0"
    assert manifest["statistics"]["claims"] > 0


def test_show_shard_verifies(tmp_path):
    """Compiled show shard passes axm-verify."""
    from axm_show.show_compile import compile_show
    from axm_build.sign import SUITE_ED25519
    from axm_verify.logic import verify_shard

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, suite=SUITE_ED25519)

    result = verify_shard(out, out / "sig" / "publisher.pub")
    assert result["status"] == "PASS", f"axm-verify failed: {result}"


def test_altitude_ceiling_enforcement():
    """show_spec with max_altitude_ft exceeding LAANC ceiling fails validation."""
    from axm_show.show_schema import validate_show_spec
    raw = json.loads(KEMT_SPEC.read_text())
    raw["config"]["max_altitude_ft"] = 999  # exceeds laanc_ceiling_ft: 200
    errors = validate_show_spec(raw)
    assert any("ceiling" in e.lower() or "altitude" in e.lower() for e in errors), \
        f"Expected ceiling violation error, got: {errors}"


def test_candidate_count(tmp_path):
    """KEMT spec produces expected number of claims (venue + config + safety)."""
    from axm_show.show_compile import compile_show
    from axm_build.sign import SUITE_ED25519

    out = tmp_path / "kemt_shard"
    compile_show(KEMT_SPEC, out, suite=SUITE_ED25519)

    manifest = json.loads((out / "manifest.json").read_text())
    # KEMT spec has ~10 venue + ~8 config + ~11 safety = ~29 claims
    assert manifest["statistics"]["claims"] >= 20, \
        f"Expected >=20 claims, got {manifest['statistics']['claims']}"
