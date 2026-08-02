<#
  MT5 Windows Companion — production installer.

  Installs the companion as a Windows Service (auto-start on boot, automatic
  restart on failure), asks only for the values you actually have, stores the
  MT5 credentials encrypted with Windows DPAPI, and verifies the backend
  connection before finishing.

  Run in an elevated PowerShell:
     powershell -ExecutionPolicy Bypass -File install.ps1

  Non-interactive / re-install:
     install.ps1 -BackendUrl wss://host/companion -BridgeToken xxx `
                 -AccountId <uuid> -Login 12345 -Password 'pw' -Server 'Broker-Server'
  Maintenance:
     install.ps1 -Upgrade      # re-sync deps + restart service, keep credentials
     install.ps1 -Uninstall    # remove the service (keeps files)
#>
[CmdletBinding()]
param(
  [string]$BackendUrl,
  [string]$BridgeToken,
  [string]$AccountId,
  [string]$Login,
  [string]$Password,
  [string]$Server,
  [string]$TerminalPath,
  [switch]$Upgrade,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$ServiceName = 'MT5Companion'
$Root        = $PSScriptRoot
$Venv        = Join-Path $Root '.venv'
$Py          = Join-Path $Venv 'Scripts\python.exe'
$SecureCfg   = Join-Path $Root 'config.secure.json'
$LogDir      = Join-Path $Root 'logs'
$NssmExe     = Join-Path $Root 'nssm.exe'

$script:Step = 0; $script:Total = 8
function Step($m) { $script:Step++; Write-Host "[$script:Step/$script:Total] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "      ok - $m" -ForegroundColor Green }
function Warn($m) { Write-Host "      ! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host ""; Write-Host "ERROR: $m" -ForegroundColor Red; Write-Host "Installation aborted." -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------- elevation
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die "run this in an ELEVATED PowerShell (right-click -> Run as Administrator)." }

# --------------------------------------------------------------- uninstall
if ($Uninstall) {
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    & sc.exe stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    & sc.exe delete $ServiceName | Out-Null
    Write-Host "Service '$ServiceName' removed. Credentials remain in $SecureCfg." -ForegroundColor Green
  } else { Write-Host "Service '$ServiceName' is not installed." -ForegroundColor Yellow }
  exit 0
}

Write-Host ""
Write-Host " +------------------------------------------------+" -ForegroundColor Magenta
Write-Host " |  MT5 Windows Companion  -  service installer   |" -ForegroundColor Magenta
Write-Host " +------------------------------------------------+" -ForegroundColor Magenta

# ----------------------------------------------------------------- 1 python
Step "checking Python 3.10+"
$sysPy = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $sysPy) { Die "Python is not installed or not on PATH. Install Python 3.11 from python.org and tick 'Add python.exe to PATH'." }
$ver = & python -c "import sys;print('%d.%d'%sys.version_info[:2])"
if ([version]$ver -lt [version]'3.10') { Die "Python $ver found; 3.10 or newer is required." }
Ok "python $ver"

