#!/usr/bin/env python3
"""
Fetches the ONNX Runtime shared library used by the Rust inference engine.

Why this script exists
----------------------
The Rust crate `ort` is configured with `load-dynamic`, so it does not link
against ONNX Runtime at build time. That keeps the project buildable with the
GNU toolchain (pyke.io publishes no `windows-gnu` binaries) and lets the engine
degrade gracefully when the runtime is absent. The flip side is that the shared
library must be shipped alongside the application -- which is this script's job.

A dynamically loaded shared library is toolchain-agnostic: an MSVC-built DLL
loads happily inside a GNU-built executable, and the same `ort` build can load
the macOS `.dylib` or Linux `.so` at runtime.

On the DirectML execution provider
----------------------------------
The plan's Tier 1 (DirectML on any DX12 GPU) cannot be satisfied with an
official prebuilt binary today:

  * Microsoft stopped publishing `-directml` GitHub assets after v1.24.x, and
    the `Microsoft.ML.OnnxRuntime.DirectML` NuGet package also tops out at
    1.24.4.
  * pyke's DirectML artifact contains `DirectML.dll` plus a 360 MB
    `onnxruntime.lib` (static import library) and **no** `onnxruntime.dll`,
    so it is unusable with dynamic loading.
  * `ort` 2.0.0-rc.15 binds the ONNX Runtime **1.31** API, so a 1.24 DLL would
    be version-incompatible anyway.

We therefore ship the version-matched CPU build. The engine still attempts
DirectML first at runtime, so dropping in a DML-enabled `onnxruntime.dll` built
against the matching API is enough to enable GPU acceleration -- no code change.

Platform artifacts
------------------
Each platform id in `ARTIFACTS` points at the official ONNX Runtime release
archive and declares the library files that must end up in `resources/`. All
three are pinned to a SHA-256; a mismatch deletes the archive and fails.

Note that Microsoft publishes **no** macOS x86_64 and no universal2 artifact
for 1.31.1 -- the release contains `osx-arm64` only. Apple Silicon is therefore
the only supported macOS target; an Intel Mac would need ONNX Runtime built
from source. `detect_platform` returns None there rather than silently
installing the arm64 build.

Usage:
    python tools/fetch_onnxruntime.py                       # detect platform, download if missing
    python tools/fetch_onnxruntime.py --platform linux-x64  # explicit artifact
    python tools/fetch_onnxruntime.py --force               # re-download
    python tools/fetch_onnxruntime.py --verify              # check only, no download
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import platform
import shutil
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESOURCES_DIR = PROJECT_ROOT / "apps" / "desktop" / "src-tauri" / "resources"
CACHE_DIR = RESOURCES_DIR / ".cache"

# `ort` 2.0.0-rc.15 binds ONNX Runtime 1.31, so every artifact must be 1.31.x.
#
# `libraries` are fnmatch patterns matched against the basename inside the
# archive. `required` lists the canonical names that must exist in resources/
# after installation. `aliases` maps a canonical name to the versioned files
# that can stand in for it when the archive's symlink cannot be reproduced.
ARTIFACTS = {
    "windows-x64": {
        "label": "ONNX Runtime 1.31.1 (Windows x64, CPU)",
        "url": "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-win-x64-1.31.1.zip",
        "filename": "onnxruntime-win-x64-1.31.1.zip",
        "format": "zip",
        "sha256": "5869e26bb25314375f2d5ef1877e3ea06b1543d6c710e6e4a1ec2f7177ab4b2c",
        "libraries": ("onnxruntime.dll", "onnxruntime_providers_shared.dll"),
        "required": ("onnxruntime.dll", "onnxruntime_providers_shared.dll"),
        "aliases": {},
    },
    "macos-arm64": {
        "label": "ONNX Runtime 1.31.1 (macOS arm64, CPU)",
        # Microsoft publishes **no** osx-x86_64 and no osx-universal2 artifact
        # for 1.31.1 — the release contains osx-arm64 only. An Intel Mac would
        # need ONNX Runtime built from source; see DESKTOP_DEPLOYMENT_READINESS.md.
        "url": "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-osx-arm64-1.31.1.tgz",
        "filename": "onnxruntime-osx-arm64-1.31.1.tgz",
        "format": "tgz",
        "sha256": "2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f",
        "libraries": ("libonnxruntime.dylib", "libonnxruntime.*.dylib"),
        "required": ("libonnxruntime.dylib",),
        "aliases": {"libonnxruntime.dylib": "libonnxruntime.*.dylib"},
    },
    "linux-x64": {
        "label": "ONNX Runtime 1.31.1 (Linux x64, CPU)",
        "url": "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-linux-x64-1.31.1.tgz",
        "filename": "onnxruntime-linux-x64-1.31.1.tgz",
        "format": "tgz",
        "sha256": "c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9",
        "libraries": ("libonnxruntime.so", "libonnxruntime.so.*"),
        "required": ("libonnxruntime.so",),
        "aliases": {"libonnxruntime.so": "libonnxruntime.so.*"},
    },
}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def matches_library(name: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def already_present(spec: dict) -> bool:
    return all((RESOURCES_DIR / name).is_file() for name in spec["required"])


def prune_other_platforms(spec: dict) -> None:
    """Delete shared libraries that belong to a different platform.

    `resources/` is bundled wholesale, so a runtime fetched for one platform on
    a machine that later builds for another would otherwise ship inside the
    installer — tens of megabytes of a library the target cannot load.
    """
    if not RESOURCES_DIR.is_dir():
        return
    removed = 0
    for path in RESOURCES_DIR.iterdir():
        if not path.is_file() or not path.name.startswith(("onnxruntime", "libonnxruntime")):
            continue
        if matches_library(path.name, spec["libraries"]):
            continue
        path.unlink(missing_ok=True)
        removed += 1
    if removed:
        print(f"  [..] removed {removed} shared library file(s) from another platform")


def detect_platform() -> str | None:
    """Map the host OS and architecture to one of the ids in ARTIFACTS."""
    system = sys.platform
    machine = platform.machine().lower()

    if system == "win32" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    if system == "darwin":
        # Microsoft ships osx-arm64 only for 1.31.1; an Intel Mac has no
        # prebuilt runtime, so it must not silently fall through to arm64.
        if machine in ("arm64", "aarch64"):
            return "macos-arm64"
        return None
    if system.startswith("linux") and machine in ("x86_64", "amd64"):
        return "linux-x64"
    return None


def download(url: str, destination: Path, label: str) -> None:
    print(f"  [..] downloading {label}")
    state = {"next": 10}

    def report(block: int, block_size: int, total: int) -> None:
        if total <= 0:
            return
        done = min(block * block_size, total)
        percent = done * 100 // total
        if percent >= state["next"]:
            print(f"       {percent:3d}%  {done / 1048576:5.1f} / {total / 1048576:.1f} MB")
            state["next"] = (percent // 10 + 1) * 10

    urllib.request.urlretrieve(url, destination, reporthook=report)
    print("       done")


def _install_link(destination: Path, target_name: str) -> bool:
    """Reproduce a relative symlink, falling back to a copy.

    The archives are flattened into resources/, so link targets are reduced to
    their basename. Windows generally cannot create symlinks without elevation,
    and a copy is functionally equivalent for the dynamic loader.
    """
    target = RESOURCES_DIR / target_name
    if not target.is_file():
        return False

    try:
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        os.symlink(target_name, destination)
        if destination.is_file():
            return True
    except OSError:
        pass

    if destination.exists() or destination.is_symlink():
        destination.unlink(missing_ok=True)
    shutil.copyfile(target, destination)
    return True


def _ensure_alias(canonical_name: str, versioned_pattern: str) -> Path | None:
    """Ensure the unversioned name exists, copying a versioned library if needed."""
    canonical = RESOURCES_DIR / canonical_name
    if canonical.is_file():
        return None

    candidates = [
        path
        for path in RESOURCES_DIR.iterdir()
        if path.is_file() and fnmatch.fnmatchcase(path.name, versioned_pattern)
    ]
    if not candidates:
        return None

    # The real library has the longest name; intermediate symlinks are shorter.
    source = max(candidates, key=lambda path: (len(path.name), path.name))
    if canonical.exists() or canonical.is_symlink():
        canonical.unlink(missing_ok=True)
    shutil.copyfile(source, canonical)
    return canonical


def _zip_entry_is_symlink(entry: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(entry.external_attr >> 16)


def _extract_zip(archive: Path, patterns: tuple[str, ...]) -> list[Path]:
    extracted: list[Path] = []
    with zipfile.ZipFile(archive) as bundle:
        entries = [entry for entry in bundle.infolist() if not entry.is_dir()]
        for entry in entries:
            if _zip_entry_is_symlink(entry):
                continue
            name = Path(entry.filename).name
            if not matches_library(name, patterns):
                continue
            destination = RESOURCES_DIR / name
            with bundle.open(entry) as source, open(destination, "wb") as out:
                shutil.copyfileobj(source, out)
            extracted.append(destination)
        for entry in entries:
            if not _zip_entry_is_symlink(entry):
                continue
            name = Path(entry.filename).name
            if not matches_library(name, patterns):
                continue
            target_name = Path(bundle.read(entry).decode("utf-8", "replace").strip()).name
            if _install_link(RESOURCES_DIR / name, target_name):
                extracted.append(RESOURCES_DIR / name)
    return extracted


def _extract_tar(archive: Path, patterns: tuple[str, ...]) -> list[Path]:
    extracted: list[Path] = []
    with tarfile.open(archive, mode="r:*") as bundle:
        members = bundle.getmembers()
        for member in members:
            if not member.isfile():
                continue
            name = Path(member.name).name
            if not matches_library(name, patterns):
                continue
            source = bundle.extractfile(member)
            if source is None:
                continue
            destination = RESOURCES_DIR / name
            with source, open(destination, "wb") as out:
                shutil.copyfileobj(source, out)
            extracted.append(destination)
        for member in members:
            if not (member.issym() or member.islnk()):
                continue
            name = Path(member.name).name
            if not matches_library(name, patterns):
                continue
            target_name = Path(member.linkname).name
            if _install_link(RESOURCES_DIR / name, target_name):
                extracted.append(RESOURCES_DIR / name)
    return extracted


def extract(archive: Path, spec: dict) -> list[Path]:
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)
    archive_format = spec["format"]
    if archive_format == "zip":
        files = _extract_zip(archive, spec["libraries"])
    elif archive_format in ("tgz", "tar.gz"):
        files = _extract_tar(archive, spec["libraries"])
    else:
        raise RuntimeError(f"unsupported archive format: {archive_format}")

    for canonical_name, versioned_pattern in spec.get("aliases", {}).items():
        created = _ensure_alias(canonical_name, versioned_pattern)
        if created is not None:
            files.append(created)

    # A symlink and its target can both be reported; keep one entry per name.
    unique: dict[str, Path] = {}
    for path in files:
        unique[path.name] = path
    return list(unique.values())


def report_unpinned_digest(platform_id: str, digest: str) -> None:
    print(f"  [WARN] SHA-256 (computed, not pinned): {digest}")
    print(f"         copy this into ARTIFACTS[{platform_id!r}] to pin it:")
    print(f'             "sha256": "{digest}",')


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch ONNX Runtime for the desktop app",
        epilog="supported platform ids: " + ", ".join(ARTIFACTS),
    )
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    parser.add_argument("--verify", action="store_true", help="only check what is installed")
    parser.add_argument(
        "--platform",
        choices=list(ARTIFACTS),
        help="artifact to fetch (default: detect from the host)",
    )
    parser.add_argument(
        "--allow-unpinned",
        action="store_true",
        help="install an artifact whose SHA-256 is not pinned yet",
    )
    args = parser.parse_args()

    print("=" * 64)
    print("  PILATES AI - ONNX Runtime fetcher")
    print("=" * 64)
    print(f"  target: {RESOURCES_DIR}")

    platform_id = args.platform or detect_platform()
    if platform_id is None:
        print(f"  [FAIL] unsupported platform: {sys.platform!r} / {platform.machine()!r}")
        print(f"         supported ids: {', '.join(ARTIFACTS)}")
        print("         pass --platform <id> to choose one explicitly")
        return 1

    spec = ARTIFACTS[platform_id]
    print(f"  platform: {platform_id} - {spec['label']}")

    if spec["sha256"] is None:
        print("  [WARN] this artifact is not pinned: no SHA-256 is recorded for it")
        print("         an unpinned download cannot be integrity-checked")
        print("         --allow-unpinned is required to install it")

    if args.verify:
        if already_present(spec):
            for name in spec["required"]:
                path = RESOURCES_DIR / name
                print(f"  [OK] {name}  {path.stat().st_size / 1048576:.1f} MB")
            return 0
        missing = [name for name in spec["required"] if not (RESOURCES_DIR / name).is_file()]
        print(f"  [MISSING] {', '.join(missing)} - run without --verify to download")
        return 1

    if already_present(spec) and not args.force:
        for name in spec["required"]:
            path = RESOURCES_DIR / name
            print(f"  [SKIP] {name} already present ({path.stat().st_size / 1048576:.1f} MB)")
        print("  Use --force to re-download.")
        return 0

    if spec["sha256"] is None and not args.allow_unpinned:
        print("  [FAIL] refusing to install an unpinned artifact")
        print("         re-run with --allow-unpinned, or pin its SHA-256 in ARTIFACTS first")
        return 1

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive = CACHE_DIR / spec["filename"]
    expected = spec["sha256"]

    need_download = True
    if archive.is_file() and not args.force:
        actual = sha256_of(archive)
        if expected is None:
            print("  [SKIP] cached archive reused (unpinned - no digest to compare)")
            report_unpinned_digest(platform_id, actual)
            need_download = False
        elif actual == expected:
            print("  [SKIP] cached archive verified")
            need_download = False
        else:
            print("  [..] cached archive does not match the pinned SHA-256; downloading again")

    if need_download:
        try:
            download(spec["url"], archive, spec["label"])
        except Exception as error:  # noqa: BLE001 - surfaced to the operator
            print(f"  [FAIL] download failed: {error}")
            print(f"         If this workstation is air-gapped, copy the {platform_id}")
            print(f"         libraries (including versioned names) into {RESOURCES_DIR} manually.")
            return 1

        actual = sha256_of(archive)
        if expected is not None:
            if actual != expected:
                print("  [FAIL] SHA-256 mismatch - refusing to install an unverified binary")
                print(f"         expected {expected}")
                print(f"         actual   {actual}")
                archive.unlink(missing_ok=True)
                return 1
            print("  [OK] SHA-256 verified")
        else:
            report_unpinned_digest(platform_id, actual)

    try:
        files = extract(archive, spec)
    except Exception as error:  # noqa: BLE001
        print(f"  [FAIL] extraction failed: {error}")
        return 1

    if not files:
        print("  [FAIL] archive contained no matching shared libraries")
        return 1

    prune_other_platforms(spec)

    for path in files:
        print(f"  [OK] installed {path.name}  {path.stat().st_size / 1048576:.1f} MB")

    missing = [name for name in spec["required"] if not (RESOURCES_DIR / name).is_file()]
    if missing:
        print(f"  [FAIL] missing required file(s): {', '.join(missing)}")
        return 1

    print("\n  The engine will now find the runtime automatically at startup.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
