#!/usr/bin/env ruby
# Share the Rack View on the local network.
#
#   ruby serve.rb [data folder] [port]
#
# Serves the app and keeps its shared data in ONE folder, OUTSIDE this repository, so the
# repo stays app-only. The folder holds rack-data.json (and its .bak), unifi.json,
# unifi-snapshot.json, features-bugs.json and feature-photos/.
# Which folder: the first argument, else RACK_DATA_DIR, else ~/WCC Rack Data.
# Giving a path to a .json file still works (as before): its folder is used and that file is the rack data.
# Only this computer can save changes; anyone else on the network gets a view-only copy.
# Data files are UTF-8 whatever the computer's language setting (a service often has none, and then
# the "–" in rack names can't be read). WEBrick ships with the app in vendor/, so no gem install is needed.
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = nil
$LOAD_PATH.unshift(File.join(__dir__, "vendor"))
require "webrick"
require "json"
require "fileutils"
require "time"
require "socket"
require "timeout"
require "open3"
require "rbconfig"
require "ipaddr"
require "securerandom"
require "set"
require_relative "unifi"
require_relative "sso"

DATA_ARG = File.expand_path(ARGV[0] || ENV["RACK_DATA_DIR"] || "~/WCC Rack Data")
DATA_DIR = DATA_ARG.downcase.end_with?(".json") ? File.dirname(DATA_ARG) : DATA_ARG
DATA_FILE = DATA_ARG.downcase.end_with?(".json") ? DATA_ARG : File.join(DATA_DIR, "rack-data.json")
PORT = (ARGV[1] || ENV["PORT"] || 8765).to_i
ROOT = __dir__
CHECK_EVERY = (ENV["CHECK_INTERVAL"] || 60).to_i # seconds between automatic up-checks; 0 turns them off

# ---------- Up-checks ----------
# The server checks every device that has an IP address in the rack data (and nothing else).
# If a device has a "checkPort" it opens a TCP connection to that port; otherwise it uses
# this computer's own ping command, with the right options for Windows, Linux or macOS.
STATUS = {} # device id => { up:, ms:, method:, checkedAt:, lastUp:, since:, checks:, upChecks:, trackedSince: }
STATUS_FILE = File.join(DATA_DIR, "status.json") # so up/down history survives a restart
STATUS_LOCK = Mutex.new
HOST_OK = /\A[A-Za-z0-9.\-:]{1,253}\z/ # IPs and host names only, never anything a shell could act on

def ping_command(host)
  case RbConfig::CONFIG["host_os"]
  when /mswin|mingw|cygwin/ then ["ping", "-n", "1", "-w", "1500", host]
  when /darwin/ then ["ping", "-c", "1", "-W", "1500", host]
  else ["ping", "-c", "1", "-W", "2", host] # Linux
  end
end

def check_host(host, port)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  elapsed = -> { ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round }
  if port
    Timeout.timeout(2) { Socket.tcp(host, port, connect_timeout: 2).close }
    { up: true, ms: elapsed.call, method: "port #{port}" }
  else
    out, st = Open3.capture2e(*ping_command(host))
    ms = out[/time[=<]\s*([\d.]+)\s*ms/i, 1]
    { up: st.success? && out !~ /unreachable|timed out/i, ms: ms ? ms.to_f.round : elapsed.call, method: "ping" }
  end
rescue StandardError
  { up: false, ms: nil, method: port ? "port #{port}" : "ping" }
end

