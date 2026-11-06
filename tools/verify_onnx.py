#!/usr/bin/env python3
"""
ONNX Verification Tool for Pilates AI Pose Models
===================================================
Validates that each exported ONNX (FP16) model is numerically equivalent to its
source PyTorch (.pt) checkpoint.

Method
------
Both runtimes are fed the **exact same** preprocessed input tensor, and their
**raw** output tensors are compared directly. This deliberately bypasses
Non-Maximum Suppression: NMS is not part of the exported graph, so comparing
post-NMS detection lists would measure the post-processing implementation rather
than the export fidelity (and is order-sensitive).

The raw output layout for Ultralytics YOLO-pose is `(1, C, N)` where
`C = 4 (bbox) + nc (class scores) + nk * 3 (keypoints)` and `N` is the anchor
count (8400 for a 640x640 input).

Acceptance criteria (per MASTER_EXECUTION_PLAN.md Step 2), measured on a real
benchmark photograph:
    - Keypoint coordinate Euclidean distance < 1.5 pixels
    - Class probability difference < 0.01

A synthetic gradient image is additionally evaluated as an *informational* FP16
stress test. It is not a gate: on a flat/gradient background the model produces
near-zero objectness everywhere, and keypoint channels on such non-detection
anchors are unconstrained noise, so FP16 rounding there has no clinical meaning.

Usage:
    python tools/verify_onnx.py [--image PATH] [--no-stress]
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_DST_DIR = PROJECT_ROOT / "config" / "models"
MANIFEST_PATH = PROJECT_ROOT / "config" / "model-manifest.json"
REPORT_PATH = PROJECT_ROOT / "config" / "verification-report.json"

# Validation thresholds
MAX_KEYPOINT_DISTANCE_PX = 1.5
MAX_CLASS_PROB_DIFF = 0.01
INPUT_SIZE = 640
DETECTION_CONF = 0.25


def compute_sha256(filepath: Path) -> str:
    """Compute SHA-256 hex digest for a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def generate_synthetic_image(size: int = INPUT_SIZE) -> np.ndarray:
    """Generate a deterministic BGR stress-test image."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    ramp = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]
    img[:, :, 0] = (60 + 120 * ramp).astype(np.uint8)
    img[:, :, 1] = (80 + 80 * ramp).astype(np.uint8)
    img[:, :, 2] = (100 + 60 * ramp).astype(np.uint8)
    cx, cy = size // 2, size // 2
    body_w, body_h = size // 6, size // 3
    img[cy - body_h : cy + body_h, cx - body_w : cx + body_w] = [140, 160, 180]
    head_r = size // 12
    yy, xx = np.ogrid[:size, :size]
    head_mask = ((xx - cx) ** 2 + (yy - (cy - body_h - head_r)) ** 2) <= head_r**2
    img[head_mask] = [160, 180, 200]
    return img


def resolve_benchmark_image(explicit: str | None) -> tuple[np.ndarray, str]:
    """
    Pick the benchmark photograph.

    Preference: explicit --image, then the sample photo bundled with the
    installed Ultralytics package, then the synthetic stress image.
    """
    import cv2

    if explicit:
        image = cv2.imread(explicit)
        if image is None:
            raise SystemExit(f"[FAIL] Could not load image: {explicit}")
        return image, explicit

    try:
        import ultralytics

        candidate = Path(ultralytics.__file__).parent / "assets" / "zidane.jpg"
        if candidate.is_file():
            image = cv2.imread(str(candidate))
            if image is not None:
                return image, str(candidate)
    except Exception:
        pass

    print("[WARN] No bundled benchmark photo found; falling back to synthetic image.")
    return generate_synthetic_image(INPUT_SIZE), "synthetic"


def preprocess(image_bgr: np.ndarray, size: int = INPUT_SIZE) -> np.ndarray:
    """
    Convert a BGR uint8 image into a normalized RGB NCHW float32 tensor.

    Identical bytes are fed to both runtimes, so any resize/normalization
    convention cancels out of the comparison.
    """
    from PIL import Image

    pil_img = Image.fromarray(image_bgr[:, :, ::-1])  # BGR -> RGB
    pil_img = pil_img.resize((size, size), Image.BILINEAR)
    arr = np.asarray(pil_img, dtype=np.float32) / 255.0
    return np.transpose(arr, (2, 0, 1))[None, ...]  # (1, 3, H, W)


def run_pytorch_raw(pt_path: Path, tensor: np.ndarray):
    """Run a raw forward pass through the PyTorch model."""
    import torch
    from ultralytics import YOLO

    yolo = YOLO(str(pt_path))
    torch_model = yolo.model.float().eval()

    with torch.no_grad():
        t0 = time.perf_counter()
        out = torch_model(torch.from_numpy(tensor))
        elapsed_ms = (time.perf_counter() - t0) * 1000

    if isinstance(out, (tuple, list)):
        out = out[0]
    return out.detach().cpu().numpy(), elapsed_ms


def run_onnx_raw(onnx_path: Path, tensor: np.ndarray):
    """Run a raw forward pass through ONNX Runtime."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    t0 = time.perf_counter()
    outputs = session.run(None, {input_name: tensor})
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return outputs[0], elapsed_ms


