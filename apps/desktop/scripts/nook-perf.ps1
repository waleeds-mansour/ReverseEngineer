<#
Nook's performance scenarios and the 24 h soak (docs/nook-wm.md, "Performance budgets" and "### P1").

For the owner to run on their own PC, with a Hearth that has P1 and with Nook observing. Turn on
"Keep observing when this panel is closed" in Nook's panel, then close the panel: while it is
open Nook also hears every window appear and go, which the budgets don't allow for. The
script notes in summary.txt whether the panel was open. It never starts, stops or changes
Hearth, Nook or any window: it only asks Nook for its counters, by setting the event
Local\Nook.Diag.<session id>, and reads the diag.json Nook writes next to nook.log. Nothing leaves
the PC.

Run it hidden, as every run on this PC is:

  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy',
    'Bypass', '-File', 'apps\desktop\scripts\nook-perf.ps1', '-Scenario', 'idle'

Scenarios (each measures nook-wm between two exports):
  idle      60 s with nothing touched. Budget: no wakeups (0/s with nothing managed).
  typing    60 s while you type in VS Code. Budget: 20 wakeups/s and 0.5 ms CPU/s or less.
  alttab    10 s while you Alt-Tab about five times a second.
  drag      30 s while you drag a Chrome window around. Budget: 2% of one core or less.
  video     60 s with YouTube playing, windowed then fullscreen; the game guard should trip.
  soak      every 10 minutes for -Hours (24 by default): the P1 exit check.
With -Beep it beeps when a timed scenario starts and ends, since it has no window to watch.

