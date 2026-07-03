# axm-show

Drone show spoke for AXM. Compiles a `show_spec.json` into a genesis-verifiable shard.

A spoke owns exactly three things — domain extraction, its CLI, and its
dependency declarations ([ADOPTING.md](https://github.com/BigBirdReturns/axm-genesis/blob/main/docs/ADOPTING.md)).
Compilation, signing, Merkle construction, and identity derivation are the
kernel's. **Genesis compiles and signs; everything else reads.**

## Spoke contract

```
show_spec.json  →  axm-show-compile  →  show_shard/
                        ↓
              axm_build.compiler_generic
                        ↓
              genesis-verifiable shard
                        ↓
   axm-verify shard show_shard/ --trusted-key publisher.pub  → PASS
```

No fork from the kernel. `compile_generic_shard` is the only path to a
verifiable shard. Shard identity is derived, never stored:
`sh1_` + BLAKE3 of the manifest bytes.

## Installation

```bash
pip install axm-genesis[mldsa-compat]  # kernel dependency (>=1.0.0rc1,<2)
pip install -e .                       # this spoke
```

Until the kernel is on PyPI, install it from the repo:
`pip install 'axm-genesis[mldsa-compat] @ git+https://github.com/BigBirdReturns/axm-genesis@main'`.

## Keys

There is deliberately no default signing key — a signature under a
published key proves integrity, never authenticity. Generate a publisher
identity once (hybrid axm-hybrid1: Ed25519 ‖ ML-DSA-44):

```bash
axm-build keygen /secure/axm-keys --name publisher
# Secret key (3904 bytes): /secure/axm-keys/publisher.key  ← stays offline
# Public key (1344 bytes): /secure/axm-keys/publisher.pub  ← distribute this
```

Only the `.pub` file is ever committed or handed to verifiers. Tests use
throwaway keypairs generated per run.

## Usage

```bash
# Compile the KEMT reference show spec
axm-show-compile examples/kemt_show_spec.json show_shard/ --key /secure/axm-keys/publisher.key

# Verify the output with the trusted key, supplied out of band
axm-verify shard show_shard/ --trusted-key /secure/axm-keys/publisher.pub

# Reproducible builds: fix the timestamp (same spec + key + timestamp
# → byte-identical manifest, identical sh1_ id)
axm-show-compile examples/kemt_show_spec.json show_shard/ \
    --key /secure/axm-keys/publisher.key --created-at 2026-07-02T00:00:00Z
```

## Fleet cross-reference

A show's mission authorization is one-shot; the drones flying it have their
own lifecycle, sealed separately by
[`axm-fleet`](https://github.com/BigBirdReturns/axm-fleet) as a chain of
node record shards (`deploy` → `patch` → ... via `supersedes`). The
optional `fleet` section in `show_spec.json` cites, per asset, the
axm-fleet node record shard current at show time:

```json
"fleet": [
  {"asset_id": "node-0042", "node_record_shard_id": "sh1_<64 hex>", "role": "lead"}
]
```

This is a content address, not a live lookup or a code dependency — the
show spoke never imports axm-fleet, signs on its behalf, or resolves the
reference itself. Each cited shard is independently verifiable with its
own trusted key, out of band, exactly like the show shard itself. A
`node_record_shard_id` that isn't a well-formed `sh1_` + 64-hex-char id
fails `validate_show_spec`; the compiler will not seal a claim it cannot
name. Compile the referenced record first with `axm-fleet record`.

`axm-show` seals *mission authorization* (what may fly, under which
ceiling — one-shot); `axm-fleet` seals *fleet lifecycle* (what is running,
and how it got there — a supersedes chain over time); `axm-sfn` seals
*hardware custody* (what the machine attested it did, TPM-bound). Same
kernel, three record types — cross-referenced by shard id, never merged.

## Repository layout

```
axm-show/
  src/axm_show/
    show_schema.py      # schema contract — frozen interface between planner and compiler
    show_compile.py     # show compiler — the spoke
  examples/
    kemt_show_spec.json # KEMT reference spec (El Monte, CA)
  tests/
    test_show_compile.py  # build → verify PASS → tamper → FAIL roundtrip
  server/
    server.py           # HTTP bridge for the Glass Onion planner UI
  ui/
    glass_onion_final.jsx
```

## Shard tiers

| Tier | Source | Claims |
|------|--------|--------|
| 0 | `venue` | Regulatory facts — airspace class, LAANC ceiling, geofence. Immutable. |
| 0 | `fleet` | Which physically-attested drones flew (axm-fleet node record shard ids). Optional. |
| 1 | `config` | Operational parameters — drone count, formation, altitude, duration. |
| 2 | `safety` | Contingency mappings — fallback behavior per failure mode. |

Tier 0 claims cannot be overridden by any activation command. This is not a
configuration parameter.

## Conformance

The shards this spoke emits satisfy the four kernel requirements — REQ 1
manifest integrity, REQ 2 content identity, REQ 3 traceable lineage, REQ 4
proof bundle — defined in the kernel's
[CONFORMANCE.md](https://github.com/BigBirdReturns/axm-genesis/blob/main/spec/v1/CONFORMANCE.md).
The spoke does not check these itself: the kernel verifier runs against the
spoke's own output in the test suite, including the tamper roundtrip
(build → PASS → flip one content byte → FAIL with `E_MERKLE_MISMATCH`)
and the wrong-trusted-key case (`E_SIG_INVALID`).

```bash
pytest tests/ -v
```

## Airspace data

The KEMT example encodes a cached FAA airspace snapshot for San Gabriel
Valley Airport (El Monte, CA) in its `venue` section (`data_source`,
`data_retrieved_utc`). Replace with a live pull from the Aloft API when
developer access is provisioned.

## Version

axm-show v2.0.0 · depends on axm-genesis ≥1.0.0rc1,<2 (the frozen v1 kernel)
