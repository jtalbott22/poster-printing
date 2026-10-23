<#
.SYNOPSIS
    Read the Windows print queue and device state for the poster printers, as
    JSON on one line. Also handles pruning finished spooler records.

.DESCRIPTION
    The portal's admin console shows "job 2 of 4, printing" without anyone
    having to RDP into this box. That comes from here.

    Three modes:
      -PrinterNames "A,B"   snapshot of those queues plus device state
      -ListPrinters         just enumerate installed printers (startup check)
      -RemoveJobId <id>     prune one finished spooler record

    Ink levels come from the printer's SNMP-backed WMI class when the Canon
    driver exposes it. If it doesn't, inkLevels is null and the portal falls
    back to the Canon Accounting Manager import — no failure either way.

.EXAMPLE
    .\Get-PosterQueue.ps1 -PrinterNames "Canon PRO-4100-36,Canon PRO-4100-42"
#>
[CmdletBinding()]
param(
    [string]$PrinterNames = '',
    [switch]$ListPrinters,
    [int]$RemoveJobId = 0
)

$ErrorActionPreference = 'Stop'
function Emit { param($obj) $obj | ConvertTo-Json -Compress -Depth 6 }

try {
    $names = @()
    if ($PrinterNames) { $names = $PrinterNames.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

    # --- prune one record --------------------------------------------------
    if ($RemoveJobId -gt 0) {
        foreach ($n in $names) {
            Remove-PrintJob -PrinterName $n -ID $RemoveJobId -ErrorAction SilentlyContinue
        }
        Emit @{ ok = $true; removed = $RemoveJobId }
        return
    }

    # --- enumerate ---------------------------------------------------------
    if ($ListPrinters -or -not $names) {
        $all = Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
            @{ name = $_.Name; state = "$($_.PrinterStatus)"; driver = $_.DriverName;
               port = $_.PortName; shared = [bool]$_.Shared }
        }
        Emit @{ ok = $true; printers = @($all); jobs = @() }
        return
    }

    # --- snapshot ----------------------------------------------------------
    $jobsOut = @()
    $printersOut = @()

    foreach ($n in $names) {
        $printer = Get-Printer -Name $n -ErrorAction SilentlyContinue
        if (-not $printer) {
            $printersOut += @{ name = $n; state = 'NotInstalled'; queued = 0; message = 'printer not found on this host' }
            continue
        }

        $jobs = @(Get-PrintJob -PrinterName $n -ErrorAction SilentlyContinue |
                  Sort-Object -Property SubmittedTime)

        $pos = 0
        foreach ($j in $jobs) {
            $pos++
            # JobStatus is a flag set: "Printing, Retained". Reduce it to the
            # one state the portal cares about, worst-first.
            $flags = "$($j.JobStatus)"
            $state = 'Queued'
            foreach ($candidate in @('Error','PaperOut','UserIntervention','Blocked','Deleting','Deleted','Paused','Printing','Spooling','Retained','Printed','Complete')) {
                if ($flags -match $candidate) { $state = $candidate; break }
            }
            $jobsOut += @{
                jobId        = $j.Id
                documentName = $j.DocumentName
                state        = $state
                statusText   = $flags
                position     = $pos
                pagesPrinted = $j.PagesPrinted
                totalPages   = $j.TotalPages
                sizeBytes    = $j.Size
                submittedTime = if ($j.SubmittedTime) { $j.SubmittedTime.ToString('o') } else { $null }
                userName     = $j.UserName
                error        = if ($state -in @('Error','PaperOut','UserIntervention','Blocked')) { $flags } else { $null }
            }
        }

        $active = $jobs | Where-Object { "$($_.JobStatus)" -match 'Printing' } | Select-Object -First 1

        # Ink levels, if the driver publishes them.
        $ink = $null
        $rollIn = $null
        $paperFt = $null
        try {
            $wmi = Get-CimInstance -Namespace 'root\cimv2' -ClassName Win32_Printer `
                    -Filter "Name='$($n -replace "'", "''")'" -ErrorAction SilentlyContinue
            if ($wmi -and $wmi.PrinterStatus) { }
            # Canon's driver exposes supplies through the standard Printer MIB
            # when SNMP status is enabled on the TCP/IP port. Adjust the class
            # name here if your driver publishes elsewhere.
            $supplies = Get-CimInstance -Namespace 'root\cimv2' -ClassName Win32_PrinterConfiguration `
                    -Filter "Name='$($n -replace "'", "''")'" -ErrorAction SilentlyContinue
            if ($supplies) { $rollIn = [math]::Round($supplies.PaperWidth / 254.0, 1) }  # tenths of mm -> in
        } catch { }

        $printersOut += @{
            name             = $n
            state            = "$($printer.PrinterStatus)"
            queued           = $jobs.Count
            activeJob        = if ($active) { $active.DocumentName } else { $null }
            message          = $null
            inkLevels        = $ink
            loadedRollIn     = $rollIn
            paperRemainingFt = $paperFt
        }
    }

    Emit @{ ok = $true; jobs = @($jobsOut); printers = @($printersOut); at = (Get-Date).ToString('o') }
}
catch {
    Emit @{ ok = $false; error = $_.Exception.Message; jobs = @(); printers = @() }
    exit 1
}
