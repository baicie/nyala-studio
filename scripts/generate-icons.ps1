# Generates the full Nyala icon set from a source PNG.
# Uses System.Drawing for high-quality alpha-aware resize.
# Source PNG is centered on a transparent canvas with ~38% margin
# so macOS/Windows dock rendering shows the leopard at a comparable
# visual size to native icons.

param(
  [Parameter(Position=0)][string]$SourcePath,
  [string]$OutputDir = "src-tauri/icons"
)

if (-not $SourcePath) {
  # Use the leopard source explicitly
  $SourcePath = (Get-ChildItem -Filter 'ChatGPT*' | Select-Object -First 1).Name
  if (-not $SourcePath) {
    $SourcePath = (Get-ChildItem -Name *.png | Where-Object { $_.Name -like '*ChatGPT*' } | Select-Object -First 1)
  }
}
if (-not $SourcePath) { throw "no source PNG found; pass as positional arg" }

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# 2000x2000 canvas with 62% coverage (38% margin, 19% each side) gives
# a leopard roughly 1240px on a 2000px canvas — comparable visual ratio
# to Apple Mail / Finder in dock.
$CanvasSize = 2000
$Coverage = 0.62

function Pad-Source([string]$src, [string]$dst, [int]$canvasSize, [double]$coverage) {
  if (-not (Test-Path $src)) { throw "source not found: $src" }
  $full = (Resolve-Path $src).Path
  $bitmap = [System.Drawing.Bitmap]::FromFile($full)
  $bmpW = $bitmap.Width
  $bmpH = $bitmap.Height
  $scale = $canvasSize * $coverage / [Math]::Max($bmpW, $bmpH)
  $newW = [int]([Math]::Round($bmpW * $scale))
  $newH = [int]([Math]::Round($bmpH * $scale))
  $canvas = New-Object System.Drawing.Bitmap $canvasSize, $canvasSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $x = [int](($canvasSize - $newW) / 2)
  $y = [int](($canvasSize - $newH) / 2)
  $g.DrawImage($bitmap, $x, $y, $newW, $newH)
  $g.Dispose(); $bitmap.Dispose(); $canvas.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $canvas.Dispose()
}

function Resize-Png([string]$src, [string]$dst, [int]$size) {
  $full = (Resolve-Path $src).Path
  if (-not (Test-Path $full)) { throw "source missing: $full" }
  $bitmap = [System.Drawing.Bitmap]::FromFile($full)
  $canvas = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($bitmap, 0, 0, $size, $size)
  $g.Dispose(); $bitmap.Dispose(); $canvas.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $canvas.Dispose()
}

function Write-Icns($map, $dst) {
  # Build the chunks in memory first, then prepend icns header
  $body = New-Object System.IO.MemoryStream
  foreach ($kv in $map.GetEnumerator()) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $kv.Value))
    $entrySize = 8 + $bytes.Length
    $body.Write([System.Text.Encoding]::ASCII.GetBytes($kv.Key), 0, 4)
    # Big-endian uint32 for size
    $body.WriteByte([byte](($entrySize -shr 24) -band 0xFF))
    $body.WriteByte([byte](($entrySize -shr 16) -band 0xFF))
    $body.WriteByte([byte](($entrySize -shr 8) -band 0xFF))
    $body.WriteByte([byte]($entrySize -band 0xFF))
    $body.Write($bytes, 0, $bytes.Length)
  }
  $total = 8 + $body.Length  # icns magic + size + body
  $fs = [System.IO.File]::Create($dst)
  $fs.Write([System.Text.Encoding]::ASCII.GetBytes("icns"), 0, 4)
  $fs.WriteByte([byte](($total -shr 24) -band 0xFF))
  $fs.WriteByte([byte](($total -shr 16) -band 0xFF))
  $fs.WriteByte([byte](($total -shr 8) -band 0xFF))
  $fs.WriteByte([byte]($total -band 0xFF))
  $fs.Write($body.ToArray(), 0, [int]$body.Length)
  $fs.Close(); $body.Dispose()
}

function Write-Ico($entries, $dst) {
  # Pre-compute data offsets and lengths
  $dataStart = 6 + 16 * $entries.Count
  $runningOffset = $dataStart
  $items = @()
  foreach ($e in $entries) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $e.path))
    $items += @{ size = $e.size; data = $bytes; offset = $runningOffset }
    $runningOffset += $bytes.Length
  }
  $fs = [System.IO.File]::Create($dst)
  # ICONDIR (6 bytes little-endian)
  $fs.WriteByte(0); $fs.WriteByte(0)        # reserved
  $fs.WriteByte(1); $fs.WriteByte(0)        # type = 1 (ICO)
  $cnt = [uint16]$entries.Count
  $fs.WriteByte([byte]($cnt -band 0xFF))
  $fs.WriteByte([byte](($cnt -shr 8) -band 0xFF))
  # ICONDIRENTRY (16 bytes each, all LE)
  foreach ($it in $items) {
    $s = $it.size; if ($s -ge 256) { $w = 0 } else { $w = $s }
    $fs.WriteByte([byte]$w)
    $fs.WriteByte([byte]$w)
    $fs.WriteByte(0)  # palette
    $fs.WriteByte(0)  # reserved
    $pl = [uint16]1;  $fs.WriteByte([byte]($pl -band 0xFF)); $fs.WriteByte([byte](($pl -shr 8) -band 0xFF))
    $bp = [uint16]32; $fs.WriteByte([byte]($bp -band 0xFF)); $fs.WriteByte([byte](($bp -shr 8) -band 0xFF))
    # bytes_in_res uint32 LE
    $dl = [uint32]$it.data.Length
    $fs.WriteByte([byte]($dl -band 0xFF)); $fs.WriteByte([byte](($dl -shr 8) -band 0xFF))
    $fs.WriteByte([byte](($dl -shr 16) -band 0xFF)); $fs.WriteByte([byte](($dl -shr 24) -band 0xFF))
    # image_offset uint32 LE
    $oo = [uint32]$it.offset
    $fs.WriteByte([byte]($oo -band 0xFF)); $fs.WriteByte([byte](($oo -shr 8) -band 0xFF))
    $fs.WriteByte([byte](($oo -shr 16) -band 0xFF)); $fs.WriteByte([byte](($oo -shr 24) -band 0xFF))
  }
  # Image data
  foreach ($it in $items) {
    $fs.Write($it.data, 0, $it.data.Length)
  }
  $fs.Close()
}

