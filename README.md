# WCC Rack View

An interactive view of Westside Christian College's server racks: front and back, with drive-level detail for NVRs and storage.

Plain HTML/CSS/JavaScript. No install, no build step, no server required.

## Running it

**Easiest:** double-click `index.html` to open it in Chrome, Edge or Safari.

**Or, with a local server** (useful if your browser blocks local files):

```bash
ruby -run -e httpd . -p 8765
```

then open http://localhost:8765.

## Using it

- **Dashboard:** the home page. It shows totals, a card for each rack with a mini rack view and usage, and the drives that most need attention. Click any of them to jump straight there.
- **Links:** the address bar follows where you are (e.g. `#/rack/sip-1/r1-nvr4`). Refreshing keeps your place, and you can bookmark or share a link to a specific rack or device.
- **Racks:** pick a rack under **Racks** in the left sidebar. Use **Front / Front & back / Back** to switch views.
- **Add a device:** click any empty slot (or **+ Add device**). Set the bottom U, the height, and whether it's full depth, front only, or rear only. For example, a rear-mounted PDU can share a U with a front patch panel.
- **NVRs, NAS and servers:** set the number of drive bays, then add drives with make, model, type, capacity, serial number, install date and status. Use **Fill empty bays** to add a row for each empty bay; each new row copies the previous drive's details to save typing. **Bay rows** sets how the bays are arranged on the front (e.g. 4 rows of 4 on the 4U Hikvision NVRs); bays are numbered left to right, top to bottom.
- **Views:** **Colour** (default) shows faceplates coloured by device type, with names and drive bays. **Realistic** draws each device to look like the real hardware (`js/faces.js`). **Labels** turns device names on or off.
- **Drive health:** the colour comes from the install date: *Ageing* at 3+ years, *Replace soon* at 5+ years. A drive marked *Failed* always shows red. Hover a bay in the rack to see its serial number and age.
- **Search** (press `/`): matches device names, IPs, serial numbers and models, including drive serial numbers. A drive match jumps straight to that bay.
- **Drive report:** lists every drive across all racks. Sort by any column, filter to "Needs attention", or download a CSV.

The thresholds and device-type colours are at the top of `js/app.js`.

## Where the data lives

This repository is **the app only**. No rack, device or drive data is stored in it, and `.gitignore` blocks `*.json` files so an export can't be committed by accident.

- Data is saved **in the browser** you use (localStorage). A new browser starts empty and offers **Import data**.
- **Export** downloads a `wcc-racks-YYYY-MM-DD.json` file of everything. Keep it somewhere safe (e.g. OneDrive or a network share), not in this repo.
- **Import** loads an export file, replacing what's in that browser. This is how you move data between computers.
- Shift-click **Import** to clear all data from the browser.

## Sharing on the network

Run the app from one computer so others on the school network can open it in their browser:

```bash
ruby serve.rb
```

- It serves the app on port 8765 (e.g. `http://<this-computer's-IP>:8765`) and keeps everything it saves in **one data folder**, `~/WCC Rack Data` by default, outside this repo. Choose another folder with the first argument (`ruby serve.rb "D:\Rack Data"`) or the `RACK_DATA_DIR` environment variable. The folder holds `rack-data.json`, `unifi.json`, `unifi-snapshot.json`, `status.json` (up-check history), `features-bugs.json` and `feature-photos/`. Giving a `.json` file instead (the old way) still works: that file is the rack data and its folder holds the rest.
- **On the host computer** you can edit as normal; changes save to that file (the previous version is kept as `rack-data.json.bak`).
- **Everyone else gets a view-only copy** that picks up the host's changes every 30 seconds.
- Only the app's own files and the data are served; the rest of the folder (including `.git`) isn't.
- Without sign-in settings it's plain HTTP with roles by network address (testing only). Release installs require Microsoft sign-in; see `deploy/README-deploy.md`.

### Up-checks

While `serve.rb` runs, it checks every device that has an **IP address** about once a minute and the app shows a green or red dot. Devices that aren't responding appear on the Dashboard; **Check now** in a device's details re-checks straight away.

- With no port set it uses the server's own `ping` (works the same on Windows, Linux and macOS).
- Set **Up-check port** on a device (e.g. `443`, or `554` for NVR video) to test that port instead, which is useful when a device ignores ping.
- Each device's details show **Availability**: how long it has been up (or down) and what share of checks it answered. The history is kept in `status.json` in the data folder, so it survives a restart. Linked UniFi devices also show **Device uptime** (time since their last reboot, as of the last UniFi sync). Clicking a UniFi port shows how long its current device has been **connected** (capped at the switch's last reboot), or when a down port last saw a device.
- Only IPs in the rack data are ever checked. `CHECK_INTERVAL=120 ruby serve.rb` changes the interval (seconds; `0` turns checks off).
- Checks run from wherever the server is, so once it moves to a College server they show what's reachable from there.

### UniFi sync

`serve.rb` can pull names, models, IPs, MAC addresses, serial numbers and port details (up/down, speed, PoE, and what's connected) from your UniFi console.

1. Edit `unifi.json` in the data folder (e.g. `~/WCC Rack Data/unifi.json`, never in this repo):
   ```json
   { "url": "https://unifi.example.org:8443", "apiKey": "…", "site": "default",
     "verifyTls": true, "username": "", "password": "" }
   ```
2. Create the key in UniFi: **Settings → Control Plane → Integrations → Create API Key**. Works with UniFi consoles and the self-hosted Network Application (detected automatically). Use **either** an API key **or** a read-only local UniFi account (`username`/`password`); with a login alone everything comes from the older API (devices, serials, ports, PoE and what's on each port).
3. On the host computer, open **UniFi sync** in the sidebar → **Fetch from UniFi**. (The button only appears on the host; other computers never see it.) Each UniFi device is matched to a rack device by MAC, serial, IP or name. Check the matches, then **Apply** (only empty fields are filled unless you tick *Overwrite*).
4. Linked devices get a **Ports** panel in their details. Click a port to see what's on it; if that's a device in your racks it pulses (or **Go to** jumps to its rack). Anything on a port that has an IP gets a **Ping** button: the server pings it once and shows "Replied · 3 ms" or "No reply". Only addresses already in Rack View or the UniFi snapshot can be pinged, from the College network.

Only the host computer can sync; everyone can see the port details. UniFi's official API gives devices and port status; serials, port names and exact per-port links come from the console's older API, used automatically when the key allows it.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page layout |
| `css/style.css` | Layout and styling, matched to the College staff portal (Beacon): navy `#00205B`, Inter, white cards |
| `css/faces.css`, `js/faces.js` | Realistic hardware drawings |
| `js/app.js` | All app logic |
| `js/seed.js` | Starting data for a new browser (empty on purpose) |
| `serve.rb` | Small server for sharing on the network (see above) |
| `unifi.rb` | UniFi import used by serve.rb |
| `sso.rb` | Microsoft Entra ID sign-in (Owner and Admin groups) |
| `vendor/` | The WEBrick web server library, bundled so no gem install is needed |

## Branding notes

Follows the WCC Identity Style Guide: green is dominant, with the yellow/blue/green colour bars across the top (order always yellow → blue → green, no gaps). Gold is reserved for the crest, so it isn't used here. Headings use Foco and body text Museo Sans when they're installed, otherwise Calibri and Arial (the guide's everyday typefaces).

## Deploying to a server

Windows and Linux service installers are in [deploy/](deploy/README-deploy.md).
