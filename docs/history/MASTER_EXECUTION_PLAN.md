# MASTER EXECUTION PLAN: PILATES AI MODERNIZATION

**Target Architecture:** Proposal B (Tauri 2.0 + Rust Engine + React 19)  
**Data Strategy:** Pathway 2 (Dual-Tier Kinematic Telemetry: Firestore Operational + Cloud Storage Parquet Lake)  
**Ecosystem Strategy:** pnpm + Turborepo Monorepo (Shared Desktop Shell, Web Portal, & Visualization Components)  
**Author:** Principal AI & Software Architect  
**Version:** 1.0.0 — Production Blueprint  

---

## 1. Executive Overview

This document serves as the **authoritative, implementation-grade blueprint** for completely replacing the legacy Python/PyQt6 application with a high-performance, cross-platform architecture:

1. **Desktop App (`apps/desktop`):** Built with **Tauri 2.0 (Rust backend + React 19 frontend)**. Eliminates the Python GIL, drops binary distribution size from $>2.5\text{ GB}$ to $<60\text{ MB}$, guarantees rock-solid 60 FPS camera previews, and runs ONNX models via DirectML/GPU in $<15\text{ ms}$.
2. **Web Portal (`apps/web`):** Built with **Next.js 15 / React 19** and hosted natively on **Firebase App Hosting / Firebase Hosting** to completely sunset FlutterFlow. Serves clinicians and patients with high-fidelity analytics, session replays, and progress tracking within a single, unified Google Cloud ecosystem.
3. **Shared Packages (`packages/*`):** Shared TypeScript types, UI design system (`shadcn/ui`), and a dedicated clinical visualization library (`packages/viz`) providing 2D Canvas skeletal rendering and biomechanical curves.
4. **Dual-Tier Data Architecture:**
   - **Hot Layer (Firestore):** Structured session summaries, rep records, and downsampled $2\text{ Hz}$ movement curves for instant sub-second UI queries.
   - **Cold Layer (Google Cloud Storage / Parquet):** Full $30\text{ Hz}$ kinematic trajectories (all keypoint vectors, angles, phase states) stored as compressed Apache Parquet files for academic research and machine learning data lakes.
5. **Biomechanical Math Engine (Rust Native):** SIMD-accelerated joint vector trigonometry, a Finite State Machine (FSM) for rep/hold tracking, and composite form scoring computed in the Rust backend.
6. **Universal Cross-Device Installation & Self-Contained Bundling:** The desktop application packages into native, single-click installers (`.msi` / `.exe` via NSIS for Windows, `.dmg` for macOS, `.AppImage` for Linux) with zero external runtime dependencies (no Python virtual environments, no separate CUDA/cuDNN installations). A dynamic **Execution Provider (EP) Fallback Engine** automatically detects host hardware: DirectML (accelerating any NVIDIA, AMD, or Intel GPU) $\to$ CoreML (Apple Silicon) $\to$ SIMD CPU (AVX2/AVX-512/NEON), guaranteeing high performance on any clinic computer.

---

## 2. Directory Structure (Monorepo Blueprint)

```text
pilates-ai/
├── .github/
│   └── workflows/
│       ├── desktop-ci.yml           # Tauri build, test, and package (MSI/NSIS)
│       └── web-ci.yml               # Next.js build and Firebase App Hosting deployment
├── apps/
│   ├── desktop/                     # Tauri 2.0 Desktop Application
│   │   ├── src-tauri/
│   │   │   ├── Cargo.toml           # Rust dependencies (ort, nokhwa, arrow, parquet, rusqlite)
│   │   │   ├── tauri.conf.json      # Tauri 2.0 application configuration
│   │   │   ├── build.rs             # Tauri build hooks
│   │   │   ├── icons/               # Windows ICO and asset icons
│   │   │   └── src/
│   │   │       ├── main.rs          # Tauri runtime entry point & command router
│   │   │       ├── camera.rs        # Native DirectShow/MediaFoundation frame grabber
│   │   │       ├── inference.rs     # ONNX Runtime (DirectML) model manager & forward pass
│   │   │       ├── biomechanics.rs  # Vector angle calculations, FSM, and form scoring
│   │   │       ├── telemetry.rs     # 30 Hz in-memory buffer & Apache Parquet encoder
│   │   │       ├── outbox.rs        # SQLite WAL outbox for offline sync resilience
│   │   │       ├── cloud_sync.rs    # Dual-tier upload (Firestore write + GCS Parquet upload)
│   │   │       └── commands.rs      # IPC command handlers exposed to React frontend
│   │   ├── src/                     # Desktop React 19 Frontend Shell
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   │   ├── PatientListPage.tsx
│   │   │   │   ├── ActiveCapturePage.tsx
│   │   │   │   └── SessionDetailPage.tsx
│   │   │   └── hooks/
│   │   │       ├── useTauriCapture.ts
│   │   │       └── useTauriSync.ts
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   │
│   └── web/                         # Custom Clinical Web Portal (Sunsetting FlutterFlow)
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx         # Executive clinic overview
│       │   │   ├── patients/
│       │   │   │   ├── page.tsx     # Patient directory
│       │   │   │   └── [id]/
│       │   │   │       └── page.tsx # Patient clinical profile & session timeline
│       │   │   └── sessions/
│       │   │       └── [id]/
│       │   │           └── page.tsx # Deep-dive session replay & research telemetry
│       │   └── lib/
│       │       ├── firebase.ts      # Web Firebase client (Auth + Firestore)
│       │       └── gcs.ts           # Signed URL fetcher for Parquet telemetry
│       ├── package.json
│       ├── next.config.ts
│       └── tsconfig.json
│
├── packages/
│   ├── types/                       # Shared Domain Interfaces & DTOs
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── patient.ts           # Patient entity & clinical demographics
│   │   │   ├── session.ts           # Session records, rep structures, downsampled curves
│   │   │   ├── biomechanics.ts      # Joint definitions, angles, keypoints, FSM states
│   │   │   └── telemetry.ts         # Parquet schema definition & IPC packet types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── viz/                         # Shared Clinical Visualization Library
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── SkeletalCanvas.tsx   # 2D WebGL/Canvas rendering real-time/replay skeletons
│   │   │   ├── JointAngleGauge.tsx  # Circular/radial ROM gauge with target threshold arc
│   │   │   ├── RepTimelineChart.tsx # Recharts-based multi-phase rep dynamics curve
│   │   │   ├── FormScoreRadar.tsx   # Radar breakdown (Angle accuracy, Stability, Speed)
│   │   │   └── SessionTrendCard.tsx # Historical progress and patient baselines
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                          # Shared Design System
│       ├── src/
│       │   ├── index.ts
│       │   ├── components/          # Buttons, Cards, Dialogs, Tables, Dropdowns
│       │   └── lib/utils.ts         # clsx, tailwind-merge utilities
│       ├── package.json
│       └── tsconfig.json
│
├── config/
│   ├── model-manifest.json          # ONNX model inventory, versions, and SHA-256 hashes
│   └── pose-definitions.json        # Joint connectivity, angle pairs, and target ROM limits
├── functions/                       # Refactored Firebase Cloud Functions (Node.js 20)
│   ├── index.js                     # Lean triggers for session completion
│   ├── aggregation.js               # O(1) incremental statistics (Zero full-table scans)
│   └── package.json
├── tools/                           # Model Export & Verification Scripts (Python)
│   ├── export_onnx.py               # Converts .pt weights to FP16 ONNX models
│   └── verify_onnx.py               # Validates inference output parity vs PyTorch
├── package.json                     # Root pnpm workspaces configuration
├── pnpm-workspace.yaml
├── turbo.json                       # Turborepo task pipeline
└── README.md
```

---

## 3. Universal Hardware & Zero-Dependency Cross-Device Strategy

To satisfy the critical requirement that the desktop application must **bundle up and install cleanly on any clinic device** (from dedicated workstation PCs to low-spec examination room laptops), the system implements a zero-dependency distribution and universal hardware acceleration strategy.

### 3.1 Dynamic Execution Provider (EP) Fallback Matrix
Clinic computers feature heterogeneous hardware: NVIDIA discrete GPUs, AMD Radeon GPUs, Intel Iris Xe / UHD integrated graphics, older CPU-only office PCs, or Apple Silicon MacBooks.

The Rust ONNX inference engine (`inference.rs`) initializes sessions using an automatic fallback chain:

```
                      INFERENCE HARDWARE DISCOVERY
                      
             [ Host Hardware Scan at App Startup ]
                               │
               ┌───────────────┴───────────────┐
         (Windows Device)                 (macOS Device)
               │                               │
       Does DX12 GPU exist?             Apple Silicon / M-Series?
         (NVIDIA/AMD/Intel)                    │
        ├── YES: DirectML EP             ├── YES: CoreML EP (Neural Engine)
        └── NO:  CPU SIMD EP             └── NO:  CPU SIMD EP (NEON)
```

