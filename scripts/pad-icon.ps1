Add-Type -AssemblyName System.Drawing

$srcPath = $args[0]
$dstPath = $args[1]
$newSize = [int]$args[2]

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $srcPath))
$srcW = $src.Width
$srcH = $src.Height

$canvas = New-Object System.Drawing.Bitmap $newSize, $newSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Center the source inside the canvas, no resize (preserves crisp edges)
$x = [int](($newSize - $srcW) / 2)
$y = [int](($newSize - $srcH) / 2)
$g.DrawImage($src, $x, $y, $srcW, $srcH)
$g.Dispose()
$src.Dispose()

$canvas.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

$pct = [math]::Round(($srcW / $newSize) * 100, 1)
Write-Output ("saved {0} ({1}x{2}) with {3}x{3} canvas ({4}% coverage, {5}% margin)" -f $dstPath, $srcW, $srcH, $newSize, $pct, [math]::Round(((1 - $srcW / $newSize) * 100), 1))
