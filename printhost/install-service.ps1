<#
.SYNOPSIS
    Install the poster print agent as a Windows service, with the printer
    settings it needs.

.DESCRIPTION
    Run once, elevated, from C:\PosterPrint. Uses node-windows if present,
    otherwise falls back to sc.exe wrapping node.exe directly.

    IMPORTANT — the service must run as an account that can see the printers.
    LocalSystem can enumerate them but per-user driver defaults won't apply.
    Use a dedicated domain service account (e.g. KENT\svc-posterprint) that is
    a local Administrator on this host and has "Manage documents" on each
    poster printer.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'C:\PosterPrint',
    [string]$ServiceName = 'PosterPrintAgent',
    [string]$ServiceAccount = '',        # e.g. 'KENT\svc-posterprint'
    [System.Security.SecureString]$ServicePassword,
    [string[]]$PrinterNames = @('Canon PRO-4100-36', 'Canon PRO-4100-42')
)

$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell session.'
}

Write-Host '== Poster print agent setup ==' -ForegroundColor Cyan

# --- 1. directories ---------------------------------------------------------
foreach ($d in @($InstallDir, "$InstallDir\scripts", "$InstallDir\certs",
                 'C:\ProgramData\PosterPrint\spool', 'C:\ProgramData\PosterPrint\logs')) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Write-Host "  dir  $d"
}

# --- 2. lock down the secret ------------------------------------------------
$envFile = Join-Path $InstallDir '.env'
if (Test-Path $envFile) {
    $acl = Get-Acl $envFile
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    foreach ($id in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') +
                    @($ServiceAccount | Where-Object { $_ })) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $id, 'FullControl', 'Allow')))
    }
    Set-Acl $envFile $acl
    Write-Host '  acl  .env restricted' -ForegroundColor Green
} else {
    Write-Warning "  no .env at $envFile — copy .env.example and fill in PP_HMAC_SECRET"
}

# --- 3. verify the printers -------------------------------------------------
Write-Host "`n-- printers --"
foreach ($p in $PrinterNames) {
    $printer = Get-Printer -Name $p -ErrorAction SilentlyContinue
    if ($printer) {
        Write-Host "  OK   $p  [$($printer.DriverName)] $($printer.PrinterStatus)" -ForegroundColor Green

        # Keep printed documents, so the agent can read a terminal state
        # instead of inferring completion from a job vanishing. The agent's
        # reaper prunes these; without pruning the spool folder fills up.
        try {
            Set-PrintConfiguration -PrinterName $p -KeepPrintedJobs $true -ErrorAction Stop
            Write-Host '       keep-printed-documents: on'
        } catch { Write-Warning "       could not set KeepPrintedJobs: $($_.Exception.Message)" }

        # Spool then print: a 300 MB raster should not be dripped to the
        # device while GDI is still rendering it.
        try {
            $reg = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers\$p"
            if (Test-Path $reg) {
                Set-ItemProperty -Path $reg -Name 'Attributes' -Value 0x00000200 -ErrorAction SilentlyContinue
            }
        } catch { }
    } else {
        Write-Warning "  MISS $p  — install the Canon driver and name the queue exactly this"
    }
}

# --- 4. firewall ------------------------------------------------------------
$ruleName = 'Poster Print Agent inbound'
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort 8443 -Profile Domain | Out-Null
    Write-Host "`n  fw   opened TCP 8443 (Domain profile)" -ForegroundColor Green
    Write-Warning '  Narrow this to the portal server IP with -RemoteAddress before production.'
}

# --- 5. the service ---------------------------------------------------------
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not on PATH. Install Node 20 LTS x64 first.' }

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "`n  svc  $ServiceName exists — stopping to update"
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

$binPath = "`"$node`" `"$InstallDir\agent.js`""
$scArgs = @('create', $ServiceName, "binPath=$binPath", 'start=auto',
            'DisplayName=Poster Print Agent')
if ($ServiceAccount) {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword))
    $scArgs += "obj=$ServiceAccount"
    $scArgs += "password=$plain"
}
& sc.exe @scArgs | Out-Null
& sc.exe description $ServiceName 'Receives poster print jobs from the KSU poster portal' | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Write-Host "`n  svc  $ServiceName created" -ForegroundColor Green
Write-Host "`nNext:"
Write-Host "  1. Put PP_HMAC_SECRET in $envFile"
Write-Host "  2. Drop a TLS cert in $InstallDir\certs (or clear PP_TLS_* for a trusted VLAN)"
Write-Host "  3. Start-Service $ServiceName"
Write-Host "  4. Invoke-RestMethod http://localhost:8443/healthz"
Write-Host "  5. Confirm the portal shows this host as online under /admin -> Printers`n"