# ===== MAIN =====
if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
$tmpDir = "$OutputDir/_tmp"
if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
New-Item -ItemType Directory -Path $tmpDir | Out-Null

# 1) Pad source
$padded = "$tmpDir/master-2000.png"
Pad-Source $SourcePath $padded $CanvasSize $Coverage

# 2) Generate all sizes we need
$requiredSizes = @(16, 24, 32, 48, 50, 64, 72, 89, 107, 128, 142, 150, 192, 256, 284, 310, 384, 512, 1024)
foreach ($sz in $requiredSizes) {
  Resize-Png $padded "$tmpDir/$($sz).png" $sz
}

# 3) Lay out the canonical Tauri files
Copy-Item "$tmpDir/32.png"   "$OutputDir/32x32.png"        -Force
Copy-Item "$tmpDir/64.png"   "$OutputDir/64x64.png"        -Force
Copy-Item "$tmpDir/128.png"  "$OutputDir/128x128.png"      -Force
Copy-Item "$tmpDir/256.png"  "$OutputDir/128x128@2x.png"   -Force
Copy-Item "$tmpDir/512.png"  "$OutputDir/icon.png"         -Force

# Windows tile + store logos
$tiles = @{
  "Square30x30Logo.png"   = 30
  "Square44x44Logo.png"   = 44
  "Square71x71Logo.png"   = 71
  "Square89x89Logo.png"   = 89
  "Square107x107Logo.png" = 107
  "Square142x142Logo.png" = 142
  "Square150x150Logo.png" = 150
  "Square284x284Logo.png" = 284
  "Square310x310Logo.png" = 310
  "StoreLogo.png"         = 50
}
foreach ($kv in $tiles.GetEnumerator()) {
  $size = $kv.Value
  $out = "$tmpDir/$($size).png"
  if (-not (Test-Path $out)) { Resize-Png $padded $out $size }
  Copy-Item $out "$OutputDir/$($kv.Key)" -Force
}

# 4) Build .icns
$icnsMap = [ordered]@{
  'icp4' = "$tmpDir/16.png"
  'icp5' = "$tmpDir/32.png"
  'icp6' = "$tmpDir/64.png"
  'ic07' = "$tmpDir/128.png"
  'ic08' = "$tmpDir/256.png"
  'ic09' = "$tmpDir/512.png"
  'ic10' = "$tmpDir/32.png"   # 16@2x = 32
  'ic11' = "$tmpDir/64.png"   # 32@2x = 64
  'ic12' = "$tmpDir/128.png"  # 64@2x = 128
  'ic13' = "$tmpDir/256.png"  # 128@2x = 256
  'ic14' = "$tmpDir/512.png"  # 256@2x = 512
  'ic15' = "$tmpDir/1024.png" # 512@2x = 1024
}
Write-Icns $icnsMap "$OutputDir/icon.icns"

# 5) Build .ico
$icoEntries = @(
  # Tauri's Windows icon loader uses the first ICO entry.
  @{ size = 256; path = "$tmpDir/256.png" },
  @{ size = 128; path = "$tmpDir/128.png" },
  @{ size = 64;  path = "$tmpDir/64.png" },
  @{ size = 48;  path = "$tmpDir/48.png" },
  @{ size = 32;  path = "$tmpDir/32.png" },
  @{ size = 24;  path = "$tmpDir/24.png" },
  @{ size = 16;  path = "$tmpDir/16.png" }
)
Write-Ico $icoEntries "$OutputDir/icon.ico"

# 6) Refresh public/favicon from 512 master
Copy-Item "$OutputDir/icon.png" "public/favicon.png" -Force

# 7) Cleanup tmp
Remove-Item -Recurse -Force $tmpDir

# Verify
Write-Output ""
Write-Output ("Generated icons in {0}:" -f $OutputDir)
Get-ChildItem $OutputDir | Where-Object { -not $_.PSIsContainer } | Format-Table Name, Length
Write-Output ""
Write-Output "favicon:"
Get-ChildItem "public/favicon.png" | Format-Table Name, Length
