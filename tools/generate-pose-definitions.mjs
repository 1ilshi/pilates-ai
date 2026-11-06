#!/usr/bin/env node
/**
 * Generates packages/types/src/pose-definitions.generated.ts from
 * config/pose-definitions.json.
 *
 * The JSON file is the single source of truth: it is embedded into the Tauri
 * installer for the Rust engine (Step 4) and compiled into the TypeScript
 * packages for the React UI. Generating the TS module keeps both in lockstep
 * without hand-maintaining two copies.
 *
 * Usage:
 *   node tools/generate-pose-definitions.mjs           # write the module
 *   node tools/generate-pose-definitions.mjs --check   # verify it is current
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SOURCE = join(ROOT, "config", "pose-definitions.json");
const TARGET = join(
  ROOT,
  "packages",
  "types",
  "src",
  "pose-definitions.generated.ts",
);

const BANNER = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT.
 *
 * Source of truth: config/pose-definitions.json
 * Regenerate with:  node tools/generate-pose-definitions.mjs
 */`;

function readDefinitions() {
  if (!existsSync(SOURCE)) {
    throw new Error(`pose definitions not found: ${SOURCE}`);
  }
  const raw = readFileSync(SOURCE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${SOURCE}: ${error.message}`);
  }
  validate(parsed);
  return parsed;
}

/** Fail fast on structurally broken definitions rather than emitting bad types. */
function validate(defs) {
  const errors = [];
  if (!defs.poses || typeof defs.poses !== "object") {
    throw new Error("pose-definitions.json must contain a `poses` object");
  }
  const ids = Object.keys(defs.poses);
  if (ids.length !== 5) {
    errors.push(`expected 5 poses, found ${ids.length}`);
  }
  for (const id of ids) {
    const pose = defs.poses[id];
    if (pose.pose_id !== id) {
      errors.push(`${id}: pose_id "${pose.pose_id}" does not match its key`);
    }
    const n = pose.keypoint_count;
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`${id}: keypoint_count must be a positive integer`);
      continue;
    }
    if (pose.keypoint_labels?.length !== n) {
      errors.push(
        `${id}: keypoint_labels has ${pose.keypoint_labels?.length} entries, expected ${n}`,
      );
    }
    for (const [i, bone] of (pose.bones ?? []).entries()) {
      if (!Array.isArray(bone) || bone.length !== 2) {
        errors.push(`${id}: bone ${i} must be a [from, to] pair`);
        continue;
      }
      for (const idx of bone) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
          errors.push(`${id}: bone ${i} references out-of-range index ${idx}`);
        }
      }
    }
    for (const slot of ["primary_angle", "secondary_angle"]) {
      const angle = pose[slot];
      if (angle == null) {
        if (slot === "primary_angle") errors.push(`${id}: primary_angle is required`);
        continue;
      }
      for (const key of ["a", "b", "c"]) {
        const idx = angle[key];
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
          errors.push(`${id}: ${slot}.${key} index ${idx} out of range`);
        }
      }
      if (!angle.name) errors.push(`${id}: ${slot}.name is required`);
    }
    const rom = pose.target_rom;
    if (!rom || ![rom.min, rom.max, rom.target].every(Number.isFinite)) {
      errors.push(`${id}: target_rom requires numeric min/max/target`);
    } else if (!(rom.min <= rom.target && rom.target <= rom.max)) {
      errors.push(`${id}: target_rom must satisfy min <= target <= max`);
    }
  }
  if (errors.length) {
    throw new Error(`invalid pose definitions:\n  - ${errors.join("\n  - ")}`);
  }
}

function render(defs) {
  const body = JSON.stringify(defs, null, 2);
  return `${BANNER}

import type { PoseDefinitionMap } from "./pose-definitions";

export const POSE_DEFINITIONS_SOURCE_SHA256: string =
  "__SHA256__";

export const POSE_DEFINITIONS: PoseDefinitionMap = ${body} as PoseDefinitionMap;
`;
}

function sha256(text) {
  // Tiny, dependency-free SHA-256 so this script needs no npm install.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(
    (((bytes.length + 9) >> 6) + 1) << 6,
  );
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

function main() {
  const check = process.argv.includes("--check");
  const defs = readDefinitions();
  const digest = sha256(JSON.stringify(defs, null, 2));
  const output = render(defs).replace("__SHA256__", digest);

  if (check) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
    if (current !== output) {
      console.error(
        `[FAIL] ${relative(ROOT, TARGET)} is stale. Run: node tools/generate-pose-definitions.mjs`,
      );
      process.exit(1);
    }
    console.log(`[ OK ] pose definitions up to date (sha256 ${digest.slice(0, 16)}...)`);
    return;
  }

  writeFileSync(TARGET, output, "utf8");
  console.log(
    `[ OK ] wrote ${relative(ROOT, TARGET)} (sha256 ${digest.slice(0, 16)}...)`,
  );
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
