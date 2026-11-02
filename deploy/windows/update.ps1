# Updates Rack View to the latest GitHub release. Keeps settings and data.
# Run in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File "<install folder>\update.ps1" [-Force]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cfg = "$env:ProgramData\WCC Rack View\config.env"
$conf = @{}
Get-Content $cfg | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $conf[$Matches[1]] = $Matches[2].Trim() }
# The repository is public, so no token is needed; GITHUB_TOKEN is only for a private fork
$h = @{ 'X-GitHub-Api-Version' = '2022-11-28' }
if ($conf.GITHUB_TOKEN) { $h.Authorization = "Bearer $($conf.GITHUB_TOKEN)" }
$rel = Invoke-RestMethod -Headers $h "https://api.github.com/repos/$($conf.GITHUB_REPO)/releases/latest"
$verFile = Join-Path $PSScriptRoot 'VERSION'
$cur = if (Test-Path $verFile) { (Get-Content $verFile -TotalCount 1).Trim() } else { 'none' }
Write-Host "Installed: $cur   Latest: $($rel.tag_name)"
if ($cur -eq $rel.tag_name -and -not $Force) { Write-Host 'Already up to date.'; return }
$asset = $rel.assets | Where-Object { $_.name -like '*windows*.zip' } | Select-Object -First 1
if (-not $asset) { throw "No Windows package on release $($rel.tag_name)" }
$tmp = Join-Path $env:TEMP "rackview-update-$([guid]::NewGuid())"
New-Item -ItemType Directory $tmp | Out-Null
try {
    $h.Accept = 'application/octet-stream'
    Invoke-WebRequest -Headers $h $asset.url -OutFile "$tmp\pkg.zip" -UseBasicParsing
    Expand-Archive "$tmp\pkg.zip" $tmp
    $pkg = Get-ChildItem $tmp -Directory | Select-Object -First 1
    & "$($pkg.FullName)\install.ps1" -InstallDir $PSScriptRoot -Port ([int]$conf.PORT)
    Write-Host "Updated to $($rel.tag_name)."
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
