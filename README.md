# Pilates AI

Clinical workstation for capturing and analysing Pilates pose performance with
on-device computer vision.

## Architecture

| Path | What it is |
| :--- | :--- |
| `apps/desktop` | Tauri 2 desktop app — React 19 frontend + Rust engine |
| `apps/desktop/src-tauri` | Rust engine: camera capture, ONNX inference, biomechanics, Parquet telemetry, SQLite outbox, cloud sync |
| `apps/web` | Clinical web portal (React/Vite) |
| `packages/types` | Shared domain types and generated pose definitions |
| `packages/ui` | Design system (Tailwind v4 tokens + primitives) |
| `packages/viz` | Clinical visualisation (skeleton canvas, gauges, charts) |
| `functions` | Firebase Cloud Functions (O(1) session aggregation) |
| `tools` | Python tooling: ONNX export/verification, ONNX Runtime fetcher, pose-definition generator |
| `assets/models` | Source PyTorch weights (`best.pt`) — the input to ONNX export |
| `config` | Pose definitions, model manifest, ONNX models, Firebase config |

Data is dual-tier: **Firestore** holds session summaries and a 2 Hz kinematic
curve for instant queries, while full 30 Hz trajectories are written to
**Cloud Storage** as Snappy Parquet for research.

## Quick start

```powershell
pnpm install
pnpm turbo run build
.venv\Scripts\python.exe tools\fetch_onnxruntime.py   # ONNX Runtime DLL
pnpm --filter @pilates/desktop tauri dev
```

See [TESTING.md](TESTING.md) for how to verify each layer, including checks that
run without a webcam.

## Documentation

- [MASTER_EXECUTION_PLAN.md](MASTER_EXECUTION_PLAN.md) — architecture blueprint
  and the step-by-step build record.
- [TESTING.md](TESTING.md) — how to run and test the application.

## Credits

- Muhammadrasheed — backend, data collection, data structuring
- Bilal — model training, data visualisation (FlutterFlow)
- Phumin — data visualisation (FlutterFlow)