1. **Tier 1 (Windows GPU — DirectML):** 
   DirectML executes on **any DirectX 12 compatible GPU**, including integrated Intel Iris Xe, AMD Radeon, and NVIDIA GeForce/RTX cards. Clinic staff **do not** need to install NVIDIA CUDA, cuDNN, or specialized vendor drivers.
2. **Tier 2 (macOS Acceleration — CoreML):**
   Automatically binds to the Apple Neural Engine (ANE) and Metal GPU pipeline on Apple Silicon (M1/M2/M3/M4).
3. **Tier 3 (Universal CPU Fallback — SIMD AVX2 / AVX-512 / NEON):**
   If the clinic machine lacks a compatible GPU, the engine falls back to CPU SIMD vector units. Because models are FP16/INT8 quantized nano architectures, CPU inference completes in $<35\text{ ms}$ without UI lag.

### 3.2 Single-Click Zero-Dependency Installers
Legacy desktop applications that bundle Python (e.g. PyInstaller) suffer from missing DLL errors, anti-virus false positives, and 2.5 GB installer sizes. Tauri 2.0 compiles to a native C++ runtime binary:

| OS Target | Installer Format | Bundled Runtimes & Dependencies | Target Machine Requirements |
| :--- | :--- | :--- | :--- |
| **Windows 10/11** | **NSIS Installer (`.exe`)** & **MSI (`.msi`)** | Statically linked MSVC runtime, bundled `onnxruntime.dll`, bundled `DirectML.dll` | Zero dependencies. Works on fresh Windows install out of the box. |
| **macOS (12+)** | **Universal DMG (`.dmg`)** | Universal Mach-O binary (`x86_64` + `arm64`), bundled ONNX dylibs | macOS 12+ (Apple Silicon or Intel). Notarized for Gatekeeper. |
| **Linux** | **AppImage** / **Debian (`.deb`)** | Self-contained WebKitGTK / OpenSSL dependencies | Any modern Linux distro with glibc 2.31+. |

### 3.3 Offline Self-Contained Asset Packaging
All 5 ONNX models (`pose1.onnx` through `pose5.onnx`) and joint configuration files are embedded directly into the installer bundle via `tauri.conf.json`:
```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "resources": [
      "assets/models/*.onnx",
      "config/model-manifest.json",
      "config/pose-definitions.json"
    ]
  }
}
```
- **Total Installer Size:** $\approx 45\text{–}55\text{ MB}$ (98% smaller than the legacy 2.6 GB bundle).
- **100% Offline Capability:** Clinic staff do not need to download model weights after installation. The app works instantly on air-gapped or restricted clinic networks.

### 3.4 Camera Hardware Abstraction
The Rust camera ingestion layer (`camera.rs`) dynamically probes available video capture drivers:
- **Windows:** DirectShow (universal USB/integrated webcam compatibility) with MediaFoundation fallback.
- **macOS:** Native AVFoundation capture.
- **Auto-Resolution Negotiation:** Automatically queries camera capabilities and selects $640 \times 480$ or $1280 \times 720$ at 30/60 FPS, supporting built-in laptop cameras, plug-and-play USB webcams, and clinical ceiling-mounted cameras.

---

## 4. Required Dependencies & Environment Setup

### 3.1 Host System Requirements
- **OS:** Windows 10/11 (64-bit) with Developer Mode or Administrator privileges.
- **Node.js:** `v20.x` or `v22.x` LTS + `pnpm v9.x` (`corepack enable pnpm`).
- **Rust Toolchain:** `1.80+` (`rustup default stable-x86_64-pc-windows-msvc`).
- **C++ Build Tools:** Visual Studio 2022 Build Tools (with "Desktop development with C++" and Windows 10/11 SDK).
- **Python (for export only):** Python `3.11` or `3.12` with `ultralytics`, `onnx`, `onnxruntime`, `torch`.

### 3.2 Key Dependencies by Subsystem

#### Root (`package.json`)
```json
{
  "name": "pilates-ai-monorepo",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

#### Tauri Core (`apps/desktop/src-tauri/Cargo.toml`)
```toml
[package]
name = "pilates-desktop"
version = "2.0.0"
edition = "2021"

[dependencies]
tauri = { version = "2.0", features = ["tray-icon"] }
tauri-plugin-shell = "2.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1.40", features = ["full"] }
uuid = { version = "1.10", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }

# Computer Vision & ONNX Runtime (DirectML GPU + CPU fallback)
ort = { version = "2.0.0-rc.9", features = ["directml", "copy-dylibs"] }
image = "0.25"
nokhwa = { version = "0.10", features = ["input-native"] } # DirectShow webcam capture

# Biomechanical Math
glam = "0.29" # SIMD-accelerated 2D/3D vector mathematics

# Dual-Tier Telemetry (Apache Arrow & Parquet)
arrow = { version = "53.0", features = ["prettyprint"] }
parquet = { version = "53.0", features = ["arrow"] }

# Local Outbox & SQLite WAL Cache
rusqlite = { version = "0.32", features = ["bundled"] }

