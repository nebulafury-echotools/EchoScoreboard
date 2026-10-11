# Long-lived foreground follower. Prints one JSON line every ~150ms.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  // Largest visible top-level window of a pid (used for -Probe).
  public static IntPtr MainOf(uint pid) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { RECT r; GetClientRect(h, out r); long a = (long)r.R * r.B; if (a > area) { area = a; best = h; } } return true; }, IntPtr.Zero);
    return best;
  }
}
'@
[void][W]::SetProcessDpiAwarenessContext([IntPtr](-4))   # per-monitor v2: report physical pixels
function Info($h, $fg) {
  $o = [ordered]@{ fg = $fg; proc = ''; pid = 0 }
  if ($h -eq [IntPtr]::Zero) { return $o }
  $procId = [uint32]0; [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
  $o.pid = [int]$procId
  try { $o.proc = ([System.Diagnostics.Process]::GetProcessById([int]$procId)).ProcessName } catch {}
  if ($o.proc -ieq 'echovr') {
    $o.min = [bool][W]::IsIconic($h)
    $r = New-Object W+RECT
    if (-not $o.min -and [W]::GetClientRect($h, [ref]$r)) {
      $p = New-Object W+PT
      [void][W]::ClientToScreen($h, [ref]$p)
      $o.rect = @($p.X, $p.Y, ($r.R - $r.L), ($r.B - $r.T))
    }
  }
  return $o
}
if ($args -contains '-Probe') {   # one-shot: report echovr's main window regardless of focus
  $e = Get-Process echovr | Select-Object -First 1
  if ($e) { $h = [W]::MainOf([uint32]$e.Id); (Info $h $false) | ConvertTo-Json -Compress }
  exit
}
while ($true) {
  (Info ([W]::GetForegroundWindow()) $true) | ConvertTo-Json -Compress
  Start-Sleep -Milliseconds 150
}
