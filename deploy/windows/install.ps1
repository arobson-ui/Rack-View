# Installs (or upgrades) WCC Rack View as a background service that starts with Windows.
# Run from the unpacked release folder in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-InstallDir "D:\Rack View"] [-Port 443] [-DataDir "D:\WCC Rack Data"]
# Without -InstallDir it asks where to install, defaulting to this folder (the app then runs from here).
param([string]$InstallDir, [int]$Port = 443, [string]$DataDir = "$env:ProgramData\WCC Rack View\data")
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
    throw 'Run this from an Administrator PowerShell.'
}
$here = $PSScriptRoot
if (-not $InstallDir) {
    $InstallDir = Read-Host "Install location [$here]"
    if (-not $InstallDir) { $InstallDir = $here }
}
New-Item -ItemType Directory -Force $InstallDir | Out-Null
$app  = (Resolve-Path $InstallDir).Path.TrimEnd('\')
$conf = "$env:ProgramData\WCC Rack View"
$task = 'WCC Rack View'

# The package carries its own Ruby (ruby\), so nothing needs installing. Without it (e.g. a source checkout),
# fall back to an installed Ruby 3.0+ (an older one on the PATH is skipped).
function Find-Ruby3 {
    $candidates = @("$app\ruby\bin\ruby.exe", "$here\ruby\bin\ruby.exe")
    $candidates += @(Get-Command ruby -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $candidates += @(Get-ChildItem 'C:\Ruby3*\bin\ruby.exe', "$env:ProgramFiles\Ruby3*\bin\ruby.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
    foreach ($r in ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
        & $r -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.0") ? 0 : 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { return $r }
    }
    return $null
}

Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $app, $conf, $DataDir | Out-Null
if ($app -ne $here.TrimEnd('\')) {
    foreach ($item in 'serve.rb', 'unifi.rb', 'sso.rb', 'index.html', 'run.ps1', 'update.ps1', 'uninstall.ps1', 'VERSION', 'css', 'js', 'img', 'vendor', 'ruby') {
        if (Test-Path (Join-Path $here $item)) { Copy-Item (Join-Path $here $item) $app -Recurse -Force }
    }
}
$ruby = Find-Ruby3
if (-not $ruby) { throw 'No Ruby 3 found: this package should include one in ruby\. Re-download the release.' }
Write-Host "Using $(& $ruby -v)"
$cfg = Join-Path $conf 'config.env'
if (-not (Test-Path $cfg)) {
    # Release: https on port 443, sign-in required. A certificate dropped in the app folder is used for https;
    # without one, put IIS in front (see README-deploy.md).
    $cert = Get-ChildItem $app -File | Where-Object { $_.Extension -in '.pfx', '.p12', '.crt', '.pem' } | Select-Object -First 1
    $tls = @{}
    if ($cert) {
        $tls.TLS_CERT = $cert.Name
        if ($cert.Extension -in '.pfx', '.p12') { $tls.TLS_PFX_PASSWORD = Read-Host "Password for $($cert.Name)" }
        else { $tls.TLS_KEY = (Get-ChildItem $app -Filter *.key | Select-Object -First 1).Name }
        Write-Host "Using certificate $($cert.Name) for https on port 443."
    }
    (Get-Content (Join-Path $here 'config.example.env')) `
        -replace '^RACK_DATA_DIR=.*', "RACK_DATA_DIR=$DataDir" `
        -replace '^PORT=.*', "PORT=$Port" |
        ForEach-Object { if ($_ -match '^([A-Z_]+)=' -and $tls.ContainsKey($Matches[1])) { "$($Matches[1])=$($tls[$Matches[1]])" } else { $_ } } |
        Set-Content $cfg -Encoding ascii
}
# Add any settings that are new in this version, keeping existing values
$have = (Get-Content $cfg) -match '^[A-Z_]+=' -replace '=.*', ''
Get-Content (Join-Path $here 'config.example.env') | Where-Object { $_ -match '^([A-Z_]+)=' -and $have -notcontains $Matches[1] } | Add-Content $cfg -Encoding ascii
# config.env will hold the Entra client secret: only Administrators and SYSTEM may read it
icacls $cfg /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$app\run.ps1`" -Config `"$cfg`" -Ruby `"$ruby`""
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $task

$port = ((Get-Content $cfg) -match '^PORT=' -replace '^PORT=', '').Trim()
Get-NetFirewallRule -DisplayName $task -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$ports = @($port); if (((Get-Content $cfg) -match '^TLS_CERT=.+')) { $ports += ((Get-Content $cfg) -match '^HTTP_REDIRECT_PORT=' -replace '^HTTP_REDIRECT_PORT=', '').Trim() }
New-NetFirewallRule -DisplayName $task -Direction Inbound -Protocol TCP -LocalPort ($ports | Where-Object { $_ -and $_ -ne '0' }) -Action Allow | Out-Null

Write-Host "Installed in $app and started on port $port."
Write-Host "Settings: $cfg   Data: $DataDir   Log: $conf\server.log"
Write-Host "After editing settings: Stop-ScheduledTask '$task'; Start-ScheduledTask '$task'"
