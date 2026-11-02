# UniFi Network import for serve.rb.
#
# Reads switches, NVRs and other UniFi gear, their ports (state, speed, PoE) and what each
# port links to, from a UniFi console, and turns it into one simple snapshot the app reads.
#
# Settings live in unifi.json next to the rack data file (never in this repo):
#   { "url": "https://unifi.example.edu.au:8443", "apiKey": "…", "site": "default", "verifyTls": true,
#     "username": "", "password": "" }
# Create the key in UniFi: Settings → Control Plane → Integrations → Create API Key.
#
# Works with both UniFi consoles (UDM, Cloud Key, UniFi OS: API under /proxy/network) and the
# self-hosted UniFi Network Application (port 8443: API at the root); it detects which.
# The official Integration API gives devices and port status. The older internal API adds serial
# numbers, port names and exactly what's on each port; it's tried with the API key, and with the
# optional username/password (use a read-only local UniFi account) if the key isn't accepted there.
require "net/http"
require "uri"
require "openssl"
require "json"
require "time"

module UniFi
  class Error < StandardError; end

  module_function

  def config(dir)
    path = File.join(dir, "unifi.json")
    cfg = File.exist?(path) ? JSON.parse(File.read(path)) : {}
    key = cfg["apiKey"].to_s.strip
    url = cfg["url"].to_s.strip.sub(%r{/+\z}, "")
    {
      path: path,
      url: url,
      api_key: key,
      site: (cfg["site"] || "default").to_s,
      verify_tls: cfg["verifyTls"] != false,
      username: cfg["username"].to_s, password: cfg["password"].to_s,
      prefix: cfg["apiPrefix"],
      configured: url.start_with?("http") && !url.include?("CONSOLE"),
      has_key: !key.empty? && !key.include?("PASTE"),
      has_login: !cfg["username"].to_s.strip.empty? && !cfg["password"].to_s.empty?
    }
  rescue JSON::ParserError
    raise Error, "unifi.json isn't valid JSON"
  end

  def mac(value)
    value.to_s.downcase.gsub(/[^0-9a-f]/, "")
  end

  def request(cfg, path, post: nil)
    uri = URI("#{cfg[:url]}#{cfg[:prefix]}#{path}")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.verify_mode = cfg[:verify_tls] ? OpenSSL::SSL::VERIFY_PEER : OpenSSL::SSL::VERIFY_NONE # set verifyTls false for self-signed consoles
    http.open_timeout = 5
    http.read_timeout = 20
    req = post ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
    req["X-API-KEY"] = cfg[:api_key] unless cfg[:api_key].to_s.empty?
    req["Cookie"] = cfg[:cookie] if cfg[:cookie]
    req["Accept"] = "application/json"
    if post
      req["Content-Type"] = "application/json"
      req.body = JSON.generate(post)
    end
    http.request(req)
  end

  def get(cfg, path)
    res = request(cfg, path)
    raise Error, "UniFi said #{res.code} for #{path}" unless res.is_a?(Net::HTTPSuccess)
    JSON.parse(res.body)
  rescue Error
    raise
  rescue StandardError => e
    raise Error, "Couldn't reach UniFi at #{cfg[:url]} (#{e.class.name.split('::').last}: #{e.message})"
  end

  # Integration API lists are paged: { offset, limit, count, totalCount, data: [...] }
  def get_all(cfg, path)
    out = []
    offset = 0
    loop do
      sep = path.include?("?") ? "&" : "?"
      page = get(cfg, "#{path}#{sep}offset=#{offset}&limit=200")
      items = page.is_a?(Hash) ? Array(page["data"]) : Array(page)
      out.concat(items)
      offset += items.size
      break if items.empty? || !page.is_a?(Hash) || offset >= page["totalCount"].to_i
    end
    out
  end

  def fetch(cfg)
    raise Error, "UniFi isn't set up yet: add the console address to #{cfg[:path]}" unless cfg[:configured]
    raise Error, "No API key or login yet: add one to #{cfg[:path]}" unless cfg[:has_key] || cfg[:has_login]

    cfg = cfg.merge(prefix: cfg[:prefix] || detect_prefix(cfg))
    return fetch_legacy(cfg) unless cfg[:has_key]
    base = "/integration/v1"
    sites = get_all(cfg, "#{base}/sites")
    site = sites.find { |s| [s["internalReference"], s["name"], s["id"]].map(&:to_s).include?(cfg[:site]) } || sites.first
    raise Error, "No UniFi sites found" unless site

    devices = {}
    get_all(cfg, "#{base}/sites/#{site['id']}/devices").each do |d|
      detail = begin
        get(cfg, "#{base}/sites/#{site['id']}/devices/#{d['id']}")
      rescue Error
        d
      end
      ports = Array(detail.dig("interfaces", "ports")).map do |p|
        poe = p["poe"] || {}
        { idx: p["idx"].to_i, name: nil, up: p["state"].to_s.upcase == "UP", speedMbps: p["speedMbps"], maxSpeedMbps: p["maxSpeedMbps"],
          connector: p["connector"], poe: { enabled: poe["enabled"] == true, watts: nil }, links: [] }
      end
      m = mac(d["macAddress"])
      devices[m] = { mac: m, unifiId: d["id"], name: d["name"], model: d["model"], ip: d["ipAddress"], serial: nil,
                     firmware: detail["firmwareVersion"], state: d["state"], ports: ports, clients: [] }
    end

    clients = get_all(cfg, "#{base}/sites/#{site['id']}/clients").select { |c| c["type"].to_s.upcase == "WIRED" }
    by_id = devices.values.each_with_object({}) { |dv, h| h[dv[:unifiId]] = dv }
    clients.each do |c|
      host = by_id[c["uplinkDeviceId"]]
      host[:clients] << { mac: mac(c["macAddress"]), name: c["name"], ip: c["ipAddress"] } if host
    end

    source = "integration"
    begin
      legacy(cfg, site["internalReference"] || cfg[:site], devices)
      source = "integration+legacy"
    rescue Error
      # The older API isn't available with an API key on every console; the basics above still work.
    end

    { fetchedAt: Time.now.utc.iso8601, source: source, site: site["name"], devices: devices.values }
  end

  # Username/password only (no API key): everything comes from the older API
  def fetch_legacy(cfg)
    cfg = login(cfg)
    sites = Array(get(cfg, "/api/self/sites")["data"])
    site = sites.find { |s| [s["name"], s["desc"]].map(&:to_s).include?(cfg[:site]) } || sites.first
    raise Error, "No UniFi sites found" unless site
    devices = {}
    legacy(cfg, site["name"], devices, add: true)
    { fetchedAt: Time.now.utc.iso8601, source: "legacy", site: site["desc"] || site["name"], devices: devices.values }
  end

  # UniFi consoles put the Network API under /proxy/network; the self-hosted app serves it at the root
  def detect_prefix(cfg)
    # The self-hosted app answers /status with its version (no login needed)
    res = request(cfg.merge(prefix: ""), "/status")
    return "" if res.is_a?(Net::HTTPSuccess) && (JSON.parse(res.body).dig("meta", "server_version") rescue nil)
    ["/proxy/network", ""].each do |prefix|
      res = request(cfg.merge(prefix: prefix), "/integration/v1/sites")
      return prefix unless res.code == "404"
    end
    raise Error, "Couldn't find the UniFi Network API at #{cfg[:url]}"
  rescue Error
    raise
  rescue StandardError => e
    raise Error, "Couldn't reach UniFi at #{cfg[:url]} (#{e.message})"
  end

  # The older API may want a session login instead of the API key (optional username/password)
  def login(cfg)
    return cfg if cfg[:username].empty? || cfg[:password].empty?
    path = cfg[:prefix] == "/proxy/network" ? "/api/auth/login" : "/api/login"
    res = request(cfg.merge(prefix: cfg[:prefix] == "/proxy/network" ? "" : cfg[:prefix]), path, post: { username: cfg[:username], password: cfg[:password] })
    raise Error, "UniFi login failed: check the username and password in unifi.json (#{res.code})" unless res.is_a?(Net::HTTPSuccess)
    cookies = Array(res.get_fields("set-cookie")).map { |c| c.split(";").first }.join("; ")
    cfg.merge(cookie: cookies)
  end

  # Give every link on a port the best name UniFi has for that MAC: a name someone set in UniFi, else the
  # hostname, plus the maker (from the MAC) and IP. Uses online clients and UniFi's list of known clients,
  # which also covers devices that are offline right now. Links that still have no name keep their MAC.
  def name_links(cfg, site_ref, devices, online)
    clean = ->(v) { s = v.to_s.strip; s.empty? ? nil : s }
    names = {}
    remember = lambda do |c|
      m = mac(c["mac"])
      return if m.empty?
      e = (names[m] ||= {})
      e[:name] ||= clean.(c["name"])
      e[:hostname] ||= clean.(c["hostname"])
      e[:vendor] ||= clean.(c["oui"])
      e[:ip] ||= clean.(c["ip"]) || clean.(c["last_ip"])
    end
    online.each(&remember)
    begin
      Array(get(cfg, "/api/s/#{site_ref}/rest/user")["data"]).each(&remember)
    rescue Error
      # not every account can read the known-clients list; online clients still help
    end
    # Maker by MAC prefix (first 3 bytes), learned from the clients UniFi already knows the maker of;
    # anything sharing a prefix with this site's own UniFi gear is Ubiquiti
    makers = {}
    names.each { |m, e| makers[m[0, 6]] ||= e[:vendor] if e[:vendor] }
    devices.each_key { |m| makers[m[0, 6]] ||= "Ubiquiti" }
    # A port can be up with nothing listed on it (e.g. a firewall, which isn't a client and sends no LLDP);
    # UniFi still notes the last device it saw there, so show that
    devices.each_value do |dv|
      dv[:ports].each do |p|
        p[:links] << { kind: "seen", mac: p[:lastMac], ip: p[:lastIp] } if p[:links].empty? && p[:lastMac]
      end
    end
    devices.each_value do |dv|
      dv[:ports].each do |p|
        p[:links].each do |l|
          n = names[l[:mac]] || {}
          l[:name] = n[:name] || n[:hostname] if clean.(l[:name]).nil?
          l[:vendor] ||= n[:vendor] || makers[l[:mac].to_s[0, 6]]
          l[:ip] ||= n[:ip]
        end
      end
    end
  end

  # Older internal API: serials, port names, PoE watts, LLDP neighbours and which port each client is on
  def legacy(cfg, site_ref, devices, add: false)
    cfg = login(cfg) unless cfg[:cookie]
    list = Array(get(cfg, "/api/s/#{site_ref}/stat/device")["data"])
    list.each do |d| # first pass: devices, serials and ports
      m = mac(d["mac"])
      if add && !devices[m]
        devices[m] = { mac: m, name: d["name"] || d["model"], model: d["model"], ip: d["ip"], serial: nil, firmware: d["version"],
                       state: d["state"].to_i == 1 ? "ONLINE" : "OFFLINE", ports: [], clients: [] }
      end
      dev = devices[m]
      next unless dev
      dev[:serial] ||= d["serial"]
      dev[:uptime] = d["uptime"].to_i if d["uptime"] # seconds since the device last booted, as of this fetch
      Array(d["port_table"]).each do |p|
        port = dev[:ports].find { |x| x[:idx] == p["port_idx"].to_i }
        port ||= (dev[:ports] << { idx: p["port_idx"].to_i, up: p["up"] == true, speedMbps: p["speed"], connector: p["media"],
                                   poe: { enabled: p["poe_enable"] == true }, links: [] }).last
        port[:name] = p["name"] if p["name"] && p["name"] !~ /\APort \d+\z/
        port[:poe][:watts] = p["poe_power"].to_f.round(1) if p["poe_power"] && p["poe_enable"] != false
        # when the device now on this port connected (port uptime), or when the port last saw something
        lc = p["last_connection"]
        if lc.is_a?(Hash)
          port[:connectedAt] = Time.at(lc["connected_at"].to_i).utc.iso8601 if lc["connected"] && lc["connected_at"].to_i.positive?
          port[:lastSeen] = Time.at(lc["last_seen"].to_i).utc.iso8601 if lc["last_seen"].to_i.positive?
          port[:lastMac] = mac(lc["mac"]) unless mac(lc["mac"]).empty?
          port[:lastIp] = lc["ip"] unless lc["ip"].to_s.empty?
        end
      end
    end
    list.each do |d| # second pass: what links to what (every device's ports exist by now)
      dev = devices[mac(d["mac"])]
      next unless dev
      Array(d["lldp_table"]).each do |l|
        port = dev[:ports].find { |x| x[:idx] == l["local_port_idx"].to_i }
        next unless port
        port[:links] << { kind: "lldp", mac: mac(l["chassis_id"]), name: l["system_name"], port: l["port_id"] }
      end
      up = d["uplink"] || {}
      if up["uplink_mac"]
        port = dev[:ports].find { |x| x[:idx] == up["port_idx"].to_i }
        port[:links] << { kind: "uplink", mac: mac(up["uplink_mac"]), port: up["uplink_remote_port"] } if port
        parent = devices[mac(up["uplink_mac"])]
        pport = parent && parent[:ports].find { |x| x[:idx] == up["uplink_remote_port"].to_i }
        pport[:links] << { kind: "downlink", mac: dev[:mac], name: dev[:name], port: up["port_idx"] } if pport
      end
    end
    sta = get(cfg, "/api/s/#{site_ref}/stat/sta")
    Array(sta["data"]).each do |c|
      next unless c["sw_mac"] && c["sw_port"]
      dev = devices[mac(c["sw_mac"])]
      port = dev && dev[:ports].find { |x| x[:idx] == c["sw_port"].to_i }
      port[:links] << { kind: "client", mac: mac(c["mac"]), name: c["name"] || c["hostname"], ip: c["ip"] } if port
    end
    devices.each_value { |dv| dv[:ports].each { |p| p[:links].uniq! { |l| l[:mac] } } }
    name_links(cfg, site_ref, devices, Array(sta["data"]))
  end
end