def check_all
  return unless File.exist?(DATA_FILE)
  targets = []
  JSON.parse(File.read(DATA_FILE))["racks"].to_a.each do |r|
    r["devices"].to_a.each do |d|
      host = d["ip"].to_s.strip
      next if host.empty? || host !~ HOST_OK
      port = d["checkPort"].to_i
      targets << [d["id"], host, port.between?(1, 65_535) ? port : nil]
    end
  end
  queue = Queue.new
  targets.each { |t| queue << t }
  Array.new([targets.size, 16].min) do
    Thread.new do
      loop do
        id, host, port = begin; queue.pop(true); rescue ThreadError; break; end
        result = check_host(host, port).merge(checkedAt: Time.now.utc.iso8601, host: host)
        STATUS_LOCK.synchronize do
          prev = STATUS[id] || {}
          result[:lastUp] = result[:up] ? result[:checkedAt] : prev[:lastUp]
          # when the current up (or down) streak began, and how often it has answered since tracking began
          result[:since] = prev.key?(:up) && prev[:up] == result[:up] ? (prev[:since] || prev[:trackedSince] || result[:checkedAt]) : result[:checkedAt]
          result[:checks] = prev[:checks].to_i + 1
          result[:upChecks] = prev[:upChecks].to_i + (result[:up] ? 1 : 0)
          result[:trackedSince] = prev[:trackedSince] || result[:checkedAt]
          STATUS[id] = result
        end
      end
    end
  end.each(&:join)
  STATUS_LOCK.synchronize { STATUS.select! { |id, _| targets.any? { |t| t[0] == id } } }
  save_status
rescue StandardError => e
  warn "Up-check failed: #{e.message}"
end

def save_status
  snapshot = STATUS_LOCK.synchronize { STATUS.dup }
  tmp = "#{STATUS_FILE}.tmp"
  File.write(tmp, JSON.generate(snapshot))
  File.rename(tmp, STATUS_FILE)
rescue StandardError => e
  warn "Couldn't save up-check history: #{e.message}"
end

# Pick up where the last run left off (keys back to symbols, as check_all expects)
begin
  JSON.parse(File.read(STATUS_FILE)).each { |id, s| STATUS[id] = s.transform_keys(&:to_sym) } if File.exist?(STATUS_FILE)
rescue StandardError
  STATUS.clear
end

$last_check = Time.at(0)
CHECK_LOCK = Mutex.new
def check_now
  CHECK_LOCK.synchronize do
    return if Time.now - $last_check < 10 # at most one run every 10 seconds, however many people click
    $last_check = Time.now
    check_all
  end
end

if CHECK_EVERY.positive?
  Thread.new { loop { check_now; sleep CHECK_EVERY } }
end

# ---------- Who's asking ----------
# The ONE place that decides what a request may do (see sso.rb for the modes):
#   sso      the signed-in person's role from their Entra groups: owner (everything, incl. UniFi sync and
#            signing off features and bugs) or admin (edits racks and logs features/bugs); not signed in = none
#   setup    nobody gets in until sign-in is configured
#   network  (testing, no sign-in configured) by address: this computer is owner, the local network
#            contributor (views, logs features and bugs), anything else viewer (views only)
ROLES = %w[none viewer contributor admin owner].freeze
SSO_MODE = SSO.mode
# Behind IIS/nginx every request arrives from this computer, so with TRUST_PROXY=1 the browser's
# address is taken from the X-Forwarded-For header the proxy adds (only when the request is local).
TRUST_PROXY = ENV["TRUST_PROXY"] == "1"
def who(req)
  case SSO_MODE
  when :sso
    s = SSO.session(req)
    return s ? { role: s[:role], name: s[:name], email: s[:email] } : { role: "none", name: nil }
  when :setup
    return { role: "none", name: nil }
  end
  ip = IPAddr.new(req.remote_ip.to_s)
  ip = ip.native if ip.ipv4_mapped?
  if TRUST_PROXY && ip.loopback? && (fwd = req["X-Forwarded-For"].to_s.split(",").last&.strip)
    ip = IPAddr.new(fwd)
    ip = ip.native if ip.ipv4_mapped?
  end
  role = if ip.loopback? then "owner"
         elsif ip.private? || ip.link_local? then "contributor"
         else "viewer"
         end
  { role: role, name: nil } # no sign-in in this mode, so no name
rescue IPAddr::Error
  { role: "viewer", name: nil }