Every run checks the rule that matters most: Nook made no change to any window (writes landed 0).
Results go to -Out (by default nook\perf-<time> in Nook's folder) as the raw exports, a CSV for
the soak, and summary.txt.
#>
[CmdletBinding()]
param(
  [ValidateSet('idle', 'typing', 'alttab', 'drag', 'video', 'soak')]
  [string]$Scenario = 'idle',
  [double]$Hours = 24,
  [int]$Seconds = 0,
  [string]$NookDir = "$env:LOCALAPPDATA\app.hearth.desktop\nook",
  [string]$Out = '',
  # Only for trying the script against a stand-in; Nook's own name is per session.
  [string]$EventName = '',
  [switch]$Beep
)
$ErrorActionPreference = 'Stop'

$budgets = @{
  idle   = @{ seconds = 60; wakeups_per_s = 0.0; cpu_ms_per_s = 0.5 }
  typing = @{ seconds = 60; wakeups_per_s = 20.0; cpu_ms_per_s = 0.5 }
  alttab = @{ seconds = 10; wakeups_per_s = 50.0; cpu_ms_per_s = 5.0 }
  drag   = @{ seconds = 30; wakeups_per_s = 1000.0; cpu_ms_per_s = 20.0 }
  video  = @{ seconds = 60; wakeups_per_s = 20.0; cpu_ms_per_s = 0.5 }
}
# The hook callback's p99 and the flush's p99, from diag.json's log-linear histograms.
$callbackP99Ns = 5120
$flushP99Ns = 1048576

if (-not (Test-Path $NookDir)) { throw "Nook's folder isn't at $NookDir; pass -NookDir" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Out) { $Out = Join-Path $NookDir "perf-$stamp" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$summary = Join-Path $Out 'summary.txt'
function Say([string]$line) {
  $line | Tee-Object -FilePath $summary -Append | Out-Null
}

$session = (Get-Process -Id $PID).SessionId
$diagEvent = if ($EventName) { $EventName } else { "Local\Nook.Diag.$session" }
$diag = Join-Path $NookDir 'diag.json'

# Asks Nook for an export and waits for the new diag.json.
function Export([string]$label) {
  $before = if (Test-Path $diag) { (Get-Item $diag).LastWriteTimeUtc } else { [datetime]::MinValue }
  try {
    $ev = [System.Threading.EventWaitHandle]::OpenExisting($diagEvent)
  } catch {
    throw "Nook isn't observing (no $diagEvent). Open Nook's panel, or turn observing on, first."
  }
  try { [void]$ev.Set() } finally { $ev.Dispose() }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    if ((Test-Path $diag) -and (Get-Item $diag).LastWriteTimeUtc -gt $before) {
      $copy = Join-Path $Out "$label.json"
      Copy-Item $diag $copy -Force
      return (Get-Content $copy -Raw | ConvertFrom-Json)
    }
  }
  throw "Nook didn't write diag.json within 10 s"
}

function Thread($d, [string]$name) { $d.threads.$name }

# Compares two exports: nook-wm's wakeups and CPU per second, and the checks every run makes.
function Compare-Exports($a, $b, [string]$label, $budget) {
  $seconds = ($b.uptime_ms - $a.uptime_ms) / 1000.0
  if ($seconds -le 0) { Say "${label}: Nook restarted between exports; no comparison"; return $false }
  $wa = Thread $a 'nook-wm'; $wb = Thread $b 'nook-wm'
  # The later export woke nook-wm once itself; that wakeup isn't Nook's cost.
  $wakeups = [math]::Max(0, $wb.wakeups - $wa.wakeups - 1) / $seconds
  $ok = $true
  $line = "{0}: {1:N1} s; nook-wm {2:N3} wakeups/s, {3} events in, {4} coalesced" -f $label, $seconds, $wakeups,
    ($wb.events_in - $wa.events_in), ($wb.coalesced - $wa.coalesced)
  if ($null -ne $wa.cycles -and $null -ne $wb.cycles) {
    # Cycles to time at the processor's nominal clock: close enough for a budget in ms per s.
    $mhz = (Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed
    $cpuMs = ($wb.cycles - $wa.cycles) / ($mhz * 1000.0) / $seconds
    $line += ", {0:N3} ms CPU/s" -f $cpuMs
    if ($budget -and $cpuMs -gt $budget.cpu_ms_per_s) { $ok = $false; $line += " (over $($budget.cpu_ms_per_s))" }
  }
  if ($budget -and $wakeups -gt $budget.wakeups_per_s) { $ok = $false; $line += " (wakeups over $($budget.wakeups_per_s)/s)" }
  Say $line
  foreach ($other in 'nook-shell', 'nook-com') {
    $oa = Thread $a $other; $ob = Thread $b $other
    if ($oa -and $ob) { Say ("  {0}: {1:N3} wakeups/s" -f $other, (($ob.wakeups - $oa.wakeups) / $seconds)) }
  }
  Say ("  callback p99 under {0} ns over {1} calls; flush p99 under {2} ns" -f $b.callback.p99_ns, $b.callback.count, $b.flush.p99_ns)
  if ($b.callback.p99_ns -gt $callbackP99Ns) { $ok = $false; Say "  callback p99 is over the 5 us budget" }
  if ($b.flush.p99_ns -gt $flushP99Ns) { $ok = $false; Say "  flush p99 is over the 1 ms budget" }
  Say ("  writes: {0} attempted, {1} refused, {2} landed" -f $b.writes.attempted, $b.writes.refused, $b.writes.landed)
  if ($b.writes.landed -ne 0) { $ok = $false; Say "  FAIL: Nook changed a window while observing" }
  if ($b.gates.Count -gt 0) { Say "  gates on: $($b.gates -join ', ')" }
  if ($a.panel_open -or $b.panel_open) { Say "  note: Nook's panel was open, so every window appearing and going counted too" }
  return $ok
}

Say "Nook perf, scenario $Scenario, started $(Get-Date -Format o), session $session"
if ($Scenario -ne 'soak') {
  $budget = $budgets[$Scenario]
  $length = if ($Seconds -gt 0) { $Seconds } else { $budget.seconds }
  $a = Export "$Scenario-before"
  if ($Beep) { [console]::Beep(880, 200) }
  Start-Sleep -Seconds $length
  if ($Beep) { [console]::Beep(660, 400) }
  $b = Export "$Scenario-after"
  $ok = Compare-Exports $a $b $Scenario $budget
  Say $(if ($ok) { 'PASS' } else { 'FAIL' })
  exit $(if ($ok) { 0 } else { 1 })
}

# The soak: an export every 10 minutes, each interval judged against the idle budgets for CPU
# and against the zero-writes rule; wakeups are recorded, since a day includes real use.
$csv = Join-Path $Out 'soak.csv'
'at,uptime_s,wm_wakeups,wm_events_in,wm_coalesced,wm_cycles,callback_p99_ns,flush_p99_ns,writes_attempted,writes_landed,gates' |
  Set-Content -Path $csv -Encoding utf8
$first = Export 'soak-0000'
$prev = $first
$end = (Get-Date).AddHours($Hours)
$n = 0
$allOk = $true
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds 600
  $n++
  try { $now = Export ('soak-{0:D4}' -f $n) } catch { Say "export $n failed: $_"; $allOk = $false; continue }
  $wm = Thread $now 'nook-wm'
  ('{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},"{10}"' -f (Get-Date -Format o), [int]($now.uptime_ms / 1000), $wm.wakeups,
    $wm.events_in, $wm.coalesced, $wm.cycles, $now.callback.p99_ns, $now.flush.p99_ns, $now.writes.attempted,
    $now.writes.landed, ($now.gates -join ' ')) | Add-Content -Path $csv -Encoding utf8
  if ($now.uptime_ms -lt $prev.uptime_ms) { Say "export ${n}: Nook restarted"; $allOk = $false }
  elseif (-not (Compare-Exports $prev $now ('interval {0}' -f $n) $null)) { $allOk = $false }
  $prev = $now
}
if ($prev.uptime_ms -ge $first.uptime_ms) {
  Say '--- the whole soak'
  if (-not (Compare-Exports $first $prev 'soak' $null)) { $allOk = $false }
}
Say $(if ($allOk) { 'PASS: no window changed, every interval within the callback and flush budgets' } else { 'FAIL: see above' })
exit $(if ($allOk) { 0 } else { 1 })
