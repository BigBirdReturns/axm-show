# axm-show

Drone show spoke for AXM. Compiles a `show_spec.json` into a genesis-verifiable shard.

Same architecture as `axm-embodied`. Same relationship to genesis. Different domain.

## Spoke contract

```
show_spec.json  →  show_compile.py  →  show_shard/
                        ↓
              axm_build.compiler_generic
                        ↓
              genesis-verifiable shard
                        ↓
              axm-verify shard show_shard/  → PASS
```

No fork from the kernel. `compile_generic_shard` is the only path to a verifiable shard.

## Installation

```bash
pip install axm-genesis  # kernel dependency
pip install -e .          # this spoke
```

## Usage

```bash
# Compile the KEMT reference show spec
axm-show-compile examples/kemt_show_spec.json show_shard/

# Verify the output
axm-verify shard show_shard/

# Use Ed25519 for development / reproducible gold shards
axm-show-compile examples/kemt_show_spec.json show_shard/ --suite ed25519 --gold
```

## Repository layout

```
axm-show/
  src/axm_show/
    show_schema.py      # schema contract — frozen interface between planner and compiler
    show_compile.py     # show compiler — the spoke
  examples/
    kemt_show_spec.json # KEMT reference spec (El Monte, CA)
  tiles/
    kemt-sgv-v1.json    # cached airspace tile — replace with live Aloft pull
  tests/
    test_show_compile.py
  governance/
    trust_store.json
    local_policy.json
```

## Shard tiers

| Tier | Source | Claims |
|------|--------|--------|
| 0 | `venue` | Regulatory facts — airspace class, LAANC ceiling, geofence. Immutable. |
| 1 | `config` | Operational parameters — drone count, formation, altitude, duration. |
| 2 | `safety` | Contingency mappings — fallback behavior per failure mode. |

Tier 0 claims cannot be overridden by any activation command. This is not a configuration parameter.

## Tile files

`tiles/kemt-sgv-v1.json` is a cached FAA airspace tile for KEMT (San Gabriel Valley Airport, El Monte CA).
Replace with a live pull from the Aloft API when developer access is provisioned.

## Version

axm-show v1.0.0 · depends on axm-genesis v1.2.0
