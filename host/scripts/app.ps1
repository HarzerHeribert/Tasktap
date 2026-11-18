# Dot-sourced by smoke.ps1 and scripts\winvm\desktop.ps1: the built app started with its debug
# channel, one command per line on its standard input and one line of JSON per event on its
# standard output. Start-App leaves $proc, the app's process, and $seen, every line it printed
# that Until has read so far.
function Start-App([string]$Exe, [hashtable]$Environment, [int]$Seconds) {
    $start = [Diagnostics.ProcessStartInfo]::new($Exe)
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['TASKTAP_DEBUG'] = '1'
    foreach ($name in $Environment.Keys) { $start.Environment[$name] = $Environment[$name] }
    $script:lines = [Collections.Concurrent.ConcurrentQueue[string]]::new()
    $script:proc = [Diagnostics.Process]::new()
    $proc.StartInfo = $start
    $script:seen = [Collections.Generic.List[string]]::new()
    $null = Register-ObjectEvent $proc OutputDataReceived -MessageData $lines -Action { if ($EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) } }
    $null = Register-ObjectEvent $proc ErrorDataReceived -MessageData $lines -Action { if ($EventArgs.Data) { $Event.MessageData.Enqueue("stderr: $($EventArgs.Data)") } }
    $null = $proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    $script:deadline = (Get-Date).AddSeconds($Seconds)
}

# The next line the app prints that matches, within the run's time; every line is kept.
function Until($pattern, $seconds = 10) {
    $until = (Get-Date).AddSeconds($seconds)
    if ($until -gt $deadline) { $until = $deadline }
    while ($true) {
        $line = $null
        while ($lines.TryDequeue([ref]$line)) {
            $seen.Add($line)
            if ($line -match $pattern) { return $line }
        }
        if ((Get-Date) -ge $until -or $proc.HasExited) { return $null }
        Start-Sleep -Milliseconds 50
    }
}
function Send($line) { $proc.StandardInput.WriteLine($line); $proc.StandardInput.Flush() }
# The value of an expression in the workspace page, as text; $null when the page does not answer.
function Js($expr, $seconds = 5) {
    Send "eval workspace $expr"
    $line = Until '"event":"report"' $seconds
    if ($line) { (ConvertFrom-Json $line).data } else { $null }
}
