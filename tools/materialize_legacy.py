#!/usr/bin/env python3
"""
Materialises the frozen FlutterFlow-era statistics onto each patient document.

Why
---
The legacy app stored one document per 3-second accuracy sample under
`patients/{id}/pose1..pose5`, plus a few `comments`. Those collections are now
frozen (all eight legacy Cloud Functions were deleted), so the numbers can never
change again. Reading them at display time would mean a subcollection query per
pose per patient.

This script computes the summary once and stores it as a single
`legacy_json` string field on the patient document. The app then needs exactly
one document read per patient, and works offline after a pull.

Design notes
------------
* **`legacy_json` is a string, not a map.** It is a frozen denormalised cache
  that is never queried, and a string keeps the Rust read path identical to the
  existing `document_json` handling. Firestore's typed-value encoding for nested
  maps would add a lot of parsing for no benefit here.
* **Narrow `updateMask`.** Only `legacy_json` is written; `address`, `note`,
  `tel_number`, the legacy `pose{N}_*` aggregates and everything else are
  untouched.
* **Idempotent.** Re-running recomputes from the raw samples and overwrites the
  same field, so it is safe to repeat.

Usage
-----
    python tools/materialize_legacy.py --dry-run     # preview, no writes
    python tools/materialize_legacy.py               # write legacy_json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

POSES = ["pose1", "pose2", "pose3", "pose4", "pose5"]
BASE_TEMPLATE = "https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents"
PAGE_SIZE = 300


def get_token() -> str:
    """Obtain an access token from the gcloud CLI.

    `gcloud` is often absent from PATH in a non-interactive shell (on Windows it
    ships as `gcloud.cmd` inside the Cloud SDK), so try the usual candidates
    before giving up.
    """
    import os
    import shutil

    candidates = [
        os.environ.get("GCLOUD_BIN"),
        shutil.which("gcloud"),
        shutil.which("gcloud.cmd"),
        r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
        r"C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    ]

    for candidate in candidates:
        if not candidate:
            continue
        try:
            token = subprocess.check_output(
                [candidate, "auth", "print-access-token"],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
            if token:
                return token
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            continue

    raise SystemExit(
        "cannot obtain a gcloud access token. Install the Cloud SDK, add it to PATH, "
        "or set GCLOUD_BIN to the gcloud executable."
    )


def call(url: str, token: str, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method or ("PATCH" if data else "GET"))
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()[:300]


def list_patients(base: str, token: str) -> list[dict]:
    patients: list[dict] = []
    page_token = None
    while True:
        url = f"{base}/patients?pageSize={PAGE_SIZE}"
        if page_token:
            url += f"&pageToken={urllib.parse.quote(page_token)}"
        status, body = call(url, token)
        if status != 200:
            raise SystemExit(f"listing patients failed ({status}): {body}")
        patients.extend(body.get("documents", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            return patients


def numeric(field: dict) -> float | None:
    if "doubleValue" in field:
        return float(field["doubleValue"])
    if "integerValue" in field:
        return float(field["integerValue"])
    return None


def read_samples(base: str, token: str, patient_id: str, pose: str) -> dict | None:
    """Aggregate one pose subcollection. Returns None when it is empty."""
    count = 0
    total = 0.0
    minimum = None
    maximum = None
    latest = None
    page_token = None

    while True:
        url = f"{base}/patients/{patient_id}/{pose}?pageSize={PAGE_SIZE}"
        if page_token:
            url += f"&pageToken={urllib.parse.quote(page_token)}"
        status, body = call(url, token)
        if status == 404:
            return None
        if status != 200:
            raise SystemExit(f"reading {patient_id}/{pose} failed ({status}): {body}")

        for document in body.get("documents", []):
            fields = document.get("fields", {})
            accuracy = numeric(fields.get("accuracy", {}))
            if accuracy is None:
                continue
            count += 1
            total += accuracy
            minimum = accuracy if minimum is None else min(minimum, accuracy)
            maximum = accuracy if maximum is None else max(maximum, accuracy)
            stamp = fields.get("timestamp", {}).get("timestampValue")
            if stamp and (latest is None or stamp > latest):
                latest = stamp

        page_token = body.get("nextPageToken")
        if not page_token:
            break

    if count == 0:
        return None

    return {
        "count": count,
        "avg": round(total / count, 4),
        "min": round(minimum, 4),
        "max": round(maximum, 4),
        # The legacy app credited 3 seconds per sample.
        "seconds": count * 3,
        "last_sample_at": latest,
    }


def count_comments(base: str, token: str, patient_id: str) -> int:
    status, body = call(f"{base}/patients/{patient_id}/comments?pageSize=1", token)
    if status != 200:
        return 0
    total = 0
    page_token = body.get("nextPageToken")
    # Only the count matters; walk pages without collecting documents.
    while True:
        url = f"{base}/patients/{patient_id}/comments?pageSize={PAGE_SIZE}"
        if page_token:
            url += f"&pageToken={urllib.parse.quote(page_token)}"
        status, body = call(url, token)
        if status != 200:
            return total
        total += len(body.get("documents", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            return total


def build_legacy(base: str, token: str, patient_id: str) -> dict | None:
    poses: dict[str, dict] = {}
    last_sample = None
    total_samples = 0

    for pose in POSES:
        summary = read_samples(base, token, patient_id, pose)
        if summary is None:
            continue
        poses[pose] = summary
        total_samples += summary["count"]
        stamp = summary.get("last_sample_at")
        if stamp and (last_sample is None or stamp > last_sample):
            last_sample = stamp

    if not poses:
        return None

    return {
        "source": "flutterflow-app",
        "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "last_sample_at": last_sample,
        "total_samples": total_samples,
        "comments_count": count_comments(base, token, patient_id),
        "poses": poses,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialise frozen legacy statistics")
    parser.add_argument("--project", default="pilates-ai")
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    args = parser.parse_args()

    base = BASE_TEMPLATE.format(project=args.project)
    token = get_token()

    print("=" * 66)
    print(f"  Materialise legacy summaries  (project {args.project})")
    print("=" * 66)

    patients = list_patients(base, token)
    print(f"  patients found: {len(patients)}")

    written = skipped = failed = 0
    for document in patients:
        patient_id = document["name"].rsplit("/", 1)[-1]
        fields = document.get("fields", {})
        name = fields.get("name", {}).get("stringValue", "?")

        legacy = build_legacy(base, token, patient_id)
        if legacy is None:
            skipped += 1
            print(f"  [SKIP] {name[:24]:24} no legacy samples")
            continue

        if args.dry_run:
            written += 1
            print(
                f"  [DRY ] {name[:24]:24} poses={len(legacy['poses'])} "
                f"samples={legacy['total_samples']} comments={legacy['comments_count']} "
                f"last={legacy['last_sample_at']}"
            )
            continue

        status, body = call(
            f"{base}/patients/{patient_id}?updateMask.fieldPaths=legacy_json",
            token,
            {"fields": {"legacy_json": {"stringValue": json.dumps(legacy)}}},
        )
        if status == 200:
            written += 1
            print(
                f"  [ OK ] {name[:24]:24} poses={len(legacy['poses'])} "
                f"samples={legacy['total_samples']}"
            )
        else:
            failed += 1
            print(f"  [FAIL] {name[:24]:24} ({status}) {body}")

    print("-" * 66)
    verb = "would write" if args.dry_run else "written"
    print(f"  {verb}: {written}   skipped: {skipped}   failed: {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
