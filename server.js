#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = __dirname;
const PORT = Number.parseInt(process.env.MOVLY_WEB_PORT || process.env.PORT || '8080', 10);
const API_BASE = (process.env.MOVLY_API_BASE || 'https://api-go.shebin.eu').replace(/\/+$/, '');
const API_KEY = process.env.MOVLY_API_KEY;
const DOWNLOAD_ROOT = path.resolve(process.env.DOWNLOAD_ROOT || path.join(ROOT_DIR, 'downloads'));
const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET;
const DOWNLOAD_TOKEN_TTL_SECONDS = Number.parseInt(process.env.DOWNLOAD_TOKEN_TTL_SECONDS || '300', 10);

const setupErrors = [];
if (!API_KEY) setupErrors.push('MOVLY_API_KEY není nastavený.');
if (!DOWNLOAD_TOKEN_SECRET || DOWNLOAD_TOKEN_SECRET.length < 24) {
  setupErrors.push('DOWNLOAD_TOKEN_SECRET musí být nastavený a mít alespoň 24 znaků.');
}
if (!Number.isFinite(PORT) || PORT <= 0) setupErrors.push('MOVLY_WEB_PORT/PORT není platný port.');
if (!Number.isFinite(DOWNLOAD_TOKEN_TTL_SECONDS) || DOWNLOAD_TOKEN_TTL_SECONDS < 30) {
  setupErrors.push('DOWNLOAD_TOKEN_TTL_SECONDS musí být alespoň 30.');
}
if (setupErrors.length > 0) {
  console.error('[Movly web] Konfigurace není kompletní:');
  setupErrors.forEach((line) => console.error(`- ${line}`));
  process.exit(1);
}

// Privátní Windows update manifest. Leží vedle instalaček v DOWNLOAD_ROOT a je
// PODEPSANÝ OFFLINE (Ed25519) na build stroji — server ho jen servíruje za auth
// bránou a doplní živé velikosti souborů. Privátní klíč na serveru NIKDY není,
// takže ani kompromitovaný web nepodstrčí klientovi falešnou aktualizaci.
// Stejná vlastnost jako Sparkle EdDSA na macOS.
const WINDOWS_UPDATE_MANIFEST = 'windows-manifest.json';

const DOWNLOADS = [
  {
    id: 'windows-x64',
    platform: 'Windows',
    title: 'Windows x64',
    subtitle: 'Většina běžných PC a notebooků s Intel/AMD',
    fileName: 'MovlySetup-x64.exe',
    type: 'EXE installer',
  },
  {
    id: 'windows-arm64',
    platform: 'Windows',
    title: 'Windows ARM64',
    subtitle: 'Surface/Parallels a ARM zařízení',
    fileName: 'MovlySetup-arm64.exe',
    type: 'EXE installer',
  },
  {
    id: 'windows-x86',
    platform: 'Windows',
    title: 'Windows x86',
    subtitle: 'Starší 32bit Windows',
    fileName: 'MovlySetup-x86.exe',
    type: 'EXE installer',
  },
  {
    id: 'macos-universal',
    platform: 'macOS',
    title: 'macOS Universal',
    subtitle: 'Apple Silicon i Intel Mac',
    fileName: 'Movly-macOS-universal-devsigned.zip',
    type: 'ZIP aplikace',
  },
];

class HttpError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

