#!/usr/bin/env python3
"""
ONNX Export Tool for Pilates AI Pose Models
============================================
Exports all 5 YOLO pose models from PyTorch (.pt) to ONNX format with FP16
quantization and graph simplification for deployment via ONNX Runtime (DirectML).

Usage:
    python tools/export_onnx.py

Output:
    config/models/pose{1-5}.onnx   — Exported ONNX models
    config/model-manifest.json     — SHA-256 digests and metadata
"""

import hashlib
import json
import sys
import time
from pathlib import Path

# Resolve paths relative to project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_SRC_DIR = PROJECT_ROOT / "assets" / "models"
MODELS_DST_DIR = PROJECT_ROOT / "config" / "models"
MANIFEST_PATH = PROJECT_ROOT / "config" / "model-manifest.json"

# Model definitions: pose index -> source directory name
POSE_MODELS = {
    1: "pose1",
    2: "pose2",
    3: "pose3",
    4: "pose4",
    5: "pose5",
}

# Export configuration
EXPORT_CONFIG = {
    "format": "onnx",
    "half": True,        # FP16 quantization for smaller size + faster inference
    "dynamic": False,    # Static input shape for DirectML optimization
    "imgsz": 640,        # Fixed 640x640 input resolution
    "simplify": True,    # ONNX graph simplification (folds constants, removes dead nodes)
    "opset": 17,         # ONNX opset 17 for broad ONNX Runtime compatibility
}


def compute_sha256(filepath: Path) -> str:
    """Compute SHA-256 hex digest for a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def export_model(pose_index: int, src_dir_name: str) -> dict:
    """
    Export a single YOLO pose model to ONNX.

    Returns metadata dict with model info, paths, and SHA-256 digest.
    """
    from ultralytics import YOLO

    src_path = MODELS_SRC_DIR / src_dir_name / "best.pt"
    dst_filename = f"pose{pose_index}.onnx"
    dst_path = MODELS_DST_DIR / dst_filename

    if not src_path.exists():
        print(f"  ❌ Source model not found: {src_path}")
        return None

    print(f"  📦 Loading {src_path.name} from {src_dir_name}/...")
    model = YOLO(str(src_path))

    # Extract model metadata before export
    model_info = {
        "pose_index": pose_index,
        "source": str(src_path.relative_to(PROJECT_ROOT)),
        "num_classes": model.model.nc if hasattr(model.model, "nc") else None,
        "num_keypoints": model.model.kpt_shape[0] if hasattr(model.model, "kpt_shape") else None,
        "class_names": model.names if hasattr(model, "names") else {},
    }

    print(f"  🔄 Exporting to ONNX (FP16, imgsz={EXPORT_CONFIG['imgsz']}, opset={EXPORT_CONFIG['opset']})...")
    t0 = time.time()

    # Ultralytics .export() returns the path to the exported file
    # By default it saves next to the source .pt file
    export_path = model.export(**EXPORT_CONFIG)
    export_elapsed = time.time() - t0

    # Move the exported file to our destination directory
    exported = Path(export_path)
    if exported.exists():
        # Copy to destination (Ultralytics exports next to .pt by default)
        import shutil
        shutil.move(str(exported), str(dst_path))
        print(f"  ✅ Exported → {dst_path.relative_to(PROJECT_ROOT)} ({export_elapsed:.1f}s)")
    else:
        print(f"  ❌ Export failed — file not found at {export_path}")
        return None

    # Compute SHA-256 digest
    sha256 = compute_sha256(dst_path)
    file_size_bytes = dst_path.stat().st_size
    file_size_mb = file_size_bytes / (1024 * 1024)

    return {
        "pose": f"pose{pose_index}",
        **model_info,
        "onnx_path": str(dst_path.relative_to(PROJECT_ROOT)),
        "onnx_filename": dst_filename,
        "sha256": sha256,
        "file_size_bytes": file_size_bytes,
        "file_size_mb": round(file_size_mb, 2),
        "export_config": EXPORT_CONFIG,
        "export_time_seconds": round(export_elapsed, 1),
    }


def main():
    print("=" * 60)
    print("  PILATES AI — ONNX Model Export Pipeline")
    print("=" * 60)
    print()

    # Ensure output directory exists
    MODELS_DST_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {
        "version": "2.0.0",
        "format": "ONNX",
        "precision": "FP16",
        "input_shape": [1, 3, EXPORT_CONFIG["imgsz"], EXPORT_CONFIG["imgsz"]],
        "opset": EXPORT_CONFIG["opset"],
        # ONNX deployment catalog — consumed by tools/verify_onnx.py and the
        # Rust inference engine (config/models/*.onnx).
        "onnx_models": [],
    }

    total_start = time.time()
    success_count = 0
    fail_count = 0

    for pose_idx, src_dir in sorted(POSE_MODELS.items()):
        print(f"\n[{pose_idx}/{len(POSE_MODELS)}] Exporting pose{pose_idx}...")
        try:
            result = export_model(pose_idx, src_dir)
            if result:
                manifest["onnx_models"].append(result)
                success_count += 1
            else:
                fail_count += 1
        except Exception as e:
            print(f"  ❌ Error exporting pose{pose_idx}: {e}")
            fail_count += 1

    total_elapsed = time.time() - total_start

    # Write manifest
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\n📋 Manifest written to {MANIFEST_PATH.relative_to(PROJECT_ROOT)}")

    # Summary
    print(f"\n{'=' * 60}")
    print(f"  EXPORT SUMMARY")
    print(f"  ✅ Success: {success_count}  ❌ Failed: {fail_count}")
    print(f"  ⏱  Total time: {total_elapsed:.1f}s")
    total_size = sum(
        m["file_size_mb"] for m in manifest["onnx_models"]
    )
    print(f"  📦 Total ONNX size: {total_size:.1f} MB")
    print(f"{'=' * 60}")

    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
