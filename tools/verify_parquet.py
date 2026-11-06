#!/usr/bin/env python3
"""
Validates the telemetry Parquet file with an independent reader.

The Rust tests already round-trip the file through Arrow, but that only proves
the writer agrees with itself. This script reads the same bytes with `polars`
and asserts the published schema from the plan (§4.3), so a reader written in
Python, R or DuckDB can rely on it.

Usage
-----
    # 1. Produce a fixture from the Rust side
    cd apps/desktop/src-tauri
    cargo test writes_parquet_fixture_for_external_validation

    # 2. Validate it
    python tools/verify_parquet.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATH = PROJECT_ROOT / "apps" / "desktop" / "src-tauri" / "target" / "parquet-fixture.parquet"

# Column name -> expected polars dtype, in the order the writer emits them.
EXPECTED_COLUMNS = [
    ("timestamp_ms", "Int64"),
    ("frame_index", "Int32"),
    ("phase", "String"),
    ("primary_angle", "Float32"),
    ("secondary_angle", "Float32"),
    ("form_score", "Float32"),
    ("keypoint_ids", "List(Int8)"),
    ("keypoint_x", "List(Float32)"),
    ("keypoint_y", "List(Float32)"),
    ("keypoint_conf", "List(Float32)"),
    ("model_class", "Int8"),
]

LIST_COLUMNS = ["keypoint_ids", "keypoint_x", "keypoint_y", "keypoint_conf"]

VALID_PHASES = {
    "idle",
    "start_position",
    "eccentric",
    "holding",
    "concentric",
    "rep_completed",
}


def normalise(dtype) -> str:
    """Render a polars dtype the same way regardless of polars version."""
    return str(dtype).replace("Utf8", "String").replace(" ", "")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the telemetry Parquet schema")
    parser.add_argument("--path", default=str(DEFAULT_PATH))
    args = parser.parse_args()

    path = Path(args.path)
    print("=" * 66)
    print("  PILATES AI - Parquet integrity check")
    print("=" * 66)
    print(f"  file: {path}")

    if not path.is_file():
        print("  [FAIL] file not found.")
        print("         Produce it with:")
        print("           cd apps/desktop/src-tauri")
        print("           cargo test writes_parquet_fixture_for_external_validation")
        return 1

    try:
        import polars as pl
    except ImportError:
        print("  [FAIL] polars is not installed. pip install polars")
        return 1

    try:
        frame = pl.read_parquet(path)
    except Exception as error:  # noqa: BLE001 - surfaced to the operator
        print(f"  [FAIL] polars could not read the file: {error}")
        return 1

    failures: list[str] = []

    # --- Schema ----------------------------------------------------------
    actual_columns = list(frame.columns)
    expected_names = [name for name, _ in EXPECTED_COLUMNS]

    if actual_columns != expected_names:
        failures.append(
            f"column mismatch\n    expected: {expected_names}\n    actual:   {actual_columns}"
        )
    else:
        print("  [OK] column names and order match the published schema")

    schema = dict(frame.schema)
    for name, expected_type in EXPECTED_COLUMNS:
        if name not in schema:
            continue
        actual_type = normalise(schema[name])
        if actual_type != expected_type:
            failures.append(f"{name}: expected {expected_type}, got {actual_type}")

    if not any(f.startswith(tuple(name for name, _ in EXPECTED_COLUMNS)) for f in failures):
        print("  [OK] every column has the expected dtype")

    # --- Content ---------------------------------------------------------
    rows = frame.height
    if rows == 0:
        failures.append("file contains no rows")
    else:
        print(f"  [OK] rows: {rows}")

    nulls = frame.null_count()
    total_nulls = sum(nulls.row(0))
    if total_nulls:
        for column in actual_columns:
            count = nulls[column][0]
            if count:
                failures.append(f"{column}: {count} null value(s)")
    else:
        print("  [OK] no null values in any column")

    # --- List columns ----------------------------------------------------
    for column in LIST_COLUMNS:
        if column not in frame.columns:
            continue
        try:
            distinct = frame.select(pl.col(column).list.len().alias("n"))["n"].unique().to_list()
        except Exception as error:  # noqa: BLE001
            failures.append(f"{column}: cannot measure list length ({error})")
            continue
        if len(distinct) != 1:
            failures.append(f"{column}: inconsistent list lengths {distinct}")
        else:
            print(f"  [OK] {column}: {distinct[0]} entries per frame")

    # --- Enum-ish column -------------------------------------------------
    if "phase" in frame.columns:
        observed = set(frame["phase"].unique().to_list())
        unknown = observed - VALID_PHASES
        if unknown:
            failures.append(f"phase contains unexpected values: {sorted(unknown)}")
        else:
            print(f"  [OK] phase values within the contract: {sorted(observed)}")

    # --- Report ----------------------------------------------------------
    print("-" * 66)
    if failures:
        print(f"  FAILED ({len(failures)} problem(s)):")
        for failure in failures:
            print(f"   - {failure}")
        return 1

    print("  PASSED: schema, nulls, list lengths and phase values all conform.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
