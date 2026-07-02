#!/usr/bin/env python3
"""
axm-show/server/server.py

HTTP bridge: Glass Onion React UI  <-->  real AXM show compiler + verifier.

Endpoints:
    POST /show/compile    compile show_spec.json, return manifest + claims
    POST /show/verify     run axm-verify on a compiled shard
    GET  /health          liveness

Usage:
    cd server/
    AXM_SHOW_KEY=/secure/axm-keys/publisher.key python server.py   # port 8400
    PORT=9000 python server.py                                     # custom port

Signing key:
    AXM_SHOW_KEY must point at a 3904-byte axm-hybrid1 secret key blob
    written by `axm-build keygen`. If unset, the server generates an
    EPHEMERAL keypair at boot — fine for the demo loop, but the shards it
    signs prove integrity only, never authenticity, and cannot be
    re-verified after the process exits. There is deliberately no
    committed default key.

Trust anchor:
    /show/verify checks shards against the server's own publisher public
    key (held out of band, written once at boot) — never against the
    publisher.pub embedded in the shard being verified.

The React UI sets BACKEND_URL = "http://localhost:8400" and the demo becomes real.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import traceback
from pathlib import Path

from flask import Flask, jsonify, request
from flask.wrappers import Response

# ── Locate axm packages ──────────────────────────────────────────────────────
# Convention: this file lives in axm-show/server/ and axm-genesis/ is cloned
# beside axm-show/. Prefer `pip install axm-genesis axm-show`; the sys.path
# fallback below is for running straight from checkouts.

import sys
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent

GENESIS_SRC = Path(os.environ.get("AXM_GENESIS_SRC", _ROOT / "axm-genesis" / "src"))
SHOW_SRC    = Path(os.environ.get("AXM_SHOW_SRC",    _HERE.parent / "src"))

for p in [str(GENESIS_SRC), str(SHOW_SRC)]:
    if p not in sys.path:
        sys.path.insert(0, p)

from axm_build.sign import (                                        # noqa: E402
    HYBRID1_SK_LEN,
    SUITE_HYBRID1,
    hybrid1_keygen,
    hybrid1_public_key,
)
from axm_show.show_compile import compile_show                      # noqa: E402
from axm_show.show_schema import validate_show_spec                 # noqa: E402
from axm_verify.logic import verify_shard as _verify_shard          # noqa: E402

# ── Config ────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", 8400))
SHARD_DIR = Path(os.environ.get("AXM_SHARD_DIR", tempfile.mkdtemp(prefix="axm_shards_")))
SHARD_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("axm-show-server")

# ── Publisher key ─────────────────────────────────────────────────────────────
_key_env = os.environ.get("AXM_SHOW_KEY", "")
if _key_env:
    SECRET_KEY = Path(_key_env).read_bytes()
    if len(SECRET_KEY) != HYBRID1_SK_LEN:
        raise SystemExit(
            f"AXM_SHOW_KEY is not a {HYBRID1_SK_LEN}-byte axm-hybrid1 secret key "
            f"blob (got {len(SECRET_KEY)} bytes). Generate one with: "
            f"axm-build keygen <outdir> --name publisher"
        )
    PUBLIC_KEY = hybrid1_public_key(SECRET_KEY)
    log.info(f"Publisher key: {_key_env}")
else:
    PUBLIC_KEY, SECRET_KEY = hybrid1_keygen()
    log.warning(
        "AXM_SHOW_KEY not set — using an EPHEMERAL keypair. Shards signed "
        "this session prove integrity only, never authenticity, and cannot "
        "be re-verified after the server exits."
    )

# The out-of-band trust anchor for /show/verify: the server's own public
# key, written once at boot. Never the publisher.pub inside the shard.
TRUSTED_PUB_PATH = SHARD_DIR / "trusted_publisher.pub"
TRUSTED_PUB_PATH.write_bytes(PUBLIC_KEY)

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


# ── CORS (dev only) ──────────────────────────────────────────────────────────
@app.after_request
def _cors(resp: Response) -> Response:
    origin = os.environ.get("CORS_ORIGIN", "*")
    resp.headers["Access-Control-Allow-Origin"]  = origin
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


# ── Health ────────────────────────────────────────────────────────────────────
@app.route("/health")
def health() -> Response:
    shards = [d.name for d in SHARD_DIR.iterdir() if d.is_dir()] if SHARD_DIR.exists() else []
    return jsonify({"status": "ok", "suite": SUITE_HYBRID1, "shards": len(shards)})


# ── Compile ───────────────────────────────────────────────────────────────────
@app.route("/show/compile", methods=["POST", "OPTIONS"])
def compile_endpoint() -> Response:
    if request.method == "OPTIONS":
        return jsonify({}), 200

    spec_raw: dict = request.get_json(force=True, silent=True) or {}
    if not spec_raw:
        return jsonify({"status": "FAIL", "errors": ["Empty or invalid JSON body"]}), 400

    # Validate before touching disk
    errors = validate_show_spec(spec_raw)
    if errors:
        return jsonify({"status": "FAIL", "errors": errors}), 422

    out_dir = Path(tempfile.mkdtemp(prefix="axm_show_", dir=SHARD_DIR))
    try:
        # Shard identity is derived, never stored (spec §9):
        # compile_show returns "sh1_" + BLAKE3(manifest bytes).
        shard_id = compile_show(
            spec_path=None,
            out_path=out_dir,
            secret_key=SECRET_KEY,
            _spec_raw=spec_raw,
        )

        # Read real outputs
        manifest = json.loads((out_dir / "manifest.json").read_bytes())
        source_text = (out_dir / "content" / "source.txt").read_text(encoding="utf-8")
        claims = _read_claims_with_evidence(out_dir)
        entities = _read_entity_labels(out_dir)

        stats = manifest.get("statistics", {})
        t = {0: 0, 1: 0, 2: 0}
        for c in claims:
            t[int(c.get("tier", 0))] = t.get(int(c.get("tier", 0)), 0) + 1

        # Rename to canonical shard_id so /show/verify can find it
        final = SHARD_DIR / shard_id
        if final.exists():
            shutil.rmtree(final)
        out_dir.rename(final)

        log.info(f"PASS: {shard_id[:40]}  claims={len(claims)}")

        return jsonify({
            "status": "PASS",
            "shard_id":    shard_id,
            "merkle_root": manifest["integrity"]["merkle_root"],
            "suite":       manifest.get("suite", SUITE_HYBRID1),
            "timestamp":   manifest["metadata"]["created_at"],
            "manifest":    manifest,
            "source_text": source_text,
            "claims":      claims,
            "entities":    len(entities),
            "stats": {"claims": len(claims), "entities": len(entities), "t0": t[0], "t1": t[1], "t2": t[2]},
        })

    except Exception as exc:
        traceback.print_exc()
        return jsonify({"status": "FAIL", "errors": [str(exc)]}), 500
    finally:
        # Clean up only if rename didn't happen (error path)
        if out_dir.exists():
            shutil.rmtree(out_dir, ignore_errors=True)


# ── Verify ────────────────────────────────────────────────────────────────────
@app.route("/show/verify", methods=["POST", "OPTIONS"])
def verify_endpoint() -> Response:
    """Run real axm-verify on a shard that was compiled by /show/compile."""
    if request.method == "OPTIONS":
        return jsonify({}), 200

    body: dict = request.get_json(force=True, silent=True) or {}
    shard_id = body.get("shard_id", "")
    if not shard_id:
        return jsonify({"status": "FAIL", "errors": ["Missing shard_id"]}), 400

    shard_path = SHARD_DIR / shard_id
    if not shard_path.exists():
        return jsonify({"status": "FAIL", "errors": [f"Shard not on disk: {shard_id[:40]}…"]}), 404

    try:
        # Trusted key supplied out of band (the server's own publisher key),
        # never the publisher.pub embedded in the shard.
        result = _verify_shard(shard_path, trusted_key_path=TRUSTED_PUB_PATH)

        # Normalize the result for the React UI
        checks = result.get("checks", [])
        if not checks and "status" in result:
            # Flat result format: synthesize check list
            checks = [{"name": "axm-verify", "status": result["status"], "detail": json.dumps(result.get("errors", []))}]

        return jsonify({
            "status": result.get("status", "FAIL"),
            "checks": checks,
            "errors": result.get("errors", []),
            "profiles_checked":   result.get("profiles_checked", []),
            "profiles_unchecked": result.get("profiles_unchecked", []),
        })
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"status": "FAIL", "errors": [str(exc)]}), 500


# ── Helpers ───────────────────────────────────────────────────────────────────

def _read_jsonl(path: Path) -> list[dict]:
    """Read a canonical JSONL table (one JSON object per line)."""
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _read_entity_labels(shard_dir: Path) -> list[str]:
    """Read entity labels from graph/entities.jsonl."""
    entities = _read_jsonl(shard_dir / "graph" / "entities.jsonl")
    return [str(e.get("label", e.get("entity_id", ""))) for e in entities]


def _read_claims_with_evidence(shard_dir: Path) -> list[dict]:
    """Join claims + provenance + spans to produce enriched claims for the UI.

    Returns: [{ id, subject, predicate, object, object_type, tier, evidence }]
    The "evidence" field is the raw text span from source.txt.
    """
    claims = _read_jsonl(shard_dir / "graph" / "claims.jsonl")
    provenance = _read_jsonl(shard_dir / "graph" / "provenance.jsonl")
    spans = _read_jsonl(shard_dir / "evidence" / "spans.jsonl")
    entities = _read_jsonl(shard_dir / "graph" / "entities.jsonl")

    # entity_id -> label
    eid_label = {e["entity_id"]: e["label"] for e in entities}

    # (source_hash, byte_start, byte_end) -> span text
    span_text = {
        (s.get("source_hash"), s.get("byte_start"), s.get("byte_end")): s.get("text", "")
        for s in spans
    }

    # claim_id -> evidence text (via provenance byte ranges -> spans)
    claim_ev: dict[str, str] = {}
    for prov in provenance:
        key = (prov.get("source_hash"), prov.get("byte_start"), prov.get("byte_end"))
        if key in span_text:
            claim_ev[prov.get("claim_id", "")] = span_text[key]

    result = []
    for c in claims:
        cid = c["claim_id"]
        result.append({
            "id":          cid,
            "subject":     eid_label.get(c["subject"], c["subject"]),
            "predicate":   c["predicate"],
            "object":      c["object"],
            "object_type": c["object_type"],
            "tier":        int(c.get("tier", 0)),
            "evidence":    claim_ev.get(cid, ""),
        })
    return result


# ── Entry ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"AXM Show Server  http://localhost:{PORT}")
    print(f"  Genesis: {GENESIS_SRC}")
    print(f"  Show:    {SHOW_SRC}")
    print(f"  Shards:  {SHARD_DIR}")
    print(f"  Suite:   {SUITE_HYBRID1}")
    print(f"  Trusted key: {TRUSTED_PUB_PATH}")
    app.run(host="127.0.0.1", port=PORT, debug=False)