def measure_parity(
    pt_raw: np.ndarray,
    onnx_raw: np.ndarray,
    num_classes: int,
    num_keypoints: int,
) -> dict:
    """
    Compare raw YOLO-pose tensors of shape (1, C, N).

    Returns worst-case keypoint pixel distance, class probability difference,
    bbox drift, and the same metrics restricted to detection-relevant anchors.
    """
    if pt_raw.shape != onnx_raw.shape:
        return {
            "shape_mismatch": f"pt={pt_raw.shape} onnx={onnx_raw.shape}",
            "passed": False,
        }

    pt = pt_raw.astype(np.float32)
    ox = onnx_raw.astype(np.float32)

    expected_channels = 4 + num_classes + num_keypoints * 3
    if pt.shape[1] != expected_channels:
        return {
            "shape_mismatch": (
                f"expected {expected_channels} channels "
                f"(4 + {num_classes} classes + {num_keypoints}*3 keypoints), got {pt.shape[1]}"
            ),
            "passed": False,
        }

    n_anchors = pt.shape[2]

    # Keypoint columns: (x, y) per keypoint, confidence column excluded
    kpt_base = 4 + num_classes
    xy_cols = np.concatenate(
        [[kpt_base + k * 3, kpt_base + k * 3 + 1] for k in range(num_keypoints)]
    )

    pt_xy = pt[:, xy_cols, :]
    onnx_xy = ox[:, xy_cols, :]
    dist = np.sqrt(np.sum((pt_xy - onnx_xy) ** 2, axis=1))[0]  # (N,)

    pt_cls = pt[:, 4 : 4 + num_classes, :]
    onnx_cls = ox[:, 4 : 4 + num_classes, :]
    class_diff = float(np.max(np.abs(pt_cls - onnx_cls)))

    bbox_diff = float(np.max(np.abs(pt[:, :4, :] - ox[:, :4, :])))
    tensor_diff = float(np.max(np.abs(pt - ox)))

    # Detection-relevant subset: anchors the model would actually keep
    obj_conf = pt_cls.max(axis=1)[0]
    relevant = obj_conf > DETECTION_CONF
    n_relevant = int(relevant.sum())
    relevant_kpt_max = float(dist[relevant].max()) if n_relevant else None
    relevant_cls_max = (
        float(np.max(np.abs(pt_cls[:, :, relevant] - onnx_cls[:, :, relevant])))
        if n_relevant
        else None
    )

    return {
        "anchors": n_anchors,
        "keypoints": num_keypoints,
        "classes": num_classes,
        "keypoint_max_px": float(dist.max()),
        "keypoint_mean_px": float(dist.mean()),
        "keypoint_p99_px": float(np.percentile(dist, 99)),
        "class_prob_max_diff": class_diff,
        "bbox_max_diff_px": bbox_diff,
        "tensor_max_abs_diff": tensor_diff,
        "detection_relevant_anchors": n_relevant,
        "detection_relevant_keypoint_max_px": relevant_kpt_max,
        "detection_relevant_class_max_diff": relevant_cls_max,
        "passed": bool(
            dist.max() < MAX_KEYPOINT_DISTANCE_PX and class_diff < MAX_CLASS_PROB_DIFF
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify ONNX model parity with PyTorch")
    parser.add_argument("--image", type=str, default=None, help="Benchmark image path")
    parser.add_argument(
        "--no-stress",
        action="store_true",
        help="Skip the informational synthetic stress pass",
    )
    args = parser.parse_args()

    print("=" * 70)
    print("  PILATES AI - ONNX Model Verification (raw tensor parity)")
    print("=" * 70)

    bench_image, bench_label = resolve_benchmark_image(args.image)
    bench_tensor = preprocess(bench_image)
    print(f"\n[BENCH] {bench_label}  {bench_image.shape}")
    print(f"[PRE  ] tensor {bench_tensor.shape} {bench_tensor.dtype} "
          f"range=[{bench_tensor.min():.3f}, {bench_tensor.max():.3f}]")

    stress_tensor = None
    if not args.no_stress:
        stress_tensor = preprocess(generate_synthetic_image(INPUT_SIZE))
        print("[STRESS] synthetic gradient (informational, not a gate)")

    if not MANIFEST_PATH.exists():
        print(f"\n[FAIL] Model manifest not found: {MANIFEST_PATH}")
        print("       Run `python tools/export_onnx.py` first.")
        return 1

    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)

    onnx_models = manifest.get("onnx_models")
    if not isinstance(onnx_models, list) or not onnx_models:
        print("\n[FAIL] Manifest has no `onnx_models` entries.")
        print("       Run `python tools/export_onnx.py` first.")
        return 1

    reports = []
    all_passed = True

    for model_meta in onnx_models:
        pose = model_meta["pose"]
        pt_path = PROJECT_ROOT / model_meta["source"]
        onnx_path = PROJECT_ROOT / model_meta["onnx_path"]
        nc = int(model_meta.get("num_classes") or 2)
        nk = int(model_meta.get("num_keypoints") or 17)

        print(f"\n{'-' * 70}")
        print(f"[{pose}] {onnx_path.name}  (nc={nc}, nk={nk})")

        entry = {"pose": pose, "onnx_path": str(onnx_path), "passed": False}

        if not onnx_path.exists() or not pt_path.exists():
            missing = onnx_path if not onnx_path.exists() else pt_path
            print(f"  [FAIL] Missing file: {missing}")
            entry["error"] = f"missing file: {missing}"
            reports.append(entry)
            all_passed = False
            continue

        # --- SHA-256 integrity against the manifest ---
        actual_sha = compute_sha256(onnx_path)
        sha_match = actual_sha == model_meta["sha256"]
        print(f"  [SHA ] {'MATCH' if sha_match else 'MISMATCH'}")
        entry["sha256_match"] = sha_match
        if not sha_match:
            print(f"         expected: {model_meta['sha256']}")
            print(f"         actual:   {actual_sha}")
            entry["error"] = "sha256 mismatch"
            reports.append(entry)
            all_passed = False
            continue

        # --- Benchmark parity (gating) ---
        pt_raw, pt_ms = run_pytorch_raw(pt_path, bench_tensor)
        onnx_raw, onnx_ms = run_onnx_raw(onnx_path, bench_tensor)
        print(f"  [PT  ] {pt_raw.shape} in {pt_ms:6.1f} ms")
        print(f"  [ONNX] {onnx_raw.shape} in {onnx_ms:6.1f} ms")

        bench = measure_parity(pt_raw, onnx_raw, nc, nk)
        bench["image"] = bench_label
        bench["pt_inference_ms"] = round(pt_ms, 2)
        bench["onnx_inference_ms"] = round(onnx_ms, 2)
        entry["benchmark"] = bench

        if "shape_mismatch" in bench:
            print(f"  [FAIL] {bench['shape_mismatch']}")
            reports.append(entry)
            all_passed = False
            continue

        print(f"  [KPT ] max {bench['keypoint_max_px']:.4f} px  "
              f"(p99 {bench['keypoint_p99_px']:.4f}, mean {bench['keypoint_mean_px']:.4f})  "
              f"threshold {MAX_KEYPOINT_DISTANCE_PX}")
        print(f"  [CLS ] max diff {bench['class_prob_max_diff']:.6f}  "
              f"threshold {MAX_CLASS_PROB_DIFF}")
        print(f"  [BBOX] max diff {bench['bbox_max_diff_px']:.4f} px (informational)")
        if bench["detection_relevant_anchors"]:
            print(f"  [DET ] {bench['detection_relevant_anchors']} anchors above conf "
                  f"{DETECTION_CONF}: kpt max "
                  f"{bench['detection_relevant_keypoint_max_px']:.4f} px, "
                  f"cls max {bench['detection_relevant_class_max_diff']:.6f}")
        else:
            print(f"  [DET ] no anchors above conf {DETECTION_CONF} on this image")

        # --- Synthetic stress pass (informational) ---
        if stress_tensor is not None:
            s_pt, _ = run_pytorch_raw(pt_path, stress_tensor)
            s_onnx, _ = run_onnx_raw(onnx_path, stress_tensor)
            stress = measure_parity(s_pt, s_onnx, nc, nk)
            stress["image"] = "synthetic"
            entry["stress"] = stress
            if "shape_mismatch" not in stress:
                print(f"  [STR ] kpt max {stress['keypoint_max_px']:.4f} px, "
                      f"cls max {stress['class_prob_max_diff']:.6f} (informational)")

        entry["passed"] = bool(bench["passed"])
        print(f"  => {'PASS' if entry['passed'] else 'FAIL'}")

        if not entry["passed"]:
            all_passed = False
        reports.append(entry)

    # --- Summary ---
    print(f"\n{'=' * 70}")
    passed = sum(1 for r in reports if r["passed"])
    failed = len(reports) - passed
    print(f"  RESULT: {passed} passed, {failed} failed (of {len(onnx_models)} models)")
    print(f"  Overall: {'ALL PASS' if all_passed else 'SOME FAILURES'}")
    print(f"{'=' * 70}")

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "criteria": {
                    "max_keypoint_distance_px": MAX_KEYPOINT_DISTANCE_PX,
                    "max_class_prob_diff": MAX_CLASS_PROB_DIFF,
                    "benchmark_image": bench_label,
                },
                "method": "raw tensor parity on identical preprocessed input",
                "reports": reports,
                "all_passed": all_passed,
            },
            f,
            indent=2,
        )
    print(f"\n[OUT ] Report saved to {REPORT_PATH.relative_to(PROJECT_ROOT)}")

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
