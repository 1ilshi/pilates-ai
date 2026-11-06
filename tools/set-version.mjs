#!/usr/bin/env node
/**
 * Write one version into every manifest that carries it.
 *
 * The desktop version currently lives in three places — `package.json`,
 * `tauri.conf.json` and `Cargo.toml` — and nothing keeps them in step. A
 * release is cut from a git tag (`desktop-v2.1.0`), so the tag is the only
 * source of truth and this script is the one thing that propagates it.
 *
 * Usage:
 *   node tools/set-version.mjs 2.1.0          # write
 *   node tools/set-version.mjs desktop-v2.1.0 # tag form, the prefix is stripped
 *   node tools/set-version.mjs --check        # verify the three agree
 *
 * Exits non-zero if the version is not semver, if `--check` finds a mismatch,
 * or if a manifest cannot be updated.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MANIFESTS = {
  package: join(ROOT, "apps", "desktop", "package.json"),
  tauri: join(ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json"),
  cargo: join(ROOT, "apps", "desktop", "src-tauri", "Cargo.toml"),
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Strip the `desktop-v` release-tag prefix, if present. */
function normalise(raw) {
  return raw.replace(/^desktop-v/, "").replace(/^v/, "");
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPackageVersion() {
  return readJson(MANIFESTS.package).version;
}

function readTauriVersion() {
  return readJson(MANIFESTS.tauri).version;
}

function readCargoVersion() {
  const lines = readFileSync(MANIFESTS.cargo, "utf8").split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (inPackage && /^version\s*=/.test(trimmed)) {
      const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
      if (!match) break;
      return match[1];
    }
  }
  return null;
}

function writePackage(version) {
  const json = readJson(MANIFESTS.package);
  json.version = version;
  writeFileSync(MANIFESTS.package, `${JSON.stringify(json, null, 2)}\n`);
}

function writeTauri(version) {
  const json = readJson(MANIFESTS.tauri);
  json.version = version;
  writeFileSync(MANIFESTS.tauri, `${JSON.stringify(json, null, 2)}\n`);
}

function writeCargo(version) {
  const text = readFileSync(MANIFESTS.cargo, "utf8");
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  let updated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("[")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    // Only the `[package]` version — dependency versions must not move.
    if (inPackage && /^version\s*=/.test(trimmed)) {
      lines[index] = `version = "${version}"`;
      updated = true;
      break;
    }
  }
  if (!updated) fail(`no [package] version found in ${MANIFESTS.cargo}`);
  writeFileSync(MANIFESTS.cargo, lines.join("\n"));
}

function report() {
  const versions = {
    "apps/desktop/package.json": readPackageVersion(),
    "apps/desktop/src-tauri/tauri.conf.json": readTauriVersion(),
    "apps/desktop/src-tauri/Cargo.toml": readCargoVersion(),
  };
  for (const [file, value] of Object.entries(versions)) {
    console.log(`  ${file}: ${value ?? "(missing)"}`);
  }
  return versions;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    const versions = report();
    const values = Object.values(versions);
    if (values.some((value) => value === null)) {
      fail("a manifest has no version");
    }
    if (new Set(values).size !== 1) {
      fail("the three manifests disagree — run `node tools/set-version.mjs <version>`");
    }
    console.log(`  OK: all manifests report ${values[0]}`);
    return;
  }

  const raw = args.find((arg) => !arg.startsWith("-"));
  if (!raw) fail("usage: node tools/set-version.mjs <version|desktop-vX.Y.Z> [--check]");

  const version = normalise(raw);
  if (!SEMVER.test(version)) fail(`not a semver version: ${raw}`);

  console.log(`Setting desktop version to ${version}`);
  writePackage(version);
  writeTauri(version);
  writeCargo(version);
  report();
  console.log("  done — rebuild the installers so the bundles carry the new version");
}

main();
