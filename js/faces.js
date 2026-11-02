/* Realistic faceplate drawings, in the spirit of UniFi's rack view.
   faceFor(device, face, health) returns HTML for one device, front or rear.
   The look is picked from make/model/type (see skinFor); anything unknown
   falls back to a sensible generic for its type. */
(function () {
  "use strict";

  const rep = (n, html) => Array.from({ length: n }, (_, i) => (typeof html === "function" ? html(i) : html)).join("");
  const has = (s, re) => re.test(s || "");

  // ---------- which drawing to use ----------
  function skinFor(d) {
    const mk = (d.make || "").toLowerCase(), md = (d.model || "").toLowerCase(), nm = (d.name || "").toLowerCase();
    if (mk.includes("ubiquiti") || md.includes("unifi") || /^usw|envr|unvr/.test(md)) {
      if (has(md, /envr|unvr|nvr/)) return "unifi-nvr";
      return "unifi-switch";
    }
    if (mk.includes("hikvision")) return d.uHeight >= 3 ? "hik-big" : "hik-2u";
    // HPE makes both ProLiant servers and Aruba switches
    if (/\bhpe?\b|hewlett/.test(mk) && (["server", "storage"].includes(d.type) || has(md, /proliant|apollo/))) return "hpe-proliant";
    if (mk.includes("aruba") || mk.includes("hpe")) return "aruba";
    if (mk.includes("synology")) return has(md, /diskstation|ds\d/) ? "syno-desk" : "syno-rack";
    if (mk.includes("dell")) {
      if (has(md, /vrtx/)) return "dell-vrtx";
      if (has(md, /monitor/) || nm.includes("monitor")) return "monitor";
      return "dell-r";
    }
    if (mk.includes("australian monitor")) return has(md, /zonemix/) ? "am-mixer" : "am-amp";
    if (mk.includes("blackmagic")) return "videohub";
    if (mk.includes("asl")) return "intercom";
    if (mk.includes("nec")) return "nec";
    if (mk.includes("oneaccess") || mk.includes("ekinops")) return "router-shelf";
    if (d.type === "patch") {
      if (has(md + nm, /fibre|fiber/)) return "fibre";
      if (has(md, /xlr|connector|d-series/) || nm.includes("connector")) return "connector";
      return "patch";
    }
    if (d.type === "blank") {
      if (nm.includes("shelf")) return "shelf";
      if (nm.includes("cable")) return "cable-mgr";
      return has(nm, /vent/) ? "vented" : "blank";
    }
    if (d.type === "pdu") return "pdu";
    if (d.type === "ups") return "ups";
    if (d.type === "switch") return "generic-switch";
    if (d.type === "nvr" || d.type === "storage") return "generic-storage";
    if (d.type === "server") return "dell-r";
    if (d.type === "firewall") return "appliance";
    return "appliance";
  }

  // ---------- small building blocks ----------
  const ear = (side) => `<span class="ear ${side}"></span>`;
  const plate = (cls, body, opts = {}) =>
    `<div class="fp ${cls}">${opts.noEars ? "" : ear("l")}<div class="fp-body">${body}</div>${opts.noEars ? "" : ear("r")}</div>`;
  const led = (c = "g") => `<i class="led2 ${c}"></i>`;

  // RJ45 ports in blocks; rows = 1 or 2. Numbered down each column (odd on top, like UniFi), from start
  function rj45(n, rows = 2, block = 12, st, start = 1) {
    const cols = Math.ceil(n / rows);
    const groups = Math.ceil(cols / (block / rows));
    let html = "", idx = start;
    for (let g = 0; g < groups; g++) {
      const c = Math.min(block / rows, cols - g * (block / rows));
      html += `<span class="port-block" style="grid-template-columns:repeat(${c},1fr);grid-template-rows:repeat(${rows},1fr)">${rep(c * rows, () => portEl("rj", idx++, st))}</span>`;
    }
    return `<span class="ports-wrap">${html}</span>`;
  }
  const sfp = (n, rows = n > 4 ? 2 : 1, st, start = 1) =>
    `<span class="port-block sfp-block" style="grid-template-columns:repeat(${Math.ceil(n / rows)},1fr);grid-template-rows:repeat(${rows},1fr)">${rep(n, (i) => portEl("sfp", start + i, st))}</span>`;
  // One port; st(idx) gives its UniFi state ({ cls, title }) or nothing when UniFi doesn't know it
  const portEl = (cls, idx, st) => {
    const s = st && st(idx);
    return s ? `<i class="${cls} ${s.cls}" data-port="${idx}" title="${s.title}"></i>` : `<i class="${cls}"></i>`;
  };

  // Drive trays: each tray's LED shows health, click opens that bay
  function trays(d, health, cols, rows, cls = "") {
    const n = cols * rows;
    return `<span class="trays ${cls}" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${rep(n, (i) => {
      const bay = i + 1, h = health(bay);
      return `<span class="tray bay ${h}" data-bay="${bay}" title="${h === "empty" ? "Bay " + bay + ": empty" : "Bay " + bay}"><i class="tray-led"></i></span>`;
    })}</span>`;
  }
  // For NVRs whose drives sit behind the front panel: a row of HDD status LEDs
  function hddLeds(d, health, count) {
    const rows = window.bayRows(d), cols = Math.ceil(count / rows);
    return `<span class="hdd-leds" style="grid-template-columns:repeat(${cols}, 5px)" title="Drive status — click a light for that bay">${rep(count, (i) => `<span class="bay hddled ${health(i + 1)}" data-bay="${i + 1}"></span>`)}</span>`;
  }

  // ---------- front drawings ----------
  const FRONT = {
    "unifi-switch"(d, h, st) {
      const md = (d.model || "").toLowerCase();
      let ports = "";
      if (md.includes("pro-aggregation")) ports = sfp(28, 2, st) + sfp(4, 2, st, 29);
      else if (md.includes("aggregation")) ports = sfp(8, 2, st);
      else {
        const n = d.ports || (md.includes("48") ? 48 : md.includes("16") ? 16 : md.includes("8") ? 8 : 24);
        ports = rj45(n, 2, 12, st) + sfp(n >= 48 ? 4 : 2, n >= 48 ? 2 : 1, st, n + 1);
      }
      return plate("silver unifi", `<span class="unifi-lcd"></span><span class="grow"></span>${ports}`);
    },
    "unifi-nvr"(d, h) {
      const rows = window.bayRows(d), cols = Math.ceil((d.bays || rows * 4) / rows);
      return plate("silver unifi", `<span class="unifi-lcd tall"></span>${trays(d, h, cols, rows, "silver-trays")}`);
    },
    "hik-2u"(d, h) {
      return plate("black hik", `<span class="brand-txt">HIKVISION</span>
        <span class="col"><span class="num-leds">${rep(16, '<i></i>')}</span><span class="disc-tray"></span></span>
        <span class="grow"></span>${hddLeds(d, h, d.bays || 8)}<span class="keys">${rep(10, "<i></i>")}</span><span class="dpad"></span><span class="knob"></span>`);
    },
    "hik-big"(d, h) {
      return plate("black hik", `<span class="grille"></span>
        <span class="keypad"><span class="kp-lcd"></span><span class="kp-keys">${rep(12, "<i></i>")}</span><span class="dpad"></span><span class="knob big"></span></span>
        <span class="grille"></span><span class="brand-txt corner">HIKVISION</span>${hddLeds(d, h, d.bays || 16)}`);
    },
    aruba(d, h, st) {
      return plate("graphite", `<span class="brand-txt aruba">aruba</span><span class="mini-leds">${led()}${led("o")}${led()}</span><span class="console"></span>
        <span class="grow"></span>${rj45(d.ports || 24, 2, 12, st)}${sfp(4, 1, st, (d.ports || 24) + 1)}`);
    },
    "hpe-proliant"(d, h) {
      const n = d.bays || 8, rows = window.bayRows(d);
      return plate("black", `<span class="col narrow"><span class="brand-txt small">HPE</span><span class="mini-leds">${led()}${led("b")}</span></span>${trays(d, h, Math.ceil(n / rows), rows, "dark-trays")}`);
    },
    "syno-rack"(d, h) {
      const n = d.bays || 8, rows = window.bayRows(d);
      return plate("black syno", `<span class="col narrow"><span class="brand-txt small">Synology</span><span class="mini-leds">${rep(Math.min(n, 12), () => led())}</span></span>${trays(d, h, Math.ceil(n / rows), rows, "dark-trays")}`);
    },
    "syno-desk"(d, h) {
      return `<div class="fp shelf-scene"><div class="fp-body"><span class="desk-nas">${trays(d, h, d.bays || 8, 1, "dark-trays vertical")}</span></div><span class="shelf-plate"></span></div>`;
    },
    "dell-r"(d, h) {
      return plate("black dell", `<span class="dell-tag"></span><span class="hex-bezel"><span class="dell-badge">DELL EMC</span></span><span class="col narrow">${led("b")}<span class="lcd-strip"></span></span>`);
    },
    "dell-vrtx"() {
      return plate("black vrtx", `<span class="col full"><span class="fins">${rep(18, "<i></i>")}</span><span class="perf"><span class="dell-round">DELL</span></span></span>`);
    },
    monitor() {
      return `<div class="fp shelf-scene"><div class="fp-body"><span class="monitor"><span class="screen"></span><span class="stand"></span></span></div><span class="shelf-plate"></span></div>`;
    },
    "am-amp"(d) {
      return plate("black am", `<span class="brand-txt am">AUSTRALIAN<br>MONITOR</span><span class="grow"></span><span class="am-panel">${led()}${led()}${led("b")}</span><span class="grow"></span><span class="model-txt">${(d.model || "").toUpperCase()}</span><span class="rocker"></span>`);
    },
    "am-mixer"() {
      return plate("black am", `<span class="knob sm"></span><span class="blue-lcd"></span><span class="knob sm"></span><span class="knob sm"></span><span class="grow"></span><span class="brand-txt small">ZONEMIX8</span><span class="rocker"></span>`);
    },
    videohub() {
      return plate("graphite", `<span class="brand-txt small light">Smart Videohub</span><span class="grow"></span><span class="btn-grid">${rep(20, "<i></i>")}</span><span class="blue-lcd"></span><span class="knob sm"></span>`);
    },
    intercom() {
      return plate("black", `<span class="red-btn"></span><span class="brand-txt small">ASL</span><span class="grow"></span>${rep(2, '<span class="channel"><span class="knob sm"></span><i class="pill-btn"></i><i class="pill-btn"></i></span>')}<span class="xlr"></span>`);
    },
    nec() {
      return plate("black", `<span class="nec-left"><span class="brand-txt small">NEC</span><span class="disc-tray short"></span></span><span class="cards">${rep(3, '<i></i>')}</span><span class="slots">${rep(3, "<i></i>")}</span>`);
    },
    "router-shelf"() {
      return `<div class="fp shelf-scene"><div class="fp-body"><span class="router-box"><span class="brand-txt small light">ONEACCESS</span><span class="mini-leds">${led()}${led()}${led("o")}</span></span></div><span class="shelf-plate"></span></div>`;
    },
    patch(d) {
      const n = d.ports || 24, rows = d.uHeight >= 2 && n > 24 ? 2 : 1, per = Math.ceil(n / rows);
      // a high-density 1U panel (more than 24 jacks) stacks its jacks two high so it fits the rack width
      return plate("black", `<span class="patch-rows">${rep(rows, () => `<span class="patch-row"><span class="label-strip"></span>${per > 24 ? rj45(per, 2, 12) : rj45(per, 1, 6)}</span>`)}</span>`);
    },
    fibre(d) {
      return plate("steel", `<span class="fibre-row">${rep(Math.min(12, Math.ceil((d.ports || 24) / 2)), '<i class="lc"></i>')}</span><span class="fibre-handle"></span>`);
    },
    connector(d) {
      return plate("black", `<span class="d-row">${rep(Math.min(10, d.ports || 8), (i) => `<i class="dhole ${i % 3 === 0 ? "xlr" : ""}"><b></b></i>`)}</span>`);
    },
    shelf() { return `<div class="fp shelf-scene"><div class="fp-body"></div><span class="shelf-plate"></span></div>`; },
    "cable-mgr"() { return plate("black", `<span class="fingers">${rep(5, "<i></i>")}</span>`); },
    vented() { return plate("black", `<span class="vent-slots"></span>`); },
    blank() { return plate("black", ""); },
    pdu() { return plate("black", `<span class="red-btn small"></span><span class="outlets">${rep(6, '<i class="au"></i>')}</span>`); },
    ups() { return plate("black", `<span class="ups-lcd"></span><span class="grow"></span><span class="vent-slots short"></span>${led()}`); },
    "generic-switch"(d, h, st) { return plate("graphite", `<span class="mini-leds">${led()}${led()}</span><span class="grow"></span>${rj45(d.ports || 24, 2, 12, st)}${sfp(2, 1, st, (d.ports || 24) + 1)}`); },
    "generic-storage"(d, h) { const n = d.bays || 4, rows = window.bayRows(d); return plate("black", trays(d, h, Math.ceil(n / rows), rows, "dark-trays")); },
    appliance() { return plate("graphite", `<span class="mini-leds">${led()}${led()}${led("o")}</span><span class="grow"></span>${rj45(8, 1, 4)}`); }
  };

  // ---------- rear drawings ----------
  function rear(d, skin) {
    const silver = skin.startsWith("unifi");
    const color = silver ? "silver" : skin === "aruba" || skin === "videohub" ? "graphite" : "black";
    if (skin === "pdu") return FRONT.pdu(d);
    if (["patch", "connector"].includes(skin)) return plate("black rear", `<span class="punch">${rep(d.uHeight * 2, '<i></i>')}</span>`);
    if (skin === "fibre") return plate("steel rear", `<span class="fibre-row">${rep(6, '<i class="lc"></i>')}</span>`);
    if (["shelf", "monitor", "syno-desk", "router-shelf", "cable-mgr", "blank", "vented"].includes(skin)) {
      return skin === "monitor" ? `<div class="fp shelf-scene"><div class="fp-body"><span class="monitor back"><span class="screen"></span><span class="stand"></span></span></div><span class="shelf-plate"></span></div>`
        : FRONT[skin] ? FRONT[skin](d, () => "ok") : FRONT.blank(d);
    }
    const tall = d.uHeight >= 2;
    const psus = ["unifi-switch", "aruba", "am-amp", "am-mixer", "videohub", "intercom"].includes(skin) ? 1 : 2;
    const fans = skin === "unifi-switch" ? (/(pro|48)/i.test(d.model) ? 4 : 0) : skin === "unifi-nvr" ? 5 : tall ? 3 : 0;
    const io = skin.startsWith("hik") ? `<span class="hik-io">${rep(6, "<i></i>")}</span>${rj45(2, 1, 2)}<span class="terminal"></span>`
      : skin === "unifi-switch" ? `<span class="console"></span>` : skin.startsWith("am") || skin === "intercom" ? `<span class="terminal"></span><span class="terminal"></span>`
      : rj45(4, 1, 4);
    return `<div class="fp ${color} rear-face"><div class="fp-body">
      ${rep(psus, '<span class="psu2"><i class="fan-sm"></i><i class="iec"></i></span>')}
      ${io}<span class="grow"></span>${rep(fans, '<i class="fan"></i>')}
    </div></div>`;
  }

  window.faceFor = function (d, face, health, portState) {
    const skin = skinFor(d);
    return face === "rear" ? rear(d, skin) : (FRONT[skin] || FRONT.appliance)(d, health, portState);
  };
  window.skinFor = skinFor;
})();
