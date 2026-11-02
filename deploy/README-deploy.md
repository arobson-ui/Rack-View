# Deploying WCC Rack View on a server

Two packages, same app: `rackview-windows-<ver>.zip` and `rackview-linux-<ver>.tar.gz`.
Both run `serve.rb` as a background service that starts with the server and restarts if it stops.
Settings live in `config.env` (data folder, port, check interval, Entra ID sign-in). Upgrading
re-runs the installer; it replaces the app files and never touches `config.env` or the data folder.

## Windows Server
1. Unzip, open **PowerShell as Administrator** in the folder.
2. `powershell -ExecutionPolicy Bypass -File .\install.ps1` (optional `-Port 8765 -DataDir "D:\WCC Rack Data"`).
   Nothing to install first: the package carries its own Ruby (in its `ruby` folder). Sets up a startup task running as SYSTEM and a firewall rule.
- App: the folder you choose when installing (default: the unzipped folder)
- Settings and log: `C:\ProgramData\WCC Rack View\config.env`, `server.log`
- Data (default): `C:\ProgramData\WCC Rack View\data`
- Restart after editing settings: `Stop-ScheduledTask 'WCC Rack View'; Start-ScheduledTask 'WCC Rack View'`
- Remove: `.\uninstall.ps1` (keeps settings and data)

## Linux (Ubuntu/Debian/RHEL, systemd)
1. `tar -xzf rackview-linux-<ver>.tar.gz && cd rackview-linux-<ver>`
2. `sudo ./install.sh` (optional port: `sudo ./install.sh 8765`).
   Nothing to install first: the package carries its own Ruby (in its `ruby` folder). Sets up a `rackview` system user and the `rackview` systemd unit.
- App: the folder you choose when installing (default: the extracted folder)  Settings: `/etc/rackview/config.env`  Data: `/var/lib/rackview`
- Restart after editing settings: `sudo systemctl restart rackview`; logs: `journalctl -u rackview -f`
- Remove: `sudo ./uninstall.sh` (keeps settings and data)

## Moving existing data
Copy `rack-data.json`, `unifi.json`, `features-bugs.json` and `feature-photos/` into the data folder, then restart.

## Sign-in (Entra ID)
Release installs require Microsoft sign-in (`REQUIRE_SSO=1`) and serve https on port 443. Until all six `ENTRA_*`
settings in `config.env` are filled in, every page shows only what is missing, so nothing is exposed.
- **Rack View Owner** group: everything, including UniFi sync and signing off features/bugs.
- **Rack View Admin** group: edit racks, devices and drives; log features/bugs.
- Anyone else who signs in is turned away with a message saying who to ask.
App registration steps are in IT-HANDOVER.md. Sessions last 8 hours; restarting the service signs everyone out.
Running `serve.rb` with no `ENTRA_*` settings and without `REQUIRE_SSO=1` (e.g. on a laptop for testing) keeps the
old behaviour: port 8765, the computer itself is owner, the local network is contributor.
## Building the packages
`./deploy/build-release.sh v1.0.0` writes both files to `dist/`.

## HTTPS, the simple way (recommended)
Copy the certificate (`.pfx`, or `.crt` + `.key`) into the install folder before running the installer. It then
serves https on port 443 by itself and redirects http. See IT-HANDOVER.md. The IIS/nginx steps below are only an alternative.

## Web address via IIS or nginx (alternative)
1. Ask IT for a DNS record `rackview.example.org` pointing at the server, and a TLS certificate for it.
2. Put a reverse proxy in front of the app on port 443:
   - **Linux:** `sudo apt install nginx`, then use `nginx-rackview.conf` (instructions at the top of the file).
   - **Windows:** install IIS with the *URL Rewrite* and *Application Request Routing* modules, enable the proxy
     in ARR, create a site bound to https/443 for `rackview.example.org` with the certificate, and add a
     rewrite rule sending everything to `http://127.0.0.1:8765/{R:1}`. Set the server variable
     `HTTP_X_FORWARDED_FOR` to `{REMOTE_ADDR}` on that rule.
3. Set `TRUST_PROXY=1` in `config.env` and restart the app. **Do this**, or every visitor looks like the
   server itself and gets admin.
4. Once only the proxy should reach the app, close the firewall port 8765 to everyone else.
5. Entra ID redirect URI: `https://rackview.example.org/auth/callback`.

## Updating
Once installed, updating is one command. It downloads the latest GitHub release, replaces the app files,
adds any new settings to `config.env`, and restarts the service. Settings and data are kept.
- **Windows** (Administrator PowerShell): `powershell -ExecutionPolicy Bypass -File "<install folder>\update.ps1"`
- **Linux:** `sudo <install folder>/update.sh`
Add `-Force` / `--force` to reinstall the same version. To publish an update: `./deploy/build-release.sh v1.0.1`,
then create a GitHub release with both files from `dist/`.
