/* WCC Rack View — plain JavaScript, no build step.
   Data lives in localStorage; Export/Import moves it between computers. */
(function () {
  "use strict";

  // When sign-in is on and the session has ended, any call to the server answers 401: go and sign in again,
  // coming back to the same #/… page afterwards
  const plainFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await plainFetch(...args);
    if (res.status === 401 && /^api\//.test(String(args[0]))) location.replace("/auth/login?r=" + encodeURIComponent(location.hash));
    return res;
  };

  const STORAGE_KEY = "wcc-rack-visualiser-v4";

  // Drive age thresholds (years). Surveillance drives are typically rated ~3–5 years.
  const AGE_AGEING = 3;
  const AGE_OLD = 5;

  const TYPES = {
    server:   { label: "Server",        color: "#00205b" },
    nvr:      { label: "NVR / DVR",     color: "#006a52" },
    storage:  { label: "Storage / NAS", color: "#2f6f8f" },
    switch:   { label: "Switch",        color: "#3b5bdb" },
    firewall: { label: "Firewall / Router", color: "#a61e4d" },
    patch:    { label: "Patch panel",   color: "#5c636a" },
    ups:      { label: "UPS",           color: "#84754e" },
    pdu:      { label: "PDU",           color: "#495057" },
    blank:    { label: "Blank / shelf", color: "#868e96" },
    other:    { label: "Other",         color: "#7a6c9c" }
  };
  const TYPE_SHORT = { server: "SRV", nvr: "NVR", storage: "NAS", switch: "SW", firewall: "FW", patch: "PP", ups: "UPS", pdu: "PDU", blank: "—", other: "AV" };
  const DRIVE_TYPES = ["HDD (Surveillance)", "HDD (NAS)", "HDD (Enterprise)", "HDD (Desktop)", "SSD (SATA)", "SSD (NVMe)", "SSD (SAS)", "HDD (SAS)"];
  const DRIVE_STATUS = { ok: "OK", failed: "Failed", spare: "Spare / not in use" };
  const HAS_BAYS = (t) => t === "nvr" || t === "storage" || t === "server";

  // ---------- State ----------
  let data = load();
  let ui = { rackId: data.racks[0]?.id || null, deviceId: null, face: "both", search: "", reportSort: { key: "health", dir: 1 }, reportFilter: "all", reportRack: "", reportDevice: "", reportQuery: "", view: "home", look: loadPref("look-v2", "simple"), labels: loadPref("labels", true), compact: loadPref("compact", true), collapsed: loadPref("collapsed", []) };

  function loadPref(k, dflt) {
    try { const v = localStorage.getItem(STORAGE_KEY + ":" + k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
  }
  function savePref(k, v) {
    try { localStorage.setItem(STORAGE_KEY + ":" + k, JSON.stringify(v)); } catch (e) { /* not important */ }
  }

  // Shrink a photo to a small JPEG so lots of them fit in browser storage and in exports
  function resizeImage(file, maxW) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => reject(new Error("That file isn't an image this browser can read."));
      img.src = URL.createObjectURL(file);
    });
  }
  const photoFor = (d, face) => (face === "rear" ? d.photoRear : d.photoFront);

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalise(JSON.parse(raw));
    } catch (e) { /* fall through to seed */ }
    return structuredClone(window.SEED_DATA);
  }
  // Make sure numbers are numbers (older saves or hand-edited imports may hold strings)
  function normalise(d) {
    d.racks.forEach((r) => {
      r.id ||= uid(); r.units = +r.units || 42; r.devices ||= [];
      r.devices.forEach((dev) => {
        dev.id ||= uid(); dev.uStart = +dev.uStart; dev.uHeight = +dev.uHeight || 1; dev.face ||= "both";
        (dev.drives || []).forEach((dr) => { dr.bay = parseInt(dr.bay, 10) || 0; });
      });
    });
    return d;
  }
  function save() {
    if (readOnly()) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {
      if (!shared.on) return toast("Couldn't save in this browser. Use Export to keep a copy.", "error");
    }
    const done = () => {
      const el = $("#save-status");
      el.textContent = (shared.on ? "Shared · saved " : "Saved · ") + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      el.classList.add("saved");
      setTimeout(() => el.classList.remove("saved"), 1500);
    };
    if (!shared.on) return done();
    pushShared().then(done, (e) => toast("Couldn't save to the shared file: " + e.message, "error"));
  }

  // ---------- Shared mode ----------
  // When the app is served by serve.rb, data comes from one shared file on the host computer.
  // The host can edit; everyone else on the network sees a view-only copy that refreshes itself.
  // role comes from serve.rb: admin (this computer), contributor (the local network) or viewer
  const shared = { on: false, canEdit: true, role: "owner", snapshot: "" };
  const readOnly = () => shared.on && !shared.canEdit;
  async function connectShared() {
    if (!location.protocol.startsWith("http")) return;
    try {
      const info = await fetch("api/info", { cache: "no-store" });
      if (!info.ok) return;
      const meta = await info.json();
      shared.on = true; shared.canEdit = !!meta.canEdit; shared.role = meta.role || (meta.canEdit ? "owner" : "viewer");
      shared.sso = !!meta.sso; shared.name = meta.name || ""; shared.email = meta.email || "";
      const res = await fetch("api/data", { cache: "no-store" });
      if (res.ok) { shared.snapshot = await res.text(); data = normalise(JSON.parse(shared.snapshot)); }
      else if (shared.canEdit && data.racks.length) await pushShared(); // first run: share what this browser already has
      else if (!shared.canEdit) data = structuredClone(window.SEED_DATA);
    } catch (e) { /* not running under serve.rb: stay with this browser's data */ }
  }
  async function pushShared() {
    const res = await fetch("api/data", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  }
  // Pick up changes made elsewhere (the host editing, or the data file changed on the server)
  // so an open page never saves an old copy over newer data
  async function refreshShared() {
    if (!shared.on || document.hidden || modal.open) return;
    try {
      const res = await fetch("api/data", { cache: "no-store" });
      const text = res.ok ? await res.text() : "";
      const latest = text && normalise(JSON.parse(text));
      if (latest && JSON.stringify(latest) !== JSON.stringify(data)) {
        shared.snapshot = text; data = latest;
        if (!currentRack()) ui.rackId = data.racks[0]?.id || null;
        if (!findDevice(currentRack(), ui.deviceId)) ui.deviceId = null;
        renderAll(); toast("Updated with the latest changes");
      }
    } catch (e) { /* host offline; try again later */ }
  }
  // ---------- Up-checks (run by the server, see serve.rb) ----------
  // status.error: the server is there but its up-check API isn't answering
  const status = { on: false, error: false, results: {}, checkedAt: null };
  async function fetchStatus(run = false) {
    if (!shared.on) return;
    try {
      const res = await fetch("api/status", { method: run ? "POST" : "GET", cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      const body = await res.json();
      status.on = true; status.error = false; status.results = body.results || {}; status.checkedAt = body.checkedAt; status.every = body.every;
    } catch (e) { status.error = true; /* server busy or offline; try again on the next round */ }
    renderRack(); renderDetails();
    if (ui.view === "home") renderHome();
  }
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

  // Why up-checks can't tell us anything right now (one banner instead of a page of red), or "" when they can.
  // "Nothing has ever answered" usually means the server can't reach the device network, not that everything is down.
  function checkerProblem() {
    if (!shared.on) return "";
    if (status.error || !status.on) return "The up-checker isn't answering, so device status is unknown. Is serve.rb still running on the host computer?";
    const results = Object.values(status.results);
    if (status.every === 0 && !results.length) return "Up-checks are turned off on the server (CHECK_INTERVAL=0), so device status is unknown.";
    if (results.length && !results.some((s) => s.up || s.lastUp)) return "No device has answered an up-check yet. The host computer probably can't reach these addresses, so status is shown as unknown rather than down.";
    return "";
  }
  // Up, down or unknown for one device (null when it has no IP, so there's nothing to check).
  // Down = a check ran and failed for a device that has answered before. A device that has never answered
  // (wrong IP, or a network the checker can't reach) is unknown, not red.
  function stateOf(d) {
    if (!d.ip) return null;
    const s = status.on ? status.results[d.id] : undefined;
    const problem = checkerProblem();
    if (!shared.on) return { key: "unknown", label: "Not checked", tip: "Up-checks run when the app is served by serve.rb", s };
    if (!s) return { key: "unknown", label: "Not checked", tip: problem || "Not checked yet · the next round runs within a minute", s };
    if (s.up) return { key: "up", label: "Up", tip: `Up · ${s.ms != null ? s.ms + " ms · " : ""}${s.method} · checked ${timeOf(s.checkedAt)}`, s };
    if (problem) return { key: "unknown", label: "Unknown", tip: problem, s };
    if (!s.lastUp) return { key: "unknown", label: "No reply yet", tip: `Has never answered (${s.method}) · check the IP address, or whether the host computer can reach it · checked ${timeOf(s.checkedAt)}`, s };
    return { key: "down", label: "Down", tip: `Not responding (${s.method}) · last up ${timeOf(s.lastUp)} · checked ${timeOf(s.checkedAt)}`, s };
  }
  // A shape as well as a colour, so status isn't colour-only
  const STATE_ICON = { up: "✓", down: "✕", unknown: "?" };
  function statusDot(d) {
    const st = stateOf(d);
    if (!st) return "";
    return `<span class="st-dot ${st.key}" role="img" aria-label="${esc(st.label)}" title="${esc(st.label + " · " + st.tip)}">${STATE_ICON[st.key]}</span>`;
  }
  // "3d 4h", "5h 12m", "8m"
  function duration(ms) {
    const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60), dys = Math.floor(h / 24);
    return dys ? `${dys}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : m ? `${m}m` : "under a minute";
  }
  // How long it has been up (or down), and how often it answered, from the server's check history
  function uptimeLine(d) {
    const st = stateOf(d), s = st?.s;
    if (!s || !s.since || (st.key !== "up" && st.key !== "down")) return "";
    const sinceStart = s.since === s.trackedSince; // it has been this way for as long as we've been checking
    const word = st.key === "up" ? "Up" : "Down", elapsed = Date.now() - new Date(s.since);
    const streak = sinceStart && elapsed < 60000 ? `${word} · checks only started just now`
      : `${word} for ${sinceStart ? "at least " : ""}${duration(elapsed)}`;
    const pct = s.checks >= 5 ? ` · answered ${((s.upChecks / s.checks) * 100).toFixed(s.upChecks === s.checks ? 0 : 1)}% of ${s.checks} checks since ${whenText(s.trackedSince)}` : "";
    return streak + pct;
  }
  // Time since the device itself last rebooted, as UniFi reported it at the last sync (moved on to now)
  function unifiUptime(d) {
    const u = unifiFor(d);
    if (!u?.uptime || !unifi.snapshot?.fetchedAt) return "";
    const ms = u.uptime * 1000 + (Date.now() - new Date(unifi.snapshot.fetchedAt));
    return `${duration(ms)} since last reboot`;
  }
  // "2 Nov, 9:23 am"
  const whenText = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  // How long the device UniFi last saw connect on this port has been there, or when the port last saw anything.
  // (On busy links between switches that device changes often, so this can be shorter than the cable's real uptime.)
  function portUptime(p, u) {
    if (p.up && p.connectedAt) {
      // UniFi remembers the connect time across reboots; nothing can have been connected longer than the switch has been on
      const boot = u?.uptime && unifi.snapshot?.fetchedAt ? new Date(unifi.snapshot.fetchedAt) - u.uptime * 1000 : 0;
      const start = Math.max(+new Date(p.connectedAt), boot);
      return `Connected for ${duration(Date.now() - start)} (since ${start === boot ? "the switch last rebooted, " : ""}${whenText(start)})`;
    }
    if (!p.up && p.lastSeen) return `Down · last saw a device ${whenText(p.lastSeen)} (${duration(Date.now() - new Date(p.lastSeen))} ago)`;
    return "";
  }

  function statusLine(d) {
    const st = stateOf(d);
    if (!st) return "";
    const btn = shared.on ? ` <button class="btn btn-small" data-action="check-now">Check now</button>` : "";
    return `<span class="st-line"><span class="st-dot ${st.key}" aria-hidden="true">${STATE_ICON[st.key]}</span>${esc(st.label)}${st.key === "up" && st.s?.ms != null ? " · " + st.s.ms + " ms" : ""}</span>
      <span class="help">${esc(st.tip)}</span>${btn}`;
  }

  function applyMode() {
    if (shared.sso) { // signed in with Microsoft: show who, their role, and a way out
      $("#who-name").textContent = shared.name || shared.email || "Signed in";
      $("#who-name").title = shared.email || "";
      $("#sign-out").hidden = false;
    }
    const roleText = { owner: "Owner", admin: "Admin", contributor: "Contributor", viewer: "View only" }[shared.role] || "";
    document.body.classList.toggle("readonly", readOnly());
    $("#btn-unifi").hidden = !(shared.on && shared.role === "owner"); // UniFi sync is for owners only
    const status = $("#save-status");
    if (shared.sso) status.textContent = roleText;
    else if (readOnly()) status.textContent = "View only · shared from host";
    else if (shared.on) status.textContent = "Shared on the network";
  }

  // ---------- Helpers ----------
  // jump instead of gliding when the computer is set to reduce motion
  const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function uid() { return Math.random().toString(36).slice(2, 10); }
  // "WD" + "WD Purple" reads as "WD Purple", not "WD WD Purple"
  const makeModel = (make, model) => (model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(" "));
  // A device with no name of its own is shown by its make and model
  const devName = (d) => d.name || [d.make, d.model].filter(Boolean).join(" ") || "Unnamed device";
  const currentRack = () => data.racks.find((r) => r.id === ui.rackId);
  const findDevice = (rack, id) => rack?.devices.find((d) => d.id === id);

  function ageDays(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function formatAge(days) {
    if (days == null) return "Unknown";
    if (days < 0) return "Not yet";
    const y = Math.floor(days / 365.25);
    const m = Math.floor((days - y * 365.25) / 30.44);
    if (y === 0) return m + " mo";
    return y + "y " + m + "m";
  }
  function formatDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d) ? esc(s) : d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
  }
  // Health of a drive: failed status wins, otherwise based on age. No install date = age unknown (not "healthy").
  function driveHealth(drive) {
    if (!drive) return "empty";
    if (drive.status === "failed") return "failed";
    const days = ageDays(drive.installDate);
    if (days == null) return "unknown";
    if (days >= AGE_OLD * 365.25) return "old";
    if (days >= AGE_AGEING * 365.25) return "ageing";
    return "ok";
  }
  const HEALTH_LABEL = { ok: "Healthy", ageing: "Ageing", old: "Replace soon", failed: "Failed", unknown: "Age unknown", empty: "Empty" };
  // One definition used everywhere (dashboard, room cards, lists, drive report):
  // Failed + Replace soon need attention now; Ageing is one to watch. Most urgent first.
  const SEVERITY = { failed: 4, old: 3, ageing: 2, unknown: 1, ok: 0, empty: 0 };
  const HEALTH_ORDER = ["failed", "old", "ageing", "unknown", "ok"];
  const needsAttention = (h) => h === "failed" || h === "old";
  const bySeverity = (a, b) => SEVERITY[b.health] - SEVERITY[a.health] || (b.ageDays ?? -1) - (a.ageDays ?? -1);
  function driveCounts(drives) {
    const c = { total: drives.length, failed: 0, old: 0, ageing: 0, unknown: 0, ok: 0 };
    drives.forEach((d) => { c[d.health]++; });
    c.attention = c.failed + c.old;
    return c;
  }

  function bayCount(dev) {
    const maxBay = Math.max(0, ...(dev.drives || []).map((d) => d.bay || 0));
    return Math.max(dev.bays || 0, maxBay);
  }
  // How the bays sit on the front panel: rows of bays, numbered left to right, top to bottom.
  // Set per device ("Bay rows"); otherwise guessed from the height and bay count.
  function bayRows(dev) {
    const n = bayCount(dev);
    if (dev.bayRows) return Math.max(1, Math.min(dev.bayRows, n || 1));
    if (n <= 4) return 1;
    return Math.min(Math.max(1, dev.uHeight), Math.ceil(n / 4));
  }
  window.bayRows = bayRows;
  function deviceHealth(dev) {
    const hs = (dev.drives || []).map(driveHealth);
    return HEALTH_ORDER.find((h) => hs.includes(h)) || null;
  }
  // Worth flagging on the rack: needs attention, or one to watch (an unknown age isn't flagged, just shown on the bay)
  const flagged = (h) => needsAttention(h) || h === "ageing";
  const showsOn = (dev, face) => dev.face === "both" || dev.face === face;

  // Is the U range free on the faces this device uses?
  function rangeFree(rack, uStart, uHeight, face, ignoreId) {
    if (uStart < 1 || uStart + uHeight - 1 > rack.units) return false;
    return !rack.devices.some((d) => {
      if (d.id === ignoreId) return false;
      const overlapsU = uStart <= d.uStart + d.uHeight - 1 && d.uStart <= uStart + uHeight - 1;
      const overlapsFace = face === "both" || d.face === "both" || d.face === face;
      return overlapsU && overlapsFace;
    });
  }

  function matches(dev, q) {
    if (!q) return false;
    const hay = [dev.name, dev.make, dev.model, dev.serial, dev.assetTag, dev.ip, dev.mac, dev.notes,
      ...(dev.drives || []).flatMap((d) => [d.serial, d.model, d.make])].join(" ").toLowerCase();
    return hay.includes(q);
  }

  // ---------- Rendering: sidebar ----------
  // Racks grouped by room (their Location), rooms in the order they first appear
  function rooms() {
    const m = new Map();
    data.racks.forEach((r) => { const k = (r.location || "").trim() || "No room set"; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m];
  }

  function renderSidebar() {
    $("#rack-list").innerHTML = rooms().map(([room, racks]) => {
      const open = !ui.collapsed.includes(room);
      return `<li class="nav-room">
        <button class="nav-room-head${open ? " open" : ""}" data-room="${esc(room)}" aria-expanded="${open}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span>${esc(room)}</span>${!open && racks.some(failedIn) ? `<span class="nav-warn" role="img" aria-label="Failed drives in this room">!</span>` : ""}<span class="count">${racks.length}</span>
        </button>
        ${open ? `<ul class="nav-room-racks">${racks.map((r) => {
          const bad = failedIn(r);
          return `
          <li><button class="nav-sub-item${r.id === ui.rackId && ui.view === "racks" ? " active" : ""}" data-rack="${esc(r.id)}" title="${r.units}U · ${r.devices.length} devices${bad ? ` · ${bad} failed drive${bad === 1 ? "" : "s"}` : ""}">
            <span>${esc(r.name)}</span>${bad ? `<span class="nav-warn" role="img" aria-label="${bad} failed drive${bad === 1 ? "" : "s"}">!</span>` : ""}<span class="count">${r.devices.length}</span>
          </button></li>`;
        }).join("")}</ul>` : ""}
      </li>`;
    }).join("") || `<li class="nav-empty">No racks yet</li>`;

    $("#legend").innerHTML = Object.values(TYPES).map((t) =>
      `<li><span class="swatch" style="background:${t.color}"></span>${t.label}</li>`).join("");
    renderSearch();
  }
  const failedIn = (r) => r.devices.reduce((s, d) => s + (d.drives || []).filter((dr) => driveHealth(dr) === "failed").length, 0);

  // ---------- Search ("/" anywhere) ----------
  // Results grouped by what matched, so a serial or IP is easy to spot among device names
  const SEARCH_GROUPS = [["devices", "Devices"], ["serials", "Serial numbers"], ["ips", "IP & MAC addresses"], ["models", "Models"]];
  function searchHits(q) {
    const g = { devices: [], serials: [], ips: [], models: [] };
    const has = (v) => v != null && String(v).toLowerCase().includes(q);
    data.racks.forEach((r) => r.devices.forEach((d) => {
      const where = `${r.name} · U${d.uStart}`;
      const hit = (group, label, sub, bay, mono) => g[group].push({ r, d, label, sub, bay, mono });
      if (has(devName(d)) || has(d.make) || has(d.assetTag) || has(d.notes)) hit("devices", devName(d), where + (has(d.assetTag) ? ` · asset ${d.assetTag}` : ""));
      if (has(d.serial)) hit("serials", d.serial, `${devName(d)} · ${where}`, null, true);
      if (has(d.ip) || has(d.mac)) hit("ips", has(d.ip) ? d.ip : d.mac, `${devName(d)} · ${where}`, null, true);
      if (has(d.model)) hit("models", makeModel(d.make, d.model), `${devName(d)} · ${where}`);
      (d.drives || []).forEach((dr) => {
        if (has(dr.serial)) hit("serials", dr.serial, `Drive in bay ${dr.bay} · ${devName(d)} · ${r.name}`, dr.bay, true);
        else if (has(dr.model) || has(dr.make)) hit("models", makeModel(dr.make, dr.model) || "Drive", `Drive in bay ${dr.bay} · ${devName(d)} · ${r.name}`, dr.bay);
      });
    }));
    return g;
  }
  function renderSearch() {
    const q = ui.search.trim().toLowerCase();
    const box = $("#search-results"), input = $("#search");
    ui.searchIdx = -1;
    input.removeAttribute("aria-activedescendant");
    if (!q) { box.innerHTML = ""; input.setAttribute("aria-expanded", "false"); return; }
    const g = searchHits(q), PER = 8;
    const total = SEARCH_GROUPS.reduce((s, [k]) => s + g[k].length, 0);
    let i = 0;
    box.innerHTML = `<div class="pop-head">${total ? `${total} result${total === 1 ? "" : "s"} · ↑↓ to choose, Enter to open` : ""}</div>` +
      (total ? SEARCH_GROUPS.filter(([k]) => g[k].length).map(([k, title]) => `
        <div class="result-group" role="group" aria-label="${title}"><div class="result-head">${title} <span>${g[k].length}</span></div>
        ${g[k].slice(0, PER).map((h) => `<button class="result" role="option" id="sr-${i++}" tabindex="-1" data-goto-rack="${esc(h.r.id)}" data-goto-dev="${esc(h.d.id)}" ${h.bay ? `data-goto-bay="${h.bay}"` : ""}>
          <strong class="${h.mono ? "serial" : ""}">${esc(h.label)}</strong><small>${esc(h.sub)}</small></button>`).join("")}
        ${g[k].length > PER ? `<p class="result-more">+ ${g[k].length - PER} more. Type more to narrow it down.</p>` : ""}</div>`).join("")
        : `<p class="no-results">Nothing matches “${esc(ui.search.trim())}”. Try part of a name, serial number, IP address or model.</p>`);
    input.setAttribute("aria-expanded", "true");
  }
  // ↑/↓ move through results, Enter opens the highlighted one (or the first)
  function moveSearch(step) {
    const opts = $$("#search-results .result");
    if (!opts.length) return;
    ui.searchIdx = (ui.searchIdx + step + opts.length) % opts.length;
    opts.forEach((o, n) => o.classList.toggle("active", n === ui.searchIdx));
    $("#search").setAttribute("aria-activedescendant", opts[ui.searchIdx].id);
    opts[ui.searchIdx].scrollIntoView({ block: "nearest" });
  }

  // ---------- Rendering: rack ----------
  function renderRack() {
    const rack = currentRack();
    const header = $("#rack-header");
    const stage = $("#rack-stage");
    $("#view-racks").classList.toggle("no-rack", !rack); // no legend or details panel without a rack
    if (!rack) {
      header.innerHTML = "";
      stage.innerHTML = welcomeCard();
      return;
    }
    const layout = rackLayout(rack);
    const usedU = rack.units - layout.free;
    const pct = Math.round((usedU / rack.units) * 100);
    const gap = layout.largest;

    header.innerHTML = `
      <div class="page-title">
        <div>
          <p class="eyebrow">${esc(rack.location || "Racks")}</p>
          <h1>${esc(rack.name)}</h1>
          <div class="meta"><span>${rack.units}U rack</span><span>${rack.devices.length} devices</span>
            <span class="usage"><span class="usage-bar" title="${pct}% of rack units used"><span style="width:${pct}%"></span></span>${usedU}U used · ${pct}%</span>
            <span title="U with nothing mounted on either face">${layout.free}U free${gap ? ` · largest gap ${gap.len}U (U${gap.lo}${gap.len > 1 ? "–U" + gap.hi : ""})` : ""}</span></div>
        </div>
        <div class="page-actions">
          <button class="btn" data-action="edit-rack">Edit rack</button>
          <button class="btn btn-primary" data-action="add-device">+ Add device</button>
        </div>
      </div>
      <div class="toolbar">
      <div class="segmented" role="group" aria-label="Rack face">
        ${["front", "both", "rear"].map((f) => `<button data-face="${f}" class="${ui.face === f ? "active" : ""}">${f === "both" ? "Front & back" : f === "front" ? "Front" : "Back"}</button>`).join("")}
      </div>
      <div class="segmented" role="group" aria-label="Display style">
        ${[["simple", "Colour", "Coloured faceplates by device type, with names"], ["real", "Realistic", "Drawn to look like the real hardware"]]
          .map(([v, l, t]) => `<button data-look="${v}" class="${ui.look === v ? "active" : ""}" title="${t}">${l}</button>`).join("")}
      </div>
      <div class="segmented" role="group" aria-label="Labels">
        <button data-labels="1" class="${ui.labels ? "active" : ""}" aria-pressed="${ui.labels}" title="Show every device name on the rack">Labels</button>
        <button data-compact="1" class="${ui.compact ? "active" : ""}" aria-pressed="${ui.compact}" title="Fold runs of ${FOLD_MIN} or more empty U into one row">Fold empty U</button>
      </div>
      </div>`;

    const faces = ui.face === "both" ? ["front", "rear"] : [ui.face];
    stage.innerHTML = (rack.devices.length ? "" : `<p class="empty-note rack-empty">This rack has no devices yet. Click any empty slot below, or <strong>+ Add device</strong>, to add one.</p>`) +
      faces.map((f) => rackColumn(rack, f, layout)).join("");
  }

  // Rows of the rack drawing, top to bottom. With "Fold empty U" on, a run of FOLD_MIN+ U that's empty on both faces
  // becomes one row, so the devices fit on screen; Front and Back fold the same way so they stay lined up.
  // "Free" means nothing is mounted on either face (a front-only device still blocks a full-depth one).
  const FOLD_MIN = 4;
  function rackLayout(rack) {
    const used = new Set();
    rack.devices.forEach((d) => { for (let u = d.uStart; u < d.uStart + d.uHeight; u++) used.add(u); });
    const rows = [];
    let largest = null;
    for (let u = rack.units; u >= 1;) {
      if (used.has(u)) { rows.push({ hi: u, lo: u }); u--; continue; }
      let lo = u;
      while (lo > 1 && !used.has(lo - 1)) lo--;
      const len = u - lo + 1;
      if (!largest || len > largest.len) largest = { hi: u, lo, len };
      if (ui.compact && len >= FOLD_MIN) rows.push({ hi: u, lo, fold: true });
      else for (let x = u; x >= lo; x--) rows.push({ hi: x, lo: x });
      u = lo - 1;
    }
    const rowOf = {};
    rows.forEach((r, i) => { for (let x = r.lo; x <= r.hi; x++) rowOf[x] = i + 1; });
    return { rows, rowOf, free: rack.units - used.size, largest };
  }

  function rackColumn(rack, face, layout) {
    const q = ui.search.trim().toLowerCase();
    const { rows, rowOf } = layout;
    const numbers = rows.map((r) => (r.fold ? `<div class="fold-num" aria-hidden="true">⋮</div>` : `<div>${r.hi}</div>`)).join("");
    const cells = [], status = [];
    const covered = new Set();
    rack.devices.filter((d) => showsOn(d, face)).forEach((d) => {
      for (let u = d.uStart; u < d.uStart + d.uHeight; u++) covered.add(u);
      const rowStart = rowOf[d.uStart + d.uHeight - 1];
      const cls = ["device", "u" + d.uHeight, panelSide(d, face) === "rear" ? "rear" : "", !useSkin(d, face) && panelSide(d, face) === "front" && HAS_BAYS(d.type) && bayCount(d) > 0 ? "bay-device" : "", useSkin(d, face) ? "skin" : ui.look === "photos" && photoFor(d, face) ? "has-photo" : "",
        d.id === ui.deviceId ? "selected" : "", q ? (matches(d, q) ? "match" : "dim") : ""].join(" ");
      const t = TYPES[d.type] || TYPES.other;
      cells.push(`<div class="${cls}" role="button" tabindex="0" data-device="${esc(d.id)}"
        style="grid-row:${rowStart} / span ${d.uHeight};--dev:${t.color}"
        title="${esc(devName(d))} — ${esc([d.make, d.model].filter(Boolean).join(" "))} (U${d.uStart}${d.uHeight > 1 ? "–" + (d.uStart + d.uHeight - 1) : ""})">
        ${deviceFace(d, face)}</div>`);
      // up-check dot sits in its own rail beside the device so it never covers ports or trays
      const marks = statusDot(d);
      if (marks) status.push(`<div class="status-cell" style="grid-row:${rowStart} / span ${d.uHeight}" data-device="${esc(d.id)}">${marks}</div>`);
    });
    rows.forEach((r, i) => {
      if (r.fold) {
        cells.push(`<button class="empty-fold" style="grid-row:${i + 1}" data-unfold="1" title="Show every U">U${r.lo}–U${r.hi} · ${r.hi - r.lo + 1}U empty <span>Show</span></button>`);
      } else if (!covered.has(r.hi)) {
        cells.push(`<button class="empty-u" style="grid-row:${i + 1}" data-empty-u="${r.hi}" data-face="${face}" aria-label="Add device at U${r.hi} ${face}">+ Add at U${r.hi}</button>`);
      }
    });
    const tracks = `grid-template-rows:repeat(${rows.length}, var(--u-height))`;
    return `<section class="rack-col">
      <h2>${face === "front" ? "Front" : "Back"}</h2>
      <div class="rack${ui.labels ? " labels" : ""}" style="${tracks}">
        <div class="rack-numbers" style="${tracks}">${numbers}</div>
        <div class="rack-bay" style="${tracks}">${cells.join("")}</div>
        <div class="rack-status" style="${tracks}">${status.join("")}</div>
        <div class="rack-numbers" style="${tracks}">${numbers}</div>
      </div>
    </section>`;
  }

  // Which panel faces you: a rear-only device (e.g. a rear-mounted switch) shows its front panel at the back of the rack
  const panelSide = (d, face) => (face === "rear" && d.face !== "rear" ? "rear" : "front");
  const useSkin = (d, face) => ui.look === "real" || (ui.look === "photos" && !photoFor(d, face));

  // What the device face looks like (front or rear)
  function deviceFace(d, face) {
    const label = `<span class="dev-label"><span class="dev-name">${esc(devName(d))}</span></span>`; // model is in the tooltip and details
    const photo = photoFor(d, face);
    if (ui.look === "photos" && photo) {
      return `<img class="dev-photo" src="${esc(photo)}" alt="">
        <span class="photo-tag">${esc(devName(d))}</span>`;
    }
    if (useSkin(d, face)) {
      const bayHealth = (bay) => driveHealth((d.drives || []).find((x) => x.bay === bay));
      const side = panelSide(d, face);
      return window.faceFor(d, side, bayHealth, side === "front" ? portStateFor(d) : null) + `<span class="name-chip">${esc(devName(d))}</span>`;
    }
    if (d.type === "blank") return label;

    if (panelSide(d, face) === "front") {
      if (HAS_BAYS(d.type) && bayCount(d) > 0) {
        const n = bayCount(d);
        const rows = bayRows(d), cols = Math.ceil(n / rows);
        const bays = Array.from({ length: n }, (_, i) => {
          const drive = (d.drives || []).find((x) => x.bay === i + 1);
          const h = driveHealth(drive);
          const tip = drive ? `Bay ${i + 1}: ${drive.make || ""} ${drive.model || ""} ${drive.capacityTB ? drive.capacityTB + "TB" : ""} · S/N ${drive.serial || "?"} · ${formatAge(ageDays(drive.installDate))} · ${HEALTH_LABEL[h]}` : `Bay ${i + 1}: empty`;
          return `<span class="bay ${h}" data-bay="${i + 1}" title="${esc(tip)}"></span>`;
        }).join("");
        // bays span the whole faceplate, like the real unit; the name sits in a strip on top
        return `<span class="bay-title"><b>${esc(devName(d))}</b></span>` +
          `<span class="bays full${cols / rows <= 8 ? " wide" : ""}" style="grid-template-columns:repeat(${cols}, 1fr);grid-template-rows:repeat(${rows}, 1fr)">${bays}</span>`;
      }
      if (d.type === "patch" || d.type === "switch") {
        const st = portStateFor(d);
        // How many copper (RJ45) and SFP ports: UniFi's own list when linked, else the model's real layout,
        // else the port count on the device. SFP cages come after the RJ45s, as UniFi numbers them.
        const uniPorts = d.type === "switch" ? unifiFor(d)?.ports || [] : [];
        let n, sfps;
        if (uniPorts.length) {
          sfps = uniPorts.filter((p) => /sfp/i.test(p.connector || "")).length;
          n = uniPorts.length - sfps;
        } else if (d.type === "switch" && /pro.?aggregation/i.test(d.model || "")) { n = 0; sfps = 32; }
        else if (d.type === "switch" && /aggregation/i.test(d.model || "")) { n = 0; sfps = 8; }
        else {
          n = Math.min(d.ports || 24, 48);
          sfps = d.type !== "switch" ? 0 : n >= 48 ? 4 : 2;
        }
        const port = (idx, cls = "") => {
          const s = st && st(idx);
          return s ? `<span class="port${cls} ${s.cls}" data-port="${idx}" title="${s.title}"></span>` : `<span class="port${cls}"></span>`;
        };
        // laid out like the faceplate: blocks of 12 (6 wide, odd ports on top) with gaps between, SFPs set apart;
        // a 24-port patch panel is one row in sixes
        const rows = d.type === "patch" && n <= 24 ? 1 : 2, per = rows * 6;
        let groups = "";
        for (let start = 1; start <= n; start += per) {
          groups += `<span class="port-group" style="grid-template-rows:repeat(${rows}, 7px)">${Array.from({ length: Math.min(per, n - start + 1) }, (_, i) => port(start + i)).join("")}</span>`;
        }
        // SFP cages in blocks of 8 (4 wide, 2 high), like an aggregation switch's faceplate
        for (let s = 0; s < sfps; s += 8) {
          const c = Math.min(8, sfps - s);
          groups += `<span class="port-group sfp-group" style="grid-template-rows:repeat(${c > 2 ? 2 : 1}, 7px)">${Array.from({ length: c }, (_, i) => port(n + s + i + 1, " sfp-port")).join("")}</span>`;
        }
        return label + `<span class="ports">${groups}</span>`;
      }
      if (d.type === "ups") return label + `<span class="vent"></span><span class="leds"><span class="led"></span></span>`;
      return label + `<span class="vent"></span><span class="leds"><span class="led"></span><span class="led ${flagged(deviceHealth(d)) ? "amber" : ""}"></span></span>`;
    }

    // rear
    const plainPorts = (count) => `<span class="ports"><span class="port-group">${'<span class="port"></span>'.repeat(count)}</span></span>`;
    if (d.type === "pdu") return label + plainPorts(8);
    if (d.type === "patch") return label;
    const psus = d.type === "switch" || d.type === "firewall" ? 1 : 2;
    return `<span class="psu"></span>${psus > 1 ? '<span class="psu"></span>' : ""}${label}<span class="vent"></span>${plainPorts(d.type === "switch" ? 4 : 6)}`;
  }

  // ---------- Rendering: details ----------
  function renderDetails(flashBay) {
    const rack = currentRack();
    const d = findDevice(rack, ui.deviceId);
    const box = $("#details");
    box.classList.toggle("has-device", !!d); // on small screens a selected device opens as a bottom sheet
    if (!d) {
      box.innerHTML = `<div class="placeholder">
        <span class="ph-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></svg></span>
        <p><strong>Select a device</strong></p>
        <p>Click anything in the rack to see its details and drives, or click an empty slot to add a device there.</p></div>`;
      return;
    }
    const t = TYPES[d.type] || TYPES.other;
    const n = bayCount(d);
    const drives = (d.drives || []).slice().sort((a, b) => a.bay - b.bay);
    const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
    // Fields worth knowing about: say "No data" with a way to add it, instead of hiding the row
    const add = `<button class="btn-link add-data" data-action="edit-device">Add</button>`;
    const want = (k, v) => `<dt>${k}</dt><dd>${v || `<span class="no-data">No data</span>${add}`}</dd>`;

    let drivesHtml = HAS_BAYS(d.type) && !n && !drives.length
      ? `<h3>Drives</h3><p class="empty-note">No drives recorded. Use <strong>Edit device &amp; drives</strong> to set the bays and add drives, so their age is tracked.</p>` : "";
    if (HAS_BAYS(d.type) && (n > 0 || drives.length)) {
      const cards = Array.from({ length: n }, (_, i) => {
        const dr = drives.find((x) => x.bay === i + 1);
        const h = driveHealth(dr);
        if (!dr) return `<div class="drive-card empty" data-bay-card="${i + 1}"><div class="row"><strong>Bay ${i + 1}</strong><span class="pill empty">Empty</span></div></div>`;
        return `<div class="drive-card ${h} ${flashBay === i + 1 ? "flash" : ""}" data-bay-card="${i + 1}">
          <div class="row"><strong>Bay ${i + 1} · ${esc(dr.capacityTB ? dr.capacityTB + " TB" : "")} ${esc(dr.kind || "")}</strong><span class="pill ${h}">${HEALTH_LABEL[h]}</span></div>
          <div>${esc(makeModel(dr.make, dr.model)) || "—"}</div>
          <div class="row"><span class="serial">S/N ${dr.serial ? `<span class="copyable" data-copy="${esc(dr.serial)}" title="Click to copy">${esc(dr.serial)}</span>` : '<span class="no-data">No data</span>'}</span>${dr.installDate ? `<span>Age ${formatAge(ageDays(dr.installDate))}</span>` : ""}</div>
          <div class="help">Installed ${dr.installDate ? formatDate(dr.installDate) : '<span class="no-data">No data</span> · add an install date to track its age'}${dr.status === "spare" ? " · Spare" : ""}${dr.notes ? " · " + esc(dr.notes) : ""}</div>
        </div>`;
      }).join("");
      const used = drives.reduce((s, x) => s + (Number(x.capacityTB) || 0), 0);
      const rows = bayRows(d), cols = Math.ceil(n / rows);
      const map = Array.from({ length: n }, (_, i) => {
        const h = driveHealth(drives.find((x) => x.bay === i + 1));
        return `<button class="bm-cell ${h}${flashBay === i + 1 ? " picked" : ""}" data-bay-pick="${i + 1}" title="Bay ${i + 1}: ${HEALTH_LABEL[h]}">${i + 1}</button>`;
      }).join("");
      const tally = HEALTH_ORDER.map((h) => [h, drives.filter((x) => driveHealth(x) === h).length]).filter(([, c]) => c);
      drivesHtml = `<h3>Drives</h3>
        <div class="drive-summary"><span>${drives.length} of ${n} bays · ${used} TB raw</span>${tally.map(([h, c]) => `<span class="pill ${h}">${c} ${HEALTH_LABEL[h].toLowerCase()}</span>`).join("")}</div>
        <div class="bay-map" style="grid-template-columns:repeat(${cols}, 1fr)" aria-label="Bay layout, as on the front of the unit">${map}</div>
        ${cards}`;
    }

    box.innerHTML = `
      <div class="det-head">
        <span class="det-icon" style="background:${t.color}">${TYPE_SHORT[d.type] || "•"}</span>
        <div><h2>${esc(devName(d))}</h2><p class="det-sub">${esc(d.name ? [d.make, d.model].filter(Boolean).join(" ") : t.label)}</p></div>
        <button class="sheet-close" data-action="close-details" aria-label="Close details">×</button>
      </div>
      <span class="type-chip"><span class="swatch" style="background:${t.color}"></span>${t.label}</span>
      ${flagged(deviceHealth(d)) ? `<span class="type-chip warn ${deviceHealth(d)}">${needsAttention(deviceHealth(d)) ? "Drive needs attention" : "Drive to watch"}</span>` : ""}
      <dl class="kv">
        ${row("Make / model", esc([d.make, d.model].filter(Boolean).join(" ")))}
        ${want("Serial", d.serial ? `<span class="serial copyable" data-copy="${esc(d.serial)}" title="Click to copy">${esc(d.serial)}</span>` : "")}
        ${row("Asset tag", esc(d.assetTag))}
        ${d.type === "blank" || d.type === "patch" || d.type === "pdu" ? row("IP address", esc(d.ip)) : want("IP address", esc(d.ip))}
        ${d.ip ? `<dt>Status</dt><dd class="st-cell">${statusLine(d)}</dd>` : ""}
        ${uptimeLine(d) ? `<dt>Availability</dt><dd>${esc(uptimeLine(d))}</dd>` : ""}
        ${unifiUptime(d) ? `<dt>Device uptime</dt><dd>${esc(unifiUptime(d))}</dd>` : ""}
        <dt>Position</dt><dd>U${d.uStart}${d.uHeight > 1 ? "–U" + (d.uStart + d.uHeight - 1) : ""} (${d.uHeight}U) · ${d.face === "both" ? "Full depth" : d.face === "front" ? "Front only" : "Rear only"}</dd>
        ${row("Purchased", d.purchaseDate ? formatDate(d.purchaseDate) + ` (${formatAge(ageDays(d.purchaseDate))} ago)` : "")}
        ${d.type === "blank" || d.type === "patch" ? "" : want("Warranty end", d.warrantyEnd ? formatDate(d.warrantyEnd) + (ageDays(d.warrantyEnd) > 0 ? ' <span class="pill old">Expired</span>' : "") : "")}
      </dl>
      ${d.photoFront || d.photoRear ? `<h3>Photos</h3><div class="photo-pair">
        ${[["Front", d.photoFront], ["Back", d.photoRear]].filter(([, p]) => p).map(([l, p]) => `<figure><a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="${l} of ${esc(devName(d))}"></a><figcaption>${l}</figcaption></figure>`).join("")}
      </div>` : ""}
      ${d.notes ? `<h3>Notes</h3><div class="notes">${esc(d.notes)}</div>` : ""}
      ${drivesHtml}
      ${portsPanel(d, ui.portIdx)}
      <div class="detail-actions">
        <button class="btn btn-primary" data-action="edit-device">Edit${HAS_BAYS(d.type) ? " device & drives" : " device"}</button>
        <button class="btn" data-action="duplicate-device">Duplicate</button>
        <button class="btn btn-danger" data-action="delete-device">Delete</button>
      </div>`;
    if (flashBay) $(`[data-bay-card="${flashBay}"]`, box)?.scrollIntoView({ block: "nearest", behavior: smooth() });
  }

  // ---------- Dashboard ----------
  function miniRack(r) {
    const bars = r.devices.filter((d) => d.face !== "rear").map((d) => {
      const top = ((r.units - (d.uStart + d.uHeight - 1)) / r.units) * 100;
      const h = deviceHealth(d);
      return `<span class="mini-dev${flagged(h) ? " " + h : ""}" style="top:${top}%;height:calc(${(d.uHeight / r.units) * 100}% - 1px);background:${(TYPES[d.type] || TYPES.other).color}"></span>`;
    }).join("");
    return `<span class="mini-rack">${bars}</span>`;
  }

  // Shown when this browser has no data yet
  function welcomeCard() {
    return `<div class="welcome">
      <span class="ph-icon"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg></span>
      <h2>No rack data ${shared.on ? "on this server" : "in this browser"} yet</h2>
      <p>Rack data isn't stored in the app itself. Import an Export file (e.g. <code>wcc-racks-….json</code>) to load your racks, devices and drives, or start from scratch.</p>
      <div class="welcome-actions"><button class="btn btn-primary" data-action="import">Import data</button><button class="btn" data-action="add-rack">+ Add a rack</button></div>
    </div>`;
  }

  // One device in the dashboard's status lists, with when it was last checked
  function statusRow(r, d, st) {
    return `<button class="att-row" data-goto-rack="${esc(r.id)}" data-goto-dev="${esc(d.id)}" title="${esc(st.tip)}">
      <span class="pill st-${st.key}"><span class="st-dot ${st.key}" aria-hidden="true">${STATE_ICON[st.key]}</span>${esc(st.label)}</span>
      <span class="att-main"><strong>${esc(devName(d))}</strong><small>${esc(d.ip)}${st.s ? " · " + esc(st.s.method) : ""}</small></span>
      <span class="att-where"><span>${esc(r.name)}</span><small>U${d.uStart}${r.location ? " · " + esc(r.location) : ""}</small></span>
      <span class="att-age"><small>Last checked</small>${st.s?.checkedAt ? timeOf(st.s.checkedAt) : "Never checked"}</span>
    </button>`;
  }

  function renderHome() {
    if (!data.racks.length) {
      $("#view-home").innerHTML = `<div class="page-title"><div><p class="eyebrow">Rack View</p><h1>Welcome</h1></div></div><div class="card">${welcomeCard()}</div>`;
      return;
    }
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const drives = allDrives();
    const counts = driveCounts(drives);
    const attention = drives.filter((d) => needsAttention(d.health)).sort(bySeverity);
    const allDevices = data.racks.flatMap((r) => r.devices.map((d) => [r, d]));
    const withWarranty = allDevices.filter(([, d]) => d.warrantyEnd);
    const warrantyOut = withWarranty.filter(([, d]) => ageDays(d.warrantyEnd) > 0).length;
    const today = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
    const states = allDevices.map(([r, d]) => [r, d, stateOf(d)]).filter(([, , st]) => st);
    const n = (k) => states.filter(([, , st]) => st.key === k).length;
    const down = states.filter(([, , st]) => st.key === "down");
    const unknown = states.filter(([, , st]) => st.key === "unknown");
    const problem = checkerProblem();
    const plural = (c, word) => `${c} ${word}${c === 1 ? "" : "s"}`;

    const tileFor = (r) => {
      const used = new Set();
      r.devices.forEach((d) => { for (let u = d.uStart; u < d.uStart + d.uHeight; u++) used.add(u); });
      const pct = Math.round((used.size / r.units) * 100);
      const rc = driveCounts(drives.filter((d) => d.rackId === r.id));
      const pills = rc.total
        ? (rc.attention ? `<span class="pill old">${rc.attention} need${rc.attention === 1 ? "s" : ""} attention</span>` : "") +
          (rc.ageing ? `<span class="pill ageing">${rc.ageing} to watch</span>` : "") +
          (!rc.attention && !rc.ageing ? `<span class="pill ok">No drive issues</span>` : "")
        : `<span class="pill empty">No drives recorded</span>`;
      return `<button class="card rack-tile" data-rack="${esc(r.id)}">
        ${miniRack(r)}
        <span class="tile-body">
          <strong>${esc(r.name)}</strong>
          <span class="tile-meta">${r.units}U · ${r.devices.length ? plural(r.devices.length, "device") : "No devices yet"}</span>
          <span class="usage"><span class="usage-bar"><span style="width:${pct}%"></span></span>${pct}% used</span>
          <span class="tile-pills">${pills}</span>
        </span>
      </button>`;
    };
    const tiles = rooms().map(([room, racks]) => `
      <div class="room-head"><h3>${esc(room)}</h3><span>${racks.length} rack${racks.length === 1 ? "" : "s"}</span></div>
      <div class="rack-tiles">${racks.map(tileFor).join("")}</div>`).join("");

    const list = attention.slice(0, 8).map((d) => `
      <button class="att-row" data-goto-rack="${esc(d.rackId)}" data-goto-dev="${esc(d.deviceId)}" data-goto-bay="${d.bay}">
        <span class="pill ${d.health}">${HEALTH_LABEL[d.health]}</span>
        <span class="att-main"><strong class="serial">${d.serial ? esc(d.serial) : '<span class="no-data">No serial recorded</span>'}</strong>
          <small>${esc(makeModel(d.make, d.model))}${d.capacityTB ? " · " + d.capacityTB + " TB" : ""}</small></span>
        <span class="att-where"><span>${esc(d.device)}</span><small>${esc(d.rack)} · ${d.deviceU} · Bay ${d.bay}</small></span>
        <span class="att-age">${formatAge(d.ageDays)}</span>
      </button>`).join("");

    $("#view-home").innerHTML = `
      <div class="page-title">
        <div><p class="eyebrow">${today}</p><h1>${greeting}</h1>
          <div class="meta"><span>Server racks, devices and drives across the College</span></div></div>
        <div class="page-actions">
          <button class="btn" id="home-export">Export backup</button>
          <button class="btn btn-primary" data-action="add-rack">+ Add rack</button>
        </div>
      </div>
      ${problem ? `<div class="banner warn" role="status"><strong>Device status unknown.</strong> ${esc(problem)}</div>` : ""}
      <div class="stats">
        <div class="stat"><strong>${data.racks.length}</strong>${data.racks.length === 1 ? "Rack" : "Racks"} in ${plural(rooms().length, "room")}</div>
        <div class="stat"><strong>${allDevices.length}</strong>${allDevices.length === 1 ? "Device" : "Devices"}</div>
        <button class="stat link" data-report="all"><strong>${counts.total}</strong>Drives tracked</button>
        <button class="stat link ${counts.attention ? "old" : ""}" data-report="attention"><strong>${counts.attention}</strong>Need attention
          <small>${counts.failed} failed · ${counts.old} replace soon</small></button>
        <button class="stat link ${counts.ageing ? "ageing" : ""}" data-report="ageing"><strong>${counts.ageing}</strong>To watch <small>Ageing, ${AGE_AGEING}–${AGE_OLD} years</small></button>
        ${withWarranty.length
          ? `<div class="stat ${warrantyOut ? "ageing" : ""}"><strong>${warrantyOut}</strong>Out of warranty <small>of ${plural(withWarranty.length, "device")} with a warranty date</small></div>`
          : `<div class="stat nodata"><strong>No data</strong>Warranty <small>Add warranty end dates to devices to track this</small></div>`}
        ${states.length ? `<div class="stat ${down.length ? "failed" : ""}"><strong>${problem ? "Unknown" : n("up") + " up"}</strong>Device status
          <small>${problem ? "See the note above" : `${down.length} down · ${unknown.length} unknown`}${allDevices.length > states.length ? ` · ${allDevices.length - states.length} without an IP` : ""}</small></div>` : ""}
      </div>
      <h2 class="section-h">Rooms</h2>
      ${tiles}
      ${down.length ? `<h2 class="section-h">Not responding</h2>
      <div class="card att-list">${down.map(([r, d, st]) => statusRow(r, d, st)).join("")}</div>` : ""}
      ${unknown.length && !problem ? `<details class="card att-list unknown-list"><summary>${plural(unknown.length, "device")} with unknown status</summary>
        ${unknown.map(([r, d, st]) => statusRow(r, d, st)).join("")}</details>` : ""}
      <div class="section-row">
        <h2 class="section-h">Drives needing attention</h2>
        <button class="btn-link" data-report="attention">View in drive report →</button>
      </div>
      <div class="card att-list">${list || `<p class="empty-state">${counts.total ? "No drives need attention." : "No drives recorded yet. Add drives to an NVR, NAS or server to track their age."}</p>`}
        ${attention.length > 8 ? `<button class="att-more" data-report="attention">+ ${attention.length - 8} more in the drive report</button>` : ""}
        ${counts.ageing ? `<button class="att-more" data-report="ageing">${plural(counts.ageing, "ageing drive")} to watch →</button>` : ""}</div>`;
    $("#home-export").addEventListener("click", exportJson);
  }

  // ---------- Drive report ----------
  function allDrives() {
    const out = [];
    data.racks.forEach((r) => r.devices.forEach((d) => (d.drives || []).forEach((dr) => {
      out.push({ ...dr, rack: r.name, rackId: r.id, device: devName(d), deviceU: "U" + d.uStart + (d.uHeight > 1 ? "–" + (d.uStart + d.uHeight - 1) : ""), deviceId: d.id, health: driveHealth(dr), ageDays: ageDays(dr.installDate) });
    })));
    return out;
  }
  const REPORT_COLS = [["rack", "Rack"], ["device", "Device"], ["bay", "Bay"], ["make", "Make"], ["model", "Model"], ["kind", "Type"], ["capacityTB", "TB"], ["serial", "Serial number"], ["installDate", "Installed"], ["ageDays", "Age"], ["health", "Health"]];
  const REPORT_FILTERS = [["all", "All drives"], ["attention", "Needs attention (failed + replace soon)"], ["failed", "Failed"], ["old", `Replace soon (${AGE_OLD}+ yrs)`],
    ["ageing", `To watch: ageing (${AGE_AGEING}–${AGE_OLD} yrs)`], ["unknown", "Age unknown (no install date)"], ["ok", "Healthy"]];

  // The drives the report shows right now: status, rack, device and text filters, sorted.
  // Default order is most urgent first (Failed, Replace soon, Ageing, Age unknown, Healthy), oldest first within each.
  function reportRows() {
    const f = ui.reportFilter, rack = ui.reportRack || "", dev = ui.reportDevice || "";
    const q = (ui.reportQuery || "").trim().toLowerCase();
    const list = allDrives().filter((r) =>
      (f === "all" || (f === "attention" ? needsAttention(r.health) : r.health === f)) &&
      (!rack || r.rackId === rack) && (!dev || r.deviceId === dev) &&
      (!q || [r.serial, r.make, r.model, r.kind, r.device, r.rack, r.notes].join(" ").toLowerCase().includes(q)));
    const { key, dir } = ui.reportSort;
    return list.sort((a, b) => {
      if (key === "health") return bySeverity(a, b) * dir;
      const av = a[key] ?? "", bv = b[key] ?? "";
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return c * dir || bySeverity(a, b);
    });
  }
  // The page frame (title, filters) is drawn once; typing in a filter only redraws the tiles and rows, so focus stays put
  function renderReport() {
    const all = allDrives();
    const rackOpts = data.racks.filter((r) => all.some((d) => d.rackId === r.id));
    $("#drive-report").innerHTML = `
      <div class="page-title">
        <div><p class="eyebrow">All racks</p><h1>Drive report</h1><div class="meta"><span>Every drive in every NVR, NAS and server</span></div></div>
        <div class="page-actions"><button class="btn" id="btn-export-csv">Download CSV</button></div>
      </div>
      ${all.length ? `<div class="report-filters" role="search">
        <label class="rf-q"><span>Search</span><input type="search" id="report-q" value="${esc(ui.reportQuery || "")}" placeholder="Serial, model, device…"></label>
        <label><span>Status</span><select id="report-filter">${REPORT_FILTERS.map(([v, l]) => `<option value="${v}" ${ui.reportFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label><span>Rack</span><select id="report-rack"><option value="">All racks</option>${rackOpts.map((r) => `<option value="${esc(r.id)}" ${ui.reportRack === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
        <label><span>Device</span><select id="report-device"></select></label>
        <button class="btn btn-small" id="report-clear" hidden>Clear filters</button>
      </div>` : ""}
      <div id="report-body"></div>`;
    updateReport();
  }
  function updateReport() {
    const body = $("#report-body");
    if (!body) return;
    const all = allDrives();
    if (!all.length) {
      body.innerHTML = `<div class="card"><p class="empty-state">No drives recorded yet. Open an NVR, NAS or server in a rack and use <strong>Edit device &amp; drives</strong> to add its drives. They'll all appear here.</p></div>`;
      return;
    }
    // device list follows the chosen rack
    const devSel = $("#report-device");
    const devs = data.racks.filter((r) => !ui.reportRack || r.id === ui.reportRack).flatMap((r) => r.devices.filter((d) => d.drives?.length).map((d) => [r, d]));
    if (ui.reportDevice && !devs.some(([, d]) => d.id === ui.reportDevice)) ui.reportDevice = "";
    devSel.innerHTML = `<option value="">All devices</option>` + devs.map(([r, d]) => `<option value="${esc(d.id)}" ${ui.reportDevice === d.id ? "selected" : ""}>${esc(devName(d))}${ui.reportRack ? "" : " · " + esc(r.name)}</option>`).join("");
    const filtered = ui.reportFilter !== "all" || ui.reportRack || ui.reportDevice || (ui.reportQuery || "").trim();
    $("#report-clear").hidden = !filtered;

    const c = driveCounts(all), list = reportRows();
    const totalTB = all.reduce((s, r) => s + (Number(r.capacityTB) || 0), 0);
    const tile = (f, n, label, cls = "", sub = "") => `<button class="stat link ${cls} ${ui.reportFilter === f ? "active" : ""}" data-report-filter="${f}" aria-pressed="${ui.reportFilter === f}"><strong>${n}</strong>${label}${sub ? `<small>${sub}</small>` : ""}</button>`;
    const { key, dir } = ui.reportSort;
    body.innerHTML = `
      <div class="stats">
        ${tile("all", c.total, "Drives tracked", "", `${Math.round(totalTB * 10) / 10} TB raw`)}
        ${tile("attention", c.attention, "Need attention", c.attention ? "old" : "", `${c.failed} failed · ${c.old} replace soon`)}
        ${tile("failed", c.failed, "Failed", c.failed ? "failed" : "")}
        ${tile("old", c.old, "Replace soon", c.old ? "old" : "", `${AGE_OLD}+ years`)}
        ${tile("ageing", c.ageing, "To watch", c.ageing ? "ageing" : "", `Ageing, ${AGE_AGEING}–${AGE_OLD} years`)}
        ${c.unknown ? tile("unknown", c.unknown, "Age unknown", "", "No install date") : ""}
      </div>
      <p class="report-count" aria-live="polite">${list.length === all.length ? `Showing all ${all.length} drives` : `Showing ${list.length} of ${all.length} drives`} · most urgent first unless you sort by a column</p>
      <div class="table-wrap">
      <table class="grid report">
        <thead><tr>${REPORT_COLS.map(([k, l]) => `<th scope="col" data-sort="${k}" tabindex="0" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${l}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td data-label="Rack">${esc(r.rack)}</td>
          <td data-label="Device"><button class="btn-link" data-goto-rack="${esc(r.rackId)}" data-goto-dev="${esc(r.deviceId)}" data-goto-bay="${r.bay}">${esc(r.device)}</button> <span class="u-tag">${r.deviceU}</span></td>
          <td data-label="Bay">${r.bay}</td><td data-label="Make">${esc(r.make)}</td><td data-label="Model">${esc(r.model)}</td><td data-label="Type">${esc(r.kind)}</td><td data-label="TB">${esc(r.capacityTB)}</td>
          <td data-label="Serial" class="mono">${r.serial ? `<button class="copy-serial" data-copy="${esc(r.serial)}" title="Copy serial number">${esc(r.serial)}<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>` : '<span class="no-data">No data</span>'}</td>
          <td data-label="Installed" class="nowrap">${r.installDate ? formatDate(r.installDate) : '<span class="no-data">No data</span>'}</td>
          <td data-label="Age" class="nowrap">${r.installDate ? formatAge(r.ageDays) : "—"}</td>
          <td data-label="Health"><span class="pill ${r.health}">${HEALTH_LABEL[r.health]}</span></td></tr>`).join("") ||
          `<tr><td colspan="${REPORT_COLS.length}" class="no-results">No drives match these filters. <button class="btn-link" id="report-clear-2">Clear filters</button></td></tr>`}
        </tbody>
      </table></div>`;
  }
  // CSV of exactly the rows on screen (filters and sort applied)
  function exportCsv() {
    const rows = reportRows();
    const head = ["Rack", "Device", "Bay", "Make", "Model", "Type", "Capacity TB", "Serial", "Installed", "Age", "Health", "Notes"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head.map(q).join(",")].concat(rows.map((r) => [r.rack, r.device, r.bay, r.make, r.model, r.kind, r.capacityTB, r.serial, r.installDate, r.installDate ? formatAge(r.ageDays) : "", HEALTH_LABEL[r.health], r.notes].map(q).join(","))).join("\r\n");
    download(new Blob(["﻿" + csv], { type: "text/csv" }), `wcc-drives-${today()}.csv`); // BOM so Excel reads "–" etc. correctly
    toast(`Downloaded ${rows.length} drive${rows.length === 1 ? "" : "s"} as CSV`);
  }

  // ---------- Modals ----------
  // Small notifications in the corner, instead of browser alert()s
  function toast(message, kind = "ok") {
    const host = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 250); }, kind === "error" ? 6000 : 3200);
  }

  // Styled yes/no question, instead of browser confirm(); resolves true/false
  // detail: optional extra HTML we build ourselves (already escaped), e.g. counts or a checkbox
  function ask({ title, message, confirmLabel = "Confirm", danger = false, detail = "" }) {
    const dlg = $("#confirm-dialog");
    dlg.innerHTML = `<form method="dialog">
      <div class="confirm-body"><span class="confirm-icon ${danger ? "danger" : ""}">${danger ? "!" : "?"}</span>
        <div><h2>${esc(title)}</h2><p>${esc(message)}</p>${detail}</div></div>
      <div class="modal-foot"><button class="btn" value="no">Cancel</button>
        <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" value="yes">${esc(confirmLabel)}</button></div></form>`;
    dlg.returnValue = "";
    dlg.showModal();
    $("button[value=yes]", dlg).focus();
    return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true }));
  }

  const modal = $("#modal");
  function openModal(title, bodyHtml, footHtml, onSubmit) {
    modal.innerHTML = `<form method="dialog" novalidate>
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" data-close aria-label="Close">×</button></div>
      <div class="modal-body">${bodyHtml}<div class="form-error" id="form-error" role="alert"></div></div>
      <div class="modal-foot">${footHtml}</div></form>`;
    const form = $("form", modal);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const err = onSubmit(form);
      if (err) { $("#form-error").textContent = err; return; }
      modal.close();
    });
    $$("[data-close]", modal).forEach((b) => b.addEventListener("click", () => modal.close()));
    modal.showModal();
    $("input, select", modal)?.focus();
    return form;
  }
  const field = (name, label, value, opts = {}) => {
    const { type = "text", cls = "", options, attrs = "" } = opts;
    let input;
    if (options) input = `<select name="${name}" id="f-${name}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    else if (type === "textarea") input = `<textarea name="${name}" id="f-${name}" ${attrs}>${esc(value)}</textarea>`;
    else input = `<input type="${type}" name="${name}" id="f-${name}" value="${esc(value)}" ${attrs}>`;
    return `<div class="field ${cls}"><label for="f-${name}">${label}</label>${input}</div>`;
  };

  // Photo picker: the (resized) image is kept in a hidden input so it submits with the form
  function photoInput(name, label, value, maxW = 700) {
    return `<div class="photo-input" data-max-w="${maxW}">
      <label>${label}</label>
      <div class="photo-preview">${value ? `<img src="${esc(value)}" alt="">` : "<span>No photo</span>"}</div>
      <input type="hidden" name="${name}" value="${esc(value)}">
      <div class="photo-buttons">
        <label class="btn btn-small">Choose photo…<input type="file" accept="image/*" hidden></label>
        <button type="button" class="btn btn-small btn-danger" data-clear-photo ${value ? "" : "hidden"}>Remove</button>
      </div>
    </div>`;
  }
  function wirePhotoInputs(form) {
    $$(".photo-input", form).forEach((box) => {
      const hidden = $("input[type=hidden]", box);
      const preview = $(".photo-preview", box);
      const clear = $("[data-clear-photo]", box);
      $("input[type=file]", box).addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          hidden.value = await resizeImage(file, +box.dataset.maxW);
          preview.innerHTML = `<img src="${hidden.value}" alt="">`;
          clear.hidden = false;
        } catch (err) { $("#form-error").textContent = err.message; }
        e.target.value = "";
      });
      clear.addEventListener("click", () => { hidden.value = ""; preview.innerHTML = "<span>No photo</span>"; clear.hidden = true; });
    });
  }

  function rackModal(rack) {
    const isNew = !rack;
    rack = rack || { name: "", location: currentRack()?.location || "", units: 42, notes: "" };
    openModal(isNew ? "Add rack" : "Edit rack", `
      <div class="form-grid">
        ${field("name", "Rack name *", rack.name, { cls: "span-2", attrs: "required" })}
        ${field("units", "Height (U) *", rack.units, { type: "number", attrs: 'min="1" max="60"' })}
        ${field("location", "Room", rack.location, { cls: "span-3", attrs: 'list="room-list" placeholder="e.g. CIP Server Room"' })}
        <datalist id="room-list">${rooms().map(([room]) => `<option value="${esc(room)}">`).join("")}</datalist>
        ${field("notes", "Notes", rack.notes, { type: "textarea", cls: "span-3" })}
      </div>
`,
      `${isNew ? "" : '<button type="button" class="btn btn-danger left" id="btn-del-rack">Delete rack</button>'}
       <button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Save</button>`,
      (form) => {
        const f = Object.fromEntries(new FormData(form));
        const units = parseInt(f.units, 10);
        if (!f.name.trim()) return "Please give the rack a name.";
        if (!(units >= 1 && units <= 60)) return "Height must be between 1 and 60U.";
        if (!isNew && rack.devices.some((d) => d.uStart + d.uHeight - 1 > units)) return "Some devices sit above U" + units + ". Move them first.";
        if (isNew) {
          const r = { id: uid(), name: f.name.trim(), location: f.location.trim(), units, notes: f.notes, devices: [] };
          data.racks.push(r);
          ui.rackId = r.id; ui.deviceId = null;
        } else Object.assign(rack, { name: f.name.trim(), location: f.location.trim(), units, notes: f.notes });
        save(); renderAll(); toast(isNew ? "Rack added" : "Rack updated");
      });
    $("#btn-del-rack")?.addEventListener("click", async () => {
      if (!(await ask({ title: `Delete ${rack.name}?`, message: `This removes the rack and all ${rack.devices.length} devices in it. It can't be undone unless you have an export.`, confirmLabel: "Delete rack", danger: true }))) return;
      data.racks = data.racks.filter((r) => r !== rack);
      ui.rackId = data.racks[0]?.id || null; ui.deviceId = null;
      modal.close(); save(); renderAll(); toast("Rack deleted");
    });
  }

  function deviceModal(dev, preset = {}) {
    const rack = currentRack();
    const isNew = !dev;
    dev = dev || { name: "", type: "server", uStart: preset.uStart || 1, uHeight: 1, face: preset.face || "both", drives: [] };
    let drives = structuredClone(dev.drives || []);
    const typeOpts = Object.entries(TYPES).map(([k, t]) => [k, t.label]);

    const form = openModal(isNew ? `Add device to ${rack.name}` : `Edit ${devName(dev)}`, `
      <div class="form-grid">
        ${field("name", "Name (optional)", dev.name, { cls: "span-2", attrs: 'placeholder="Leave blank to show the make and model"' })}
        ${field("type", "Type", dev.type, { options: typeOpts })}
        ${field("make", "Make", dev.make)}
        ${field("model", "Model", dev.model)}
        ${field("serial", "Serial number", dev.serial)}
        ${field("assetTag", "Asset tag", dev.assetTag)}
        ${field("ip", "IP address", dev.ip)}
        ${field("mac", "MAC address", dev.mac, { attrs: 'placeholder="aa:bb:cc:dd:ee:ff"' })}
        ${field("checkPort", "Up-check port (optional)", dev.checkPort, { type: "number", attrs: 'min="1" max="65535" placeholder="Blank = ping"' })}
        ${field("ports", "Ports (switch / patch)", dev.ports, { type: "number", attrs: 'min="0" max="96"' })}
        ${field("uStart", "Bottom U *", dev.uStart, { type: "number", attrs: `min="1" max="${rack.units}"` })}
        ${field("uHeight", "Height (U) *", dev.uHeight, { type: "number", attrs: 'min="1" max="20"' })}
        ${field("face", "Mounted", dev.face, { options: [["both", "Full depth (front & back)"], ["front", "Front only"], ["rear", "Rear only"]] })}
        ${field("purchaseDate", "Purchase date", dev.purchaseDate, { type: "date" })}
        ${field("warrantyEnd", "Warranty end", dev.warrantyEnd, { type: "date" })}
        ${field("bays", "Drive bays", bayCount(dev) || "", { type: "number", attrs: 'min="0" max="60"' })}
        ${field("bayRows", "Bay rows (as on the front)", dev.bayRows || "", { type: "number", attrs: 'min="1" max="12" placeholder="auto"' })}
        ${field("notes", "Notes", dev.notes, { type: "textarea", cls: "span-3" })}
      </div>
      <div class="drive-editor" id="drive-editor"></div>`,
      `<button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Save</button>`,
      (form) => {
        readDrives();
        const f = Object.fromEntries(new FormData(form));
        const uStart = parseInt(f.uStart, 10), uHeight = parseInt(f.uHeight, 10);
        if (!f.name.trim() && !f.make.trim() && !f.model.trim()) return "Give the device a name, or at least a make or model.";
        if (!(uStart >= 1) || !(uHeight >= 1)) return "Position and height must be at least 1.";
        if (uStart + uHeight - 1 > rack.units) return `It doesn't fit: U${uStart}–U${uStart + uHeight - 1} goes past the top of this ${rack.units}U rack.`;
        if (!rangeFree(rack, uStart, uHeight, f.face, dev.id)) return `U${uStart}${uHeight > 1 ? "–U" + (uStart + uHeight - 1) : ""} is already in use on that side of the rack.`;
        const bays = parseInt(f.bays, 10) || 0;
        const keptDrives = HAS_BAYS(f.type) ? drives.filter((d) => d.serial || d.model || d.make) : [];
        const bayNums = keptDrives.map((d) => d.bay);
        if (new Set(bayNums).size !== bayNums.length) return "Two drives are in the same bay.";
        const out = {
          name: f.name.trim(), type: f.type, make: f.make.trim(), model: f.model.trim(), serial: f.serial.trim(),
          assetTag: f.assetTag.trim(), ip: f.ip.trim(), checkPort: parseInt(f.checkPort, 10) || undefined, mac: f.mac.trim(), ports: parseInt(f.ports, 10) || undefined,
          uStart, uHeight, face: f.face, purchaseDate: f.purchaseDate, warrantyEnd: f.warrantyEnd,
          notes: f.notes, bays: HAS_BAYS(f.type) ? Math.max(bays, ...bayNums, 0) : undefined,
          bayRows: HAS_BAYS(f.type) ? parseInt(f.bayRows, 10) || undefined : undefined, drives: keptDrives
        };
        if (isNew) { out.id = uid(); rack.devices.push(out); ui.deviceId = out.id; }
        else Object.assign(dev, out);
        save(); renderAll(); toast(isNew ? "Device added" : "Changes saved");
      });

    const editor = $("#drive-editor", form);
    const typeSel = $("#f-type", form);
    const baysInput = $("#f-bays", form);

    function readDrives() {
      $$("tr[data-i]", editor).forEach((tr) => {
        const d = drives[+tr.dataset.i];
        $$("[data-k]", tr).forEach((inp) => {
          const k = inp.dataset.k;
          d[k] = k === "bay" ? parseInt(inp.value, 10) || 0 : k === "capacityTB" ? (inp.value === "" ? "" : Number(inp.value)) : inp.value.trim();
        });
      });
    }
    function drawDrives() {
      const show = HAS_BAYS(typeSel.value);
      baysInput.closest(".field").hidden = !show;
      $("#f-bayRows", form).closest(".field").hidden = !show;
      if (!show) { editor.innerHTML = ""; return; }
      drives.sort((a, b) => a.bay - b.bay);
      editor.innerHTML = `
        <h3>Drives <span><button type="button" class="btn btn-small" id="fill-bays">Fill empty bays</button> <button type="button" class="btn btn-small btn-primary" id="add-drive">+ Add drive</button></span></h3>
        ${drives.length ? `<table class="drive-table"><thead><tr><th>Bay</th><th>Make</th><th>Model</th><th>Type</th><th>TB</th><th>Serial number</th><th>Installed</th><th>Status</th><th></th></tr></thead><tbody>
        ${drives.map((d, i) => `<tr data-i="${i}">
          <td><input data-k="bay" type="number" min="1" value="${esc(d.bay)}" aria-label="Bay"></td>
          <td><input data-k="make" value="${esc(d.make)}" aria-label="Make"></td>
          <td><input data-k="model" value="${esc(d.model)}" aria-label="Model"></td>
          <td><select data-k="kind" aria-label="Drive type">${DRIVE_TYPES.map((t) => `<option ${t === d.kind ? "selected" : ""}>${t}</option>`).join("")}</select></td>
          <td><input data-k="capacityTB" type="number" step="0.5" min="0" value="${esc(d.capacityTB)}" style="width:60px" aria-label="Capacity TB"></td>
          <td><input data-k="serial" value="${esc(d.serial)}" aria-label="Serial number"></td>
          <td><input data-k="installDate" type="date" value="${esc(d.installDate)}" aria-label="Install date"></td>
          <td><select data-k="status" aria-label="Status">${Object.entries(DRIVE_STATUS).map(([k, l]) => `<option value="${k}" ${k === (d.status || "ok") ? "selected" : ""}>${l}</option>`).join("")}</select></td>
          <td><button type="button" class="rm" data-rm="${i}" title="Remove drive" aria-label="Remove drive">×</button></td>
        </tr>`).join("")}</tbody></table>` : `<p class="help">No drives recorded. Set the number of drive bays above, then use "Fill empty bays" or "+ Add drive".</p>`}
        <p class="help">Age is worked out from the install date: ${AGE_AGEING}+ years shows as Ageing, ${AGE_OLD}+ years as Replace soon.</p>`;
    }
    function nextFreeBay() {
      const used = new Set(drives.map((d) => +d.bay));
      let b = 1; while (used.has(b)) b++;
      return b;
    }
    // New drives copy make/model/type from the previous one to save typing
    function newDrive(bay) {
      const last = drives[drives.length - 1] || {};
      return { bay, make: last.make || "", model: last.model || "", kind: last.kind || (typeSel.value === "nvr" ? "HDD (Surveillance)" : "HDD (NAS)"), capacityTB: last.capacityTB ?? "", serial: "", installDate: new Date().toISOString().slice(0, 10), status: "ok" };
    }
    editor.addEventListener("click", (e) => {
      if (e.target.id === "add-drive") { readDrives(); drives.push(newDrive(nextFreeBay())); drawDrives(); $$("tr[data-i] [data-k=serial]", editor).pop()?.focus(); }
      if (e.target.id === "fill-bays") {
        readDrives();
        const n = parseInt(baysInput.value, 10) || 0;
        if (!n) { $("#form-error").textContent = "Set the number of drive bays first."; baysInput.focus(); return; }
        const used = new Set(drives.map((d) => +d.bay));
        for (let b = 1; b <= n; b++) if (!used.has(b)) drives.push(newDrive(b));
        drawDrives();
      }
      if (e.target.dataset.rm != null) { readDrives(); drives.splice(+e.target.dataset.rm, 1); drawDrives(); }
    });
    typeSel.addEventListener("change", () => { readDrives(); drawDrives(); });
    drawDrives();
  }

  // ---------- UniFi ----------
  // serve.rb fetches from the UniFi console and keeps a snapshot; the app reads it to show ports
  // and links, and the sync screen copies names / IPs / MACs / serials onto rack devices.
  const unifi = { snapshot: null, byMac: {} };
  const normMac = (m) => String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  const prettyMac = (m) => normMac(m).replace(/(..)(?!$)/g, "$1:");
  function setSnapshot(snap) {
    unifi.snapshot = snap;
    unifi.byMac = {};
    (snap?.devices || []).forEach((u) => { unifi.byMac[normMac(u.mac)] = u; });
  }
  async function loadUnifi() {
    if (!shared.on) return;
    try {
      const res = await fetch("api/unifi/snapshot", { cache: "no-store" });
      if (res.ok && res.status !== 204) setSnapshot(await res.json());
    } catch (e) { /* no snapshot yet */ }
  }
  const unifiFor = (d) => unifi.byMac[normMac(d.unifiMac || d.mac)];
  function rackDeviceByMac(mac) {
    const m = normMac(mac);
    if (!m) return null;
    for (const r of data.racks) for (const d of r.devices) if (normMac(d.mac) === m || normMac(d.unifiMac) === m) return [r, d];
    return null;
  }
  // What's on the other end of a port link: a rack device's name if we have it, else what UniFi calls it
  // Best name for whatever is on a port: the rack device, the name or hostname UniFi has, the UniFi
  // device's own name, then the maker ("Hikvision device"); the MAC only when there's nothing else
  function linkName(l, port) {
    const hit = rackDeviceByMac(l.mac);
    return hit ? devName(hit[1]) : l.name || unifi.byMac[normMac(l.mac)]?.name || fromPortName(l, port)
      || (l.vendor ? `${l.vendor} device` : prettyMac(l.mac));
  }
  // A switch that sends no name (e.g. the Dell VRTX's built-in switch) is often described by the port it's on:
  // "To Dell VRTX Chassis" → "Dell VRTX Chassis (port name)". Only for a neighbour switch, or the only thing on the port.
  function fromPortName(l, port) {
    const n = String(port?.name || "").trim();
    if (!n || /^(port|sfp\+?|sfp28|qsfp\+?)\s*\d+$/i.test(n)) return "";
    if (l.kind === "client" && (port.links || []).length > 1) return "";
    return `${n.replace(/^to\s+/i, "")} (port name)`;
  }
  // The port number at the far end of a switch-to-switch link (clients have none)
  const linkPort = (l) => (l.kind === "client" ? null : parseInt(String(l.port ?? "").replace(/\D/g, ""), 10) || null);

  // What is connected to a port right now. UniFi keeps a record of the last device it saw on each port ("seen");
  // that only counts as connected while UniFi says the connection is current (port up with a connect time).
  // Otherwise it's history (a down port, or an old record on an up port), so no linked marker, arrow or glow.
  const seenIsCurrent = (p) => !!(p.up && p.connectedAt);
  const liveLinks = (p) => (p.links || []).filter((l) => l.kind !== "seen" || seenIsCurrent(p));

  // Port colours on the rack face: idx → { cls, title }, or null when UniFi doesn't know this device
  function portStateFor(d) {
    const u = unifiFor(d);
    if (!u?.ports?.length) return null;
    const picked = d.id === ui.deviceId ? ui.portIdx : null;
    return (idx) => {
      const p = u.ports.find((x) => x.idx === idx);
      if (!p) return null;
      const what = liveLinks(p).map((l) => linkName(l, p)).join(", ");
      return {
        cls: [p.up ? "up" : "down", p.up && p.poe?.enabled ? "poe" : "", liveLinks(p).length ? "linked" : "", idx === picked ? "picked" : ""].filter(Boolean).join(" "),
        title: esc(`Port ${idx}${p.name ? " · " + p.name : ""} · ${p.up ? "up" : "down"}${p.up && p.connectedAt ? " · " + portUptime(p, u).replace(/ \(since.*/, "").replace("Connected for", "connected") : ""}${what ? " → " + what : ""}`)
      };
    };
  }

  // Select a port (in the rack or the Ports panel) and make whatever's on the other end glow
  function pickPort(devId, idx) {
    ui.deviceId = devId;
    ui.portIdx = idx;
    renderRack();
    renderDetails();
    syncHash();
    const port = unifiFor(findDevice(currentRack(), devId))?.ports.find((p) => p.idx === idx);
    (port ? liveLinks(port) : []).forEach((l) => {
      const hit = rackDeviceByMac(l.mac);
      if (hit && hit[0].id === ui.rackId) pulseDevice(hit[1].id, linkPort(l));
    });
  }

  // UniFi's internal model codes → the product names on the box
  const UNIFI_MODELS = {
    USAGGPRO: "USW-Pro-Aggregation", USL8A: "USW-Aggregation", USL24PB: "USW-24-PoE", USL24: "USW-24", USL48PB: "USW-48-PoE", USL48: "USW-48",
    USL16PB: "USW-16-PoE", USL16LP: "USW-Lite-16-PoE", USL8LP: "USW-Lite-8-PoE", US24PRO: "USW-Pro-24-PoE", US24PRO2: "USW-Pro-24",
    US48PRO: "USW-Pro-48-PoE", US48PRO2: "USW-Pro-48", US48P500: "US-48-500W", US48P750: "US-48-750W", US48: "US-48", US24P250: "US-24-250W",
    US24P500: "US-24-500W", US24: "US-24", US16P150: "US-16-150W", US8P60: "US-8-60W", US8P150: "US-8-150W", USF5P: "USW-Flex",
    UAP6MP: "U6-Pro", U7PG2: "UAP-AC-Pro", U7MSH: "UAP-AC-Mesh", U7IW: "UAP-IW-HD", U7PRO: "U7-Pro"
  };
  const friendlyModel = (code) => UNIFI_MODELS[code] || code || "";
  const flatModel = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // Access points, Flex switches and the like never live in a rack
  const isRackGear = (u) => !/^(U7|UAP|U6|UAL|USF|UK|UDB)/i.test(u.model || "");
  const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const COMMON = new Set(["rack", "ports", "port", "local", "the", "switch", "unifi", "usw", "xg", "8xg", "25xg"]);
  const roomCode = (name) => String(String(name || "").split(" - ")[1] || "").trim().toLowerCase();

  // Where a UniFi device probably sits: scores every rack device on what the two have in common.
  // UniFi names here follow "Building - Room - Description", e.g. "CIP - SP005 - Server Rack - 8XG - TOP".
  // roomHints: rack id → room codes (e.g. "sp005") of the strong matches already found in that rack
  function suggestFor(u, roomHints = new Map()) {
    const lc = (s) => String(s || "").trim().toLowerCase();
    const fm = flatModel(friendlyModel(u.model));
    const sfpOnly = (u.ports || []).length > 0 && u.ports.every((p) => /sfp/i.test(p.connector || ""));
    const nameWords = words(u.name);
    const building = words(String(u.name || "").split(" - ")[0])[0];
    const linkedRacks = new Set();
    (u.ports || []).forEach((p) => (p.links || []).forEach((l) => { const hit = rackDeviceByMac(l.mac); if (hit) linkedRacks.add(hit[0].id); }));
    const out = [];
    data.racks.forEach((r) => {
      const place = words(`${r.location} ${r.name}`);
      r.devices.forEach((d) => {
        if (normMac(d.unifiMac) && normMac(d.unifiMac) !== normMac(u.mac)) return; // already linked to something else
        if ((normMac(d.mac) && normMac(d.mac) === normMac(u.mac)) || (u.serial && lc(d.serial) === lc(u.serial)) || (u.ip && lc(d.ip) === lc(u.ip))) {
          return out.push({ r, d, score: 1000, why: ["same MAC, serial or IP"] });
        }
        if (!["switch", "nvr", "storage", "firewall"].includes(d.type)) return;
        if (d.make && !/ubiquiti|unifi/i.test(d.make)) return; // another brand (e.g. the Aruba) can't be a UniFi device
        let score = 0;
        const why = [];
        const dm = flatModel(d.model);
        const dAgg = /aggregation/i.test(d.model || "");
        if (dm && fm && (dm === fm || dm.includes(fm) || fm.includes(dm))) { score += 45; why.push("same model"); }
        else if (d.type === "switch") {
          if (dAgg && sfpOnly) { score += 25; why.push("both SFP aggregation"); } else if (dAgg !== sfpOnly) score -= 25;
          if (d.ports && u.ports?.length && Math.abs(d.ports - u.ports.length) <= 4) { score += 15; why.push(`${u.ports.length} ports`); }
        } else score -= 30;
        if (building && place.includes(building)) { score += 25; why.push(`“${building.toUpperCase()}” matches ${r.location || r.name}`); }
        const hint = roomHints.get(r.id);
        const room = roomCode(u.name);
        if (hint && room) {
          if (hint.has(room)) { score += 12; why.push(`same room as other matches (${room.toUpperCase()})`); } else score -= 12;
        }
        const shared = nameWords.filter((w) => w !== building && !COMMON.has(w) && (place.includes(w) || words(d.name).includes(w)));
        if (shared.length) { score += Math.min(15, shared.length * 5); why.push(`“${shared.join(", ")}”`); }
        const peers = r.devices.filter((x) => x.type === d.type && flatModel(x.model) === dm).sort((a, b) => b.uStart - a.uStart);
        if (peers.length > 1) {
          if (nameWords.includes("top") && peers[0] === d) { score += 10; why.push("top of the pair"); }
          if (nameWords.includes("bottom") && peers[peers.length - 1] === d) { score += 10; why.push("bottom of the pair"); }
        }
        if (nameWords.includes("rear") && d.face === "rear") { score += 10; why.push("rear-mounted"); }
        if (linkedRacks.has(r.id)) { score += 15; why.push("cabled to gear in this rack"); }
        if (score >= 30) out.push({ r, d, score, why });
      });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, 3);
  }
  const confidence = (s) => (s >= 1000 ? "Exact" : s >= 80 ? "Strong" : s >= 55 ? "Likely" : "Possible");

  // What a sync would change on one device. The name always follows UniFi (a linked switch is called what UniFi
  // calls it); the other details only fill empty fields unless "overwrite" is ticked.
  function unifiChanges(d, u, overwrite) {
    const want = { name: u.name, model: friendlyModel(u.model), ip: u.ip, mac: prettyMac(u.mac), serial: u.serial, make: "Ubiquiti" };
    const out = [];
    Object.entries(want).forEach(([k, v]) => {
      if (!v) return;
      const cur = d[k] || "";
      if (k === "mac" ? normMac(cur) === normMac(v) : cur === v) return;
      if (cur && !overwrite && k !== "name") return;
      out.push([k, cur, v]);
    });
    return out;
  }

  async function unifiModal() {
    if (!shared.on) return toast("UniFi sync needs the app to be served by serve.rb.", "error");
    let info = {};
    try { info = await (await fetch("api/unifi", { cache: "no-store" })).json(); } catch (e) { /* shown below */ }
    const ready = info.configured && info.hasKey;
    const setup = `<div class="setup">
      <p>UniFi settings live in a file on the server, not in the app or GitHub:</p>
      <p><code>${esc(info.settingsFile || "unifi.json next to the rack data file")}</code></p>
      <ol>
        <li class="${info.configured ? "done" : ""}">UniFi address, e.g. <code>"url": "https://unifi.example.org:8443"</code>${info.configured ? ` <span class="pill ok">${esc(info.url)}</span>` : ""}</li>
        <li class="${info.hasKey ? "done" : ""}">Sign-in: either a <strong>read-only local UniFi account</strong> as <code>"username"</code> / <code>"password"</code>, or an API key from <strong>Settings → Control Plane → Integrations</strong> as <code>"apiKey"</code>${info.hasKey ? ' <span class="pill ok">Added</span>' : ""}</li>
        <li>Site name if it isn't <code>default</code>: <code>"site"</code></li>
      </ol>
      ${info.error ? `<p class="form-error">${esc(info.error)}</p>` : ""}
    </div>`;
    const form = openModal("Sync from UniFi", `
      ${ready ? "" : setup}
      <div id="unifi-results">${unifi.snapshot
        ? `<p class="help">Last fetched ${new Date(unifi.snapshot.fetchedAt).toLocaleString()} · ${unifi.snapshot.devices.length} UniFi devices</p>`
        : `<p class="help">Nothing fetched from UniFi yet.</p>`}</div>`,
      `<button type="button" class="btn left" id="unifi-fetch" ${ready && info.canSync ? "" : "disabled"}>Fetch from UniFi</button>
       <button type="button" class="btn" data-close>Close</button><button class="btn btn-primary" id="unifi-apply" disabled>Apply changes</button>`,
      (f) => applyUnifi(f));
    if (!info.canSync) $("#unifi-results", form).insertAdjacentHTML("afterbegin", `<p class="help">Only an owner can sync.</p>`);
    $("#unifi-fetch", form).addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Fetching…";
      try {
        const res = await fetch("api/unifi/sync", { method: "POST" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        setSnapshot(body);
        drawUnifiRows(form);
        toast(`Fetched ${body.devices.length} devices from UniFi`);
      } catch (err) {
        $("#form-error").textContent = err.message;
      }
      e.target.disabled = false; e.target.textContent = "Fetch again";
    });
    if (unifi.snapshot) drawUnifiRows(form);
  }

  function drawUnifiRows(form, showAll = false, query = "") {
    // Suggestions for every UniFi device, then hand out the best ones so no rack device is picked twice
    // First pass finds the obvious ones; the rooms they're in then sharpen the second pass
    const roomHints = new Map();
    unifi.snapshot.devices.filter(isRackGear).forEach((u) => {
      const top = suggestFor(u)[0];
      if (top && top.score >= 80 && roomCode(u.name)) {
        if (!roomHints.has(top.r.id)) roomHints.set(top.r.id, new Set());
        roomHints.get(top.r.id).add(roomCode(u.name));
      }
    });
    const list = unifi.snapshot.devices.map((u, i) => ({ u, i, sugg: isRackGear(u) ? suggestFor(u, roomHints) : [] }));
    const pairs = list.flatMap((row) => row.sugg.map((s) => ({ row, s }))).sort((a, b) => b.s.score - a.s.score);
    const usedDev = new Set();
    pairs.forEach(({ row, s }) => {
      if (row.pick || usedDev.has(s.d.id) || s.score < 55) return;
      row.pick = s; usedDev.add(s.d.id);
    });
    const shown = list.filter((row) => showAll || (isRackGear(row.u) && row.u.ports?.length))
      .sort((a, b) => (b.pick?.score || b.sugg[0]?.score || 0) - (a.pick?.score || a.sugg[0]?.score || 0) || String(a.u.name).localeCompare(String(b.u.name)));
    const hidden = list.length - shown.length;

    const options = (row) => {
      const sel = row.pick?.d.id;
      const sugg = row.sugg.length ? `<optgroup label="Suggested">${row.sugg.map((s) =>
        `<option value="${esc(s.d.id)}" ${s.d.id === sel ? "selected" : ""}>★ ${esc(s.r.name)} · U${s.d.uStart} · ${esc(devName(s.d))} (${confidence(s.score)})</option>`).join("")}</optgroup>` : "";
      return `<option value="">— Not in a rack —</option>${sugg}` + data.racks.map((r) =>
        `<optgroup label="${esc(r.name)}">${r.devices.map((d) => `<option value="${esc(d.id)}" ${!row.sugg.some((s) => s.d.id === d.id) && d.id === sel ? "selected" : ""}>U${d.uStart} · ${esc(devName(d))}</option>`).join("")}</optgroup>`).join("");
    };
    const rows = shown.map((row) => {
      const { u, i } = row;
      const best = row.pick || row.sugg[0];
      return `<tr data-i="${i}">
        <td><input type="checkbox" class="u-apply" ${row.pick?.score >= 1000 ? "checked" : ""} aria-label="Apply"></td>
        <td><strong>${esc(u.name || "Unnamed")}</strong><small>${esc(friendlyModel(u.model))} · ${esc(u.ip || "no IP")}<br>${esc(prettyMac(u.mac))}${u.ports?.length ? ` · ${u.ports.length} ports` : ""}</small></td>
        <td><select class="u-target">${options(row)}</select>
          ${best ? `<small class="u-why"><span class="pill ${best.score >= 80 ? "ok" : best.score >= 55 ? "ageing" : "empty"}">${confidence(best.score)}</span> <b>${esc(best.r.name)} · U${best.d.uStart}</b> · ${esc(best.why.join(" · "))}</small>` : `<small class="u-why">No likely spot in your racks</small>`}</td>
        <td class="u-changes"></td>
      </tr>`;
    }).join("");
    const suggested = shown.filter((row) => row.pick).length;
    $("#unifi-results", form).innerHTML = `
      <p class="help">Fetched ${new Date(unifi.snapshot.fetchedAt).toLocaleString()} from site “${esc(unifi.snapshot.site || "")}”${unifi.snapshot.source === "integration" ? " · port links need UniFi's older API, which this console didn't allow" : ""}.</p>
      <p class="help"><strong>${suggested} suggested match${suggested === 1 ? "" : "es"}</strong>, best first. Suggestions use the model, the building/room in the UniFi name, top/bottom and rear hints, and what each device is cabled to. Check each one, tick it, then apply.</p>
      <div class="u-bar">
        <input type="search" id="u-search" class="u-search" placeholder="Search UniFi devices: name, model, IP, MAC, rack…" value="${esc(query)}" aria-label="Search UniFi devices">
        <label class="u-overwrite"><input type="checkbox" id="u-overwrite"> Also overwrite existing model, IP and serial (names always follow UniFi; otherwise only empty fields are filled)</label>
        <button type="button" class="btn-link" id="u-show-all">${showAll ? "Hide access points and other non-rack gear" : `Show all ${list.length} (incl. ${hidden} access points and other non-rack gear)`}</button>
      </div>
      <table class="drive-table u-table"><thead><tr><th></th><th>In UniFi</th><th>Rack device</th><th>Will change</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="help u-none" hidden>No UniFi devices match that search${showAll ? "" : " (access points are hidden; show all to include them)"}.</p>`;
    $("#u-show-all", form).addEventListener("click", () => drawUnifiRows(form, !showAll, $("#u-search", form).value));
    // Filter the list as you type (ticked rows stay ticked even while hidden)
    const search = $("#u-search", form);
    const filter = () => {
      const q = search.value.trim().toLowerCase().replace(/\s+/g, " ");
      let shownRows = 0;
      $$("tr[data-i]", form).forEach((tr) => {
        const u = unifi.snapshot.devices[+tr.dataset.i];
        const hay = [u.name, u.model, friendlyModel(u.model), u.ip, u.mac, prettyMac(u.mac), u.serial, tr.querySelector(".u-why")?.textContent].join(" | ").toLowerCase().replace(/\s+/g, " ");
        const hit = !q || hay.includes(q);
        tr.hidden = !hit;
        if (hit) shownRows++;
      });
      $(".u-none", form).hidden = shownRows > 0;
    };
    search.addEventListener("input", filter);
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    filter();
    if (query) search.focus();
    const refresh = () => {
      const over = $("#u-overwrite", form).checked;
      let n = 0;
      $$("tr[data-i]", form).forEach((tr) => {
        const u = unifi.snapshot.devices[+tr.dataset.i];
        const d = findAny($(".u-target", tr).value);
        const ch = d ? unifiChanges(d, u, over) : [];
        const link = d && normMac(d.unifiMac) !== normMac(u.mac);
        $(".u-changes", tr).innerHTML = !d ? `<span class="help">Not linked</span>`
          : ch.length || link ? ch.map(([k, a, b]) => `<div><b>${k}</b> ${esc(a || "—")} → ${esc(b)}</div>`).join("") + (link ? `<div class="help">Link to UniFi for ports</div>` : "")
          : `<span class="help">Up to date</span>`;
        if (d && $(".u-apply", tr).checked && (ch.length || link)) n++;
      });
      const btn = $("#unifi-apply", form);
      btn.disabled = !n; btn.textContent = n ? `Apply changes to ${n} device${n === 1 ? "" : "s"}` : "Apply changes";
    };
    $("#unifi-results", form).addEventListener("change", refresh);
    refresh();
  }
  const findAny = (id) => { for (const r of data.racks) { const d = r.devices.find((x) => x.id === id); if (d) return d; } return null; };

  function applyUnifi(form) {
    if (!unifi.snapshot) return "Fetch from UniFi first.";
    const over = $("#u-overwrite", form)?.checked;
    let n = 0;
    $$("tr[data-i]", form).forEach((tr) => {
      if (!$(".u-apply", tr).checked) return;
      const d = findAny($(".u-target", tr).value);
      if (!d) return;
      const u = unifi.snapshot.devices[+tr.dataset.i];
      unifiChanges(d, u, over).forEach(([k, , v]) => { d[k] = v; });
      d.unifiMac = prettyMac(u.mac);
      n++;
    });
    if (!n) return "Tick at least one device that's linked to a rack device.";
    save(); renderAll(); toast(`Updated ${n} device${n === 1 ? "" : "s"} from UniFi`);
  }

  // Ports panel (in device details) for devices linked to UniFi
  function portsPanel(d, pickedIdx) {
    const u = unifiFor(d);
    if (!u || !u.ports?.length) return "";
    const ports = u.ports.slice().sort((a, b) => a.idx - b.idx);
    const cell = (p) => `<button class="pt-cell ${p.up ? "up" : "down"}${p.poe?.enabled ? " poe" : ""}${p.idx === pickedIdx ? " picked" : ""}${liveLinks(p).length ? " linked" : ""}"
      data-port-pick="${p.idx}" title="Port ${p.idx}${p.name ? " · " + esc(p.name) : ""}${p.up ? " · up" : " · down"}">${p.idx}</button>`;
    const picked = ports.find((p) => p.idx === pickedIdx);
    let detail = `<p class="help">Click a port to see what it's connected to.</p>`;
    if (picked) {
      const speed = picked.speedMbps ? (picked.speedMbps >= 1000 ? picked.speedMbps / 1000 + " Gbps" : picked.speedMbps + " Mbps") : "";
      const links = (picked.links || []).map((l) => {
        const hit = rackDeviceByMac(l.mac);
        const other = unifi.byMac[normMac(l.mac)];
        return `<div class="pt-link">
          <span><strong>${esc(linkName(l, picked))}</strong><small>${esc([l.ip || other?.ip, l.port && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(l.port) ? "port " + l.port : "", l.kind === "client" ? "client" : l.kind === "seen" ? (seenIsCurrent(picked) ? "on this port now" : `last seen here ${picked.lastSeen ? whenText(picked.lastSeen) + " (" + duration(Date.now() - new Date(picked.lastSeen)) + " ago)" : "a while ago"}`) : other ? "UniFi" : "neighbour", linkName(l, picked) !== prettyMac(l.mac) ? prettyMac(l.mac) : ""].filter(Boolean).join(" · "))}</small></span>
          <span class="pt-actions">${shared.on && shared.role !== "viewer" && (l.ip || other?.ip) ? `<button class="btn btn-small" data-ping="${esc(l.ip || other?.ip)}">Ping</button>` : ""}
          ${hit ? `<button class="btn btn-small" data-pulse-rack="${esc(hit[0].id)}" data-pulse-dev="${esc(hit[1].id)}" data-pulse-port="${linkPort(l) || ""}">${hit[0].id === ui.rackId ? "Show" : "Go to " + esc(hit[0].name)}</button>` : ""}</span>
          <span class="ping-result" aria-live="polite"></span>
        </div>`;
      }).join("");
      detail = `<div class="pt-detail">
        <div class="pt-head"><strong>Port ${picked.idx}${picked.name ? " · " + esc(picked.name) : ""}</strong>
          <span class="pill ${picked.up ? "ok" : "empty"}">${picked.up ? "Up" : "Down"}</span></div>
        <p class="help">${[speed, picked.connector, picked.poe?.enabled ? `PoE${picked.poe.watts ? " " + picked.poe.watts + " W" : " on"}` : ""].filter(Boolean).join(" · ") || "No details"}</p>
        ${portUptime(picked, u) ? `<p class="pt-uptime">${esc(portUptime(picked, u))}</p>` : ""}
        ${picked.up && !liveLinks(picked).length ? `<p class="help">The link is up, but UniFi doesn't list anything on this port right now.${links ? " The last device it saw here:" : ""}</p>` : ""}
        ${links || (picked.up ? "" : `<p class="help">Nothing on this port.</p>`)}
      </div>`;
    }
    const others = u.clients?.length ? `<p class="help">${u.clients.length} wired client${u.clients.length === 1 ? "" : "s"} on this device (port not reported).</p>` : "";
    return `<h3>Ports <span class="h3-note">from UniFi · ${new Date(unifi.snapshot.fetchedAt).toLocaleDateString()}</span></h3>
      <div class="pt-grid">${ports.map(cell).join("")}</div>${detail}${others}`;
  }

  // Ask the server to ping one client on a port, and show the answer next to it
  async function pingClient(btn) {
    const out = btn.closest(".pt-link")?.querySelector(".ping-result");
    btn.disabled = true; btn.textContent = "Pinging…";
    if (out) { out.className = "ping-result"; out.textContent = ""; }
    try {
      const res = await fetch("api/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: btn.dataset.ping }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || res.statusText);
      if (out) {
        out.className = "ping-result " + (r.up ? "ok" : "bad");
        out.textContent = r.up ? `Replied${r.ms != null ? " · " + r.ms + " ms" : ""}` : "No reply: it may be off, blocking ping, or on a network the server can't reach";
      }
    } catch (e) {
      if (out) { out.className = "ping-result bad"; out.textContent = e.message; }
    }
    btn.disabled = false; btn.textContent = "Ping again";
  }

  // Make a device (and optionally one of its ports) glow so you can spot it in the rack
  function pulseDevice(id, port) {
    const glow = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 2600); };
    $$(`[data-device="${id}"]`).forEach((el) => glow(el, "pulse"));
    if (port) $$(`[data-device="${id}"] [data-port="${port}"]`).forEach((el) => glow(el, "port-pulse"));
    $(`[data-device="${id}"]`)?.scrollIntoView({ block: "center", behavior: smooth() });
  }

  // Copy a serial etc. The clipboard API needs a secure page, which http://<host-ip> isn't, so fall back to the old way
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove();
      if (!ok) return toast("Couldn't copy. Select the text and press Ctrl+C.", "error");
    }
    toast(`Copied ${text}`);
  }

  // ---------- Import / export ----------
  const today = () => new Date().toISOString().slice(0, 10);
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportJson() {
    download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `wcc-racks-${today()}.json`);
    toast("Exported all racks to a JSON file");
  }
  const tally = (d) => {
    const devices = d.racks.reduce((s, r) => s + r.devices.length, 0);
    const drives = d.racks.reduce((s, r) => s + r.devices.reduce((t, dev) => t + (dev.drives?.length || 0), 0), 0);
    return `${d.racks.length} rack${d.racks.length === 1 ? "" : "s"} · ${devices} device${devices === 1 ? "" : "s"} · ${drives} drive${drives === 1 ? "" : "s"}`;
  };
  // Import always REPLACES (never merges), so records can't be duplicated. It checks the file first, says what will
  // change, offers to download a backup of what's here, and fixes any repeated ids so selection and links work.
  function importJson(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.racks)) throw new Error("it isn't a Rack View export (no list of racks).");
        if (parsed.racks.some((r) => !r || typeof r !== "object" || (r.devices != null && !Array.isArray(r.devices)))) throw new Error("some racks in it are damaged.");
        normalise(parsed);
      } catch (e) {
        return toast(`"${file.name}" couldn't be imported: ${e.message}`, "error");
      }
      // repeated ids (e.g. a hand-edited file) would make two devices select as one
      const seen = new Set();
      let fixed = 0;
      parsed.racks.forEach((r) => {
        if (seen.has(r.id)) { r.id = uid(); fixed++; } seen.add(r.id);
        r.devices.forEach((d) => { if (seen.has(d.id)) { d.id = uid(); fixed++; } seen.add(d.id); });
      });
      if (JSON.stringify(parsed) === JSON.stringify(data)) return toast("That file matches what's already loaded. Nothing changed.");
      const hasReal = data.racks.length && data.sample !== true;
      const detail = `<dl class="import-sum">
          <dt>In the file</dt><dd>${esc(tally(parsed))}${parsed.sample === true ? " (sample data)" : ""}</dd>
          <dt>Here now</dt><dd>${data.racks.length ? esc(tally(data)) + (data.sample === true ? " (sample data)" : "") : "Nothing yet"}</dd></dl>
        ${fixed ? `<p class="help">${fixed} repeated id${fixed === 1 ? "" : "s"} in the file will be given new ones.</p>` : ""}
        ${hasReal ? `<label class="check"><input type="checkbox" id="import-backup" checked> Download a backup of the current data first</label>` : ""}`;
      const yes = await ask({ title: "Replace the current data?", confirmLabel: "Replace data", danger: !!hasReal, detail,
        message: `Import replaces everything ${shared.on ? "in the shared file" : "in this browser"} with the contents of "${file.name}". It doesn't merge, so nothing is duplicated.` });
      if (!yes) return;
      if (hasReal && $("#import-backup")?.checked) exportJson();
      data = parsed;
      ui.rackId = data.racks[0]?.id || null; ui.deviceId = null;
      save(); renderAll();
      toast(`Imported ${tally(data)}`);
    };
    reader.onerror = () => toast(`"${file.name}" couldn't be read.`, "error");
    reader.readAsText(file);
  }

  // ---------- Features & Bugs ----------
  // Feature requests and bug reports, kept by serve.rb in features-bugs.json (photos in feature-photos/).
  // Anyone who can log one can add a note; only an owner signs them off.
  const FB_PAGES = ["Dashboard", "Racks", "Drive report", "Search", "UniFi sync", "Import / Export", "Features & Bugs", "Other"];
  const FB_TYPES = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP", "image/gif": "GIF" };
  const FB_MAX_PHOTOS = 4;
  const FB_MAX_BYTES = 4 * 1024 * 1024;
  const fb = { items: [], loaded: false, error: "", filter: "all", form: false, openId: null, photos: [], name: loadPref("fb-name", "") };
  const canLog = () => shared.on && shared.role !== "viewer";
  const canSignOff = () => shared.on && shared.role === "owner";
  const fbWhen = (iso) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
  const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const fbHead = (sub) => `<div class="page-title"><div><p class="eyebrow">Admin</p><h1>Features &amp; Bugs</h1><div class="meta"><span>${sub}</span></div></div></div>`;
  const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

  async function loadFeedback() {
    try {
      const res = await fetch("api/feedback", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      fb.items = body.items || []; fb.error = "";
    } catch (e) { fb.error = e.message; }
    fb.loaded = true;
  }
  function renderFeedback() {
    const host = $("#view-feedback");
    if (!shared.on) {
      host.innerHTML = fbHead("Logged features and bug reports.") + `<div class="card"><p class="empty-state">Features &amp; Bugs is kept on the host computer. Open the app from the address <code>ruby serve.rb</code> shows to see and log them.</p></div>`;
      return;
    }
    if (fb.form && canLog()) return renderFeedbackForm();
    fb.form = false;
    host.innerHTML = fbHead("Logged features and bug reports.") + `
      <div class="fb-bar">
        ${canLog() ? `<button class="btn btn-primary" data-fb="new">New</button>` : ""}
        <div class="fb-filters" role="group" aria-label="Show">
          ${[["all", "All"], ["feature", "Features"], ["bug", "Bugs"]].map(([v, l]) => `<label><input type="checkbox" data-fb-filter="${v}" ${fb.filter === v ? "checked" : ""}> ${l}</label>`).join("")}
        </div>
      </div>
      <div id="fb-list">${fb.loaded ? "" : `<p class="loading" role="status">Loading…</p>`}</div>`;
    if (fb.loaded) updateFeedback();
    loadFeedback().then(() => { if (ui.view === "feedback" && !fb.form) updateFeedback(); });
  }
  function fbMenu(it) {
    const signed = it.status === "signed-off";
    const items = [];
    if (canSignOff() && !signed) items.push(["signoff", "Sign off…"]);
    if (canLog()) items.push(["note", "Add a note…"]);
    if (canSignOff() && signed) items.push(["reopen", "Reopen"]);
    if (!items.length) return "";
    return `<details class="fb-menu"><summary>${!signed && canSignOff() ? "Sign off" : "Note"}${CHEVRON}</summary>
      <div class="fb-menu-pop" role="menu">${items.map(([a, l]) => `<button type="button" role="menuitem" data-fb-act="${a}" data-id="${esc(it.id)}">${l}</button>`).join("")}</div></details>`;
  }
  function fbDetail(it) {
    const notes = it.notes || [];
    return `<div class="fb-detail-body">
      <p class="fb-desc">${esc(it.description)}</p>
      ${it.photos?.length ? `<div class="fb-photos">${it.photos.map((p, n) => `<a href="api/feedback/photos/${encodeURIComponent(p)}" target="_blank" rel="noopener"><img src="api/feedback/photos/${encodeURIComponent(p)}" alt="Photo ${n + 1} for ${esc(it.title)}" loading="lazy"></a>`).join("")}</div>` : ""}
      ${notes.length ? `<ul class="fb-notes">${notes.map((n) => `<li><span class="fb-note-meta"><strong>${esc(n.by)}</strong> · ${fbWhen(n.at)}</span>${esc(n.text)}</li>`).join("")}</ul>` : ""}
      ${it.status === "signed-off" ? `<p class="help">Signed off by ${esc(it.signedOffBy || "the host")} on ${fbWhen(it.signedOffAt)}</p>` : ""}
    </div>`;
  }
  function updateFeedback() {
    const box = $("#fb-list");
    if (!box) return;
    const list = fb.items.filter((it) => fb.filter === "all" || it.type === fb.filter);
    const kind = { all: "requests", feature: "feature requests", bug: "bug reports" }[fb.filter];
    if (fb.error) box.innerHTML = `<div class="banner warn">Couldn't load the list: ${esc(fb.error)}</div>`;
    else if (!fb.items.length) box.innerHTML = `<div class="card"><p class="empty-state">Nothing logged yet.${canLog() ? " Use <strong>New</strong> to log a feature request or a bug." : ""}</p></div>`;
    else box.innerHTML = `
      <div class="table-wrap"><table class="grid fb-table">
        <thead><tr><th scope="col">Type</th><th scope="col">Request</th><th scope="col">Logged by</th><th scope="col">When</th><th scope="col">Page</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${list.map((it) => {
          const open = fb.openId === it.id, signed = it.status === "signed-off";
          return `<tr class="${open ? "open" : ""}">
            <td data-label="Type"><span class="pill fb-${it.type === "bug" ? "bug" : "feature"}">${it.type === "bug" ? "Bug" : "Feature"}</span></td>
            <td data-label="Request"><button class="fb-title" data-fb-toggle="${esc(it.id)}" aria-expanded="${open}">${esc(it.title)}${it.photos?.length ? ` <span class="fb-count-tag" title="${it.photos.length} photo${it.photos.length === 1 ? "" : "s"}">📷 ${it.photos.length}</span>` : ""}${it.notes?.length ? ` <span class="fb-count-tag" title="${it.notes.length} note${it.notes.length === 1 ? "" : "s"}">✎ ${it.notes.length}</span>` : ""}</button></td>
            <td data-label="Logged by"><span class="fb-who"><span class="fb-avatar" aria-hidden="true">${esc(initials(it.loggedBy))}</span>${esc(it.loggedBy)}</span></td>
            <td data-label="When" class="nowrap">${fbWhen(it.createdAt)}</td>
            <td data-label="Page">${esc(it.page)}</td>
            <td data-label="Status"><span class="pill ${signed ? "ok" : "empty"}">${signed ? "Signed off" : "Open"}</span></td>
            <td class="fb-actions">${fbMenu(it)}</td>
          </tr>${open ? `<tr class="fb-detail"><td colspan="7">${fbDetail(it)}</td></tr>` : ""}`;
        }).join("") || `<tr><td colspan="7" class="no-results">No ${kind} logged.</td></tr>`}</tbody>
      </table></div>
      <p class="fb-total" aria-live="polite">${list.length} ${list.length === 1 ? kind.replace(/s$/, "") : kind}</p>`;
  }

  function renderFeedbackForm() {
    $("#view-feedback").innerHTML = fbHead("Log a feature request or a bug report.") + `
      <form class="card fb-form" id="fb-form" novalidate>
        <div class="fb-form-head"><h2>New request</h2></div>
        <div class="fb-form-body">
          <fieldset class="fb-type">
            <legend class="fb-label">Type <span class="req" aria-hidden="true">*</span></legend>
            <label class="fb-radio"><input type="radio" name="type" value="feature" checked> Feature request</label>
            <label class="fb-radio"><input type="radio" name="type" value="bug"> Bug report</label>
          </fieldset>
          ${field("title", `Title <span class="req" aria-hidden="true">*</span>`, "", { attrs: 'required maxlength="200" autocomplete="off"' })}
          ${field("description", `Description <span class="req" aria-hidden="true">*</span>`, "", { type: "textarea", attrs: 'required maxlength="5000" rows="6"' })}
          ${field("page", `Page <span class="req" aria-hidden="true">*</span>`, "", { options: [["", "Choose a page"], ...FB_PAGES.map((p) => [p, p])], attrs: "required" })}
          ${field("loggedBy", `Your name <span class="req" aria-hidden="true">*</span>`, fb.name, { attrs: 'required maxlength="80" autocomplete="name"' })}
          <div class="field">
            <span class="fb-label" id="fb-photos-label">Photos</span>
            <div class="fb-drop" id="fb-drop" tabindex="0" role="button" aria-labelledby="fb-photos-label fb-drop-text" aria-describedby="fb-drop-help">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>
              <strong id="fb-drop-text">Drop photos here or browse</strong>
              <small id="fb-drop-help">Paste a screenshot. Up to ${FB_MAX_PHOTOS} photos, 4 MB each. JPEG, PNG, WebP, or GIF.</small>
              <input type="file" id="fb-file" accept="${Object.keys(FB_TYPES).join(",")}" multiple hidden>
            </div>
            <ul class="fb-thumbs" id="fb-thumbs"></ul>
          </div>
          <div class="form-error" id="fb-error" role="alert"></div>
        </div>
        <div class="fb-form-foot"><button class="btn btn-primary" type="submit">Log request</button><button class="btn" type="button" data-fb="cancel">Cancel</button></div>
      </form>`;
    drawThumbs();
    $("#f-title").focus();
  }
  function drawThumbs() {
    const ul = $("#fb-thumbs");
    if (!ul) return;
    ul.innerHTML = fb.photos.map((p, n) => `<li><img src="${p.url}" alt="${esc(p.file.name || "Pasted screenshot")}"><button type="button" data-fb-rm="${n}" aria-label="Remove photo ${n + 1}">×</button></li>`).join("");
    $("#fb-drop").hidden = fb.photos.length >= FB_MAX_PHOTOS;
  }
  // Checked here for a quick answer; serve.rb checks again by the file's actual contents
  function addPhotos(files) {
    const err = $("#fb-error");
    const problems = [];
    [...files].forEach((file) => {
      if (!FB_TYPES[file.type]) return problems.push(`${file.name || "That file"} isn't a JPEG, PNG, WebP or GIF.`);
      if (file.size > FB_MAX_BYTES) return problems.push(`${file.name || "That photo"} is over 4 MB.`);
      if (fb.photos.length >= FB_MAX_PHOTOS) return problems.push(`Up to ${FB_MAX_PHOTOS} photos.`);
      fb.photos.push({ file, url: URL.createObjectURL(file) });
    });
    err.textContent = [...new Set(problems)].join(" ");
    drawThumbs();
  }
  function clearPhotos() {
    fb.photos.forEach((p) => URL.revokeObjectURL(p.url));
    fb.photos = [];
  }
  async function submitFeedback(form) {
    const f = Object.fromEntries(new FormData(form));
    const err = $("#fb-error");
    const missing = [["title", "a title"], ["description", "a description"], ["page", "the page it's about"], ["loggedBy", "your name"]].find(([k]) => !String(f[k] || "").trim());
    if (missing) { err.textContent = `Add ${missing[1]}.`; return $(`#f-${missing[0]}`).focus(); }
    const body = new FormData();
    ["type", "title", "description", "page", "loggedBy"].forEach((k) => body.append(k, String(f[k]).trim()));
    fb.photos.forEach((p) => body.append("photos", p.file, p.file.name || "screenshot.png"));
    const btn = $("button[type=submit]", form);
    btn.disabled = true; btn.textContent = "Logging…";
    try {
      const res = await fetch("api/feedback", { method: "POST", body });
      const item = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(item.error || res.statusText);
      fb.name = String(f.loggedBy).trim(); savePref("fb-name", fb.name);
      fb.items.unshift(item); fb.form = false; fb.filter = "all"; clearPhotos();
      showView("feedback");
      toast(item.type === "bug" ? "Bug report logged" : "Feature request logged");
    } catch (e) {
      err.textContent = "Couldn't log it: " + e.message;
      btn.disabled = false; btn.textContent = "Log request";
    }
  }

  // Sign off / add a note: a small form in the usual dialog, then the server does the rest
  function fbActionModal(id, action) {
    const it = fb.items.find((x) => x.id === id);
    if (!it) return;
    const signoff = action === "signoff";
    openModal(signoff ? `Sign off “${it.title}”` : `Add a note to “${it.title}”`, `
      ${field("fbNote", signoff ? "Note (optional)" : "Note *", "", { type: "textarea", attrs: 'maxlength="2000" rows="4"' })}
      ${fb.name ? "" : field("fbName", "Your name *", "", { attrs: 'maxlength="80" autocomplete="name"' })}`,
      `<button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">${signoff ? "Sign off" : "Add note"}</button>`,
      (form) => {
        const text = form.fbNote.value.trim(), name = form.fbName ? form.fbName.value.trim() : fb.name;
        if (!signoff && !text) return "Write a note first.";
        if (!name) return "Add your name.";
        if (name !== fb.name) { fb.name = name; savePref("fb-name", name); }
        fbAction(id, action, text);
      });
    $("#f-fbNote").focus();
  }
  async function fbAction(id, action, text = "") {
    try {
      const res = await fetch(`api/feedback/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, by: fb.name }) });
      const item = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(item.error || res.statusText);
      fb.items = fb.items.map((x) => (x.id === id ? item : x));
      updateFeedback();
      toast({ signoff: "Signed off", note: "Note added", reopen: "Reopened" }[action]);
    } catch (e) { toast("Couldn't save that: " + e.message, "error"); }
  }

  // ---------- Wiring ----------
  function renderAll(flashBay) {
    $("#sample-banner").hidden = data.sample !== true;
    renderSidebar();
    renderRack();
    renderDetails(flashBay);
    if (ui.view === "drives") renderReport();
    if (ui.view === "home") renderHome();
    syncHash();
  }

  function selectDevice(id, bay) {
    if (id !== ui.deviceId) ui.portIdx = null;
    const face = document.activeElement?.closest?.(".rack-col") && $$(".rack-col").indexOf(document.activeElement.closest(".rack-col"));
    ui.deviceId = id;
    renderRack();
    renderDetails(bay);
    syncHash();
    // keep keyboard focus on the device (the rack was redrawn), so arrow keys carry on from here
    if (face !== false && face != null) $(`[data-device="${id}"].device`, $$(".rack-col")[face])?.focus({ preventScroll: true });
  }
  function goTo(rackId, devId, bay) {
    ui.search = ""; $("#search").value = ""; // close the search results
    ui.rackId = rackId;
    ui.deviceId = devId;
    showView("racks");
    renderAll(bay ? +bay : undefined);
    $(`[data-device="${devId}"]`)?.scrollIntoView({ block: "center", behavior: smooth() });
  }
  function showView(v) {
    ui.view = v;
    $$(".tab").forEach((t) => { const on = t.dataset.view === v; t.classList.toggle("active", on); if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
    $("#view-home").hidden = v !== "home";
    $("#view-racks").hidden = v !== "racks";
    $("#view-drives").hidden = v !== "drives";
    $("#view-feedback").hidden = v !== "feedback";
    if (v === "drives") renderReport();
    if (v === "home") renderHome();
    if (v === "feedback") renderFeedback();
    renderSidebar();
    syncHash();
    $(".shell").scrollTop = 0;
  }

  // The address bar mirrors where you are (#/rack/<id>/<device>, #/drives, #/feedback), so links can be shared and a refresh keeps your place
  function syncHash() {
    const rack = currentRack();
    const hash = ui.view === "racks" && rack ? `#/rack/${rack.id}${ui.deviceId ? "/" + ui.deviceId : ""}` : ui.view === "drives" ? "#/drives"
      : ui.view === "feedback" ? (fb.form ? "#/feedback/new" : "#/feedback") : "#/";
    if (location.hash !== hash) history.replaceState(null, "", hash);
    const page = ui.view === "racks" && rack ? rack.name : ui.view === "drives" ? "Drive report" : ui.view === "feedback" ? "Features & Bugs" : "Dashboard";
    document.title = `${page} · Rack View`;
  }
  function route() {
    const [, kind, id, dev] = location.hash.match(/^#\/?([^/]*)\/?([^/]*)\/?([^/]*)/) || [];
    if (kind === "rack" && data.racks.some((r) => r.id === id)) {
      ui.view = "racks"; ui.rackId = id;
      ui.deviceId = findDevice(currentRack(), dev) ? dev : null;
    } else if (kind === "feedback") {
      ui.view = "feedback"; fb.form = id === "new";
    } else ui.view = kind === "drives" ? "drives" : "home";
  }

  // Small screens: the sidebar is a drawer behind the menu button
  function setNav(open) {
    document.body.classList.toggle("nav-open", open);
    const btn = $("#menu-btn");
    btn.setAttribute("aria-expanded", open);
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    $("#nav-scrim").hidden = !open;
    if (open) $("#sidenav .nav-item")?.focus();
  }
  $("#menu-btn").addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
  $("#nav-scrim").addEventListener("click", () => setNav(false));

  document.addEventListener("click", (e) => {
    const t = e.target;
    // picking somewhere to go in the drawer closes it (opening/closing a room doesn't)
    if (document.body.classList.contains("nav-open") && t.closest(".sidenav button:not([data-room])")) setNav(false);
    const tab = t.closest(".tab");
    if (tab) { if (tab.dataset.view === "feedback") fb.form = false; return showView(tab.dataset.view); }

    const roomBtn = t.closest("[data-room]");
    if (roomBtn) {
      const room = roomBtn.dataset.room;
      ui.collapsed = ui.collapsed.includes(room) ? ui.collapsed.filter((x) => x !== room) : [...ui.collapsed, room];
      savePref("collapsed", ui.collapsed); return renderSidebar();
    }

    const rackBtn = t.closest("[data-rack]");
    if (rackBtn) { ui.rackId = rackBtn.dataset.rack; ui.deviceId = null; showView("racks"); return renderAll(); }

    const portPick = t.closest("[data-port-pick]");
    if (portPick) return pickPort(ui.deviceId, +portPick.dataset.portPick);
    const pingBtn = t.closest("[data-ping]");
    if (pingBtn) return pingClient(pingBtn);

    const pulseBtn = t.closest("[data-pulse-dev]");
    if (pulseBtn) {
      const { pulseRack, pulseDev, pulsePort } = pulseBtn.dataset;
      if (pulseRack !== ui.rackId) { ui.rackId = pulseRack; ui.deviceId = null; showView("racks"); renderAll(); }
      return setTimeout(() => pulseDevice(pulseDev, +pulsePort || null), 60);
    }

    const pick = t.closest("[data-bay-pick]");
    if (pick) return renderDetails(+pick.dataset.bayPick);

    const copy = t.closest("[data-copy]");
    if (copy) return copyText(copy.dataset.copy);

    // KPI tiles and "view all" links open the drive report filtered to that status
    const rep = t.closest("[data-report]");
    if (rep) { Object.assign(ui, { reportFilter: rep.dataset.report, reportQuery: "", reportRack: "", reportDevice: "" }); return showView("drives"); }

    const viewLink = t.closest("[data-goto-view]");
    if (viewLink) return showView(viewLink.dataset.gotoView);

    const go = t.closest("[data-goto-dev]");
    if (go) return goTo(go.dataset.gotoRack, go.dataset.gotoDev, go.dataset.gotoBay);

    const lookBtn = t.closest("[data-look]");
    if (lookBtn) { ui.look = lookBtn.dataset.look; savePref("look-v2", ui.look); return renderRack(); }
    if (t.closest("[data-labels]")) { ui.labels = !ui.labels; savePref("labels", ui.labels); return renderRack(); }
    if (t.closest("[data-compact]")) { ui.compact = !ui.compact; savePref("compact", ui.compact); return renderRack(); }
    if (t.closest("[data-unfold]")) { ui.compact = false; savePref("compact", false); return renderRack(); }

    const faceBtn = t.closest(".segmented [data-face]");
    if (faceBtn) { ui.face = faceBtn.dataset.face; return renderRack(); }

    const bay = t.closest(".bay");
    const devEl = t.closest("[data-device]");
    const rackPort = devEl && t.closest("[data-port]");
    if (rackPort) return pickPort(devEl.dataset.device, +rackPort.dataset.port);
    if (devEl) return selectDevice(devEl.dataset.device, bay ? +bay.dataset.bay : undefined);

    const empty = t.closest("[data-empty-u]");
    if (empty && readOnly()) return;
    if (empty) return deviceModal(null, { uStart: +empty.dataset.emptyU, face: ui.face === "both" ? "both" : empty.dataset.face });

    const action = t.closest("[data-action]")?.dataset.action;
    const rack = currentRack();
    const dev = findDevice(rack, ui.deviceId);
    switch (action) {
      case "add-rack": case "edit-rack": case "add-device": case "edit-device": case "duplicate-device": case "delete-device": case "import": case "unifi":
        if (readOnly()) return toast(shared.sso ? "View only. Your account can't make changes." : "View only. Changes are made on the host computer.");
    }
    switch (action) {
      case "unifi": return unifiModal();
      case "check-now": toast("Checking…"); return fetchStatus(true);
      case "close-details": ui.deviceId = null; renderRack(); renderDetails(); return syncHash();
      case "add-rack": return rackModal(null);
      case "import": return $("#import-file").click();
      case "edit-rack": return rackModal(rack);
      case "add-device": return deviceModal(null);
      case "edit-device": return dev && deviceModal(dev);
      case "duplicate-device": {
        if (!dev) return;
        // find the nearest free slot above, then below
        let spot = null;
        for (let u = 1; u + dev.uHeight - 1 <= rack.units && !spot; u++) if (rangeFree(rack, u, dev.uHeight, dev.face)) spot = u;
        if (!spot) return toast("There's no free space in this rack for a copy.", "error");
        const copy = { ...structuredClone(dev), id: uid(), name: dev.name ? dev.name + " (copy)" : "", uStart: spot, serial: "", assetTag: "", ip: "", drives: [] };
        rack.devices.push(copy); ui.deviceId = copy.id; save(); renderAll();
        return deviceModal(copy);
      }
      case "delete-device":
        if (!dev) return;
        ask({ title: `Delete ${devName(dev)}?`, message: dev.drives?.length ? `This also removes its ${dev.drives.length} drive records.` : "This removes it from the rack.", confirmLabel: "Delete", danger: true })
          .then((yes) => { if (!yes) return; rack.devices = rack.devices.filter((d) => d !== dev); ui.deviceId = null; save(); renderAll(); toast("Device deleted"); });
        return;
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-device]")) { e.preventDefault(); e.target.click(); }
    // Up/Down arrows move between devices in the rack, top to bottom
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.target.matches(".device")) {
      const list = $$(".device", e.target.parentElement).sort((a, b) => parseInt(a.style.gridRowStart, 10) - parseInt(b.style.gridRowStart, 10));
      const next = list[list.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
    if (e.key === "Escape" && document.body.classList.contains("nav-open")) { setNav(false); $("#menu-btn").focus(); return; }
    if (e.key === "Escape" && !modal.open && ui.deviceId) { ui.deviceId = null; renderRack(); renderDetails(); syncHash(); }
    if (e.key === "Escape" && document.activeElement === $("#search")) { ui.search = ""; $("#search").value = ""; renderSidebar(); renderRack(); }
    if (e.key === "/" && !modal.open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { e.preventDefault(); $("#search").focus(); }
  });

  $("#search").addEventListener("input", (e) => { ui.search = e.target.value; renderSidebar(); renderRack(); });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSearch(e.key === "ArrowDown" ? 1 : -1); }
    if (e.key === "Enter") {
      const pick = $$("#search-results .result")[Math.max(0, ui.searchIdx)];
      if (pick) { e.preventDefault(); pick.click(); }
    }
  });
  $("#btn-add-rack").addEventListener("click", () => rackModal(null));
  $("#btn-export").addEventListener("click", exportJson);
  $("#btn-import").addEventListener("click", () => (readOnly() ? toast(shared.sso ? "View only. Your account can't make changes." : "View only. Changes are made on the host computer.") : $("#import-file").click()));
  $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; });
  const report = $("#drive-report");
  const sortReport = (k) => { ui.reportSort = { key: k, dir: ui.reportSort.key === k ? -ui.reportSort.dir : 1 }; updateReport(); $(`th[data-sort="${k}"]`, report)?.focus(); };
  report.addEventListener("input", (e) => { if (e.target.id === "report-q") { ui.reportQuery = e.target.value; updateReport(); } });
  report.addEventListener("change", (e) => {
    if (e.target.id === "report-filter") ui.reportFilter = e.target.value;
    else if (e.target.id === "report-rack") { ui.reportRack = e.target.value; ui.reportDevice = ""; }
    else if (e.target.id === "report-device") ui.reportDevice = e.target.value;
    else return;
    updateReport();
  });
  report.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) return sortReport(th.dataset.sort);
    const tile = e.target.closest("[data-report-filter]");
    if (tile) { ui.reportFilter = tile.dataset.reportFilter; $("#report-filter").value = ui.reportFilter; return updateReport(); }
    if (e.target.closest("#report-clear, #report-clear-2")) { Object.assign(ui, { reportFilter: "all", reportRack: "", reportDevice: "", reportQuery: "" }); return renderReport(); }
    if (e.target.closest("#btn-export-csv")) exportCsv();
  });
  report.addEventListener("keydown", (e) => {
    const th = e.target.closest?.("th[data-sort]");
    if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortReport(th.dataset.sort); }
  });

  const fbView = $("#view-feedback");
  fbView.addEventListener("click", (e) => {
    const t = e.target;
    const filter = t.closest("[data-fb-filter]");
    if (filter) {
      // All shows everything; Features or Bugs narrows to that one (clicking it again goes back to All)
      const v = filter.dataset.fbFilter;
      fb.filter = v === "all" || fb.filter === v ? "all" : v;
      $$("[data-fb-filter]", fbView).forEach((c) => { c.checked = c.dataset.fbFilter === fb.filter; });
      return updateFeedback();
    }
    if (t.closest("[data-fb=new]")) { fb.form = true; return showView("feedback"); }
    if (t.closest("[data-fb=cancel]")) { fb.form = false; clearPhotos(); return showView("feedback"); }
    const toggle = t.closest("[data-fb-toggle]");
    if (toggle) { fb.openId = fb.openId === toggle.dataset.fbToggle ? null : toggle.dataset.fbToggle; updateFeedback(); return $(`[data-fb-toggle="${toggle.dataset.fbToggle}"]`, fbView)?.focus(); }
    const act = t.closest("[data-fb-act]");
    if (act) {
      act.closest("details").open = false;
      const { fbAct, id } = act.dataset;
      if (fbAct === "reopen") return fbAction(id, "reopen");
      return fbActionModal(id, fbAct);
    }
    const rm = t.closest("[data-fb-rm]");
    if (rm) { const [p] = fb.photos.splice(+rm.dataset.fbRm, 1); URL.revokeObjectURL(p.url); drawThumbs(); return $("#fb-drop").focus(); }
    if (t.closest("#fb-drop")) $("#fb-file").click();
  });
  // one action menu open at a time; it opens as a floating panel so the table's scroll box can't cut it off
  fbView.addEventListener("toggle", (e) => {
    const menu = e.target;
    if (!menu.matches?.(".fb-menu") || !menu.open) return;
    $$(".fb-menu[open]", fbView).forEach((m) => { if (m !== menu) m.open = false; });
    const r = $("summary", menu).getBoundingClientRect(), pop = $(".fb-menu-pop", menu);
    pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)}px`;
    pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  }, true);
  document.addEventListener("click", (e) => { if (!e.target.closest(".fb-menu")) $$(".fb-menu[open]").forEach((m) => { m.open = false; }); });
  $(".shell").addEventListener("scroll", () => $$(".fb-menu[open]").forEach((m) => { m.open = false; }), { passive: true });
  fbView.addEventListener("submit", (e) => { if (e.target.id === "fb-form") { e.preventDefault(); submitFeedback(e.target); } });
  fbView.addEventListener("change", (e) => { if (e.target.id === "fb-file") { addPhotos(e.target.files); e.target.value = ""; } });
  fbView.addEventListener("keydown", (e) => {
    if (e.target.id === "fb-drop" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); $("#fb-file").click(); }
    if (e.key === "Escape" && e.target.closest(".fb-menu")) { const m = e.target.closest(".fb-menu"); m.open = false; $("summary", m).focus(); }
  });
  fbView.addEventListener("dragover", (e) => { const drop = e.target.closest("#fb-drop"); if (drop) { e.preventDefault(); drop.classList.add("over"); } });
  fbView.addEventListener("dragleave", (e) => e.target.closest("#fb-drop")?.classList.remove("over"));
  fbView.addEventListener("drop", (e) => {
    const drop = e.target.closest("#fb-drop");
    if (!drop) return;
    e.preventDefault(); drop.classList.remove("over");
    addPhotos(e.dataTransfer.files);
  });
  // a screenshot pasted anywhere on the form is added as a photo
  document.addEventListener("paste", (e) => {
    if (ui.view !== "feedback" || !fb.form || modal.open) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault(); addPhotos(files);
  });

  // Clear all data: hold Shift and click Import (kept out of the way on purpose)
  $("#btn-import").addEventListener("click", (e) => {
    if (!e.shiftKey) return;
    e.stopImmediatePropagation();
    ask({ title: "Clear all data?", message: "Every rack, device and drive in this browser will be removed. Export first if you want to keep it.", confirmLabel: "Clear everything", danger: true })
      .then((yes) => { if (!yes) return; data = structuredClone(window.SEED_DATA); ui.rackId = data.racks[0]?.id || null; ui.deviceId = null; save(); showView("home"); renderAll(); toast("All data cleared"); });
  }, true);

  (async () => {
    await connectShared();
    await loadUnifi();
    applyMode();
    if (!currentRack()) ui.rackId = data.racks[0]?.id || null;
    route();
    showView(ui.view);
    renderAll();
    window.addEventListener("hashchange", () => { route(); showView(ui.view); renderAll(); });
    if (shared.on) { setInterval(refreshShared, 30000); document.addEventListener("visibilitychange", refreshShared); }
    if (shared.on) { fetchStatus(); setInterval(fetchStatus, 30000); }
  })();
})();