# ------------------------------------------------------------------- 2 mt5
Step "checking MetaTrader 5 terminal"
if (-not $TerminalPath) {
  $candidates = @(
    "$env:ProgramFiles\MetaTrader 5\terminal64.exe",
    "${env:ProgramFiles(x86)}\MetaTrader 5\terminal64.exe",
    "C:\MT5\acct1\terminal64.exe"
  ) + (Get-ChildItem "$env:ProgramFiles" -Filter 'terminal64.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
       Select-Object -ExpandProperty FullName)
  $TerminalPath = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if ($TerminalPath) { Ok "terminal64.exe at $TerminalPath" }
else { Warn "terminal64.exe not found automatically - the companion will use the default MT5 install at runtime." }

# ------------------------------------------------------------------ 3 venv
Step "creating virtual environment + installing packages"
if (-not (Test-Path $Py)) { & python -m venv $Venv }
& $Py -m pip install --upgrade pip --quiet
& $Py -m pip install -r (Join-Path $Root 'requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { Die "pip install failed - check the internet connection on this machine." }
Ok "dependencies installed"

# ---------------------------------------------------------------- 4 wizard
Step "setup wizard"
function AskText($label, $current, [switch]$Required) {
  if ($current) { return $current }
  while ($true) {
    $v = Read-Host "      $label"
    if ($v -or -not $Required) { return $v }
    Write-Host "      this value is required" -ForegroundColor Yellow
  }
}

$existing = $null
if ((Test-Path $SecureCfg) -and ($Upgrade -or -not $BridgeToken)) {
  try {
    Add-Type -AssemblyName System.Security
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
      [Convert]::FromBase64String((Get-Content $SecureCfg -Raw).Trim()), $null, 'LocalMachine')
    $existing = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    Ok "existing configuration found - press Enter to keep each value"
  } catch { Warn "existing config could not be read; it will be recreated" }
}

if ($Upgrade -and $existing) {
  $cfgObj = $existing
} else {
  $acct0        = if ($existing) { $existing.accounts[0] } else { $null }
  $BackendUrl   = AskText "Backend URL (wss://host/companion)$(if($existing){' ['+$existing.backend_ws_url+']'})" $BackendUrl
  if (-not $BackendUrl -and $existing) { $BackendUrl = $existing.backend_ws_url }
  if (-not $BackendUrl) { Die "Backend URL is required (shown at the end of the Ubuntu installer)." }
  if ($BackendUrl -notmatch '^wss?://') { Die "Backend URL must start with ws:// or wss://" }

  $BridgeToken  = AskText "Bridge Token" ($BridgeToken ? $BridgeToken : $existing.bridge_token) -Required
  $AccountId    = AskText "Account ID (UUID from the dashboard Accounts page)" ($AccountId ? $AccountId : $acct0.account_id) -Required
  $Login        = AskText "MT5 Login" ($Login ? $Login : $(if($acct0){"$($acct0.login)"})) -Required
  $Server       = AskText "MT5 Server" ($Server ? $Server : $acct0.server) -Required
  if (-not $Password) {
    if ($acct0 -and $acct0.password) {
      $sec = Read-Host "      MT5 Password (Enter = keep current)" -AsSecureString
      $tmp = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      $Password = if ($tmp) { $tmp } else { $acct0.password }
    } else {
      while (-not $Password) {
        $sec = Read-Host "      MT5 Password" -AsSecureString
        $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
          [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      }
    }
  }
  if ($Login -notmatch '^\d+$') { Die "MT5 Login must be numeric." }

  $cfgObj = [ordered]@{
    name                  = $env:COMPUTERNAME
    backend_ws_url        = $BackendUrl
    bridge_token          = $BridgeToken
    verify_tls            = $true
    log_level             = 'INFO'
    health_seconds        = 10
    max_reconnect_seconds = 60
    terminal_path         = $TerminalPath
    accounts              = @(@{
      account_id    = $AccountId
      login         = [int64]$Login
      password      = $Password
      server        = $Server
      terminal_path = $TerminalPath
      portable      = $false
    })
  }
}
Ok "configuration collected"

# ------------------------------------------------------- 5 verify backend
Step "verifying the backend connection"
$verifyUrl = $cfgObj.backend_ws_url
$verifyTok = $cfgObj.bridge_token
$out = & $Py (Join-Path $Root 'verify_connection.py') $verifyUrl $verifyTok 2>&1
Write-Host ("      " + ($out -join "`n      "))
if ($LASTEXITCODE -ne 0) {
  Die "backend verification failed. Fix the issue above, then re-run install.ps1. Nothing was installed as a service."
}
Ok "backend reachable and token accepted"

# ------------------------------------------------ 6 store credentials (DPAPI)
Step "encrypting credentials with Windows DPAPI"
Add-Type -AssemblyName System.Security
$json  = ($cfgObj | ConvertTo-Json -Depth 6)
$enc   = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($json), $null, 'LocalMachine')
[IO.File]::WriteAllText($SecureCfg, [Convert]::ToBase64String($enc))
$acl = Get-Acl $SecureCfg
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','Allow')))
$acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Administrators','FullControl','Allow')))
Set-Acl $SecureCfg $acl
Remove-Item (Join-Path $Root 'config.json') -ErrorAction SilentlyContinue
Ok "credentials stored in config.secure.json (machine-bound, SYSTEM+Admins only)"

# ---------------------------------------------------------- 7 windows service
Step "installing the Windows service"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path $NssmExe)) {
  try {
    $zip = Join-Path $env:TEMP 'nssm.zip'; $dst = Join-Path $env:TEMP 'nssm-extract'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
    Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip $dst -Force
    Copy-Item (Join-Path $dst 'nssm-2.24\win64\nssm.exe') $NssmExe -Force
  } catch { Warn "could not download nssm ($_) - falling back to sc.exe" }
}

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  & sc.exe stop $ServiceName | Out-Null; Start-Sleep -Seconds 2
  if (Test-Path $NssmExe) { & $NssmExe remove $ServiceName confirm | Out-Null }
  else { & sc.exe delete $ServiceName | Out-Null }
  Start-Sleep -Seconds 2
}

