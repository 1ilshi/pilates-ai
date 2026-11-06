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

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 */
const RULES = [
  { test: /-setup\.exe\.sig$/i, platform: "windows-x86_64" },
  { test: /\.msi\.sig$/i, platform: "windows-x86_64" },
  { test: /\.app\.tar\.gz\.sig$/i, platform: "darwin-aarch64" },
  { test: /\.AppImage\.tar\.gz\.sig$/i, platform: "linux-x86_64" },
  { test: /\.AppImage\.sig$/i, platform: "linux-x86_64" },
];

function classify(name) {
  for (const rule of RULES) {
    if (rule.test.test(name)) return rule.platform;
  }
  return null;
}

function assetUrl(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
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

  const files = readdirSync(dist);
  const platforms = {};

  for (const file of files) {
    const platform = classify(file);
    if (!platform) continue;

    // `foo.exe.sig` -> `foo.exe`
    const artifact = file.replace(/\.sig$/, "");
    if (!files.includes(artifact)) {
      console.warn(`warn: ${file} has no matching artifact, skipped`);
      continue;
    }

    const signature = readFileSync(join(dist, file), "utf8").trim();
    if (!signature) {
      console.warn(`warn: ${file} is empty, skipped`);
      continue;
    }

    if (platforms[platform]) {
      // NSIS and MSI both map to windows-x86_64; the NSIS installer is the
      // update path, so keep the first (rules are ordered by preference).
      console.log(`  ${platform}: already set, ignoring ${artifact}`);
      continue;
    }

    platforms[platform] = { signature, url: assetUrl(baseUrl, artifact) };
    console.log(`  ${platform}: ${artifact}`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error("error: no signed updater artifacts found in " + dist);
    process.exit(1);
  }

  const manifest = {
    version,
    notes: process.env.RELEASE_NOTES ?? `Pilates AI ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const out = join(dist, "latest.json");
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
  const channelPath = join(dist, "channel.json");
  writeFileSync(channelPath, `${JSON.stringify(channel, null, 2)}\n`);
  console.log(`wrote ${channelPath} (minimum ${channel.minimum})`);
}

main();
