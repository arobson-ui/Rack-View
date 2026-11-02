# Removes the service and firewall rule. Keeps the app folder, settings and data (delete them by hand if wanted).
$task = 'WCC Rack View'
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName $task -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Service removed. App folder, settings and data were kept.'
