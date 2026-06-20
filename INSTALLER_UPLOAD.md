# Nahrání nových instalaček na movly.sheri.cz

Web běží na Proxmoxu `192.168.1.138` v LXC `214` (`movly-web-lxc`).

Veřejná URL:

```text
https://movly.sheri.cz
```

Instalačky jsou v LXC uložené tady:

```text
/srv/movly/downloads
```

Download server očekává přesné názvy souborů:

```text
MovlySetup-x64.exe
MovlySetup-arm64.exe
MovlySetup-x86.exe
Movly-macOS-universal-devsigned.zip
windows-manifest.json
```

Pokud některý soubor chybí nebo má jiný název, web to nezamaskuje. Premium uživatel uvidí, že konkrétní instalačka není nahraná.

`windows-manifest.json` je **podepsaný** manifest pro auto-update Windows appky (servíruje ho `/api/updates/windows` za auth bránou premium/VIP+). Appka ho ověří proti zadrátovanému Ed25519 veřejnému klíči a podle SHA-256 zkontroluje stažený `.exe`. Manifest musíš vždy přegenerovat, když měníš některou Windows instalačku (viz níže).

## Před nahráním: podepiš Windows update manifest

Jednorázově vygeneruj klíč (privátní zůstane offline na Macu, veřejný vlož do `Windows/Movly/Services/UpdateService.cs`):

```bash
node web/scripts/setup-windows-update-key.mjs
```

Po každém novém buildu Windows instalaček (a po bumpu verze) podepiš manifest. Verze + build musí sedět s `Windows/Movly/Movly.csproj` (`<AssemblyVersion>x.y.z.build</AssemblyVersion>`):

```bash
node web/scripts/build-windows-manifest.mjs \
  --version 0.1.2 --build 3 \
  --notes "Co je nového v této verzi" \
  --installers ~/Downloads \
  --out ~/Downloads/windows-manifest.json
```

Skript spočítá SHA-256 každé instalačky, podepíše manifest a zapíše `windows-manifest.json` k instalačkám, takže putuje stejnou cestou jako `.exe` níže.

## Rychlý postup z Macu

Připrav si nové soubory např. v `Downloads` a zabal je do jednoho taru:

```bash
cd /Users/shebin/Downloads

tar -cf /tmp/movly-installers.tar \
  MovlySetup-x64.exe \
  MovlySetup-arm64.exe \
  MovlySetup-x86.exe \
  Movly-macOS-universal-devsigned.zip \
  windows-manifest.json
```

Nahraj balík na Proxmox host:

```bash
scp -P 12211 /tmp/movly-installers.tar root@192.168.191.10:/tmp/
```

Přihlas se na Proxmox:

```bash
ssh -p 12211 root@192.168.191.10
```

Na Proxmoxu rozbal balík do LXC:

```bash
pct push 214 /tmp/movly-installers.tar /tmp/movly-installers.tar

pct exec 214 -- bash -lc '
set -e
cd /srv/movly/downloads
tar -xf /tmp/movly-installers.tar
chown root:root /srv/movly/downloads/*
chmod 644 /srv/movly/downloads/*
rm -f /tmp/movly-installers.tar
ls -lh /srv/movly/downloads
'

rm -f /tmp/movly-installers.tar
```

## Když aktualizuješ jen jeden soubor

Příklad pro Windows x64:

```bash
scp -P 12211 /Users/shebin/Downloads/MovlySetup-x64.exe root@192.168.191.10:/tmp/MovlySetup-x64.exe
ssh -p 12211 root@192.168.191.10
```

Na Proxmoxu:

```bash
pct push 214 /tmp/MovlySetup-x64.exe /srv/movly/downloads/MovlySetup-x64.exe
pct exec 214 -- chmod 644 /srv/movly/downloads/MovlySetup-x64.exe
pct exec 214 -- chown root:root /srv/movly/downloads/MovlySetup-x64.exe
rm -f /tmp/MovlySetup-x64.exe
```

## Restart není potřeba

`movly-web.service` čte soubory z disku při každém požadavku, takže po výměně instalaček není potřeba restartovat server.

Když chceš službu přesto zkontrolovat:

```bash
ssh -p 12211 root@192.168.191.10
pct exec 214 -- systemctl status movly-web --no-pager
```

## Ověření po nahrání

Veřejná stránka musí vrátit `200`:

```bash
curl -I https://movly.sheri.cz/
```

API bez přihlášení musí vrátit `401`. To je správně, protože instalačky nejsou veřejné:

```bash
curl -I https://movly.sheri.cz/api/downloads
```

Stejně tak Windows update manifest musí být bez přihlášení `401` (neveřejný feed):

```bash
curl -I https://movly.sheri.cz/api/updates/windows
```

Logy serveru:

```bash
ssh -p 12211 root@192.168.191.10
pct exec 214 -- journalctl -u movly-web -n 80 --no-pager
```

