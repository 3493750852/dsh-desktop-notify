#requires -Version 5.1
<#
    dsh-desktop-notify — notification shim.

    Started detached and hidden by index.js, once per notification. It shows one
    Windows notification (a tray balloon, which Windows 10/11 renders as a toast
    in the Action Center), waits for a click, and exits.

    The payload arrives as base64-encoded UTF-8 JSON rather than as plain
    arguments, so no quoting, escaping, or code-page conversion can corrupt
    Chinese text or any other non-ASCII content.

    The tray icon is the DSH application's own icon, read from the running app,
    so the notification is recognisable as DSH rather than as a generic tray
    notice. Clicking it brings the DSH window to the foreground by launching the
    app again: the desktop shell owns a single-instance lock and treats a later
    launch as "focus or recreate the primary window".

    Unknown/missing payload fields are tolerated: the point of this script is to
    put something on screen, never to fail loudly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'

try {
    $raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
    $payload = $raw | ConvertFrom-Json
}
catch {
    exit 2
}

function Get-Text($value, $fallback) {
    $s = [string]$value
    if ([string]::IsNullOrWhiteSpace($s)) { return $fallback }
    return $s
}

# The shell truncates balloon text on its own; trim here so the cut is clean.
function Limit-Text($text, $max) {
    if ($null -eq $text) { return '' }
    $s = [string]$text
    if ($s.Length -le $max) { return $s }
    return $s.Substring(0, $max - 3) + '...'
}

$kind = ([string]$payload.kind).ToLowerInvariant()
$title = Limit-Text (Get-Text $payload.title 'DeepSeek Harness') 63
$body = Limit-Text (Get-Text $payload.body '') 250
$onClick = (Get-Text $payload.onClick 'focus').ToLowerInvariant()
$processName = Get-Text $payload.appProcessName 'DeepSeek Harness'
$exeHint = Get-Text $payload.exePath ''
$url = Get-Text $payload.url ''
$sound = $true
if ($null -ne $payload.sound) { $sound = [bool]$payload.sound }
$dwellMs = 8000
if ($null -ne $payload.dwellMs) {
    $requested = 0
    if ([int]::TryParse([string]$payload.dwellMs, [ref]$requested) -and $requested -ge 1000) { $dwellMs = $requested }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- The DSH application: where it is, and its own icon -------------------
function Find-AppExe {
    try {
        $alive = Get-Process -Name $processName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($alive) {
            try {
                $path = [string]$alive.Path
                if ($path) { return $path }
            }
            catch { }
        }
    }
    catch { }
    if ($exeHint -and (Test-Path -LiteralPath $exeHint)) { return $exeHint }
    return ''
}

$appExe = Find-AppExe

$icon = $null
if ($appExe) {
    try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($appExe) } catch { $icon = $null }
}
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Information }

$tipIcon = [System.Windows.Forms.ToolTipIcon]::Info
switch ($kind) {
    'approval' { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Warning }
    'question' { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Info }
    'answered' { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Info }
    'done' { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Info }
    'error' { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Error }
    default { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Info }
}

# ---- What a click should open --------------------------------------------
# 'focus' (default): bring the running DSH window forward, falling back to the
#                    GUI address when no application is installed/running.
# 'url'            : open the GUI address in the default browser.
# 'none'           : dismiss only.
function Resolve-ClickTarget {
    if ($onClick -eq 'none') { return '' }
    if ($onClick -ne 'url') {
        $focusTarget = ''
        try {
            $alive = Get-Process -Name $processName -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($alive) {
                try { $focusTarget = [string]$alive.Path } catch { $focusTarget = '' }
            }
        }
        catch { }
        if (-not $focusTarget -and $exeHint -and (Test-Path -LiteralPath $exeHint)) { $focusTarget = $exeHint }
        if ($focusTarget) { return $focusTarget }
    }
    if ($url) { return $url }
    return ''
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$context = New-Object System.Windows.Forms.ApplicationContext
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $dwellMs

try {
    $notify.Icon = $icon
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $body
    $notify.BalloonTipIcon = $tipIcon

    $timer.add_Tick({
        $timer.Stop()
        $context.ExitThread()
    })

    $notify.add_BalloonTipClicked({
        try {
            $target = Resolve-ClickTarget
            if ($target) {
                # Launching the app again is how the shell asks for its window to
                # be focused or recreated (single-instance lock).
                Start-Process -FilePath $target -ErrorAction Stop | Out-Null
            }
        }
        catch { }
        $context.ExitThread()
    })

    $notify.Visible = $true

    if ($sound) {
        try {
            switch ($kind) {
                'approval' { [System.Media.SystemSounds]::Exclamation.Play() }
                'question' { [System.Media.SystemSounds]::Question.Play() }
                'error' { [System.Media.SystemSounds]::Hand.Play() }
                default { [System.Media.SystemSounds]::Asterisk.Play() }
            }
        }
        catch { }
    }

    # Windows owns the visible duration on 10/11 and ignores the timeout we pass.
    # The pump stays alive a little longer than the banner so a click landing
    # just after the banner fades (from the Action Center) still activates DSH.
    $notify.ShowBalloonTip($dwellMs)
    $timer.Start()
    [System.Windows.Forms.Application]::Run($context)
}
catch {
    exit 3
}
finally {
    try { $timer.Stop() } catch { }
    try { $timer.Dispose() } catch { }
    try { $notify.Visible = $false } catch { }
    try { $notify.Dispose() } catch { }
}

exit 0
