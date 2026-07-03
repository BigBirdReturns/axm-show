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
# The kernel. Until axm-genesis is on PyPI, pin the commit you build against
# (axm-genesis docs/ADOPTING.md §2); after the v1.0.0 release use the range
# axm-genesis[mldsa-compat]>=1.0.0,<2.
pip install 'axm-genesis[mldsa-compat] @ git+https://github.com/BigBirdReturns/axm-genesis@bdeb2ba07f83ff3fae07e5beb335034f4853a73f'
pip install -e .          # this spoke
```

## Usage

```bash
# One publisher identity, offline: a 3904-byte axm-hybrid1 keypair. There is no
# default signing key — a signature under a published key proves integrity,
# never authenticity, so the spoke embeds none.
axm-build keygen /secure/axm-keys --name publisher

# Compile the KEMT reference show spec
axm-show-compile examples/kemt_show_spec.json show_shard/ \
    --key /secure/axm-keys/publisher.key

# Verify offline, with the trusted key supplied out of band
axm-verify shard show_shard/ --trusted-key /secure/axm-keys/publisher.pub

# Reproducible "gold" shard: same key + a fixed timestamp -> byte-identical
axm-show-compile examples/kemt_show_spec.json show_shard/ \
    --key /secure/axm-keys/publisher.key --created-at 2026-01-01T00:00:00Z

# Reissue: supersede a prior authorization (the kernel seals the lineage)
axm-show-compile examples/kemt_show_spec.json show_shard/ \
    --key /secure/axm-keys/publisher.key --supersedes sh1_<prior-id>
```

## Repository layout

```
axm-show/
  src/axm_show/
    show_schema.py         # schema contract — frozen interface between planner and compiler
    show_compile.py        # show compiler — the spoke (candidate extraction + CLI)
  server/
    server.py              # optional dev bridge: HTTP compile/verify for the UI
  ui/
    glass_onion_final.jsx  # planner / inspector UI (talks to server.py)
  examples/
    kemt_show_spec.json    # KEMT reference spec (San Gabriel Valley Airport)
  tests/
    test_show_compile.py
```

## Shard tiers

| Tier | Source | Claims |
|------|--------|--------|
| 0 | `venue` | Regulatory facts — airspace class, LAANC ceiling, geofence. Immutable. |
| 1 | `config` | Operational parameters — drone count, formation, altitude, duration. |
| 2 | `safety` | Contingency mappings — fallback behavior per failure mode. |

Tier 0 claims cannot be overridden by any activation command. This is not a configuration parameter.

## Fleet cross-reference

A show authorization can name the specific assets cleared to fly it. A future
optional `fleet` block in a `show_spec` cites the flying drones' node-record
shards from [axm-fleet](https://github.com/BigBirdReturns/axm-fleet) by derived
`sh1_` id — a content address, never a live lookup or a code dependency in
either direction. This is forward-looking: the schema block is not yet
implemented.

## Version

axm-show v1.0.0 · depends on axm-genesis 1.0.0rc1 (the frozen v1 kernel) · suite axm-hybrid1
