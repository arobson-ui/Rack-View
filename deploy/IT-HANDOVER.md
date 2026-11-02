# Rack View: setup for IT

Rack View is a small internal web app (network rack diagrams) at an address such as **https://rackview.example.org**: use your own address wherever this guide shows that one.
It runs as one background service. No IIS, nginx, database or web server is needed.

## What we need from IT
1. **A server** (Windows Server or Linux with systemd). Small: 1 CPU, 1 GB RAM, under 1 GB disk.
2. **DNS:** an A record `rackview.example.org` pointing at that server.
3. **Certificate** for `rackview.example.org`. Use either a `.pfx` file and its password, or a `.crt` file plus a `.key` file.
4. **Firewall:** allow inbound TCP 443 (and 80, which only redirects to https). The Windows installer opens these ports itself.
   Outbound, the server needs to reach the UniFi console on TCP 8443 and to **ping** the network devices
   (ICMP echo), since uptime comes from pinging each device every few minutes.
5. **Entra ID app registration** (sign-in is required: the site shows only a setup page until this is done):
   - Entra admin centre > App registrations > New registration. Name: *Rack View*. Accounts in this organisational directory only.
   - Redirect URI, platform **Web**: `https://rackview.example.org/auth/callback`
   - Certificates & secrets > New client secret (note when it expires).
   - Token configuration > Add groups claim > **Security groups**. If staff are in many groups, choose *Groups assigned to the application* instead and assign both groups to the app (Enterprise applications > Rack View > Users and groups).
   - Two security groups: **Rack View Owner** (full control, incl. UniFi sync and signing off requests) and **Rack View Admin** (edit racks, log requests). Anyone else who signs in is turned away.
   - Keep the values for `config.env` on the server (install step 5); nothing needs sending back to Anthony.

## Install (about 5 minutes)
1. Unzip the package (Windows `.zip` or Linux `.tar.gz`) where the app should live, e.g. `D:\Apps\rackview` or `/opt/rackview`.
2. Copy the certificate file(s) into that folder.
3. Run the installer:
   - **Windows:** right-click `install.ps1` and choose *Run with PowerShell* as Administrator. If that's blocked, run `powershell -ExecutionPolicy Bypass -File .\install.ps1` in an Administrator PowerShell.
   - **Linux:** `sudo ./install.sh`
4. Press Enter to accept the install location (the current folder). On Windows, enter the `.pfx` password when asked.

Nothing needs installing first: the package includes its own Ruby. The installer sets up the service (https on port 443), which restarts on its own after a crash or reboot.

5. Open `config.env` (see *Where things are*) and fill in the sign-in settings, then restart the service:

   | Setting | Where to find it in Entra |
   |---|---|
   | `ENTRA_TENANT_ID` | App registration > Overview > Directory (tenant) ID |
   | `ENTRA_CLIENT_ID` | App registration > Overview > Application (client) ID |
   | `ENTRA_CLIENT_SECRET` | The secret **Value** (shown once, when it is created) |
   | `ENTRA_REDIRECT_URI` | `https://rackview.example.org/auth/callback` |
   | `ENTRA_OWNER_GROUP_ID` | Groups > Rack View Owner > Object ID |
   | `ENTRA_ADMIN_GROUP_ID` | Groups > Rack View Admin > Object ID |

   Until all six are set, the site shows only a page listing what is missing. Once they are set, open
   https://rackview.example.org and sign in with an account in one of the two groups.

## UniFi sync
Rack View reads device names, ports and what's connected from the UniFi Network console. It only reads; it never changes anything in UniFi.

1. In UniFi, create a **local, view-only** account for Rack View (Settings > Admins & Users > Create New:
   *Restrict to local access only*, role *View Only*). Anthony can tell you the account already in use, if there is one.
2. Create `unifi.json` in the data folder (see *Where things are*):
   ```json
   { "url": "https://unifi.example.org:8443", "site": "default", "verifyTls": true,
     "username": "rackview", "password": "…" }
   ```
   Use the console's real address. If it uses a self-signed certificate, set `"verifyTls": false`.
3. Only the service may read it, since it holds a password:
   - **Linux:** `sudo chown rackview:rackview /var/lib/rackview/unifi.json && sudo chmod 600 /var/lib/rackview/unifi.json`
   - **Windows:** `icacls "C:\ProgramData\WCC Rack View\data\unifi.json" /inheritance:r /grant:r Administrators:F SYSTEM:F`

No restart is needed. A member of Rack View Owner then opens **UniFi sync** in the app and clicks **Fetch from UniFi**.

## Updating
Run `update.ps1` (Windows, as Administrator) or `sudo ./update.sh` (Linux) in the install folder.
It fetches the latest release and restarts the app. Settings and data are kept.

## Where things are
| | Windows | Linux |
|---|---|---|
| Settings | `C:\ProgramData\WCC Rack View\config.env` | `/etc/rackview/config.env` |
| Data (back this up) | `C:\ProgramData\WCC Rack View\data` | `/var/lib/rackview` |
| Log | `C:\ProgramData\WCC Rack View\server.log` | `journalctl -u rackview` |
| Restart | `Stop-ScheduledTask 'WCC Rack View'; Start-ScheduledTask 'WCC Rack View'` | `systemctl restart rackview` |
| Remove | `uninstall.ps1` | `sudo ./uninstall.sh` |

Renewing the certificate means replacing the file in the install folder (keep the same name, or update `TLS_CERT` in config.env), then restarting the service.

Contact: Anthony.