end
def can?(req, role) = ROLES.index(who(req)[:role]) >= ROLES.index(role)
def admin?(req) = can?(req, "admin") # edit racks (admin or owner)
def owner?(req) = can?(req, "owner") # UniFi sync, signing off features and bugs

# For every /api/ endpoint: is this request allowed in at all? (Answers it itself when not.)
def let_in?(req, res)
  return true if SSO_MODE == :network
  if SSO_MODE == :setup
    json(res, 503, error: "Sign-in isn't set up yet", setup: true)
    return false
  end
  return true if SSO.session(req)
  json(res, 401, error: "Please sign in", login: "/auth/login")
  false
end

def json(res, status, body)
  res.status = status
  res["Content-Type"] = "application/json"
  res["Cache-Control"] = "no-store"
  res.body = JSON.generate(body)
end

# HTTPS without IIS/nginx: set TLS_CERT to a .pfx (with TLS_PFX_PASSWORD) or a .pem/.crt (with TLS_KEY).
# Relative paths are inside the app folder. HTTP_REDIRECT_PORT (default 80) then sends http:// visitors to https://.
TLS_CERT = ENV["TLS_CERT"].to_s.strip
tls = {}
unless TLS_CERT.empty?
  require "webrick/https"
  cert_path = File.expand_path(TLS_CERT, __dir__)
  if cert_path.downcase.end_with?(".pfx", ".p12")
    pfx = OpenSSL::PKCS12.new(File.binread(cert_path), ENV["TLS_PFX_PASSWORD"].to_s)
    cert, key, chain = pfx.certificate, pfx.key, pfx.ca_certs.to_a
  else
    pem = File.read(cert_path)
    certs = pem.scan(/-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----/m).map { OpenSSL::X509::Certificate.new(_1) }
    cert, chain = certs.first, certs.drop(1)
    key = OpenSSL::PKey.read(File.read(File.expand_path(ENV["TLS_KEY"].to_s.empty? ? TLS_CERT : ENV["TLS_KEY"], __dir__)))
  end
  tls = { SSLEnable: true, SSLCertificate: cert, SSLPrivateKey: key, SSLExtraChainCert: chain }
