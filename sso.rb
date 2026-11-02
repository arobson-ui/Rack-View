# Microsoft Entra ID sign-in for serve.rb (OpenID Connect: authorization code + PKCE).
#
# Settings come from config.env (environment variables):
#   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_REDIRECT_URI,
#   ENTRA_OWNER_GROUP_ID, ENTRA_ADMIN_GROUP_ID
# Modes:
#   sso      all six are set: everyone signs in; the Owner group can do everything (incl. UniFi sync and
#            signing off features/bugs), the Admin group edits racks and logs features/bugs, anyone else is turned away
#   setup    REQUIRE_SSO=1 (the release packages) or only some are set: nothing is shown except a page
#            listing what's missing, so the data is never exposed without sign-in
#   network  none are set and REQUIRE_SSO isn't 1 (testing): roles go by network address, as before
# The groups claim must be on (Entra: App registration > Token configuration > Add groups claim).
require "net/http"
require "uri"
require "openssl"
require "json"
require "securerandom"
require "base64"
require "digest"
require "cgi"
require "time"

module SSO
  SESSION_HOURS = 8
  COOKIE = "rv_session"
  SETTINGS = {
    "ENTRA_TENANT_ID" => "Directory (tenant) ID",
    "ENTRA_CLIENT_ID" => "Application (client) ID",
    "ENTRA_CLIENT_SECRET" => "Client secret value",
    "ENTRA_REDIRECT_URI" => "Redirect URI, e.g. https://rackview.example.org/auth/callback",
    "ENTRA_OWNER_GROUP_ID" => "Object ID of the Rack View Owner group",
    "ENTRA_ADMIN_GROUP_ID" => "Object ID of the Rack View Admin group"
  }.freeze
  @sessions = {}
  @pending = {}
  @lock = Mutex.new

  module_function

  def env(key)
    ENV[key].to_s.strip
  end

  def missing
    SETTINGS.keys.select { |k| env(k).empty? }
  end

  def mode
    return :sso if missing.empty?
    return :setup if ENV["REQUIRE_SSO"].to_s.strip == "1" || missing.size < SETTINGS.size # half-filled never falls open
    :network
  end

  # Microsoft's sign-in address (ENTRA_AUTHORITY can point elsewhere for testing)
  def authority
    a = env("ENTRA_AUTHORITY")
    (a.empty? ? "https://login.microsoftonline.com" : a).sub(%r{/+\z}, "")
  end

  def endpoint(path)
    "#{authority}/#{env("ENTRA_TENANT_ID")}/oauth2/v2.0/#{path}"
  end

  def b64url(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  # The address people use, from the redirect URI (e.g. https://rackview.example.org)
  def site
    u = URI(env("ENTRA_REDIRECT_URI"))
    "#{u.scheme}://#{u.host}#{[80, 443].include?(u.port) ? "" : ":#{u.port}"}"
  rescue URI::Error
    ""
  end

  def cookie(value, max_age)
    secure = env("ENTRA_REDIRECT_URI").start_with?("https") ? "; Secure" : ""
    "#{COOKIE}=#{value}; Path=/; HttpOnly; SameSite=Lax#{secure}; Max-Age=#{max_age}"
  end

  # The signed-in person for this request, or nil
  def session(req)
    c = req.cookies.find { |x| x.name == COOKIE } or return nil
    @lock.synchronize do
      s = @sessions[c.value]
      next s if s && s[:exp] > Time.now
      @sessions.delete(c.value)
      nil
    end
  end

  def logout(req)
    c = req.cookies.find { |x| x.name == COOKIE }
    @lock.synchronize { @sessions.delete(c.value) } if c
  end

  def logout_url
    "#{endpoint("logout")}?#{URI.encode_www_form(post_logout_redirect_uri: "#{site}/")}"
  end

  # Where to send the browser to sign in. return_to is the app's #/… address, so people land where they were.
  def login_url(return_to)
    verifier = b64url(SecureRandom.random_bytes(32))
    state = SecureRandom.hex(16)
    nonce = SecureRandom.hex(16)
    back = return_to.to_s.start_with?("#/") ? return_to.to_s[0, 300] : ""
    @lock.synchronize do
      @pending.delete_if { |_, v| v[:exp] < Time.now }
      @pending[state] = { verifier: verifier, nonce: nonce, back: back, exp: Time.now + 600 }
    end
    q = URI.encode_www_form(client_id: env("ENTRA_CLIENT_ID"), response_type: "code", redirect_uri: env("ENTRA_REDIRECT_URI"),
                            response_mode: "query", scope: "openid profile email", state: state, nonce: nonce,
                            code_challenge: b64url(Digest::SHA256.digest(verifier)), code_challenge_method: "S256")
    "#{endpoint("authorize")}?#{q}"
  end

  # Finish signing in. Returns [:ok, session_id, back], [:blocked, name, reason] or [:error, message].
  def callback(query)
    return [:error, "Sign-in was cancelled or refused: #{query["error_description"].to_s[0, 300]}"] unless query["error"].to_s.empty?
    pend = @lock.synchronize { @pending.delete(query["state"].to_s) }
    return [:error, "That sign-in link has expired. Please try again."] unless pend && pend[:exp] > Time.now && !query["code"].to_s.empty?

    res = Net::HTTP.post_form(URI(endpoint("token")),
                              client_id: env("ENTRA_CLIENT_ID"), client_secret: env("ENTRA_CLIENT_SECRET"),
                              grant_type: "authorization_code", code: query["code"].to_s, redirect_uri: env("ENTRA_REDIRECT_URI"),
                              code_verifier: pend[:verifier], scope: "openid profile email")
    body = begin
      JSON.parse(res.body)
    rescue JSON::ParserError
      {}
    end
    unless res.is_a?(Net::HTTPSuccess) && body["id_token"]
      return [:error, "Microsoft didn't accept the sign-in (#{body["error"] || res.code}). #{body["error_description"].to_s.lines.first.to_s.strip[0, 300]}"]
    end

    claims = decode(body["id_token"])
    # The ID token came straight from Microsoft's token endpoint over HTTPS, in exchange for this app's own code
    # and secret, so checking who it's for and that it's fresh is enough (OpenID Connect Core 3.1.3.7).
    tenant = env("ENTRA_TENANT_ID")
    fresh = claims["exp"].to_i > Time.now.to_i - 60
    ours = claims["aud"] == env("ENTRA_CLIENT_ID") && claims["nonce"] == pend[:nonce] && claims["iss"].to_s.start_with?(authority)
    right_tenant = tenant !~ /\A\h{8}-(\h{4}-){3}\h{12}\z/ || claims["tid"] == tenant
    return [:error, "The sign-in response didn't check out. Please try again."] unless fresh && ours && right_tenant

    name = claims["name"] || claims["preferred_username"] || "Signed in"
    email = claims["preferred_username"] || claims["email"]
    if claims.dig("_claim_names", "groups")
      return [:blocked, name, "Your account is in more groups than Microsoft will list at sign-in. IT can fix this by setting the app's groups claim to \"Groups assigned to the application\"."]
    end
    groups = Array(claims["groups"])
    role = if groups.include?(env("ENTRA_OWNER_GROUP_ID")) then "owner"
           elsif groups.include?(env("ENTRA_ADMIN_GROUP_ID")) then "admin"
           end
    return [:blocked, name, nil] unless role

    sid = SecureRandom.hex(32)
    @lock.synchronize do
      @sessions.delete_if { |_, v| v[:exp] < Time.now }
      @sessions[sid] = { name: name, email: email, role: role, exp: Time.now + SESSION_HOURS * 3600 }
    end
    [:ok, sid, pend[:back]]
  rescue StandardError => e
    [:error, "Couldn't finish signing in (#{e.class.name.split("::").last}). Please try again."]
  end

  def decode(jwt)
    part = jwt.to_s.split(".")[1].to_s
    JSON.parse(Base64.urlsafe_decode64(part + ("=" * (-part.size % 4))))
  end

  # A plain page in the app's style, for sign-in problems and the setup screen
  def page(title, html)
    <<~HTML
      <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>#{CGI.escapeHTML(title)} · Rack View</title>
      <style>
        body{margin:0;font:15px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;background:#f7f8fb;color:#0f172a;display:grid;place-items:center;min-height:100vh}
        main{background:#fff;border:1px solid #e5e8ef;border-radius:14px;box-shadow:0 4px 16px rgba(15,23,42,.06);padding:32px 36px;max-width:560px;margin:24px}
        h1{color:#00205b;font-size:24px;margin:0 0 10px}p{margin:8px 0;color:#334155}code{background:#eef0f5;padding:1px 6px;border-radius:5px;font-size:13px}
        ul{padding-left:20px;color:#334155}li{margin:4px 0}a.btn{display:inline-block;margin-top:14px;background:#00205b;color:#fff;text-decoration:none;padding:9px 16px;border-radius:10px;font-weight:600}
        .logo{height:48px;margin-bottom:14px}
      </style></head><body><main><img class="logo" src="/img/wcc-logo.svg" alt="Westside Christian College">
      <h1>#{CGI.escapeHTML(title)}</h1>#{html}</main></body></html>
    HTML
  end

  def setup_page
    items = missing.map { |k| "<li><code>#{k}</code> · #{CGI.escapeHTML(SETTINGS[k])}</li>" }.join
    page("Sign-in isn't set up yet", <<~HTML)
      <p>Rack View only opens once Microsoft sign-in is configured, so nothing is shown until then.</p>
      <p>Add these to <code>config.env</code> on the server, then restart the service:</p><ul>#{items}</ul>
      <p>See IT-HANDOVER.md for the Entra app registration steps.</p>
    HTML
  end
end
