#!/usr/bin/env node
'use strict';

// Vygeneruje Ed25519 klíčový pár pro podepisování Windows update manifestu.
//
// - PRIVÁTNÍ klíč se uloží MIMO repozitář (default ~/.movly/windows-update-ed25519.pem,
//   práva 0600). Používá ho jen build-windows-manifest.mjs na tvém stroji.
// - VEŘEJNÝ klíč (raw 32 B, base64) se vypíše — vlož ho do Windows appky do
//   Services/UpdateService.cs (konstanta PublicKeyBase64).
//
// Tohle je přesný protějšek Apple/scripts/setup_sparkle_key.sh (EdDSA pro Sparkle).
//
// Použití:
//   node web/scripts/setup-windows-update-key.mjs            # vytvoří klíč (odmítne přepsat)
//   node web/scripts/setup-windows-update-key.mjs --force    # přegeneruje (zneplatní starý!)
//   MOVLY_WIN_UPDATE_KEY=/cesta/klic.pem node web/scripts/setup-windows-update-key.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const force = process.argv.includes('--force');
const keyPath = process.env.MOVLY_WIN_UPDATE_KEY
  || path.join(os.homedir(), '.movly', 'windows-update-ed25519.pem');

if (fs.existsSync(keyPath) && !force) {
  console.error(`Privátní klíč už existuje: ${keyPath}`);
  console.error('Veřejný klíč k němu:');
  console.error(`  ${publicKeyBase64(fs.readFileSync(keyPath, 'utf8'))}`);
  console.error('Přegenerování by zneplatnilo všechny dosud podepsané manifesty.');
  console.error('Pokud to opravdu chceš, spusť znovu s --force.');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(keyPath, privatePem, { mode: 0o600 });
fs.chmodSync(keyPath, 0o600);

const pub = rawPublicKeyBase64(publicKey);

console.log('Ed25519 klíčový pár pro Windows update je hotový.\n');
console.log(`Privátní klíč (drž OFFLINE, nikdy ho necommituj):\n  ${keyPath}\n`);
console.log('Veřejný klíč — vlož do Windows/Movly/Services/UpdateService.cs:');
console.log(`  private const string PublicKeyBase64 = "${pub}";\n`);
console.log('Manifest pak podepisuj přes:');
console.log('  node web/scripts/build-windows-manifest.mjs --version <x.y.z> --build <n> [--notes "…"]');

function rawPublicKeyBase64(publicKeyObject) {
  // SPKI DER pro Ed25519 má 44 B; raw 32bytový klíč jsou poslední 4 řádky (poslední 32 B).
  const der = publicKeyObject.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64');
}

function publicKeyBase64(privatePemText) {
  const pub = crypto.createPublicKey(crypto.createPrivateKey(privatePemText));
  return rawPublicKeyBase64(pub);
}
