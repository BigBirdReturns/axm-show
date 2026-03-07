"""
axm-show/src/axm_show/show_schema.py

Show Shard Schema Contract
==========================

This file defines the interface between any authoring surface (planner UI,
CLI, API) and the show compiler. It is the frozen contract.

A show_spec is a JSON document with three sections:

  venue    -> Tier 0 claims (regulatory facts, cannot be overridden)
  config   -> Tier 1 claims (operational parameters)
  safety   -> Tier 2 claims (contingency mappings)

The show compiler reads a show_spec, validates it against this schema,
extracts candidates, and delegates to compile_generic_shard. The output
is a genesis-verifiable shard.

Example show_spec.json:
{
  "schema_version": "1.0.0",
  "venue": {
    "name": "San Gabriel Valley Airport (KEMT)",
    "latitude": 34.0861,
    "longitude": -118.0353,
    "airspace_class": "D",
    "max_altitude_agl_ft": 400,
    "laanc_available": true,
    "laanc_ceiling_ft": 200,
    "authorization_required": true,
    "tfrs_active": false,
    "data_source": "aloft",
    "data_retrieved_utc": "2026-03-01T12:00:00Z"
  },
  "config": {
    "show_name": "KEMT Demo Show Alpha",
    "drone_count": 50,
    "formation_type": "grid",
    "max_altitude_ft": 200,
    "duration_seconds": 480,
    "launch_time_utc": "2026-03-15T03:00:00Z",
    "geofence_radius_m": 150,
    "min_separation_m": 3.0
  },
  "safety": {
    "wind_gust_fallback": "hold_position",
    "rf_jam_fallback": "return_home",
    "drone_failure_fallback": "land_in_place",
    "gps_spoof_fallback": "return_home",
    "battery_low_fallback": "land_in_place",
    "crowd_incursion_fallback": "hold_position",
    "full_disconnect_fallback": "land_in_place",
    "comm_degradation_tiers": {
      "tier_0_full_mesh": "execute_full_doctrine",
      "tier_1_degraded_rf": "execute_reduced_doctrine",
      "tier_2_optical_only": "loiter_or_rth",
      "tier_3_full_disconnect": "land_in_place"
    }
  }
}
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Valid values for enum fields
VALID_AIRSPACE_CLASSES = {"A", "B", "C", "D", "E", "G"}
VALID_FORMATION_TYPES = {"grid", "circle", "wave", "sphere", "text", "custom"}
VALID_FALLBACK_BEHAVIORS = {"return_home", "hold_position", "land_in_place", "safe_zone"}
VALID_DATA_SOURCES = {"aloft", "airhub", "manual", "cached"}

# Comm degradation tier actions
VALID_TIER_ACTIONS = {
    "execute_full_doctrine",
    "execute_reduced_doctrine",
    "loiter_or_rth",
    "hold_position",
    "land_in_place",
    "return_home",
}


@dataclass(frozen=True)
class ShowVenue:
    """Tier-0 regulatory claims. These are facts, not choices."""
    name: str
    latitude: float
    longitude: float
    airspace_class: str
    max_altitude_agl_ft: int
    laanc_available: bool
    laanc_ceiling_ft: int
    authorization_required: bool
    tfrs_active: bool
    data_source: str
    data_retrieved_utc: str


@dataclass(frozen=True)
class ShowConfig:
    """Tier-1 operational claims. What the operator configured."""
    show_name: str
    drone_count: int
    formation_type: str
    max_altitude_ft: int
    duration_seconds: int
    launch_time_utc: str
    geofence_radius_m: float
    min_separation_m: float


@dataclass(frozen=True)
class ShowSafety:
    """Tier-2 contingency claims. What happens when things go wrong."""
    wind_gust_fallback: str
    rf_jam_fallback: str
    drone_failure_fallback: str
    gps_spoof_fallback: str
    battery_low_fallback: str
    crowd_incursion_fallback: str
    full_disconnect_fallback: str
    comm_degradation_tiers: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ShowSpec:
    """Complete show specification. Input to the show compiler."""
    schema_version: str
    venue: ShowVenue
    config: ShowConfig
    safety: ShowSafety


def validate_show_spec(raw: dict[str, Any]) -> list[str]:
    """Validate a raw JSON dict against the show schema.

    Returns a list of error strings. Empty list means valid.
    """
    errors: list[str] = []

    if "schema_version" not in raw:
        errors.append("Missing schema_version")

    # Venue validation
    v = raw.get("venue", {})
    if not v:
        errors.append("Missing venue section")
        return errors

    if v.get("airspace_class", "") not in VALID_AIRSPACE_CLASSES:
        errors.append(f"Invalid airspace_class: {v.get('airspace_class')}")

    if not isinstance(v.get("max_altitude_agl_ft"), (int, float)):
        errors.append("Missing or invalid max_altitude_agl_ft")

    if v.get("data_source", "") not in VALID_DATA_SOURCES:
        errors.append(f"Invalid data_source: {v.get('data_source')}")

    # Config validation
    c = raw.get("config", {})
    if not c:
        errors.append("Missing config section")
        return errors

    if c.get("formation_type", "") not in VALID_FORMATION_TYPES:
        errors.append(f"Invalid formation_type: {c.get('formation_type')}")

    if not isinstance(c.get("drone_count"), int) or c["drone_count"] < 1:
        errors.append("drone_count must be a positive integer")

    max_alt = c.get("max_altitude_ft", 0)
    venue_ceiling = v.get("laanc_ceiling_ft", v.get("max_altitude_agl_ft", 400))
    if max_alt > venue_ceiling:
        errors.append(
            f"Show max_altitude_ft ({max_alt}) exceeds venue ceiling ({venue_ceiling})"
        )

    # Safety validation
    s = raw.get("safety", {})
    if not s:
        errors.append("Missing safety section")
        return errors

    for fb_key in [
        "wind_gust_fallback", "rf_jam_fallback", "drone_failure_fallback",
        "gps_spoof_fallback", "battery_low_fallback", "crowd_incursion_fallback",
        "full_disconnect_fallback",
    ]:
        val = s.get(fb_key, "")
        if val not in VALID_FALLBACK_BEHAVIORS:
            errors.append(f"Invalid {fb_key}: {val}")

    tiers = s.get("comm_degradation_tiers", {})
    for tier_key, tier_action in tiers.items():
        if tier_action not in VALID_TIER_ACTIONS:
            errors.append(f"Invalid comm tier action {tier_key}: {tier_action}")

    return errors


def parse_show_spec(raw: dict[str, Any]) -> ShowSpec:
    """Parse a validated raw dict into a ShowSpec."""
    v = raw["venue"]
    c = raw["config"]
    s = raw["safety"]

    return ShowSpec(
        schema_version=raw["schema_version"],
        venue=ShowVenue(
            name=v["name"],
            latitude=v["latitude"],
            longitude=v["longitude"],
            airspace_class=v["airspace_class"],
            max_altitude_agl_ft=v["max_altitude_agl_ft"],
            laanc_available=v["laanc_available"],
            laanc_ceiling_ft=v.get("laanc_ceiling_ft", v["max_altitude_agl_ft"]),
            authorization_required=v["authorization_required"],
            tfrs_active=v.get("tfrs_active", False),
            data_source=v.get("data_source", "manual"),
            data_retrieved_utc=v.get("data_retrieved_utc", ""),
        ),
        config=ShowConfig(
            show_name=c["show_name"],
            drone_count=c["drone_count"],
            formation_type=c["formation_type"],
            max_altitude_ft=c["max_altitude_ft"],
            duration_seconds=c["duration_seconds"],
            launch_time_utc=c.get("launch_time_utc", ""),
            geofence_radius_m=c.get("geofence_radius_m", 100.0),
            min_separation_m=c.get("min_separation_m", 3.0),
        ),
        safety=ShowSafety(
            wind_gust_fallback=s["wind_gust_fallback"],
            rf_jam_fallback=s["rf_jam_fallback"],
            drone_failure_fallback=s["drone_failure_fallback"],
            gps_spoof_fallback=s["gps_spoof_fallback"],
            battery_low_fallback=s["battery_low_fallback"],
            crowd_incursion_fallback=s["crowd_incursion_fallback"],
            full_disconnect_fallback=s["full_disconnect_fallback"],
            comm_degradation_tiers=s.get("comm_degradation_tiers", {}),
        ),
    )