if (Test-Path $NssmExe) {
  & $NssmExe install $ServiceName $Py (Join-Path $Root 'companion.py') | Out-Null
  & $NssmExe set $ServiceName AppDirectory $Root                | Out-Null
  & $NssmExe set $ServiceName DisplayName 'MT5 Windows Companion' | Out-Null
  & $NssmExe set $ServiceName Description 'Runs MetaTrader 5 and keeps a secure link to the trading backend.' | Out-Null
  & $NssmExe set $ServiceName Start SERVICE_AUTO_START          | Out-Null
  & $NssmExe set $ServiceName AppExit Default Restart           | Out-Null
  & $NssmExe set $ServiceName AppRestartDelay 5000              | Out-Null
  & $NssmExe set $ServiceName AppStdout (Join-Path $LogDir 'companion.log') | Out-Null
  & $NssmExe set $ServiceName AppStderr (Join-Path $LogDir 'companion.err.log') | Out-Null
  & $NssmExe set $ServiceName AppRotateFiles 1                  | Out-Null
  & $NssmExe set $ServiceName AppRotateBytes 10485760           | Out-Null
  Ok "service registered via nssm (auto-start, auto-restart)"
} else {
  $bin = "`"$Py`" `"$(Join-Path $Root 'companion.py')`""
  & sc.exe create $ServiceName binPath= $bin start= auto DisplayName= 'MT5 Windows Companion' | Out-Null
  Ok "service registered via sc.exe"
}
& sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/10000/restart/30000 | Out-Null
& sc.exe config  $ServiceName start= delayed-auto | Out-Null

# ---------------------------------------------------------------- 8 start
Step "starting and verifying the service"
& sc.exe start $ServiceName | Out-Null
$running = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') { $running = $true; break }
}
if (-not $running) {
  $log = Join-Path $LogDir 'companion.err.log'
  if (Test-Path $log) { Write-Host (Get-Content $log -Tail 20 | Out-String) -ForegroundColor Red }
  Die "the service did not reach 'Running'. See $LogDir for details, then re-run install.ps1."
}
Ok "service '$ServiceName' is running"

$logFile = Join-Path $LogDir 'companion.log'
Start-Sleep -Seconds 6
if (Test-Path $logFile) {
  $tail = Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue
  if ($tail -match 'connected') { Ok "linked to the backend" }
  elseif ($tail -match 'backend link down') { Warn "link retrying - check the URL/firewall; the service keeps retrying automatically" }
  if ($tail -match 'MT5 login failed|initialize failed') { Warn "MT5 login problem - verify login/password/server in MetaTrader 5" }
}

Write-Host ""
Write-Host "======== Windows Companion installed ========" -ForegroundColor Green
Write-Host @"

  Service      : $ServiceName (starts automatically on Windows boot)
  Config       : $SecureCfg  (DPAPI encrypted, machine-bound)
  Logs         : $LogDir

  Manage:
    Get-Service $ServiceName
    Restart-Service $ServiceName
    Get-Content "$logFile" -Tail 50 -Wait
    .\install.ps1 -Upgrade      # update deps + restart, keep credentials
    .\install.ps1 -Uninstall    # remove the service

  On the Ubuntu server confirm the link:
    curl -s http://127.0.0.1:8766/status | jq

"@ -ForegroundColor Gray