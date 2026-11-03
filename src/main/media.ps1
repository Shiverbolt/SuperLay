# SuperLay media helper: controls whatever Windows lists as the current media session (Spotify, browsers,
# Apple Music, Media Player...) through the System Media Transport Controls API, and reports what's playing.
# When no session exists yet it falls back to synthetic media keys, which can still wake the last player.
#
# stdin:  <id> <state|playpause|next|prev>
# stdout: one JSON object per line: { id, action, ok, active, app, title, artist, album, status }
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SLKeys {
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
'@

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw 'Windows media API timed out' }
  $task.Result
}

$mgr = $null
try {
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { $mgr = $null }

function Get-Session { if ($mgr) { $mgr.GetCurrentSession() } else { $null } }

function Get-State {
  $s = Get-Session
  if (-not $s) { return @{ active = $false } }
  $p = $null
  try { $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
  @{
    active = $true
    app    = [string]$s.SourceAppUserModelId
    title  = if ($p) { [string]$p.Title } else { '' }
    artist = if ($p) { [string]$p.Artist } else { '' }
    album  = if ($p) { [string]$p.AlbumTitle } else { '' }
    status = [string]$s.GetPlaybackInfo().PlaybackStatus
  }
}

# VK_MEDIA_PLAY_PAUSE, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PREV_TRACK
$keys = @{ playpause = 0xB3; next = 0xB0; prev = 0xB1 }

[Console]::Out.WriteLine((@{ type = 'ready'; api = [bool]$mgr } | ConvertTo-Json -Compress))
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(' ', 2)
  if ($parts.Count -lt 2) { continue }
  $id, $action = $parts
  $out = @{ id = $id; action = $action; ok = $true }
  try {
    if ($action -ne 'state') {
      $s = Get-Session
      $done = $false
      if ($s) {
        $op = switch ($action) {
          'playpause' { $s.TryTogglePlayPauseAsync() }
          'next'      { $s.TrySkipNextAsync() }
          'prev'      { $s.TrySkipPreviousAsync() }
        }
        if ($op) { $done = [bool](Await $op ([bool])) }
      }
      if (-not $done -and $keys.ContainsKey($action)) { [SLKeys]::Tap([byte]$keys[$action]); $out.fallback = $true }
      Start-Sleep -Milliseconds 450   # let the player update its metadata before we read it back
    }
    foreach ($kv in (Get-State).GetEnumerator()) { $out[$kv.Key] = $kv.Value }
  } catch {
    $out.ok = $false; $out.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
}
