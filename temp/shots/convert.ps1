Add-Type -AssemblyName System.Drawing
$dir = $PSScriptRoot
foreach ($n in @('thinking-1', 'thinking-2', 'thinking-3', 'after-done')) {
  $src = Join-Path $dir "$n.png"
  $dst = Join-Path $dir "$n-rgba.png"
  if (-not (Test-Path $src)) { Write-Host "missing $src"; continue }
  $img = [System.Drawing.Image]::FromFile($src)
  $w = [Math]::Min(900, $img.Width)
  $h = [int]($img.Height * $w / $img.Width)
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h)
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Write-Host "converted $n-rgba.png (${w}x$h)"
}
