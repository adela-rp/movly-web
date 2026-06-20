# Movly — web

Landing page aplikace **Movly** + serverově chráněné stažení instalaček pro Movly Premium/VIP účty.

GitHub Pages může sloužit jen jako vizuální reference. Pro reálné stažení instalaček musí web běžet přes `server.js`, protože statický hosting neumí bezpečně chránit soubory před nepřihlášenými uživateli.

## Soubory

- `index.html` — hlavní stránka
- `privacy.html` — zásady ochrany soukromí
- `delete-account.html` — smazání účtu
- `server.js` — Node server pro Movly login, premium kontrolu a chráněný download
- `assets/` — loga a reálné screenshoty aplikace

## Očekávané instalačky

Server čte soubory ze složky `DOWNLOAD_ROOT`. Ve výchozí produkci ji nastav na `/srv/movly/downloads`.

Postup pro nahrání nových buildů je v [INSTALLER_UPLOAD.md](INSTALLER_UPLOAD.md).

Očekávané názvy:

- `MovlySetup-x64.exe`
- `MovlySetup-arm64.exe`
- `MovlySetup-x86.exe`
- `Movly-macOS-universal-devsigned.zip`

Pokud některý soubor chybí, web kartu nezamaskuje. Zobrazí přesný chybějící název souboru.

## Lokální spuštění

```bash
cd /Users/shebin/Projekty/Movly/web
MOVLY_API_KEY="..." \
DOWNLOAD_TOKEN_SECRET="$(openssl rand -hex 32)" \
DOWNLOAD_ROOT="/Users/shebin/Projekty/Movly/web/downloads" \
node server.js
```

Pak otevři `http://localhost:8080`.

## Produkční LXC

Minimální prostředí:

- Node.js 18+
- reverzní proxy (např. nginx) na port `8080`
- instalačky ve `/srv/movly/downloads`

Proměnné:

```bash
MOVLY_WEB_PORT=8080
MOVLY_API_BASE=https://api-go.shebin.eu
MOVLY_API_KEY=...
DOWNLOAD_ROOT=/srv/movly/downloads
DOWNLOAD_TOKEN_SECRET=nahodny-dlouhy-secret
DOWNLOAD_TOKEN_TTL_SECONDS=300
NODE_ENV=production
```

Flow stažení:

1. Web pošle login na `/api/auth/login`.
2. Server ověří účet přes Movly API.
3. `/api/downloads` vrátí instalačky jen pokud má účet aktivní Premium nebo roli VIP/moderator/admin.
4. Klik na stažení vytvoří krátkodobý podepsaný odkaz `/secure-download/...`.
5. Bez platného odkazu soubor nejde stáhnout přímo.
