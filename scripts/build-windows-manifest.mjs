#!/usr/bin/env node
'use strict';

// Sestaví a PODEPÍŠE Windows update manifest (windows-manifest.json).
//
// Pro každou nalezenou instalačku spočítá SHA-256, složí kanonický `signed` JSON
// řetězec a podepíše ho Ed25519 privátním klíčem (offline). Výstup nahraješ vedle
// instalaček do DOWNLOAD_ROOT (viz web/INSTALLER_UPLOAD.md). Server ho pak servíruje
// za auth bránou na /api/updates/windows; klient ověří podpis proti zapinovanému
// veřejnému klíči a SHA-256 staženého .exe.
//
// Použití:
//   node web/scripts/build-windows-manifest.mjs --version 0.1.2 --build 3 \
//        [--notes "Co je nového"] [--channel stable] \
//        [--installers ~/Downloads] [--out web/downloads/windows-manifest.json] \
//        [--key ~/.movly/windows-update-ed25519.pem]
//
// Verze + build code drž v páru s Windows/Movly/Movly.csproj (<AssemblyVersion>x.y.z.build</AssemblyVersion>).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ARCHES = [
  { arch: 'arm64', fileName: 'MovlySetup-arm64.exe', downloadId: 'windows-arm64' },
  { arch: 'x64', fileName: 'MovlySetup-x64.exe', downloadId: 'windows-x64' },
  { arch: 'x86', fileName: 'MovlySetup-x86.exe', downloadId: 'windows-x86' },
];

const args = parseArgs(process.argv.slice(2));
const version = required('version');
const buildCode = Number.parseInt(required('build'), 10);
const notes = args.notes || '';
const channel = args.channel || 'stable';
const releasedAt = args.date || new Date().toISOString().slice(0, 10);
const installersDir = path.resolve(args.installers || path.join(os.homedir(), 'Downloads'));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const outPath = path.resolve(args.out || path.join(repoRoot, 'web', 'downloads', WINDOWS_MANIFEST_NAME()));
const keyPath = args.key || process.env.MOVLY_WIN_UPDATE_KEY
  || path.join(os.homedir(), '.movly', 'windows-update-ed25519.pem');

if (!Number.isInteger(buildCode) || buildCode <= 0) fail('--build musí být kladné celé číslo (build code).');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('--version musí být ve tvaru x.y.z.');
if (!fs.existsSync(keyPath)) fail(`Privátní klíč nenalezen: ${keyPath}\nVygeneruj ho: node web/scripts/setup-windows-update-key.mjs`);

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));

const arches = {};
for (const entry of ARCHES) {
  const filePath = path.join(installersDir, entry.fileName);
  if (!fs.existsSync(filePath)) {
    console.warn(`! Přeskakuji ${entry.arch}: ${filePath} neexistuje.`);
    continue;
  }
  const sha256 = sha256Hex(filePath);
  arches[entry.arch] = { fileName: entry.fileName, sha256, downloadId: entry.downloadId };
  console.log(`✓ ${entry.arch.padEnd(5)} ${entry.fileName}  sha256=${sha256.slice(0, 16)}…`);
}

if (Object.keys(arches).length === 0) {
  fail(`V ${installersDir} nebyla žádná instalačka (${ARCHES.map((a) => a.fileName).join(', ')}).`);
}

// Kanonický řetězec: klíče v PEVNÉM pořadí, kompaktní JSON. Přesně tenhle string se
// podepisuje a přesně tenhle string klient ověřuje a parsuje — žádná dvojznačnost.
const signedObject = { version, buildCode, channel, releasedAt, notes, arches };
const signed = JSON.stringify(signedObject);
const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), privateKey).toString('base64');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ signed, signature }, null, 2) + '\n');

console.log(`\nManifest podepsán a zapsán:\n  ${outPath}`);
console.log(`  verze ${version} (build ${buildCode}), kanál ${channel}, ${Object.keys(arches).length} architektur`);
console.log('\nDalší krok: nahraj windows-manifest.json + .exe instalačky na server (web/INSTALLER_UPLOAD.md).');

function WINDOWS_MANIFEST_NAME() {
  return 'windows-manifest.json';
}

function sha256Hex(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function required(name) {
  const value = args[name];
  if (value === undefined || value === 'true') fail(`Chybí povinný argument --${name}.`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
