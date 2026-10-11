# Background-captures Echo VR's window (PrintWindow, no focus needed) and runs Windows OCR on it.
#   capture-ocr.ps1 -OutDir <dir> [-Shots 4] [-IntervalMs 3000] [-DelayMs 0]   capture all shots first, then OCR them
#   capture-ocr.ps1 -Image a.png[,b.png]                                       OCR existing images only
# -Scale 2[,3]: OCR upscaled copies (the game's award cards are tiny from a spectator camera) and merge the lines.
# Prints one JSON object: { ok, error, shots: [ { file, w, h, mean, nonBlackPct, text, lines: [ { text, x, y, w, h } ] } ] }
param([string]$OutDir = '', [int]$Shots = 4, [int]$IntervalMs = 3000, [int]$DelayMs = 0, [string[]]$Image = @(), [string]$Scale = '2')
$ErrorActionPreference = 'Stop'
$scales = @($Scale -split '[,; ]+' | Where-Object { $_ } | ForEach-Object { [math]::Min(4, [math]::Max(1, [int]$_)) })
$Image = @($Image | ForEach-Object { $_ -split ',' } | Where-Object { $_ })   # -File passes a comma list as one string
$result = @{ ok = $false; error = $null; shots = @() }
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class EW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'no OCR engine (install an OCR language pack)' }

  function Ocr1([string]$file, [int]$k) {
    $tmp = $null
    if ($k -gt 1) {   # upscale before OCR, map boxes back after
      $src = [System.Drawing.Bitmap]::FromFile($file)
      $big = New-Object System.Drawing.Bitmap ($src.Width * $k), ($src.Height * $k)
      $gg = [System.Drawing.Graphics]::FromImage($big); $gg.InterpolationMode = 'HighQualityBicubic'; $gg.DrawImage($src, 0, 0, $big.Width, $big.Height); $gg.Dispose(); $src.Dispose()
      $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('echo_ocr_{0}.png' -f [guid]::NewGuid().ToString('N')); $big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose()
      $file = $tmp
    }
    $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
    $stream = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose(); if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue }
    $lines = @()
    foreach ($l in $res.Lines) {
      # a line's box = union of its words
      $x0 = 1e9; $y0 = 1e9; $x1 = 0; $y1 = 0
      foreach ($w in $l.Words) { $b = $w.BoundingRect; $x0 = [math]::Min($x0, $b.X); $y0 = [math]::Min($y0, $b.Y); $x1 = [math]::Max($x1, $b.X + $b.Width); $y1 = [math]::Max($y1, $b.Y + $b.Height) }
      $x0 /= $k; $y0 /= $k; $x1 /= $k; $y1 /= $k
      $lines += @{ text = ($l.Text -replace '[\p{Cc}]', ' ').Trim(); x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0) }
    }
    return @{ text = ($res.Text -replace '[\p{Cc}]', ' '); lines = $lines }
  }

  function Ocr([string]$file) {
    $text = @(); $lines = @()
    foreach ($sc in $scales) { $o = Ocr1 $file $sc; $text += $o.text; $lines += $o.lines }
    return @{ text = ($text -join ' '); lines = $lines }
  }

  function Stats([System.Drawing.Bitmap]$bmp) {
    $sum = 0.0; $nz = 0; $n = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 24) { for ($x = 0; $x -lt $bmp.Width; $x += 24) { $c = $bmp.GetPixel($x, $y); $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B; $sum += $l; if ($l -gt 8) { $nz++ }; $n++ } }
    return @{ mean = [math]::Round($sum / $n, 1); nonBlackPct = [math]::Round(100 * $nz / $n, 1) }
  }

  if ($Image.Count -gt 0) {
    foreach ($img in $Image) {
      $img = (Resolve-Path $img).Path
      $o = Ocr $img
      $result.shots += @{ file = $img; text = $o.text; lines = $o.lines }
    }
    $result.ok = $true
  } else {
    if (-not $OutDir) { throw 'OutDir required' }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $p = Get-Process echovr -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw 'echo_window_not_found' }
    $h = $p.MainWindowHandle
    if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
    for ($i = 0; $i -lt $Shots; $i++) {
      if ($i -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
      $r = New-Object EW+RECT; [void][EW]::GetClientRect($h, [ref]$r)
      if ($r.R -lt 64 -or $r.B -lt 64) { $result.shots += @{ file = $null; error = 'window_minimized_or_empty' }; continue }
      $bmp = New-Object System.Drawing.Bitmap $r.R, $r.B
      $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
      $ok = [EW]::PrintWindow($h, $dc, 2)   # PW_RENDERFULLCONTENT: works while Echo is behind other windows
      $g.ReleaseHdc($dc); $g.Dispose()
      $st = Stats $bmp
      $file = Join-Path $OutDir ('echo_{0}_{1}.png' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $i)
      $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
      $shot = @{ file = $file; w = $r.R; h = $r.B; mean = $st.mean; nonBlackPct = $st.nonBlackPct; printed = $ok }
      if (-not $ok -or $st.nonBlackPct -lt 2) { $shot.error = 'blank_capture' }
      $result.shots += $shot
    }
    foreach ($shot in $result.shots) { if ($shot.file -and -not $shot.error) { $o = Ocr $shot.file; $shot.text = $o.text; $shot.lines = $o.lines } }
    $result.ok = $true
  }
} catch { $result.error = "$($_.Exception.Message)" }
# ConvertTo-Json (PS 5.1) leaves some control chars (e.g. BEL) unescaped; blank them
$json = ($result | ConvertTo-Json -Depth 6 -Compress) -replace '[\u0000-\u001f]', ' '
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # default OEM codepage turns OCR glyphs like a bullet into BEL
[Console]::Out.Write($json)
