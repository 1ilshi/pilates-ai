#!/usr/bin/env node
/**
 * Render + math smoke harness for @pilates/viz and @pilates/ui.
 *
 * Bundles smoke.tsx with esbuild and executes it in Node, verifying:
 *   - joint-angle trigonometry against known coordinates (0/45/90/180 deg)
 *   - confidence-band thresholds (green >= 0.8, yellow 0.5-0.8, red < 0.5)
 *   - pose definition integrity (label counts, index bounds)
 *   - hold-range derivation from a kinematic curve
 *   - every UI primitive and visualization component renders without throwing
 *
 * Usage:  pnpm --filter @pilates/viz smoke
 */

import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "smoke.bundle.cjs");

buildSync({
  entryPoints: [join(HERE, "smoke.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  outfile: OUT,
  logLevel: "warning",
  // Provided by this package's node_modules at runtime.
  external: [
    "react",
    "react-dom",
    "react-dom/server",
    "react/jsx-runtime",
    "recharts",
    "lucide-react",
  ],
});

execFileSync(process.execPath, [OUT], { stdio: "inherit" });