class ApiError extends Error {
  constructor(status, payload) {
    const message = payload?.message || payload?.error || payload?.detail?.message || `Movly API vrátilo chybu ${status}.`;
    super(message);
    this.status = status;
    this.payload = payload;
    this.code = payload?.detail?.code || payload?.code;
  }
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

function json(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function notFound(res) {
  json(res, 404, { message: 'Nenalezeno.' });
}

function readRequestBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Požadavek je příliš velký.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Požadavek nemá platný JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function prehashPassword(password) {
  const digest = crypto.createHash('sha256').update(password, 'utf8').digest('base64');
  return `sha256:${digest}`;
}

function apiHeaders(token, sessionId = `web-${crypto.randomUUID()}`) {
  const headers = {
    Accept: 'application/json',
    'Api-Key': API_KEY,
    'X-Session-ID': sessionId,
    'X-Device-Type': 'mobile',
    'X-Platform': 'android',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function movlyApi(pathname, method, body, token, sessionId) {
  const url = `${API_BASE}/${pathname.replace(/^\/+/, '')}`;
  const headers = apiHeaders(token, sessionId);
  const options = { method, headers };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new HttpError(502, `Nepodařilo se spojit s Movly API: ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HttpError(502, `Movly API vrátilo nečitelnou odpověď (${response.status}).`);
    }
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

async function attemptLogin(username, password, sessionId) {
  return movlyApi(
    'v1/auth/login',
    'POST',
    {
      username,
      password,
      device_id: sessionId,
      device_type: 'android_mobile',
      push_id: null,
    },
    null,
    sessionId,
  );
}

function normalizeAccount(payload) {
  const raw = payload?.user?.account || payload?.user || payload?.account || payload;
  if (!raw || typeof raw !== 'object') throw new HttpError(502, 'Movly API nevrátilo údaje účtu.');
  return {
    id: raw.id,
    username: raw.username || '',
    email: raw.email || '',
    displayName: raw.display_name || raw.displayName || null,
    premiumUntil: raw.premium_until || raw.premiumUntil || null,
    coins: raw.coins ?? null,
    role: raw.role || 'user',
  };
}

function roleRank(role) {
  switch (String(role || '').trim().toLowerCase()) {
    case 'admin':
      return 4;
    case 'moderator':
      return 3;
    case 'vip':
      return 2;
    case 'user':
      return 1;
    default:
      return 1;
  }
}

function roleDisplayName(role) {
  switch (String(role || '').trim().toLowerCase()) {
    case 'admin':
      return 'Admin';
    case 'moderator':
      return 'Moderátor';
    case 'vip':
      return 'VIP';
    default:
      return 'Uživatel';
  }
}

function isPremiumActive(premiumUntil) {
  const raw = String(premiumUntil || '').trim();
  if (!raw) return false;
  const datePart = raw.split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return true;
  const [year, month, day] = datePart.split('-').map(Number);
  const premiumDate = new Date(year, month - 1, day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return premiumDate >= today;
}

function sessionPayload(account, token) {
  const premiumActive = isPremiumActive(account.premiumUntil);
  const elevatedRole = roleRank(account.role) >= 2;
  const hasDownloadAccess = premiumActive || elevatedRole;
  return {
    ...(token ? { token } : {}),
    account: {
      username: account.username,
      email: account.email,
      displayName: account.displayName,
      coins: account.coins,
    },
    hasDownloadAccess,
    accessLabel: hasDownloadAccess ? 'Přístup povolen' : 'Nedostupné',
  };
}

async function validateAccess(req) {
  const token = extractBearerToken(req);
  if (!token) throw new HttpError(401, 'Přihlas se Movly účtem.');
  const payload = await movlyApi('v1/auth/me', 'GET', null, token);
  const account = normalizeAccount(payload);
  const session = sessionPayload(account);
  if (!session.hasDownloadAccess) {
    throw new HttpError(403, 'Pro tento účet teď nejsou instalačky dostupné.');
  }
  return { token, account, session };
}

function downloadInfo(item) {
  const filePath = path.join(DOWNLOAD_ROOT, item.fileName);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not-file');
    return {
      ...item,
      fileName: item.fileName,
      sizeBytes: stat.size,
      sizeLabel: formatBytes(stat.size),
      available: true,
    };
  } catch {
    return {
      ...item,
      fileName: item.fileName,
      sizeBytes: null,
      sizeLabel: null,
      available: false,
      missingMessage: `Soubor ${item.fileName} není v ${DOWNLOAD_ROOT}.`,
    };
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function signDownloadToken(downloadId) {
  const payload = base64url(
    JSON.stringify({
      id: downloadId,
      exp: Date.now() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000,
      nonce: crypto.randomUUID(),
    }),
  );
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

function verifyDownloadToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new HttpError(403, 'Download odkaz není platný.');
  const expected = hmac(payload);
  if (!safeEqual(sig, expected)) throw new HttpError(403, 'Download odkaz není platný.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(403, 'Download odkaz není platný.');
  }
  if (!parsed.exp || Date.now() > parsed.exp) throw new HttpError(403, 'Download odkaz vypršel.');
  const item = DOWNLOADS.find((candidate) => candidate.id === parsed.id);
  if (!item) throw new HttpError(404, 'Instalátor neexistuje.');
  return item;
}

function hmac(value) {
  return crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(value).digest('base64url');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function handleLogin(req, res) {
  const body = await readRequestBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw new HttpError(400, 'Vyplň uživatelské jméno/e-mail a heslo.');

  const sessionId = `web-${crypto.randomUUID()}`;
  let payload;
  try {
    payload = await attemptLogin(username, prehashPassword(password), sessionId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'password_upgrade_required') {
      payload = await attemptLogin(username, password, sessionId);
    } else {
      throw error;
    }
  }

  const token = payload?.token;
  if (!token) throw new HttpError(502, 'Movly API nevrátilo přihlašovací token.');
  const account = normalizeAccount(payload);
  json(res, 200, sessionPayload(account, token));
}

async function handleMe(req, res) {
  const token = extractBearerToken(req);
  if (!token) throw new HttpError(401, 'Přihlas se Movly účtem.');
  const payload = await movlyApi('v1/auth/me', 'GET', null, token);
  json(res, 200, sessionPayload(normalizeAccount(payload)));
}

async function handleLogout(req, res) {
  const token = extractBearerToken(req);
  if (!token) {
    json(res, 200, { ok: true, message: 'Lokální session je prázdná.' });
    return;
  }
  await movlyApi('v1/auth/logout', 'POST', null, token);
  json(res, 200, { ok: true });
}

async function handleDownloads(req, res) {
  await validateAccess(req);
  json(res, 200, { downloads: DOWNLOADS.map(downloadInfo) });
}

async function handleDownloadLink(req, res, id) {
  await validateAccess(req);
  const item = DOWNLOADS.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, 'Instalátor neexistuje.');
  const info = downloadInfo(item);
  if (!info.available) throw new HttpError(404, info.missingMessage);
  json(res, 200, {
    url: `/secure-download/${signDownloadToken(item.id)}`,
    expiresInSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
  });
}

async function handleWindowsUpdate(req, res) {
  // Stejná brána jako stahování: platný Movly token + premium/VIP+ (validateAccess).
  // Bez přístupu → 401/403, takže feed zůstává neveřejný.
  await validateAccess(req);

  const manifestPath = path.join(DOWNLOAD_ROOT, WINDOWS_UPDATE_MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    throw new HttpError(404, `Manifest ${WINDOWS_UPDATE_MANIFEST} není v ${DOWNLOAD_ROOT}.`);
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new HttpError(500, 'Update manifest má neplatný JSON.');
  }
  if (typeof envelope?.signed !== 'string' || typeof envelope?.signature !== 'string') {
    throw new HttpError(500, 'Update manifest nemá podepsaná data.');
  }

  // `signed` je přesný řetězec, který klient ověří proti zapinovanému Ed25519 klíči.
  // Server ho NESMÍ měnit (jinak by se rozbil podpis) — jen ho přečte, aby doplnil
  // živé velikosti souborů do nepodepsané sekce `live` (ta slouží jen k zobrazení).
  let signed;
  try {
    signed = JSON.parse(envelope.signed);
  } catch {
    throw new HttpError(500, 'Podepsaná data manifestu nejsou platný JSON.');
  }

  const live = {};
  const arches = signed?.arches && typeof signed.arches === 'object' ? signed.arches : {};
  for (const [arch, info] of Object.entries(arches)) {
    const fileName = info?.fileName;
    if (typeof fileName !== 'string') continue;
    const filePath = path.join(DOWNLOAD_ROOT, fileName);
    try {
      const stat = fs.statSync(filePath);
      live[arch] = {
        available: stat.isFile(),
        sizeBytes: stat.size,
        sizeLabel: formatBytes(stat.size),
      };
    } catch {
      live[arch] = { available: false, sizeBytes: null, sizeLabel: null };
    }
  }

  json(res, 200, { signed: envelope.signed, signature: envelope.signature, live });
}

function handleSecureDownload(req, res, token) {
  const item = verifyDownloadToken(token);
  const filePath = path.join(DOWNLOAD_ROOT, item.fileName);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HttpError(404, `Soubor ${item.fileName} není v ${DOWNLOAD_ROOT}.`);
  }
  if (!stat.isFile()) throw new HttpError(404, `Soubor ${item.fileName} není platný soubor.`);

  const fileName = item.fileName.replace(/["\\]/g, '');
  const range = req.headers.range;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': stat.size });
    res.end();
    return;
  }

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) throw new HttpError(416, 'Neplatný rozsah stahování.');
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) throw new HttpError(416, 'Neplatný rozsah stahování.');
    res.writeHead(206, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, pathname) {
  let relativePath = pathname === '/' ? '/index.html' : pathname;
  try {
    relativePath = decodeURIComponent(relativePath);
  } catch {
    throw new HttpError(400, 'Neplatná URL.');
  }

  if (
    relativePath.startsWith('/.git') ||
    relativePath.startsWith('/downloads') ||
    relativePath === '/server.js' ||
    relativePath === '/package.json' ||
    relativePath.toLowerCase().endsWith('.md') ||
    relativePath === '/.env' ||
    relativePath === '/.env.example'
  ) {
    notFound(res);
    return;
  }

  const filePath = path.resolve(ROOT_DIR, `.${relativePath}`);
  if (!filePath.startsWith(`${ROOT_DIR}${path.sep}`)) throw new HttpError(403, 'Přístup odepřen.');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    notFound(res);
    return;
  }
  if (!stat.isFile()) {
    notFound(res);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes.get(ext) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

async function route(req, res) {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/auth/login') return handleLogin(req, res);
  if (req.method === 'GET' && pathname === '/api/auth/me') return handleMe(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/logout') return handleLogout(req, res);
  if (req.method === 'GET' && pathname === '/api/downloads') return handleDownloads(req, res);
  if (req.method === 'GET' && pathname === '/api/updates/windows') return handleWindowsUpdate(req, res);

  const linkMatch = /^\/api\/downloads\/([^/]+)\/link$/.exec(pathname);
  if (req.method === 'POST' && linkMatch) return handleDownloadLink(req, res, linkMatch[1]);

  const secureMatch = /^\/secure-download\/([^/]+)$/.exec(pathname);
  if ((req.method === 'GET' || req.method === 'HEAD') && secureMatch) return handleSecureDownload(req, res, secureMatch[1]);

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  throw new HttpError(405, 'Metoda není povolená.');
}

const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    if (error instanceof ApiError) {
      const status = error.status === 401 ? 401 : error.status === 403 ? 403 : 502;
      json(res, status, { message: error.message, code: error.code || null });
      return;
    }
    if (error instanceof HttpError) {
      json(res, error.status, { message: error.message, ...(error.payload || {}) });
      return;
    }
    console.error('[Movly web] Neošetřená chyba:', error);
    json(res, 500, { message: 'Serverová chyba.' });
  });
});

server.listen(PORT, () => {
  console.log(`[Movly web] běží na http://localhost:${PORT}`);
  console.log(`[Movly web] instalačky čte z ${DOWNLOAD_ROOT}`);
});
