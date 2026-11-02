# Starts the server with the settings in config.env. The service runs this; you can also run it by hand.
param([string]$Config = "$env:ProgramData\WCC Rack View\config.env", [string]$Ruby = "ruby")
Get-Content $Config | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process')
}
$log = Join-Path (Split-Path $Config) 'server.log'
& $Ruby (Join-Path $PSScriptRoot 'serve.rb') *>> $log
exit $LASTEXITCODE
