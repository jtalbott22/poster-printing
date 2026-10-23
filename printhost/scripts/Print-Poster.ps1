<#
.SYNOPSIS
    Send a print-ready poster raster to a Canon large-format printer and return
    the spooler JobId as JSON.

.DESCRIPTION
    Rewrite of the original printPNG.ps1 with four changes that matter:

    1. CUSTOM PAGE SIZE. The original let the driver pick a page and then
       letterboxed the image into MarginBounds. On a roll printer that means
       the driver feeds its default length, centres a 48" poster inside it,
       and you throw away paper. Here the page IS the poster: a custom
       PaperSize in hundredths of an inch, margins zero.

    2. NO RESCALING. The portal already rasterised to exactly W*DPI x H*DPI.
       Drawing into a rectangle the same physical size as the page is a 1:1
       placement, so GDI+ only resamples between our 300 DPI and the device's
       native resolution.

    3. JOB ID CAPTURE. PrintDocument.Print() tells you nothing. Setting
       DocumentName to the portal's doc token and then querying Get-PrintJob
       for that name gives us the spooler JobId, which is how the portal ties
       spooler state back to a job — and how Canon Accounting Manager rows get
       matched later.

    4. STRUCTURED OUTPUT. One JSON object on stdout, so the Node agent doesn't
       have to scrape log text.

    Run under Windows PowerShell 5.1 x64. System.Drawing.Printing is
    Windows-only and PowerShell 7 needs a compatibility shim for it. A 42x60
    poster at 300 DPI decodes to roughly 1 GB of bitmap, so 32-bit PowerShell
    will throw OutOfMemory.

.EXAMPLE
    .\Print-Poster.ps1 -FilePath C:\spool\PP-2026-0413_1.png `
        -PrinterName "Canon PRO-4100-36" -DocumentName "PP-2026-0413#1" `
        -WidthIn 48 -HeightIn 35.5 -Copies 1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [Parameter(Mandatory = $true)][string]$DocumentName,
    [Parameter(Mandatory = $true)][double]$WidthIn,
    [Parameter(Mandatory = $true)][double]$HeightIn,
    [int]$Copies = 1,
    [string]$Preset = $null,
    [int]$JobIdTimeoutSec = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Log { param([string]$m, [string]$lvl = 'INFO')
    Write-Host ("[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $lvl, $m)
}
function Emit { param($obj) $obj | ConvertTo-Json -Compress -Depth 6 }

$image = $null
$printDoc = $null

try {
    if (-not (Test-Path -LiteralPath $FilePath)) { throw "File not found: $FilePath" }

    # Bitness check — the usual cause of a mysterious OutOfMemoryException.
    if (-not [Environment]::Is64BitProcess) {
        throw 'Running in a 32-bit PowerShell. Large posters need the x64 host at C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    }

    $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
    if (-not $printer) { throw "Printer '$PrinterName' is not installed on this host" }

    Add-Type -AssemblyName System.Drawing

    Write-Log "Loading $FilePath"
    $image = [System.Drawing.Image]::FromFile($FilePath)
    $srcDpiX = if ($image.HorizontalResolution -gt 0) { $image.HorizontalResolution } else { 300 }
    $impliedW = [math]::Round($image.Width / $srcDpiX, 2)
    Write-Log ("Raster {0}x{1} px, tagged {2} DPI (implies {3}in wide)" -f `
        $image.Width, $image.Height, [math]::Round($srcDpiX, 0), $impliedW)
    Write-Log ("Target page {0}in x {1}in on {2}" -f $WidthIn, $HeightIn, $PrinterName)

    # Sanity: the raster should already match the requested page aspect.
    $pageAspect = $WidthIn / $HeightIn
    $imgAspect  = $image.Width / $image.Height
    if ([math]::Abs($pageAspect - $imgAspect) / $pageAspect -gt 0.02) {
        Write-Log ("Aspect mismatch: page {0:N3} vs raster {1:N3} — image will be fitted, not filled" -f `
            $pageAspect, $imgAspect) 'WARN'
    }

    $printDoc = New-Object System.Drawing.Printing.PrintDocument
    $printDoc.PrinterSettings.PrinterName = $PrinterName
    $printDoc.DocumentName = $DocumentName
    $printDoc.PrinterSettings.Copies = [int16]$Copies
    $printDoc.OriginAtMargins = $false

    if (-not $printDoc.PrinterSettings.IsValid) {
        throw "Printer settings for '$PrinterName' are not valid on this host"
    }

    # --- the page is the poster -------------------------------------------
    # PaperSize is in hundredths of an inch. RawKind 0 = custom.
    $w100 = [int][math]::Round($WidthIn * 100)
    $h100 = [int][math]::Round($HeightIn * 100)
    $paper = New-Object System.Drawing.Printing.PaperSize("PosterCustom", $w100, $h100)
    $paper.RawKind = 0
    $printDoc.DefaultPageSettings.PaperSize = $paper
    $printDoc.DefaultPageSettings.Landscape = $false   # dimensions define orientation
    $printDoc.DefaultPageSettings.Margins =
        New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

    # Highest resolution the driver advertises.
    $best = $printDoc.PrinterSettings.PrinterResolutions |
            Where-Object { $_.X -gt 0 } | Sort-Object X -Descending | Select-Object -First 1
    if ($best) {
        $printDoc.DefaultPageSettings.PrinterResolution = $best
        Write-Log ("Device resolution {0}x{1}" -f $best.X, $best.Y)
    }

    if ($Preset) { Write-Log "Driver preset requested: '$Preset' (apply via driver defaults; see README §5.4)" }

    $script:printError = $null
    $printDoc.add_PrintPage({
        param($sender, $e)
        try {
            $g = $e.Graphics
            $g.PageUnit          = [System.Drawing.GraphicsUnit]::Display   # 1/100 in
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

            # Fill the page exactly. Both are the same physical size by construction.
            $rect = New-Object System.Drawing.RectangleF(0, 0, $w100, $h100)
            $g.DrawImage($image, $rect)
            $e.HasMorePages = $false
        }
        catch { $script:printError = $_; $e.Cancel = $true }
    })

    Write-Log "Spooling as '$DocumentName'"
    $printDoc.Print()
    if ($script:printError) { throw $script:printError }

    # --- find our JobId ----------------------------------------------------
    $jobId = $null
    $deadline = (Get-Date).AddSeconds($JobIdTimeoutSec)
    while ((Get-Date) -lt $deadline -and -not $jobId) {
        $match = Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
                 Where-Object { $_.DocumentName -like "*$DocumentName*" } |
                 Sort-Object -Property Id -Descending | Select-Object -First 1
        if ($match) { $jobId = $match.Id; break }
        Start-Sleep -Milliseconds 400
    }

    if ($jobId) { Write-Log "Spooler JobId $jobId" }
    else { Write-Log 'Job left the spooler before we could read its Id (very short job)' 'WARN' }

    Emit @{
        ok           = $true
        jobId        = $jobId
        printer      = $PrinterName
        documentName = $DocumentName
        pageWidthIn  = $WidthIn
        pageHeightIn = $HeightIn
        rasterWidth  = $image.Width
        rasterHeight = $image.Height
        copies       = $Copies
    }
}
catch {
    Write-Log $_.Exception.Message 'ERROR'
    Emit @{ ok = $false; error = $_.Exception.Message; printer = $PrinterName; documentName = $DocumentName }
    exit 1
}
finally {
    if ($image) { $image.Dispose() }
    if ($printDoc) { $printDoc.Dispose() }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