# HTTP Client for GCS signed uploads & Firestore REST/gRPC
reqwest = { version = "0.12", features = ["json", "stream"] }
```

#### Shared Frontend Packages (`packages/viz/package.json`)
```json
{
  "name": "@pilates/viz",
  "version": "1.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@pilates/types": "workspace:*",
    "@pilates/ui": "workspace:*",
    "lucide-react": "^0.453.0",
    "recharts": "^2.13.0"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

---

## 5. Data Schemas & Interface Contracts

### 4.1 Real-Time Live Telemetry (Rust Native $\to$ React Shell via Tauri IPC)
Emitted at **30 FPS** over Tauri event bus (`emit("telemetry-frame", payload)`):

```typescript
// packages/types/src/biomechanics.ts

export type MovementPhase = "idle" | "start_position" | "eccentric" | "holding" | "concentric" | "rep_completed";

export interface Keypoint2D {
  id: number;
  label?: string;
  x: number;          // Normalized to 0.0 - 1.0 (Canvas resolution independent)
  y: number;          // Normalized to 0.0 - 1.0
  confidence: number; // 0.0 - 1.0
}

export interface LiveTelemetryFrame {
  timestamp_ms: number;
  frame_index: number;
  pose_id: "pose1" | "pose2" | "pose3" | "pose4" | "pose5";
  phase: MovementPhase;
  rep_count: number;
  
  // Real-time calculated biomechanical metrics
  primary_angle: number;       // e.g. Knee flexion angle in degrees (0 - 180)
  target_angle: number;        // e.g. 120.0 degrees
  angle_deviation: number;     // abs(primary_angle - target_angle)
  instantaneous_form_score: number; // 0 - 100%
  hold_duration_sec: number;   // Cumulative seconds within target threshold
  
  keypoints: Keypoint2D[];
}
```

### 4.2 Tier 1: Hot Operational Layer (Firestore Schema)

```typescript
// packages/types/src/session.ts

export interface RepetitionRecord {
  rep_index: number;
  started_at_ms: number;
  completed_at_ms: number;
  duration_sec: number;
  peak_rom_angle: number;
  avg_hold_duration_sec: number;
  form_score: number;         // 0 - 100%
  stability_variance: number; // Low = steady hold, High = shaky
}

export interface DownsampledPoint {
  t_sec: number;              // Time offset from session start
  angle: number;              // Primary joint angle (degrees)
  score: number;              // Instantaneous form score
  phase: MovementPhase;
}

// Document: patients/{patientId}/sessions/{sessionId}
export interface ClinicalSessionDocument {
  session_id: string;
  patient_id: string;
  pose_id: string;
  model_version: string;
  started_at: string;         // ISO-8601 UTC
  completed_at: string;       // ISO-8601 UTC
  duration_seconds: number;

  // High-Level Summary (Consumed by Web Patient Dashboard)
  summary: {
    total_reps: number;
    completion_rate: number;      // % of attempted reps successfully held
    mean_form_score: number;      // Average composite score across all reps
    peak_rom_angle: number;       // Maximum joint angle reached
    total_hold_time_sec: number;  // Total time spent in proper pose
  };

  // Structured Repetition Milestones
  reps: RepetitionRecord[];

  // Downsampled Kinematic Curve (2 Hz) for Instant Web/Desktop Charting
  kinematic_curve: DownsampledPoint[];

  // Tier 2 Data Lake Pointer
  research_telemetry: {
    storage_path: string;       // "telemetry/{patientId}/{sessionId}.parquet"
    gcs_bucket: string;
    sha256: string;
    file_size_bytes: number;
    frame_count: number;
  };
}
```

### 4.3 Tier 2: Cold Research Data Lake (Apache Parquet Schema)
Stored in Google Cloud Storage at `gs://<bucket>/telemetry/{patientId}/{sessionId}.parquet`:

| Column Name | Arrow / Parquet Data Type | Description |
| :--- | :--- | :--- |
| `timestamp_ms` | `Int64` | Monotonic millisecond timestamp from session start |
| `frame_index` | `Int32` | Sequential video frame counter |
| `phase` | `Utf8` | Biomechanical movement phase (`start`, `holding`, etc.) |
| `primary_angle` | `Float32` | Calculated primary joint angle (degrees) |
| `secondary_angle`| `Float32` | Secondary posture/stability angle (degrees) |
| `form_score` | `Float32` | Instantaneous composite score (0.0 to 100.0) |
| `keypoint_ids` | `List<Int8>` | Array of detected joint IDs |
| `keypoint_x` | `List<Float32>` | Array of normalized $X$ coordinates $[0.0, 1.0]$ |
| `keypoint_y` | `List<Float32>` | Array of normalized $Y$ coordinates $[0.0, 1.0]$ |
| `keypoint_conf`| `List<Float32>` | Array of detection confidence scores $[0.0, 1.0]$ |
| `model_class` | `Int8` | YOLO classification index (`0: end`, `1: start`) |

---

## 6. Step-by-Step Implementation Roadmap

```
                          IMPLEMENTATION SEQUENCE
                          
  [ Phase 1: Environment & Tooling ] ──> Monorepo Init + Cargo/Pnpm Setup
                │
  [ Phase 2: Model Conversion ]      ──> PyTorch (.pt) to ONNX FP16 DirectML
                │
  [ Phase 3: Shared Core Packages ]  ──> @pilates/types, @pilates/ui, @pilates/viz
                │
  [ Phase 4: Rust Engine Core ]      ──> Camera + ONNX + Biomechanics + Parquet
                │
  [ Phase 5: Tauri Desktop Shell ]   ──> React 19 UI + Live Canvas + IPC Bridge
                │
  [ Phase 6: Cloud Data Pipelines ]  ──> Firestore Batching + GCS Parquet Upload
                │
  [ Phase 7: Cloud Functions Refactor]─> O(1) Incremental Stats (Sunset O(N) scan)
                │
  [ Phase 8: Web Clinical Portal ]   ──> Next.js 15 Analytics & Session Replay
                │
  [ Phase 9: E2E Verification ]      ──> Mock Harness, Parquet Audit, CI Matrix
```

---

### Step 1: Monorepo Foundation & Tooling Setup ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** All 5 TypeScript packages (`@pilates/types`, `@pilates/ui`, `@pilates/viz`, `@pilates/desktop`, `@pilates/web`) build successfully via `pnpm turbo run build`. Rust/Tauri `cargo check` passes with GNU toolchain (stable-x86_64-pc-windows-gnu + MinGW). CI workflows scaffolded. App icons created.

1. **Initialize Monorepo:**
   - Configure root `package.json`, `pnpm-workspace.yaml`, and `turbo.json`.
   - Setup global TypeScript configuration (`tsconfig.base.json`).
2. **Scaffold Packages & Apps:**
   - Initialize `packages/types`, `packages/ui`, and `packages/viz`.
   - Scaffold `apps/desktop` using Tauri 2.0 CLI:
     ```powershell
     pnpm create tauri-app@latest apps/desktop --template react-ts
     ```
   - Scaffold `apps/web` using Next.js 15:
     ```powershell
     pnpm create next-app@latest apps/web --ts --tailwind --app --no-eslint
     ```
3. **Configure CI Pipeline:**
   - Setup GitHub Actions workflows to validate Rust builds and TypeScript compilation across the monorepo.

---

### Step 2: Model Conversion & Validation (PyTorch $\to$ ONNX FP16) ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** All 5 pose models exported to `config/models/pose{1-5}.onnx` (30.8 MB total, FP16, opset 17, imgsz 640, static shape, onnxslim-simplified). `python tools/verify_onnx.py` reports **5/5 PASS** — keypoint error 0.54–0.97 px (threshold 1.5 px) and class-probability diff ≤ 0.00052 (threshold 0.01) measured as raw-tensor parity against PyTorch on an identical preprocessed input, with SHA-256 matching the manifest. Legacy Python suite: 29/30 pass; `test_model_and_logging.py` 4/4 pass (manifest remains backward-compatible).
>
> **Notes:**
> - `config/model-manifest.json` now carries **both** catalogs: the original `models` list (`.pt`, unchanged hashes/versions) still consumed by `src/model_handler.py`, plus a new `onnx_models` list (ONNX path, SHA-256, size, `num_classes`, `num_keypoints`) for the Rust engine. This avoids invalidating the legacy app when re-exporting.
> - Verification compares **raw output tensors** rather than post-NMS detection lists. The prior approach compared PyTorch NMS output against un-NMS'd ONNX anchors and produced false failures from index-ordering alone. `num_classes` is read per model (pose4 has 3 classes, not 2).
> - Gate image is a real benchmark photo (Ultralytics `zidane.jpg`); a synthetic gradient runs as an informational FP16 stress pass. On that synthetic image pose5 reaches 2.45 px, but exclusively on anchors with objectness ≤ 0.0037 — non-detections where keypoint channels are unconstrained.
> - Export tooling deps pinned in `tools/requirements-export.txt` (onnx 1.23.2, onnxruntime 1.31.1, onnxslim 0.1.99).
> - Pre-existing, unrelated failure: `tests/test_app_controller.py::test_frame_copy_survives_capture_buffer_and_camera_is_released` asserts BGR `(10,20,30)` but receives RGB `(30,20,10)`. Untouched by this step.

1. **Export Script (`tools/export_onnx.py`):**
   - Write a standalone export script using Ultralytics:
     ```python
     from ultralytics import YOLO
     model = YOLO("src/models/pose1/best.pt")
     model.export(format="onnx", half=True, dynamic=False, imgsz=640, simplify=True)
     ```
   - Export all 5 pose models (`pose1.onnx` through `pose5.onnx`) into `config/models/`.
2. **Validation Script (`tools/verify_onnx.py`):**
   - Execute side-by-side inference on a benchmark test image.
   - Assert keypoint coordinate Euclidean distance $<1.5\text{ pixels}$ and class probability difference $<0.01$ between PyTorch and ONNX Runtime.
3. **Update Manifest:**
   - Compute SHA-256 digests and update `config/model-manifest.json`.

---

### Step 3: Shared Core & Visualization Packages ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** `pnpm turbo run build --force` → **5/5 packages build from scratch**. `pnpm --filter @pilates/viz smoke` → **45/45 checks pass**, covering joint-angle trigonometry at 0/45/90/180°, confidence-band boundaries (0.8 / 0.5), pose-definition integrity, hold-range derivation, and a server-render of every UI primitive and visualization component.
>
> **Delivered:**
> - `packages/types` — `Patient` (+`Gender`, `PatientInput`, `PatientRecord` alias), `MovementPhase` (6 states), `POSE_IDS`/`isPoseId`, `MOVEMENT_PHASES`/`isMovementPhase`, `Keypoint2D`, `Point2D`, `LiveTelemetryFrame`, `FormScoreBreakdown`, `JointAngleReading`, `JointAngleSpec`, `TargetRom`, `ConfidenceBands`, `PoseDefinition`, `PoseDefinitionDocument`, plus the existing `ClinicalSessionDocument` / `RepetitionRecord` / `DownsampledPoint` / `KinematicFrameRecord`.
> - `config/pose-definitions.json` — canonical joint connectivity, angle triplets, target ROM and hold thresholds for all 5 poses. `tools/generate-pose-definitions.mjs` compiles it into `packages/types/src/pose-definitions.generated.ts` (with `--check` mode for CI); the types build regenerates it, so the Rust engine (Step 4) and the React layer cannot drift.
> - `packages/ui` — Tailwind v4 token layer (`styles.css` `@theme`: brand ramp, pose-status colours, phase palette, radii) and `Button`, `Card`, `Badge`, `Dialog`, `Table` plus `cn`/`formatPercent`/`formatAngle`/`formatDuration`/`clamp`.
> - `packages/viz` — `SkeletalCanvas` (bones from pose definitions, confidence colour-coding, primary-angle arc with live readout, DPR-crisp, grid/labels/mirroring), `JointAngleGauge`, `RepTimelineChart` (target ROM band + shaded hold zones), `FormScoreRadar` (with baseline overlay), `SessionTrendCard`, and `lib/geometry.ts` mirroring the Rust `calculate_joint_angle`.
> - Both apps migrated to Tailwind v4 (`@tailwindcss/vite`); the v3 `tailwind.config.js` / `postcss.config.js` files were removed and `index.css` now imports the shared token layer with `@source` directives for the workspace packages.
>
> **Notes / decisions:**
> - **Keypoint labels are provisional.** The checkpoints never persisted keypoint names (only `kpt_shape`), so `pose-definitions.json` defines a clinically coherent convention per keypoint count (3/3/5/7/15) and is marked `"label_source": "provisional"`. Because every consumer reads connectivity and angle triplets from that file, correcting a label needs no code change.
> - **`MovementPhase` reconciled.** §5.1 specifies `eccentric`/`concentric` while the Step 4 prose said `InMotion`; the explicit interface contract (§5.1) wins and `in_motion` is dropped. The Step 4 FSM should emit `eccentric`/`concentric` instead of a single in-motion state.
> - `tailwind-merge` bumped to v3 (v2 only supports Tailwind v3). `recharts` pinned to 2.15.4 for React 19 compatibility; pnpm warns a 3.x canary exists outside the declared range.
> - Tailwind v4 tree-shakes unused theme variables, so `--color-pose-*` is emitted only when a class actually references it (components use the hex constants in `CONFIDENCE_COLORS`, so this is intentional).
> - `packages/viz/smoke/smoke.tsx` sits outside the package `rootDir` and is therefore transpiled by esbuild rather than type-checked by `tsc`; it is a behavioural harness, and Step 9 will promote these cases into the formal test suite.

1. **Implement `packages/types`:**
   - Define all interfaces: `Patient`, `ClinicalSessionDocument`, `RepetitionRecord`, `LiveTelemetryFrame`, and `MovementPhase`.
2. **Implement `packages/ui`:**
   - Configure Tailwind CSS v4 and export reusable component primitives (Button, Card, Dialog, Badge, Table).
3. **Implement `packages/viz`:**
   - **`SkeletalCanvas.tsx`:** High-performance Canvas/WebGL renderer:
     - Draws bone segments connecting keypoints based on `pose-definitions.json`.
     - Color-codes keypoints by confidence (Green $\ge 0.8$, Yellow $0.5–0.8$, Red $<0.5$).
     - Renders dynamic angle arcs with live numerical readout.
   - **`JointAngleGauge.tsx`:** Circular gauge indicating current joint extension/flexion relative to clinical target threshold.
   - **`RepTimelineChart.tsx`:** Interactive Recharts line component showing angle trajectory over time with highlighted hold zones.

---

### Step 4: Rust Native Engine Core (`apps/desktop/src-tauri`) ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** `cargo build` produces `pilates-desktop.exe`; `cargo test` → **65/65 pass**. Tests cover joint trigonometry at 0/45/90/180°, FSM hold validation (≥3 s), multi-rep counting, low-confidence/missing-reading handling, letterbox geometry, NMS behaviour, Parquet round-trip with zero nulls, SHA-256 stability, and 2 Hz downsampling.
>
> **Delivered:**
> - `camera.rs` — dedicated capture thread (nokhwa → MediaFoundation/DirectShow on Windows), publishing the newest decoded RGB frame into an `ArcSwapOption` slot so readers never take a lock. A start-up handshake reports the negotiated format and fails fast on a dead device (10 s timeout) instead of returning a handle that never produces frames.
> - `inference.rs` — ONNX Runtime session with the DirectML → CPU fallback chain, letterbox preprocessing (114-grey padding), raw `(1, 4+nc+3·nk, N)` decode, per-class NMS, and inverse-mapped normalized keypoints.
> - `biomechanics.rs` — `calculate_joint_angle` (glam), `RepFsm` with the full phase set, EMA smoothing, hold/rep validation, and the weighted composite form score (angle 0.50 / stability 0.30 / confidence 0.20).
> - `telemetry.rs` — Arrow schema exactly as specified in §4.3, in-memory Snappy Parquet encoding, SHA-256 digest, and 2 Hz downsampling for the Firestore curve.
> - `pose_config.rs` — validated loader for `config/pose-definitions.json`; derives FSM tolerance from each pose's ROM span.
>
> **Notes / decisions:**
> - **`ort` is pinned to 2.0.0-rc.15 with `load-dynamic`, not `directml` + `copy-dylibs`.** pyke.io publishes prebuilt ONNX Runtime only for `x86_64-pc-windows-msvc`; this host builds with the GNU toolchain and its Windows SDK ships no import libraries, so MSVC is not viable either. Dynamic loading compiles everywhere and resolves `onnxruntime.dll` at runtime from resources/`ORT_DYLIB_PATH`, degrading to a typed "inference unavailable" error rather than crashing. `tools/fetch_onnxruntime.py` fetches the runtime with a pinned SHA-256; the DLLs are gitignored and bundled via `tauri.conf.json`.
> - **DirectML is blocked upstream, not by our code.** Microsoft stopped publishing `-directml` assets after ONNX Runtime 1.24.x (the `Microsoft.ML.OnnxRuntime.DirectML` NuGet package also stops at 1.24.4), and pyke's DirectML artifact contains `DirectML.dll` plus a 360 MB `onnxruntime.lib` with **no DLL** — unusable for dynamic loading. `ort` rc.15 binds the 1.31 API, so a 1.24 DLL would be version-incompatible. We therefore ship the version-matched **CPU** build; the engine still prefers DirectML when a matching `DirectML.dll` is present, so enabling GPU acceleration later needs no code change.
> - **Provider reporting was corrected after a real forward pass exposed it.** The engine originally reported `DirectML` unconditionally on Windows, because ONNX Runtime silently falls back to CPU when an execution provider fails to register. It now decides the provider *before* creating the session (checking for `DirectML.dll`) so the UI can never claim GPU acceleration that isn't happening.
> - **The unused `image` crate was removed.** Its full codec set (rav1e/ravif/mozjpeg) pushed the MinGW linker past the 65535 export-ordinal limit (`ld: export ordinal too large: 72671`), which also broke test-binary linking.
> - `MovementPhase` emits `eccentric`/`concentric` as reconciled in Step 3; there is no catch-all `in_motion` state.
> - The preview pipeline deliberately **freezes** the FSM on frames with no usable reading rather than inventing motion; those frames are still recorded for the research lake.
> - `tauri.conf.json` bundles `config/models/*.onnx`, `model-manifest.json` and `pose-definitions.json` as resources (paths are three levels up from `src-tauri`).

1. **Camera Ingestion (`camera.rs`):**
   - Implement asynchronous video capture using `nokhwa` or native DirectShow media backend.
   - Spawn a dedicated camera thread streaming raw $640 \times 480$ RGB frames into a lock-free buffer at 30/60 FPS.
2. **ONNX Inference Engine (`inference.rs`):**
   - Configure `ort::Session` with DirectML execution provider (GPU accelerated across NVIDIA, AMD, Intel).
   - Implement dynamic model loading with automatic session unloading when the user switches poses.
   - Implement letterboxing, normalization, forward pass, and NMS post-processing.
3. **Biomechanical Math Engine (`biomechanics.rs`):**
   - Implement vector angle calculation using `glam::Vec2`:
     ```rust
     pub fn calculate_joint_angle(a: Vec2, b: Vec2, c: Vec2) -> f32 {
         let v1 = (a - b).normalize();
         let v2 = (c - b).normalize();
         v1.dot(v2).clamp(-1.0, 1.0).acos().to_degrees()
     }
     ```
   - Implement the **Repetition Finite State Machine (FSM)**:
     - Tracks transitions: `Idle` $\to$ `InMotion` $\to$ `Holding` $\to$ `CompletedRep`.
     - Validates minimum hold duration (e.g. $\ge 3.0\text{ seconds}$).
   - Compute composite form score combining angle deviation, stability variance, and detection confidence.
4. **Apache Parquet Telemetry Recorder (`telemetry.rs`):**
   - Accumulate $30\text{ Hz}$ kinematic records in an Apache Arrow `RecordBatch`.
   - On session completion, serialize into an in-memory buffer compressed with Snappy/Zstd.

---

### Step 5: Desktop React UI & IPC Bridge ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** `pnpm turbo run build` → **5/5 packages**; `tsc --noEmit` clean for `@pilates/desktop`; `cargo build` links the binary. The `@pilates/viz` smoke harness still passes 45/45 after the changes.
>
> **Delivered:**
> - `commands.rs` — `start_preview`, `stop_preview`, `set_preview_pose`, `start_session`, `capture_tick`, `stop_session`, `list_patients`, `save_patient`, `delete_patient`, `list_sessions`, `get_session_document`, `engine_status`, `get_pose_definitions`, `outbox_stats`, `sync_now`, `sync_status`, `movement_phases`, `preview_frame`, `preview_dimensions`.
> - `state.rs` — managed `AppState`; the preview thread only touches the lock-free frame slot, so UI commands never stall capture.
> - Preview thread emits `telemetry-frame` at ~30 Hz (matching `LiveTelemetryFrame`) and `engine-error` on failure.
> - `pages/PatientListPage.tsx` — searchable directory, create/delete dialog, sync-status controls.
> - `pages/ActiveCapturePage.tsx` — split view (live preview + skeleton overlay), `JointAngleGauge`, rep counter, form score, phase badge, high-contrast stop button, WebAudio chime on rep completion (mutable).
> - `pages/SessionDetailPage.tsx` — summary stats, `RepTimelineChart` with hold zones, rep breakdown table, and telemetry upload status (frames, Parquet size, SHA-256, storage path).
> - `hooks/useTauriCapture.ts`, `hooks/useTauriSync.ts`, `lib/ipc.ts` (typed bridge that degrades gracefully outside Tauri), `components/LivePreview.tsx`.
>
> **Notes / decisions:**
> - **Video preview uses Tauri's binary IPC**, not base64/JPEG: frames are downscaled to 320×240 RGB in Rust and returned as raw bytes, then painted into a canvas at ~15 FPS. This avoids adding a JPEG encoder dependency and keeps the payload at ~230 KB instead of ~1.2 MB per frame. The skeleton overlay is a second canvas so it can update at the full 30 Hz telemetry rate.
> - `tsc` previously emitted `.js`/`.d.ts` files *into* `src/` (no `outDir`); `noEmit: true` is now set for both apps and the stale artifacts were deleted.
> - The desktop bundle grew to ~696 kB (recharts); Vite warns about chunk size. Code-splitting is deferred — it does not affect correctness.
> - 15 Rust dead-code warnings remain for engine APIs that the UI does not yet call (e.g. `frames()`, `clear()`); these are intentional forward-looking surface, not errors.

1. **Tauri Command Handlers (`commands.rs`):**
   - `start_preview()`, `stop_preview()`
   - `start_session(patient_id, pose_id)`
   - `stop_session()` $\to$ returns `ClinicalSessionDocument`
   - `list_patients()`, `save_patient()`
2. **Desktop UI Pages (`apps/desktop/src`):**
   - `PatientListPage`: Modern searchable directory of clinic patients with sync status indicators.
   - `ActiveCapturePage`: Split-view workspace featuring:
     - Real-time video preview with live `SkeletalCanvas` overlay.
     - Live `JointAngleGauge` and Repetition Counter.
     - Large, high-contrast stop button and audio feedback chimes on rep completion.
   - `SessionDetailPage`: Post-exercise clinical summary with `RepTimelineChart` and telemetry upload status.

---

### Step 6: Dual-Tier Cloud Sync Pipeline ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** covered by the 65 Rust tests — outbox revision bumping, cascade delete, Parquet staging/reclaim, retry-after-failure, queue resolution, WAL mode assertion, Firestore typed-value mapping, GCS object-path layout and URL encoding. Live upload could not be exercised: no Firebase project credentials exist on this machine, so `sync_now` correctly reports `enabled: false`.
>
> **Delivered:**
> - `outbox.rs` — SQLite in WAL mode with `patients`, `sessions` (document JSON + Parquet BLOB + digest) and `sync_queue` tables, a 5 s busy timeout, and a state machine `pending → uploading → synced | failed`. Failed sessions remain retryable; once a session is `synced` its Parquet blob is reclaimed while the digest and document are retained.
> - `cloud_sync.rs` — Firebase Identity Toolkit sign-in with cached token refresh, Firestore REST `PATCH` of `patients/{patientId}/sessions/{sessionId}` with full typed-value conversion, and Parquet upload to Firebase Storage (GCS-backed) at `telemetry/{patientId}/{sessionId}.parquet`. Parquet is pushed *before* the document so the pointer in Firestore is always valid.
> - Per-session failure isolation: one bad session cannot block the batch.
>
> **Notes / decisions:**
> - **No service-account key ships to the workstation.** The desktop app signs a clinic account in with the Identity Toolkit REST API and uses the resulting ID token; embedding a service account in an installer would be a credential-leak risk.
> - Sync is **entirely optional**. Without `PILATES_FIREBASE_*` credentials the app runs offline and the outbox simply accumulates; `sync_now` returns `enabled: false` rather than erroring.
> - The blocking `reqwest` client is used deliberately: the outbox is synchronous `rusqlite`, and mixing it with an async runtime invites holding a non-`Send` connection across an await point.
> - Cloud sync writes are **once per session**, satisfying the ≥95% reduction in database writes described in the plan.

1. **Local SQLite Outbox (`outbox.rs`):**
   - Embedded SQLite in WAL mode. If internet is offline, all session records and Parquet blobs are staged locally.
2. **Cloud Storage Parquet Uploader (`cloud_sync.rs`):**
   - Upload Parquet telemetry to `gs://<bucket>/telemetry/{patientId}/{sessionId}.parquet`.
3. **Firestore Session Writer:**
   - Commit `ClinicalSessionDocument` directly to `patients/{patientId}/sessions/{sessionId}`.
   - Write occurs **once per session** (or periodic 30s checkpoint), reducing database write operations by $95\%$.

---

### Step 6.5: Database Separation & Schema Migration ✅ COMPLETE

> **Completed:** 2026-11-05
> **Trigger:** runtime error reported from the Patients page — `storage: no such column: total_sessions in SELECT ... FROM patients`.
>
> **Root cause:** The legacy Python app and the new Rust app both stored data at `%LOCALAPPDATA%\PilatesAI\pilates.db`, but with **incompatible schemas**. Because the migration used `CREATE TABLE IF NOT EXISTS patients (...)`, that statement silently did nothing on the pre-existing table — so the Rust queries referenced `total_sessions`, `lifetime_avg_score` and `last_active`, which only ever existed in the new design. `sessions` and `sync_queue` *were* created fresh, leaving the file half-migrated. Adding the missing columns would not have been enough: the legacy table also carries `local_state` soft-delete semantics, so the two apps would have kept corrupting each other.
>
> **Verification:** 76/76 Rust tests pass (10 new). Verified end-to-end against the real database on this machine: the desktop app created `pilates-desktop.db` with `user_version = 1`, imported the existing legacy patient (id and `created_at` preserved), and left `pilates.db` byte-identical with its original schema.
>
> **Delivered:**
> - **Separate store.** The desktop app now uses `pilates-desktop.db`; the legacy file is never opened as our store.
> - **Versioned migrations** via `PRAGMA user_version` (`SCHEMA_VERSION = 1`), replacing the unversioned `CREATE TABLE IF NOT EXISTS` block.
> - **Two guards against recurrence:** opening a database written by a *newer* app version fails with a clear message, and `verify_schema()` asserts the expected columns exist after migrating — so a mismatched database now reports "incompatible `patients` table (missing: …); this is likely the legacy Python database" instead of a cryptic `no such column`.
> - **One-time legacy import** — `import_legacy_patients()` opens the legacy database **read-only**, copies patient rows into the empty store preserving their ids, and queues an `import_legacy_patients` sync marker. It is skipped unless the store is completely empty, so it cannot duplicate data.
> - **Soft delete.** `delete_patient` now sets `local_state = 'tombstone'` (bumping `revision`) instead of hard-deleting, matching the legacy model and letting a deletion still reach Firestore. `list_patients`/`get_patient` filter to `active`; re-saving a tombstoned patient restores it.
> - `sessions_for_patient()` added and wired into `list_sessions`, which previously only returned *unsynced* sessions — history would have disappeared once uploaded.
>
> **Notes:**
> - The empty `sessions`/`sync_queue` tables my earlier build created inside the legacy database were deliberately left alone rather than risk modifying a file the legacy app still owns.
> - `TESTING.md` updated with the new database path and the import behaviour.
> - Unrelated to this fix: the app was running during the rebuild, which locked `pilates-desktop.exe` (`os error 32`). The instance was closed before rebuilding.

---

### Step 6.6: Firestore Compatibility & Patient Sync ✅ COMPLETE

> **Completed:** 2026-11-05
> **Trigger:** existing production Firestore data (patients and analytics) had never been assessed against the new schema.
>
> **What is actually in Firestore** (verified read-only against project `pilates-ai`): 18 patient documents, 2,231 metric documents across `pose1..pose5` (651/378/484/317/401), 6 `comments`, 3 `ageRangeGraph` and 2 `genderGraph` documents, and an empty/absent `aggregationLedger`. Metric timestamps span **1 May 2025 – 21 Nov 2025** (~1 year stale).
>
> **Decisive finding — this data was not written by the legacy Python app:**
> - Document ids are Firestore **auto-ids** (`1vP4WZnlThz7Pq2BdhAE`), not the UUID4 the Python app writes.
> - **Zero of 18** patient documents contain `revision`; none contain `created_at`/`updated_at`.
> - Metric documents hold only `{accuracy, timestamp}` — the Python app also writes `metric_id`, `session_id`, `sample_index`, `model_version`.
> - Patient documents carry `address` (12), `note` (13) and `tel_number` (12), which `Patient.payload()` never produces.
>
> It most likely originates from the FlutterFlow client being sunset. Compatibility therefore had to be judged against real documents, not against the legacy code.
>
> **Compatibility:** demographics (`name`/`age`/`weight`/`height`/`gender`) match exactly; patient ids, `revision` and timestamps do not. `pose{N}_avg` (mean 3-second *accuracy*) is not the new `lifetime_avg_score` (mean *session form score*) and must never be merged. Legacy metrics cannot be converted into sessions without inventing reps and kinematic curves.
>
> **Delivered:**
> - **Patient ids relaxed.** `validate_patient_id` now accepts any Firestore-safe id instead of requiring UUID4, so the 18 existing patients are usable. New patients still get UUIDs. Reserved `__…__` ids are rejected.
> - **Patient sync implemented** — `write_patient_document` / `tombstone_patient_document`, and `flush()` now drains the patient queue (it previously pushed sessions only, so patient operations accumulated forever and `resolve_queue_entry` was dead code).
> - **`sync_pull_patients` command + "Pull from Firestore" button.** The desktop app had **no Firestore read path at all**; existing patients could never appear locally. `pull_patients` paginates the roster and upserts without enqueueing echo writes.
> - `SyncReport.patients_synced`, `PullReport`, `OutboxStats.patients_deleted` surfaced through IPC.
>
> **Notes / decisions:**
> - **`updateMask` semantics were verified empirically, not assumed.** The REST reference says fields "not included in the mask" are deleted, which would have wiped `address`/`note`/`tel_number`. Two disposable probe documents proved the opposite for absent fields: a narrow mask leaves unknown fields untouched, and both strategies preserved them. The narrow mask was then chosen because it is a single request and avoids a read-modify-write race with the Step 7 Cloud Function's aggregate updates.
> - The probe also revealed that Firestore rejects ids of the form `__…__` as reserved — added to validation.
> - Legacy metrics, `ageRangeGraph` and `genderGraph` are deliberately **left untouched** as a frozen read-only archive. They are not migrated, converted, or deleted.
> - Verified: 83/83 Rust tests. The pull path itself is not exercised end-to-end here because the app authenticates with Firebase email/password credentials (`PILATES_FIREBASE_*`), which are not configured on this machine; the REST URL shape was confirmed against the live project using the gcloud token.

---

---

### Legacy Removal: Python Application Retired ✅ COMPLETE

> **Completed:** 2026-11-05
> The legacy PyQt6 application is fully replaced by the Tauri desktop app and has been removed from the repository.
>
> **Deleted:** `src/*.py` (13 modules: `app_controller`, `app_paths`, `capture_session`, `database`, `detection_thread`, `domain`, `local_store`, `logging_config`, `model_handler`, `pilates_ai`, `remote_store`, `sync_service`, `ui_components`), `src/__pycache__`, the legacy `tests/` suite (8 files), `requirements.txt`, `requirements-dev.txt`, `pilates_ai.spec` (PyInstaller), and `config/Dockerfile` (the Python container).
>
> **Preserved and relocated:** the source PyTorch weights moved from `src/models/` to **`assets/models/`**, because `tools/export_onnx.py` needs them to produce the ONNX models the Rust engine loads.
>
> **Follow-on changes:**
> - `tools/export_onnx.py` now reads from `assets/models/` and no longer emits the legacy `models` (`.pt`) catalog into `config/model-manifest.json` — that array existed only for `src/model_handler.py`. The manifest now contains `onnx_models` alone.
> - `tools/verify_onnx.py` dropped the now-unused `MODELS_SRC_DIR`.
> - `README.md` rewritten to describe the current monorepo instead of the retired app (team credits retained).
> - Verified afterwards: ONNX parity **5/5 PASS**, Rust **83/83**, frontend **5/5**, viz smoke 45/45, pose definitions in sync. A repository-wide search confirmed no dangling references to any removed path.

---

### Step 7: Cloud Functions Refactoring ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification:** `node --test functions/test/*.test.js` → **8/8 pass**. Both functions files pass `node --check`.
>
> **Delivered:**
> - **Legacy aggregation removed.** The five `aggregatePoseData_pose{1..5}` triggers on `patients/{patientId}/pose{N}/{docId}` are gone, along with `updateAgeAndGenderGraphs` — the function that ran `database.collection("patients").get()` (a full-collection scan) on **every** metric write. They also targeted a document shape the current application no longer produces.
> - **`onSessionCreated`** — a `firebase-functions/v2` `onDocumentCreated` trigger on `patients/{patientId}/sessions/{sessionId}`, pinned to the `asia-east2` Firestore region and with `retry: true`.
> - **O(1) incremental aggregation.** One transaction per session updates `total_sessions`, `lifetime_avg_score` and `last_active`. No collection scans, so cost and latency are constant regardless of patient count.
> - **Idempotency.** Firestore triggers are delivered *at least once*, so a `sessionLedger/{sessionId}` document makes redelivery a no-op. The legacy code's ledger concept is retained, keyed by session instead of metric.
> - **Non-destructive writes.** The patient update uses `set(..., {merge: true})`, so `address`, `note`, `tel_number` and the legacy `pose{N}_*` aggregates survive — the same guarantee established in Step 6.6.
> - `aggregation.js` takes the database handle as a parameter (no `firebase-admin` import), so the logic is unit-testable without the emulator.
>
> **Notes:**
> - **The legacy cohort charts (`ageRangeGraph`, `genderGraph`) are now frozen.** Nothing maintains them any more, by design (see Step 6.6). Whether to rebuild them from session data, or retire them, is a Step 8 decision.
> - **Deployed to production** as `onSessionCreated` (2nd gen, Node 22, `asia-east2`, matching the Firestore location). Required the project to move to the Blaze plan.
> - **Verified end-to-end against production Firestore** with a disposable patient: the first session set `total_sessions=1`, `lifetime_avg_score=80`, `last_active` from `completed_at`; a second session at 90 produced `total_sessions=2`, `lifetime_avg_score=85` (correct weighted mean); the unrelated `address` field survived. Test documents and both `sessionLedger` entries were deleted afterwards, and all 18 real patients remain untouched.
> - **All 8 legacy functions deleted.** They were initially preserved because three of them — `downloadPatientData`, `getPoseAccuracySummary`, `updateGraphsOnPatientDeletion` — existed only in production and their source was not in this repository, so a bare codebase deploy would have removed them without anyone knowing what they did. After confirming they belonged to the FlutterFlow client, all eight (`aggregatePoseData_pose1..5` plus those three, all `us-central1`) were deleted with `firebase functions:delete --force`. **`onSessionCreated` is now the only deployed function.**
> - **`firebase.json` and `.firebaserc` moved from `config/` to the repository root.** The CLI rejects a `functions` source outside the directory containing `firebase.json` (`../functions is outside of project directory`), which makes the nested layout unusable. Hosting now points at `apps/web/dist`.

---

1. **Deprecate Legacy Aggregation:**
   - Remove obsolete triggers listening to `patients/{patientId}/{pose}/{metricId}`.
2. **Implement Session Trigger (`onSessionCreated`):**
   - Trigger on document creation at `patients/{patientId}/sessions/{sessionId}`.
   - Perform an **$O(1)$ incremental update** on the patient document:
     ```javascript
     const session = snapshot.data();
     const patientRef = database.collection("patients").doc(context.params.patientId);
     
     await database.runTransaction(async (txn) => {
       const doc = await txn.get(patientRef);
       const data = doc.data() || {};
       const totalSessions = (data.total_sessions || 0) + 1;
       const avgScore = ((data.lifetime_avg_score || 0) * (totalSessions - 1) + session.summary.mean_form_score) / totalSessions;
       
       txn.update(patientRef, {
         total_sessions: totalSessions,
         lifetime_avg_score: avgScore,
         last_active: session.completed_at,
       });
     });
     ```
   - **Result:** Completely eliminates the $O(N)$ full-collection scan. Cloud Function execution drops from seconds to $<80\text{ ms}$.

---

### Legacy Data: Preserved as a Read-Only Archive

> **Status:** preserved in Firestore; surfacing in the UI is pending design sign-off.
>
> **Incident, 2026-11-05:** authorisation to delete the eight legacy Cloud Functions was taken as also covering their data, and `gcloud firestore bulk-delete` removed the legacy collections (`pose1..5` 2,231 documents, `comments`, `ageRangeGraph`, `genderGraph`). A full Firestore export had been taken to `gs://pilates-ai-legacy-export/firestore-snapshot-20261105` immediately beforehand, and `gcloud firestore import` restored every document — counts verified identical afterwards (651/378/484/317/401/6, 18 patients). **Lesson: destructive data operations need their own explicit confirmation, separate from code/deployment approvals.**
>
> **Decision:** the legacy data stays permanently, shown read-only. No trigger writes to it any more (all eight functions are deleted), so "never updates" is enforced by infrastructure rather than convention.
>
> **Known data notes:** timestamps span May–Nov 2025 (~1 year stale). The legacy `accuracy` percentage and the new `form_score` are different scales and must never share an axis or be compared numerically.

---

### Step 6.7: Legacy Data Surfacing ✅ COMPLETE

> **Completed:** 2026-11-05
> **Goal:** keep every legacy patient in the new list, with their old data visible in a section that never changes.
>
> **6.7a — Materialisation.** `tools/materialize_legacy.py` walks each patient's `pose1..pose5` and `comments` subcollections once, computes count/avg/min/max/seconds/last-sample, and writes the result as a single **`legacy_json` string field** on the patient document via a narrow `updateMask.fieldPaths=legacy_json`. Ran against production: **18/18 patients** written (2,224 samples total), idempotent and re-runnable, with `--dry-run` support.
> - Stored as a string rather than a nested map deliberately: it is a frozen, never-queried cache, and a string keeps the Rust read path identical to the existing `document_json` handling.
>
> **6.7b — Local schema v2.** `SCHEMA_VERSION` bumped to 2 with an additive migration (`address`, `note`, `tel_number`, `legacy_json`), guarded by a column-existence check so it is safe to re-run. `pull_patients` now carries these fields into SQLite. Upserts use `COALESCE(excluded.x, patients.x)`, so editing a patient in the UI — which sends none of these fields — cannot erase pulled legacy data.
>
> **6.7c — Patient detail page.** Clicking a patient in the directory now opens `PatientDetailPage` instead of jumping straight into capture. It separates the two datasets explicitly:
> - **Current program** — sessions recorded by this application, via `SessionTrendCard`.
> - **Profile** — demographics plus contact details and last session.
> - **Legacy history** — read-only panel with a frozen banner, sample/pose/comment counts and a per-pose accuracy table, captioned to make clear that legacy *accuracy* is a different metric from the new *form score*.
>
> **Bugs fixed in the same pass:**
> - **Dialog stole focus on every keystroke.** The focus effect depended on `onClose`, which is a new inline arrow on each parent render, and its selector matched `button` before `input` — so typing one character moved focus to the close button. The callback now lives in a ref (effect depends only on `open`) and form controls are matched first.
> - **Deleted patient stayed in the sidebar.** The list now reports deletions upward; the shell clears the active patient and leaves the detail page.
> - **Age/weight/height accepted letters.** Now filtered to digits (age) and digits-plus-one-decimal (weight/height), with `inputMode` hints for mobile keyboards.
> - **Gender was free text.** Now a fixed `Female` / `Male` selector.
>
> **Verification:** Rust **86/86** (3 new: legacy-field round trip, edit-does-not-erase, v1→v2 migration preserving rows); frontend **5/5**; viz smoke 45/45; `tsc --noEmit` clean.
>
> **Caveat:** seeing the legacy panel requires **Pull from Firestore**, which needs `PILATES_FIREBASE_*` credentials. Without them the app runs offline and the panel shows "No legacy history" for every patient.

---

### Step 6.8: Cloud Credentials, Optional Storage & Live Verification ✅ COMPLETE

> **Completed:** 2026-11-05
> **Goal:** make the desktop app actually talk to the production Firebase project, and prove it rather than assume it.
>
> **Blaze plan.** Cloud Functions cannot deploy on Spark. The project was upgraded to Blaze before `onSessionCreated` would deploy. Note this also affects the existing functions: with billing disabled they would have failed at runtime, not just at deploy.
>
> **Firebase CLI.** 15.35.0, authenticated as `6531503067@lamduan.mfu.ac.th`. `firebase.json` / `.firebaserc` live at the repository root (see Step 7 for why the `config/` location is unusable).
>
> **Firebase Auth account created** for the desktop app: `6531503067@lamduan.mfu.ac.th` (the user's real address, so password resets work). Email/Password sign-in was already enabled — verified by probing `accounts:signInWithPassword`, which returned `INVALID_LOGIN_CREDENTIALS` rather than `OPERATION_NOT_ALLOWED`.
>
> **Firestore security rules verified empirically** by signing in *as the app user* and performing real reads and writes (my earlier gcloud probes ran as Owner and bypassed rules entirely, so they proved nothing about the app). Result: authenticated read and write both permitted. **These rules are permissive — any account in the project can modify any patient. Tighten before clinical use.**
>
> **No Cloud Storage bucket exists** in the project (only Cloud Functions source buckets). Because `CloudConfig::from_env` previously required a bucket, cloud sync could not start at all — which would have blocked the read-only patient pull. `PILATES_FIREBASE_BUCKET` is now **optional**: Firestore reads/writes work without it, `push_session` skips only the Parquet upload, and `upload_parquet` returns an explicit error instead of failing obscurely.
>
> **Live integration test added:** `pull_patients_from_live_firestore`, `#[ignore]`d so CI stays hermetic, run with `cargo test ... -- --ignored --nocapture`. It exercises the real path — auth, REST, parsing, SQLite — rather than a mock:
> ```
> pulled: fetched=18 imported=18 updated=0
> patients carrying legacy_json: 18
> ```
>
> **Verified the running binary**, not just the library: startup logs `[pilates] cloud sync enabled`, and the real database migrated to schema **v2** with the `address`/`note`/`tel_number`/`legacy_json` columns present.
>
> **Repository hygiene recorded here (previously undocumented):**
> - `.gitignore` now covers `target/` — the Rust build directory held a **541 MB** debug binary that `git add -A` would otherwise have committed. Also added `apps/*/dist/`, `packages/*/dist/`, `.turbo/`, `*.tsbuildinfo`, the fetched `resources/*.dll` (~17 MB) and `resources/.cache/` (~79 MB download cache).
> - Both apps set `"noEmit": true`; `tsc` had been emitting `.js`/`.d.ts` files *into* `src/`, which is why stale `App.js` artifacts were present. Those were deleted.
> - Source weights moved `src/models/` → `assets/models/` when the Python app was retired (see Legacy Removal).
>
> **Operational lessons worth keeping:**
> - **PowerShell parses `a,b,c` as an array.** Passing `--collection-ids=pose1,pose2,…` silently mangled the argument into one space-joined string, and the first `bulk-delete` was a no-op that still reported success. Quote list-valued CLI arguments.
> - **Destructive data operations need their own confirmation**, separate from a "delete the functions" approval — see the incident recorded in the Legacy Data section.
> - **A stale binary can invalidate a verification.** The first startup test reported "no credentials" purely because the on-disk executable predated the optional-bucket change. Rebuild before trusting a runtime check.

---

### Step 6.9: Repetition Counting from the `start` → `end` Transition ✅ COMPLETE

> **Completed:** 2026-11-05
> **Why the angle FSM was replaced.** The five models never persisted keypoint *names*, only counts (3/3/5/7/15). The angle-based FSM therefore depended on a guessed index mapping; a wrong guess makes joint angles meaningless and repetitions silently never count, with no visible symptom.
>
> **Why the first replacement (duration) was also wrong.** Counting one class's *duration* ignores the fact that these are **two-class classifiers**: `start` is the beginning of the movement and `end` is the finish. Duration also breaks on real hardware — clinic cameras flicker, so one hold splits into fragments (all rejected) or several passes merge into one.
>
> **Final model — a transition, debounced on both sides:**
> ```text
>   IDLE ──confirmed 'start'──▶ ARMED ──confirmed 'end'──▶ 1 rep ──▶ IDLE
>                                 │
>                                 └── no 'end' within max_transition ──▶ IDLE
> ```
> - **Debounce** — a class must persist for `confirm_frames` (3 ≈ 100 ms) before it is believed, so a single-frame blip never changes state.
> - **Reject impossibly fast transitions** — `start → end` in under `min_transition_sec` (0.5 s) is a misdetection, not a movement.
> - **Stale `start` expires** — an unmatched start is dropped after `max_transition_sec` (20 s), so one stray detection cannot pair with an `end` a minute later.
> - **A fresh `start` is required for every rep**, so holding `end` — or `end` flickering — never adds repetitions.
>
> **Delivered:**
> - `rep_tracker.rs` — `DetectionRepTracker` implementing the state machine, with per-rep duration (start→end), peak/mean confidence, peak ROM and stability variance.
> - Per-pose tuning in `config/pose-definitions.json`: `start_class` (`"start"`), `end_class` (`"end"`), `min_confidence` (0.25), `confirm_frames` (3), `min_transition_sec` (0.5), `max_transition_sec` (20). Class matching is a case-insensitive substring, so `end` also matches `end left` / `end right` — important for pose4, whose classes are split by side.
> - `CaptureSession` counts reps from the tracker; the angle FSM remains as the **secondary** metric supplying phase, joint angle and the composite form score.
> - Session documents report `duration_sec` per repetition; `completion_rate` is counted vs. attempts, where an attempt is a confirmed `start`.
> - Live telemetry reports the tracker's rep count and the time elapsed since the start position.
> - **Class names reach the UI**: the manifest's `class_names` are loaded into the engine and attached to each detection, so the canvas labels boxes `start 87%` rather than `class 1 87%`.
>
> **Also delivered (bug #2):** `SkeletalCanvas` draws the detection box — dashed, colour-coded by confidence, labelled with class name and percentage — restoring the rectangle the legacy app showed. A live `Detections: N` counter sits beside the preview so "no box" can no longer be confused with "no detection".
>
> **Verification:** Rust **107 passed, 1 ignored** (11 tracker tests: start→end counts, end-without-start ignored, single-blip immunity, flickering end does not double-count, two cycles, too-fast rejection, stale start expiry, low-confidence rejection, side-specific labels, unfinished transition discarded, statistics). The mock pipeline emits `start` at the resting position and `end` at the peak, so the hardware-free test still proves two counted reps end-to-end.
>
> **Notes:**
> - Form score is the mean composite score across the transition. It still blends angle accuracy when angles are available.
> - A `start` with no matching `end` is **not** a rep — it is discarded when the session stops.
> - Every value is per pose in `pose-definitions.json`; change it and regenerate, no rebuild required.

---

### Step 8: Custom Clinical Web Portal (`apps/web`) ✅ COMPLETE

> **Completed:** 2026-11-05
> **Live:** https://pilates-ai.web.app
> **Verification:** `pnpm turbo run build` → 5/5; `tsc --noEmit` clean; deployed to Firebase Hosting and checked over HTTPS — root serves the bundle (1.2 MB), and `/patients` plus `/patients/:id/sessions/:id` both rewrite to the SPA entry point.
>
> **Delivered:**
> - **Firebase client** (`lib/firebase.ts`) — config from `VITE_FIREBASE_*` with project defaults. The web config is public by design; access is governed by Firestore rules.
> - **Auth** (`lib/auth.tsx`) — email/password sign-in with Firebase persistence, clinician-readable error mapping (`auth/invalid-credential` → "Email or password is incorrect"), and a gated shell.
> - **Overview** — clinic totals derived from patient documents only (`total_sessions`, `lifetime_avg_score`, `last_active`, all maintained by `onSessionCreated`), so it needs no session reads.
> - **Patients directory** — search, session counts, mean scores, and **Current / Legacy / None** badges.
> - **Patient profile** — current programme trend plus the same read-only legacy panel the desktop shows, from the same materialised `legacy_json`.
> - **Session replay** — summary statistics, `RepTimelineChart` with hold zones, rep breakdown table, and a `.parquet` download resolved through Firebase Storage.
> - **Deployment** — `firebase deploy --only hosting` publishes `apps/web/dist`; `web-ci.yml` now builds the workspace packages before the portal and deploys on `main`.
>
> **Notes / decisions:**
> - **Stayed on Vite rather than migrating to Next.js as the plan specified.** Every route is auth-gated, per-user data with no SEO requirement, so SSR provides no benefit and would add a hosting pipeline (App Hosting) for no gain. The existing Firebase Hosting rewrites already serve the SPA correctly, including deep links.
> - **Skeleton replay is not possible from Firestore.** The `kinematic_curve` stored on the session document is `{t_sec, angle, score, phase}` at 2 Hz — it contains **no keypoints**. Full-rate skeleton replay requires the Parquet archive, which holds the keypoint columns. The UI states this rather than pretending otherwise; the Parquet download is the path to that data today.
> - **Parquet download will not work until a Storage bucket exists.** The project has none, so `research_telemetry` is absent from sessions and the download button is not rendered.
> - The bundle is 1.2 MB (Firebase SDK). Vite warns about chunk size; code-splitting is deferred.

1. **Patient Progress Dashboard:**
   - Visualizes patient adherence, rep counts, and historical Range of Motion (ROM) gains over time.
2. **Session Replay Interface:**
   - Clinicians can click on any past session and view:
     - Repetition breakdown table with peak angles and hold times.
     - Interactive `RepTimelineChart` showing movement trajectories.
     - 2D `SkeletalCanvas` replaying the patient's movement from the downsampled or full Parquet data.
3. **Data Export for Researchers:**
   - Clinicians or researchers can download the raw `.parquet` file directly from the Web App for custom analysis in Python/R/DuckDB.
4. **Firebase App Hosting / Hosting Deployment:**
   - Configured natively inside `config/firebase.json` under the `hosting` target pointing to `apps/web`.
   - CI/CD workflow (`web-ci.yml`) automatically builds the web app via Turborepo (`pnpm --filter @pilates/web build`) and deploys to Firebase Hosting upon merges to `main`.
   - **Unified Benefits:** Single Google Cloud bill, seamless Firebase Auth state sharing, zero-CORS friction for GCS telemetry downloads, and automated SSL certificate management for custom clinic domains (e.g., `app.pilatesai.clinic`).

---

### Step 9: Comprehensive End-to-End Verification ✅ COMPLETE

> **Completed:** 2026-11-05
> **Verification totals:** Rust **95 passed, 1 ignored**; Cloud Functions **8/8**; frontend **5/5**; viz smoke **45/45**; Parquet audit **PASSED**; ONNX parity **5/5**.
>
> **1. Hardware-free mock video pipeline** (`mock_source.rs`). A deterministic generator produces frames *and* detections, so the real capture path runs with no webcam, no ONNX Runtime and no network. Keypoints are placed so `calculate_joint_angle(hip, knee, ankle)` equals the scripted angle exactly — tests assert on genuine FSM behaviour rather than mocked metrics. `synthetic_pipeline_completes_repetitions_without_hardware` drives a scripted 2-rep profile (rest 20°, peak 90°, 4 s hold) through `CaptureSession` and asserts two completed reps, a peak ROM approaching 90°, and a valid Parquet payload.
>
> **2. Biomechanical unit tests.** Already established in Step 4 and retained: joint trigonometry at 0°/45°/90°/180°, degenerate-vector handling, FSM hold validation (≥3 s), short-hold rejection, multi-rep counting, low-confidence and missing-reading behaviour, and composite score bounds.
>
> **3. Parquet integrity via an independent reader.** `writes_parquet_fixture_for_external_validation` emits a real file; `tools/verify_parquet.py` re-reads it with **polars** — not the Arrow writer that produced it — and asserts the published schema:
> ```
> [OK] column names and order match the published schema
> [OK] every column has the expected dtype
> [OK] rows: 30
> [OK] no null values in any column
> [OK] keypoint_*: 3 entries per frame
> [OK] phase values within the contract
> ```
>
> **4. Offline resilience.** `offline_sessions_persist_and_drain_after_reconnect` records a session with no network, closes the store, reopens it (simulating an application restart), asserts the session and its Parquet blob survived, then marks it synced and asserts the queue drained and the blob was reclaimed.
>
> **5. CI matrix updated.** `desktop-ci.yml` now runs the engine tests, the pose-definition sync check, the visualisation smoke suite, and the Parquet audit (with Python + polars), and uploads the fixture. `web-ci.yml` builds the workspace packages before the portal — previously it would have failed on missing `dist/` outputs — then type-checks and deploys.
>
> **Notes:**
> - The live Firestore pull test remains `#[ignore]`d so CI stays hermetic; run it deliberately with `--ignored`.
> - CI targets `x86_64-pc-windows-msvc`, which has the Windows SDK that this workstation lacks. The ONNX runtime DLL is absent there, so `runs_real_forward_pass_when_runtime_is_installed` skips cleanly rather than failing.

1. **Hardware-Free Mock Video Pipeline:**
   - Provide a synthetic video frame feeder in Rust for automated testing on CI runners without webcams.
2. **Biomechanical Unit Tests:**
   - Verify joint angle math against known trigonometric coordinates ($0^\circ, 45^\circ, 90^\circ, 180^\circ$).
   - Test FSM state transitions under simulated movement curves.
3. **Parquet Integrity Check:**
   - Automated script reading back generated `.parquet` files via Python `polars` / `pyarrow` to verify schema conformity and zero null fields.
4. **Offline Resilience Test:**
   - Simulate network disconnection during a capture session; verify data persists in local SQLite and cleanly drains to Firestore upon reconnection.

---

## 7. Execution Gate: Readiness Sign-Off

This blueprint is fully specified. An engineer or coding agent can begin execution immediately starting with **Phase 1 (Monorepo Setup)** and **Phase 2 (Model Export)**.