end
server = WEBrick::HTTPServer.new(Port: PORT, AccessLog: [], Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN), **tls)
unless tls.empty?
  redirect_port = (ENV["HTTP_REDIRECT_PORT"] || 80).to_i
  if redirect_port.positive?
    begin
      redirect = WEBrick::HTTPServer.new(Port: redirect_port, AccessLog: [], Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN))
      redirect.mount_proc("/") do |req, res|
        host = req.host.to_s
        res.set_redirect(WEBrick::HTTPStatus::MovedPermanently, "https://#{host}#{PORT == 443 ? "" : ":#{PORT}"}#{req.unparsed_uri}")
      end
      Thread.new { redirect.start }
    rescue Errno::EADDRINUSE, Errno::EACCES => e
      warn "http redirect on port #{redirect_port} not started: #{e.message}"
    end
  end
end

# Only the app's own files are served (never .git or anything else in the folder)
%w[css js img].each do |dir|
  server.mount("/#{dir}", WEBrick::HTTPServlet::FileHandler, File.join(ROOT, dir))
end
server.mount_proc("/") do |req, res|
  raise WEBrick::HTTPStatus::NotFound unless ["/", "/index.html"].include?(req.path)
  res["Content-Type"] = "text/html; charset=utf-8"
  res["Cache-Control"] = "no-cache"
  res.body = if SSO_MODE == :setup then SSO.setup_page
             elsif SSO_MODE == :sso && !SSO.session(req)
               # not signed in: go to Microsoft, remembering the #/… address so they land back where they were
               %(<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>location.replace("/auth/login?r=" + encodeURIComponent(location.hash))</script><a href="/auth/login">Sign in</a>)
             else File.read(File.join(ROOT, "index.html"))
             end
end

# ---------- Sign-in (Entra ID; only in sso mode) ----------
server.mount_proc("/auth") do |req, res|
  raise WEBrick::HTTPStatus::NotFound unless SSO_MODE == :sso
  res["Cache-Control"] = "no-store"
  case req.path
  when "/auth/login"
    res.set_redirect(WEBrick::HTTPStatus::Found, SSO.login_url(req.query["r"]))
  when "/auth/callback"
    result = SSO.callback(req.query)
    res["Content-Type"] = "text/html; charset=utf-8"
    case result[0]
    when :ok
      res["Set-Cookie"] = SSO.cookie(result[1], SSO::SESSION_HOURS * 3600)
      res.set_redirect(WEBrick::HTTPStatus::Found, "/#{result[2]}")
    when :blocked
      res.status = 403
      res.body = SSO.page("You don't have access to Rack View", "<p>You're signed in as <strong>#{CGI.escapeHTML(result[1].to_s)}</strong>, but your account isn't in the <strong>Rack View Owner</strong> or <strong>Rack View Admin</strong> group.</p><p>#{CGI.escapeHTML(result[2] || "Ask IT to add you to one of them, then sign in again.")}</p><a class=\"btn\" href=\"/auth/logout\">Sign in as someone else</a>")
    else
      res.status = 400
      res.body = SSO.page("Sign-in didn't work", "<p>#{CGI.escapeHTML(result[1].to_s)}</p><a class=\"btn\" href=\"/auth/login\">Try again</a>")
    end
  when "/auth/logout"
    SSO.logout(req)
    res["Set-Cookie"] = SSO.cookie("", 0)
    res.set_redirect(WEBrick::HTTPStatus::Found, SSO.logout_url)
  else
    raise WEBrick::HTTPStatus::NotFound
  end
end

server.mount_proc("/api/info") do |req, res|
  next unless let_in?(req, res)
  me = who(req)
  json(res, 200, role: me[:role], name: me[:name], email: me[:email], sso: SSO_MODE == :sso, canEdit: %w[admin owner].include?(me[:role]), updatedAt: File.exist?(DATA_FILE) ? File.mtime(DATA_FILE).utc.iso8601 : nil)
end

server.mount_proc("/api/data") do |req, res|
  next unless let_in?(req, res)
  case req.request_method
  when "GET"
    if File.exist?(DATA_FILE)
      res["Content-Type"] = "application/json"
      res["Cache-Control"] = "no-store"
      res.body = File.read(DATA_FILE)
    else
      json(res, 404, error: "No shared data yet")
    end
  when "PUT"
    next json(res, 403, error: "View only: you can't change rack data") unless admin?(req)
    begin
      parsed = JSON.parse(req.body.to_s)
      raise "no racks" unless parsed.is_a?(Hash) && parsed["racks"].is_a?(Array)
    rescue StandardError
      next json(res, 400, error: "Not valid rack data")
    end
    FileUtils.mkdir_p(File.dirname(DATA_FILE))
    FileUtils.cp(DATA_FILE, "#{DATA_FILE}.bak") if File.exist?(DATA_FILE) # one-step undo
    tmp = "#{DATA_FILE}.tmp"
    File.write(tmp, JSON.pretty_generate(parsed))
    File.rename(tmp, DATA_FILE)
    Thread.new { CHECK_LOCK.synchronize { $last_check = Time.at(0) }; check_now } # pick up new or changed IPs
    json(res, 200, ok: true)
  else
    json(res, 405, error: "Method not allowed")
  end
end

# ---------- UniFi ----------
# GET /api/unifi            whether UniFi is set up (and where its settings file is)
# GET /api/unifi/snapshot   the last thing fetched from UniFi (everyone can read it)
# POST /api/unifi/sync      fetch again now (host computer only)
UNIFI_DIR = DATA_DIR
UNIFI_SNAPSHOT = File.join(UNIFI_DIR, "unifi-snapshot.json")
server.mount_proc("/api/unifi") do |req, res|
  next unless let_in?(req, res)
  case [req.request_method, req.path]
  when ["GET", "/api/unifi"]
    begin
      cfg = UniFi.config(UNIFI_DIR)
      json(res, 200, configured: cfg[:configured], hasKey: cfg[:has_key] || cfg[:has_login], url: cfg[:url], site: cfg[:site], settingsFile: cfg[:path],
                     snapshotAt: File.exist?(UNIFI_SNAPSHOT) ? File.mtime(UNIFI_SNAPSHOT).utc.iso8601 : nil, canSync: owner?(req))
    rescue UniFi::Error => e
      json(res, 200, configured: false, hasKey: false, error: e.message, settingsFile: File.join(UNIFI_DIR, "unifi.json"), canSync: owner?(req))
    end
  when ["GET", "/api/unifi/snapshot"]
    next res.status = 204 unless File.exist?(UNIFI_SNAPSHOT) # nothing fetched yet: normal, so not an error in the browser console
    res["Content-Type"] = "application/json"
    res["Cache-Control"] = "no-store"
    res.body = File.read(UNIFI_SNAPSHOT)
  when ["POST", "/api/unifi/sync"]
    next json(res, 403, error: "Only an owner can sync from UniFi") unless owner?(req)
    begin
      snap = UniFi.fetch(UniFi.config(UNIFI_DIR))
      File.write(UNIFI_SNAPSHOT, JSON.pretty_generate(snap))
      json(res, 200, snap)
    rescue UniFi::Error => e
      json(res, 502, error: e.message)
    end
  else
    json(res, 404, error: "Not found")
  end
end

# Latest up-check results. POST runs a fresh check first (rate-limited) and then returns them.
server.mount_proc("/api/status") do |req, res|
  next unless let_in?(req, res)
  check_now if req.request_method == "POST"
  results = STATUS_LOCK.synchronize { STATUS.dup }
  json(res, 200, enabled: true, every: CHECK_EVERY, checkedAt: $last_check.year > 1970 ? $last_check.utc.iso8601 : nil, results: results)
end

# ---------- Ping one address ----------
# POST /api/ping {"ip": "10.0.0.5"}  pings it once (or tests "port" over TCP) and says if it answered.
# Only addresses already known (devices in the rack data, or anything in the UniFi snapshot) can be pinged,
# so this can't be used to probe the network. College network only; one check per address every 3 seconds.
PING_LOCK = Mutex.new
$ping_last = {}
$known_ips = { at: nil, ips: Set.new }
def known_ip?(ip)
  stamp = [DATA_FILE, UNIFI_SNAPSHOT].map { |f| File.exist?(f) ? File.mtime(f) : nil }
  if $known_ips[:at] != stamp
    ips = Set.new
    walk = lambda do |o|
      case o
      when Hash then o.each { |k, v| k.to_s =~ /\A(ip|lastIp)\z/ && v.is_a?(String) ? ips << v.strip : walk.(v) }
      when Array then o.each(&walk)
      end
    end
    [DATA_FILE, UNIFI_SNAPSHOT].each { |f| walk.(JSON.parse(File.read(f, encoding: "UTF-8"))) if File.exist?(f) }
    $known_ips = { at: stamp, ips: ips }
  end
  $known_ips[:ips].include?(ip)
end

server.mount_proc("/api/ping") do |req, res|
  next unless let_in?(req, res)
  next json(res, 405, error: "Use POST") unless req.request_method == "POST"
  next json(res, 403, error: "Only computers on the College network can ping") unless can?(req, "contributor")
  body = (JSON.parse(req.body.to_s) rescue {})
  ip = body.is_a?(Hash) ? body["ip"].to_s.strip : ""
  port = body.is_a?(Hash) ? body["port"].to_i : 0
  next json(res, 400, error: "Not an address") unless ip.match?(HOST_OK)
  next json(res, 403, error: "Only addresses already in Rack View or UniFi can be pinged") unless known_ip?(ip)
  wait = PING_LOCK.synchronize do
    left = 3 - (Time.now - ($ping_last[ip] || Time.at(0)))
    $ping_last[ip] = Time.now if left <= 0
    left
  end
  next json(res, 429, error: "Pinged a moment ago; try again in a few seconds") if wait.positive?
  result = check_host(ip, port.between?(1, 65_535) ? port : nil)
  json(res, 200, result.merge(ip: ip, checkedAt: Time.now.utc.iso8601))
end

# ---------- Features & Bugs ----------
# Feature requests and bug reports, kept in features-bugs.json (photos in feature-photos/) in the data folder.
# GET  /api/feedback                  the list (everyone)
# POST /api/feedback                  log one: a form with type, title, description, page, loggedBy and up to 4 photos (contributors)
# POST /api/feedback/<id>/note        add a note (contributors)
# POST /api/feedback/<id>/signoff     sign it off, with an optional note (admin)
# POST /api/feedback/<id>/reopen      open it again (admin)
# GET  /api/feedback/photos/<file>    one photo
FEEDBACK_FILE = File.join(DATA_DIR, "features-bugs.json")
PHOTO_DIR = File.join(DATA_DIR, "feature-photos")
FEEDBACK_LOCK = Mutex.new
MAX_PHOTOS = 4
MAX_PHOTO_BYTES = 4 * 1024 * 1024
# A photo is recognised by its first bytes, never by its file name or what the browser says it is
PHOTO_KINDS = {
  "jpg" => ->(b) { b.start_with?("\xFF\xD8\xFF".b) },
  "png" => ->(b) { b.start_with?("\x89PNG\r\n\x1A\n".b) },
  "gif" => ->(b) { b.start_with?("GIF87a", "GIF89a") },
  "webp" => ->(b) { b.start_with?("RIFF") && b[8, 4] == "WEBP" }
}.freeze
PHOTO_TYPES = { "jpg" => "image/jpeg", "png" => "image/png", "gif" => "image/gif", "webp" => "image/webp" }.freeze
PHOTO_NAME = /\A[0-9a-f]{32}\.(jpg|png|gif|webp)\z/

def feedback_items
  File.exist?(FEEDBACK_FILE) ? JSON.parse(File.read(FEEDBACK_FILE))["items"].to_a : []
end
# Read, change and write back as one step, so two people logging at once can't lose either entry
def change_feedback
  FEEDBACK_LOCK.synchronize do
    items = feedback_items
    result = yield items
    FileUtils.mkdir_p(DATA_DIR)
    tmp = "#{FEEDBACK_FILE}.tmp"
    File.write(tmp, JSON.pretty_generate("items" => items))
    File.rename(tmp, FEEDBACK_FILE)
    result
  end
end

server.mount_proc("/api/feedback") do |req, res|
  next unless let_in?(req, res)
  me = who(req)
  case [req.request_method, req.path]
  in ["GET", "/api/feedback"]
    json(res, 200, items: feedback_items, role: me[:role])
  in ["POST", "/api/feedback"]
    next json(res, 403, error: "Only computers on the College network can log features and bugs") unless can?(req, "contributor")
    next json(res, 413, error: "That's too much to upload at once") if req["content-length"].to_i > MAX_PHOTOS * MAX_PHOTO_BYTES + 1_000_000
    q = req.query
    text = ->(k, max) { q[k].to_s.dup.force_encoding("UTF-8").scrub.strip[0, max] }
    type, title, description, page = text.("type", 10), text.("title", 200), text.("description", 5000), text.("page", 80)
    logged_by = me[:name] || text.("loggedBy", 80)
    next json(res, 400, error: "Choose Feature request or Bug report") unless %w[feature bug].include?(type)
    next json(res, 400, error: "Add a title") if title.empty?
    next json(res, 400, error: "Add a description") if description.empty?
    next json(res, 400, error: "Choose the page it's about") if page.empty?
    next json(res, 400, error: "Add your name") if logged_by.empty?
    photos = (q["photos"]&.list || []).map { |f| f.to_s.b }.reject(&:empty?)
    next json(res, 400, error: "Up to #{MAX_PHOTOS} photos") if photos.size > MAX_PHOTOS
    if (i = photos.index { |d| d.bytesize > MAX_PHOTO_BYTES })
      next json(res, 400, error: "Photo #{i + 1} is over 4 MB")
    end
    exts = photos.map { |d| PHOTO_KINDS.find { |_, ok| ok.(d) }&.first }
    if (i = exts.index(nil))
      next json(res, 400, error: "Photo #{i + 1} isn't a JPEG, PNG, WebP or GIF")
    end
    FileUtils.mkdir_p(PHOTO_DIR)
    names = photos.zip(exts).map do |d, ext|
      name = "#{SecureRandom.hex(16)}.#{ext}"
      File.binwrite(File.join(PHOTO_DIR, name), d)
      name
    end
    item = { "id" => SecureRandom.hex(6), "type" => type, "title" => title, "description" => description, "page" => page,
             "loggedBy" => logged_by, "createdAt" => Time.now.utc.iso8601, "status" => "open", "photos" => names, "notes" => [] }
    change_feedback { |items| items.unshift(item) }
    json(res, 201, item)
  in ["POST", %r{\A/api/feedback/([0-9a-f]{12})/(note|signoff|reopen)\z}]
    id, action = req.path.match(%r{([0-9a-f]{12})/(\w+)\z}).captures
    next json(res, 403, error: "Only an owner can sign off or reopen") if action != "note" && !owner?(req)
    next json(res, 403, error: "Only computers on the College network can add notes") unless can?(req, "contributor")
    body = (JSON.parse(req.body.to_s) rescue {})
    body = {} unless body.is_a?(Hash)
    note = body["text"].to_s.strip[0, 2000]
    by = me[:name] || body["by"].to_s.strip[0, 80]
    by = "Unknown" if by.empty?
    next json(res, 400, error: "Write a note first") if action == "note" && note.empty?
    now = Time.now.utc.iso8601
    item = change_feedback do |items|
      it = items.find { |x| x["id"] == id }
      next nil unless it
      it["notes"] ||= []
      it["notes"] << { "text" => note, "by" => by, "at" => now } unless note.empty?
      case action
      when "signoff" then it.merge!("status" => "signed-off", "signedOffAt" => now, "signedOffBy" => by)
      when "reopen" then it["status"] = "open"; it.delete("signedOffAt"); it.delete("signedOffBy")
      end
      it
    end
    item ? json(res, 200, item) : json(res, 404, error: "That request no longer exists")
  in ["GET", %r{\A/api/feedback/photos/}]
    name = File.basename(req.path)
    path = File.join(PHOTO_DIR, name)
    next json(res, 404, error: "No such photo") unless name.match?(PHOTO_NAME) && File.file?(path)
    res["Content-Type"] = PHOTO_TYPES[File.extname(name).delete(".")]
    res["X-Content-Type-Options"] = "nosniff"
    res["Cache-Control"] = "private, max-age=86400"
    res.body = File.binread(path)
  else
    json(res, 404, error: "Not found")
  end
rescue JSON::ParserError
  json(res, 500, error: "features-bugs.json isn't valid JSON, so it wasn't changed")
end

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }
puts "Rack View running on #{tls.empty? ? "http" : "https"} port #{PORT}"
puts "Data folder: #{DATA_DIR}"
puts "Sign-in: #{ { sso: "Microsoft Entra ID", setup: "required but not configured (setup page only)", network: "none, roles by network address (testing)" }[SSO_MODE] }"
warn "Note: sign-in needs https; set TLS_CERT, or put IIS/nginx in front with TRUST_PROXY=1" if SSO_MODE == :sso && tls.empty? && !TRUST_PROXY
puts "Rack data: #{DATA_FILE}"
server.start
