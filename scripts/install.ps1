# Installs or updates cmd on Windows (x64, or Arm via emulation), per user, no admin:
#   irm https://raw.githubusercontent.com/janoelze/cmd/master/scripts/install.ps1 | iex
# Downloads the latest release's installer and runs it silently. Files PowerShell
# downloads carry no Mark of the Web, so SmartScreen doesn't stop the (not yet
# signed) installer. $env:CMD_VERSION = "0.3.0" installs a specific release.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is much faster without its progress bar

$repo = "janoelze/cmd"
$api = if ($env:CMD_VERSION) { "https://api.github.com/repos/$repo/releases/tags/v$($env:CMD_VERSION.TrimStart('v'))" } else { "https://api.github.com/repos/$repo/releases/latest" }
$release = Invoke-RestMethod $api -Headers @{ "User-Agent" = "cmd-install" }
$asset = $release.assets | Where-Object { $_.name -like "*-win-x64-setup.exe" } | Select-Object -First 1
if (-not $asset) { throw "no Windows installer in $($release.tag_name)" }

$exe = Join-Path $env:TEMP $asset.name
Write-Host "downloading $($asset.browser_download_url)"
Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing
# The installer closes a running cmd first; the core and its terminals keep running.
Write-Host "installing cmd $($release.tag_name)"
Start-Process $exe -ArgumentList "/S" -Wait
Remove-Item $exe -ErrorAction SilentlyContinue

$app = Join-Path $env:LOCALAPPDATA "Programs\cmd\cmd.exe"
if (Test-Path $app) {
  Write-Host "installed $app"
  Start-Process $app
} else {
  Write-Host "installed; start cmd from the Start menu"
}
