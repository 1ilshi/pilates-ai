#!/usr/bin/env node
/**
 * Build `latest.json` — the manifest the desktop updater polls.
 *
 * The workflow downloads every installer artifact into one directory, then runs
 * this script. It reads the version from `tauri.conf.json` and classifies each
 * `.sig` file that Tauri produced, because a signature only exists for an
 * artifact the updater can actually install.
 *
 * URLs point at `releases/latest/download/<asset>`, so the manifest never has
 * to embed the tag and the same file keeps working for the next release.
 *
 * Usage:
 *   node tools/build-update-manifest.mjs <dist-dir> [--base-url <url>]
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CONF = join(ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json");

const DEFAULT_BASE =
  "https://github.com/1ilshi/pilates-ai/releases/latest/download";

/**
 * Map an artifact to a Tauri updater platform key.
 *
 * Only artifacts with a signature are updatable, and the key must match what
 * `tauri-plugin-updater` asks for on the host.
 *
 * `priority` breaks ties *within* a platform: lower wins. On Windows both the
 * NSIS installer and the MSI are signed, but the NSIS installer is the update
 * path — a per-user NSIS install cannot be updated by a per-machine MSI.
 */
const RULES = [
  { test: /-setup\.exe\.sig$/i, platform: "windows-x86_64", priority: 0 },
  { test: /\.msi\.sig$/i, platform: "windows-x86_64", priority: 1 },
  { test: /\.app\.tar\.gz\.sig$/i, platform: "darwin-aarch64", priority: 0 },
  { test: /\.AppImage\.tar\.gz\.sig$/i, platform: "linux-x86_64", priority: 0 },
  { test: /\.AppImage\.sig$/i, platform: "linux-x86_64", priority: 1 },
];

function classify(name) {
  for (const rule of RULES) {
    if (rule.test.test(name)) return { platform: rule.platform, priority: rule.priority };
  }
  return null;
}

function assetUrl(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
}

/** Every file under `dir`, at any depth. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const distIndex = args.findIndex((arg) => !arg.startsWith("--"));
  const distArg = distIndex === -1 ? "dist" : args[distIndex];
  const baseFlag = args.indexOf("--base-url");
  const baseUrl = baseFlag === -1 ? DEFAULT_BASE : args[baseFlag + 1];

  const dist = resolve(ROOT, distArg);
  const config = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const version = config.version;

  // `download-artifact` keeps each artifact's internal directory structure, so
  // the installers arrive nested several levels deep — and some of those paths
  // contain `release/bundle`, which is why the staging directory lives outside
  // `dist`: a staging dir *inside* it collided with an artifact path and `gh`
  // tried to upload a directory as a release asset.
  const outDir = resolve(ROOT, "release-assets");
  mkdirSync(outDir, { recursive: true });

  const files = walk(dist).map((path) => ({
    path,
    name: path.split(/[\\/]/).pop(),
  }));

  const platforms = {};
  const chosen = {};

  for (const { path, name } of files) {
    const kind = classify(name);
    if (!kind) continue;

    // `foo.exe.sig` -> `foo.exe`
    const artifactName = name.replace(/\.sig$/, "");
    const artifact = files.find((entry) => entry.name === artifactName);
    if (!artifact) {
      console.warn(`warn: ${name} has no matching artifact, skipped`);
      continue;
    }

    const signature = readFileSync(path, "utf8").trim();
    if (!signature) {
      console.warn(`warn: ${name} is empty, skipped`);
      continue;
    }

    // Walk order is filesystem order, so "first match wins" is not stable:
    // msi/ sorts before nsis/ and would win on Windows. Compare priority.
    const current = chosen[kind.platform];
    if (current && current.priority <= kind.priority) {
      console.log(`  ${kind.platform}: keeping ${current.artifactName}, ignoring ${artifactName}`);
      continue;
    }

    if (current) {
      console.log(`  ${kind.platform}: preferring ${artifactName} over ${current.artifactName}`);
    }

    chosen[kind.platform] = { priority: kind.priority, artifactName };
    copyFileSync(artifact.path, join(outDir, artifactName));
    copyFileSync(path, join(outDir, name));
    platforms[kind.platform] = { signature, url: assetUrl(baseUrl, artifactName) };
    console.log(`  ${kind.platform}: ${artifactName}`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error("error: no signed updater artifacts found under " + dist);
    console.error("found " + files.length + " file(s): " + files.map((f) => f.name).join(", "));
    process.exit(1);
  }

  // Every installer is published, not only the ones the updater installs: a
  // clinic downloading by hand wants the .msi and .deb too.
  for (const { path, name } of files) {
    if (name.endsWith(".sig")) continue;
    if (!/\.(exe|msi|dmg|deb|AppImage|tar\.gz)$/i.test(name)) continue;
    copyFileSync(path, join(outDir, name));
  }

  const manifest = {
    version,
    notes: process.env.RELEASE_NOTES ?? `Pilates AI ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const out = join(outDir, "latest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out} (version ${version}, ${Object.keys(platforms).length} platform(s))`);

  // `channel.json` is the policy file, separate from the artifact list: it
  // records the oldest version still supported. It is raised only when a
  // change is genuinely incompatible with older clients (a MAJOR), never for
  // ordinary fixes, so a clinic on an older build keeps working.
  const channel = {
    schema_version: 1,
    latest: version,
    minimum: process.env.MINIMUM_VERSION ?? version,
    updated_at: new Date().toISOString(),
  };
  const channelPath = join(outDir, "channel.json");
  writeFileSync(channelPath, `${JSON.stringify(channel, null, 2)}\n`);
  console.log(`wrote ${channelPath} (minimum ${channel.minimum})`);
}

main();
