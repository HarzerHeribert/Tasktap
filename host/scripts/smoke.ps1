# host\scripts\smoke.ps1: what smoke.sh proves on the Mac, as far as it is built for Windows. It starts the built app on a temporary data folder, passive (it takes no keyboard and uses a clipboard
# of its own), with a core that has the fixture agent, drives it only through its debug channel (one command per
# line on standard input), and says PASS or FAIL for:
#   - the core starting and the host reaching it over its pipe, the workspace page running and having the core's
#     records through the bridge, a folder becoming a workspace, a terminal with the system's shell answering what
#     is typed into it;
#   - a thought end to end: typed on Home and sent, placed in the open folder, the fixture agent working in a
#     terminal of the workspace, its folder-trust prompt and its question in the pane's strip and on Home, the
#     question answered as the global shortcut answers it, its result marked; then runs in a copy of the project
#     of their own: changes that wait, Keep bringing them in, Discard asked first and taking them away;
#   - previews beside a terminal: a page of the project and a local web address in a frame, and what a frame is
#     held to (host\src\frames.rs), tried by the page the Mac's check uses (frame-probe.html);
#   - the tab at the top edge: its window made with the notch's own page in it, opened and folded as the pointer
#     and the capture key would, told through the debug channel (a passive run's tab takes neither; what the real
#     pointer and keys do is the desktop round's, scripts\winvm\desktop.ps1);
#   - the capture key, and the app quitting with nothing left running.
#   pwsh host\scripts\build.ps1 -Fixtures
#   pwsh host\scripts\smoke.ps1
# The runs need git, the previews Node (for the check's own web server); without one, that part is said and not
# run. What smoke.sh checks beyond this (most of the notch, speech, splits, the sheets, Settings, pictures) is not here yet:
# scripts\winvm\README.md, "The smoke script".
param(
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [string]$App = (Join-Path (Split-Path $PSScriptRoot -Parent) "target\$Target-pc-windows-msvc\release\Tasktap Next"),
    [string]$Core = (Join-Path (Split-Path $PSScriptRoot -Parent) 'binaries\fixtures\tasktap.exe'),
    [int]$Seconds = 420
)
$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tasktap-smoke-$PID"
New-Item -ItemType Directory -Force "$tmp\data", "$tmp\project", "$tmp\agents" | Out-Null
$failed = 0
function Pass($what) { Write-Host "PASS $what" }
function Fail($what, $why = '') { Write-Host "FAIL $what$(if ($why) { ": $("$why".Replace("`n", ' | '))" })"; $script:failed++ }
function Note($what) { Write-Host "NOTE  $what" }

# The fixture agent as the core finds one and as a person types it into a shell: the fixture core under the agent's
# names, in a folder at the front of the app's PATH, which its core and every terminal inherit.
Copy-Item $Core "$tmp\agents\fixture-agent.exe"
Copy-Item $Core "$tmp\agents\fixture.exe"
# The project is a git repository with one commit, so a run can work in a copy of it (Keep and Discard). git reads
# no configuration but the check's own.
$git = [bool](Get-Command git -ErrorAction SilentlyContinue)
$env:GIT_CONFIG_GLOBAL = "$tmp\gitconfig"
$env:GIT_CONFIG_NOSYSTEM = '1'
if ($git) {
    Set-Content "$tmp\gitconfig" "[user]`n`tname = Smoke`n`temail = smoke@example.com`n[init]`n`tdefaultBranch = main`n[core]`n`tautocrlf = false"
    Set-Content "$tmp\project\README" 'smoke'
    Set-Content "$tmp\project\.gitignore" '*.log'
    git -C "$tmp\project" init -q; git -C "$tmp\project" add README .gitignore; git -C "$tmp\project" commit -qm 'Start'
    if ($LASTEXITCODE -ne 0) { Fail "the project's repository"; $git = $false }
}
# What the host would have the system open goes to a file instead: nothing is opened on this machine.
Set-Content "$tmp\opener.cmd" "@echo %* >> `"$tmp\opened`""
Set-Content "$tmp\opened" '' -NoNewline

. (Join-Path $PSScriptRoot 'app.ps1')
Start-App (Join-Path $App 'Tasktap Next.exe') @{
    TASKTAP_PASSIVE = '1'
    TASKTAP_DATA = "$tmp\data"
    TASKTAP_PICK = "$tmp\project"
    TASKTAP_OPEN = "$tmp\opener.cmd"
    TASKTAP_CORE_EXE = $Core
    TASKTAP_CORE_BUILD = (Get-Content (Join-Path (Split-Path $Core -Parent) 'build.txt') -Raw).Trim()
    PATH = "$tmp\agents;$env:PATH"
    GIT_CONFIG_GLOBAL = "$tmp\gitconfig"
    GIT_CONFIG_NOSYSTEM = '1'
} $Seconds

# Waits until a page expression's value contains $want; what it last was is kept for the failure's line.
function Has($expr, $want, $seconds = 10, $page = 'workspace') {
    $until = (Get-Date).AddSeconds($seconds)
    do {
        $script:last = "$(Js $expr 3 $page)"
        if ($last.Contains($want)) { return $true }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $until)
    $false
}
# What a selector's element says, as an expression; a line typed into the shown terminal; a key pressed on an
# element (the strip's and a sheet's keys act on what has the keyboard); a field of the thought with these words.
function Text($selector) { "(document.querySelector('$selector')?.innerText ?? '')" }
function Line($line) { $null = Js "(__ws.type('$line'), 1)"; Start-Sleep -Milliseconds 400 }
function Press($selector, $key, $control = 'false') { $null = Js "(t => (t?.focus(), t?.dispatchEvent(new KeyboardEvent('keydown', { key: '$key', bubbles: true, cancelable: true, ctrlKey: $control })), !!t))(document.querySelector('$selector'))" }
function Thought($words, $field) { "String([...__ws.records.thoughts.values()].find(t => t.text === '$words')?.$field)" }
function Call($name, $json) { Send "call $name $json"; $null = Until "`"event`":`"reply`",`"name`":`"$name`"" 5 }
# A thought captured for the project as a client sends one.
function Run($words) { $null = Js "(__ws.call('thought.capture', { id: __ws.uuid7(), text: '$words', strokes: [], source: 'typed', project_id: '$project' }), 1)" }
function Js-Path($path) { $path.Replace('\', '\\') }
# Whether the app has said a line with this text in it, now or within $seconds.
function Seen($text, $seconds = 0) {
    $until = (Get-Date).AddSeconds($seconds)
    do {
        $line = $null
        while ($lines.TryDequeue([ref]$line)) { $seen.Add($line) }
        if ($seen | Where-Object { $_.Contains($text) }) { return $true }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $until)
    $false
}
$fixture = $null

try {
    # The first start of the web view on a machine takes its time.
    if (Until '"event":"ready"' 45) { Pass 'the core starts and the host reaches it over its pipe' } else { Fail 'the core starts and the host reaches it' }
    Send 'call core.status {}'
    $status = Until '"event":"reply"' 5
    if ($status -match '"terminals":0') { Pass 'the core answers the host: no terminal runs' } else { Fail "the core answers the host: $status" }
    # The page runs once its window exists; over SSH there is no desktop to show it on.
    $page = $null
    for ($i = 0; $i -lt 10 -and $page -ne 'object'; $i++) { $page = Js 'typeof __ws' 2 }
    if ($page -eq 'object') { Pass 'the workspace page runs in its web view' } else { Fail "the workspace page runs in its web view (it said: $page)" }
    $project = $null
    if ($page -eq 'object') {
        if (Has "String(__ws.records.prefs !== undefined && __ws.records.projects !== undefined)" 'true' 6) { Pass 'the page has the core''s records through the bridge' } else { Fail "the page has the core's records (it said: $last)" }
        # A core built with its fixtures detects its agents when asked, as a normal one does at start.
        Call 'put' '{"c":"prefs","id":"agent","patch":"fixture"}'
        Call 'put' '{"c":"prefs","id":"hold","patch":2}'
        Call 'agents.detect' '{}'
        # A folder as a workspace, and in it a terminal with the system's shell, typed into.
        $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$(Js-Path "$tmp\project")' }), 1)"
        for ($i = 0; $i -lt 10 -and -not $project; $i++) { $project = Js "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''" 2 }
        if ($project) { Pass 'a folder becomes a workspace' } else { Fail 'a folder becomes a workspace' }
        $null = Js "(__ws.show('$project'), __ws.command('new-terminal'), 1)"
        $terminal = $null
        for ($i = 0; $i -lt 15 -and -not $terminal; $i++) {
            Start-Sleep -Milliseconds 400
            $terminal = Js "[...__ws.records.terminals.values()].find(t => t.state === 'running')?.id ?? ''" 2
        }
        if ($terminal) { Pass 'New Terminal starts the system''s shell' } else { Fail 'New Terminal starts the system''s shell' }
        if ($terminal) {
            # The command prompt reckons: the answer is nowhere in what was typed.
            Line 'set /a 6*7'
            if (Has "(__ws.text().match(/^42/m) ?? ['no'])[0]" '42' 6) { Pass 'the shell is typed into and answers' } else { Fail 'the shell is typed into and answers' (Js '__ws.text()' 2) }
            # The fixture agent is on the PATH of the terminals, as a tool a person installed is.
            Line 'where fixture-agent'
            if (Has "__ws.text().replace(/\s+/g, '')" "$tmp\agents\fixture-agent.exe" 6) { Pass 'a terminal finds the fixture agent on its PATH' } else { Fail 'a terminal finds the fixture agent on its PATH' (Js '__ws.text()' 2) }
            $null = Js "(__ws.call('terminal.stop', { id: '$terminal' }), 1)"
        }
    }

    if ($project) {
        # ——— A thought, end to end. Typed on Home and sent: with one folder open it goes there, and starts after its hold.
        $field = "document.querySelector('.home #capture-input')"
        $null = Js "(__ws.show('home'), 1)"
        if (-not (Has "String(!!$field)" 'true' 5)) { Fail 'Home shows its field' }
        $null = Js "($field.focus(), document.execCommand('selectAll'), document.execCommand('insertText', false, 'Hello from the smoke'), 1)"
        Send 'key workspace Enter'
        if (Has (Thought 'Hello from the smoke' 'phase') 'working' 20) { Pass 'a thought typed on Home and sent is placed in the open folder and starts after its hold' } else { Fail 'a thought typed on Home is placed and starts' "its phase: $last; the field: $(Js "$field.value" 2); under it: $(Js (Text '.home .cap-said') 2)" }
        $session = Js "[...__ws.records.thoughts.values()].find(t => t.text === 'Hello from the smoke')?.session_id ?? ''" 2
        $null = Has "String(__ws.focusSession('$session'))" 'true' 10
        if (Has '__ws.text()' 'fixture-agent' 10) { Pass 'the fixture agent runs in a terminal of the workspace, which shows it' } else { Fail 'the agent''s terminal shows' (Js '__ws.text()' 2) }
        # The fixture agent, like Claude Code in a folder it does not trust yet, asks in its terminal first.
        Line 'print:Do you trust the files in this folder?'
        if (Has (Text '.strip') 'asks in its terminal' 10) { Pass 'a folder-trust prompt in a starting agent''s terminal shows in its pane''s strip' } else { Fail 'the trust prompt shows in its pane' $last }
        Line 'event:ready'
        Line 'event:turn_started'
        Line 'ask:Deploy to staging?'
        if ((Has (Text '.strip') 'Deploy to staging?' 10) -and $last.Contains('Yes')) { Pass 'the agent''s question shows in its pane''s strip with its answers' } else { Fail 'the question shows in its pane' $last }
        $null = Js "(__ws.show('home'), 1)"
        if ((Has (Text '.needs') 'Deploy to staging?' 5) -and $last.Contains('Yes')) { Pass 'Home shows it under Needs you, in full, with its answers' } else { Fail 'Home shows the question' $last }
        $null = Js "(__ws.show('$project'), 1)"
        Send 'affirm'
        if (Has '__ws.text()' 'answer:yes' 10) { Pass 'affirm, as its global shortcut sends it, answers the agent' } else { Fail 'affirm answers the question' (Js '__ws.text()' 2) }
        Line 'event:turn_finished:All green.'
        if (Has "document.querySelector('.tabw.on .st')?.dataset.s + ' ' + document.querySelector('.row.s.sel .st')?.dataset.s" 'ready ready' 10) { Pass 'the turn''s end is a result: the tab and the sidebar row mark it unread' } else { Fail 'the result marks' $last }
    }

    if ($project -and $git) {
        # ——— Runs in a copy of the project of their own. One that writes a file and exits: its changes come back
        # pending, with nothing still running.
        Call 'put' "{`"c`":`"projects`",`"id`":`"$project`",`"patch`":{`"isolate`":`"always`"}}"
        Start-Sleep -Milliseconds 500
        Run 'write:kept.txt:hello'
        if (Has (Thought 'write:kept.txt:hello' 'workdir?.changes') 'pending' 40) { Pass 'a run in its own copy of the project ends with its changes pending' } else { Fail 'a run''s changes come back pending' $last }
        $null = Js "(__ws.show('home'), 1)"
        if ((Has (Text '.waiting') '1 file' 8) -and $last.Contains('Keep') -and $last.Contains('Discard')) { Pass 'Home lists it under Changes waiting, with its diffstat and Keep, Discard and Review changes' } else { Fail 'Changes waiting on Home' $last }
        $null = Js "(document.querySelector('.waiting .key')?.click(), 1)"
        if ((Has (Thought 'write:kept.txt:hello' 'workdir?.changes') 'kept' 40) -and (Test-Path "$tmp\project\kept.txt")) { Pass 'Keep brings the changes into the project''s branch' } else { Fail 'Keep' "$last; kept.txt in the project: $(Test-Path "$tmp\project\kept.txt")" }
        # A run whose agent is still running when its changes come back: Discard stops it first, once confirmed.
        Run 'Write a scratch file'
        if (-not (Has (Thought 'Write a scratch file' 'phase') 'working' 20)) { Fail 'the second run starts' $last }
        $session = Js "[...__ws.records.thoughts.values()].find(t => t.text === 'Write a scratch file')?.session_id ?? ''" 2
        $null = Has "String(__ws.focusSession('$session'))" 'true' 10
        if (-not (Has '__ws.text()' 'fixture-agent' 10)) { Fail 'the second run''s agent shows' }
        Line 'event:ready'
        Line 'event:turn_started'
        Line 'write:dropped.txt:bye'
        Line 'event:turn_finished:Wrote it.'
        if ((Has (Text '.strip') '1 file' 40) -and $last.Contains('Review changes')) { Pass 'the pane shows the result''s diffstat with Keep, Discard and Review changes' } else { Fail 'the result strip' $last }
        Press '.strip' 'r'
        if ((Has (Text '.sheet .files') 'dropped.txt' 6) -and (Has (Text '.sheet .code') 'bye' 6)) { Pass 'Review changes opens the changed files and the diff in a sheet' } else { Fail 'review' $last }
        Press '.sheet' 'd'
        if ((Has (Text '.sheet') 'Discard the changes' 5) -and $last.Contains('Its session is stopped first')) { Pass 'Discard asks first, and says the session is stopped first' } else { Fail 'the discard sheet' $last }
        Press '.sheet' 'Backspace' 'true'
        if ((Has (Thought 'Write a scratch file' 'workdir?.changes') 'discarded' 40) -and -not (Test-Path "$tmp\project\dropped.txt")) { Pass 'Ctrl+Backspace stops the session, then discards its changes' } else { Fail 'discard' "$last; dropped.txt in the project: $(Test-Path "$tmp\project\dropped.txt")" }
        Call 'put' "{`"c`":`"projects`",`"id`":`"$project`",`"patch`":{`"isolate`":`"never`"}}"
    } elseif ($project) { Note 'no git here: the runs in a copy of the project (Keep, Discard) were not run' }

    $node = [bool](Get-Command node -ErrorAction SilentlyContinue)
    if ($project -and -not $node) { Note 'no Node here: the previews and what a frame is held to were not run' }
    if ($project -and $node) {
        # ——— Previews beside a terminal. A web server of the check's own on this machine, and files in the project.
        $confined = @($seen | Where-Object { $_ -match '"event":"frame","confined"|"confined":(true|false)' })[-1]
        if ("$confined" -match '"confined":true') { Pass 'the web view is held to this machine''s addresses before any preview gets a frame' } else { Fail 'the web view is held to this machine''s addresses' "$confined" }
        Set-Content "$tmp\frames.log" '' -NoNewline
        $start = [Diagnostics.ProcessStartInfo]::new('node')
        $start.ArgumentList.Add((Join-Path $PSScriptRoot 'frame-fixture.cjs')); $start.ArgumentList.Add("$tmp\frames.log"); $start.ArgumentList.Add((Join-Path $PSScriptRoot 'frame-probe.html'))
        $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.CreateNoWindow = $true
        $fixture = [Diagnostics.Process]::Start($start)
        $read = $fixture.StandardOutput.ReadLineAsync()
        $port, $remote, $literal = if ($read.Wait(10000)) { "$($read.Result)" -split ' ' } else { '', 'none', 'none' }
        if (-not $port) { Fail 'the check''s own web server starts' }
        Set-Content "$tmp\project\report.html" '<!doctype html><title>Report</title><body style="font:16px system-ui;margin:24px"><h1>Report</h1><p>Written by the agent.</p>'
        Set-Content "$tmp\project\beside.txt" 'beside'
        Set-Content "$tmp\outside-frame.txt" 'outside'
        $null = Js "(__ws.show('$project'), 1)"
        $shell = Js "__ws.newTerminal('$project')" 5
        if (-not (Has "__ws.records.terminals.get('$shell')?.state + ' ' + __ws.engines.get('$shell')?.attached" 'running true' 10)) { Fail 'a shell for the previews' $last }
        $cwd = Js-Path "$tmp\project"
        function Follow($kind, $target) { $null = Js "(__ws.follow('$shell', { kind: '$kind', target: '$target' }, '$cwd', {}), 1)" }
        $frame = "(f => f ? [f.getAttribute('sandbox'), new URL(f.src).host, f.src.split('/').pop()].join(' ') : 'no frame')(document.querySelector('.pane:not([hidden]) .pv iframe'))"
        $base = Js "__ws.call('host.frame', {}).then(f => f.base, e => 'refused: ' + (e.message ?? e))" 5
        $server = "$base" -replace '^http://', '' -replace '/.*$', ''
        if ("$base" -match '^http://127\.0\.0\.1:\d+/[0-9a-f]{32}$') { Pass 'the host gives a frame a server of its own on this machine, under a token' } else { Fail 'the host''s server for frames' "$base" }
        Follow 'path' 'report.html'
        if (Has $frame "allow-scripts allow-forms allow-same-origin $server report.html" 10) { Pass 'a page of the project is shown in a sandboxed frame that loads it from the host''s own server, at an address that is not the app''s' } else { Fail 'a page preview' "$last | $(Js "document.querySelector('.pane:not([hidden]) .pv')?.innerText ?? 'no preview'" 2)" }
        if (Has "fetch(document.querySelector('.pane:not([hidden]) .pv iframe').src).then(r => r.status + ' ' + r.headers.get('content-type'), e => 'refused')" 'refused' 5) { Pass 'the page around a frame cannot read the frame''s file itself: the server gives it to the frame alone' } else { Note "the page around a frame asked the server for the frame's file and was told: $last" }
        Follow 'web' "http://127.0.0.1:$port/"
        if ((Has $frame "allow-scripts allow-forms allow-same-origin 127.0.0.1:$port" 10) -and (Get-Content "$tmp\frames.log" -Raw) -match "(?m)^127\.0\.0\.1:$port /\r?$") { Pass 'a web address of this machine is shown in a sandboxed frame, loaded as it is' } else { Fail 'a local address' $last }

        # What a frame may not do, tried by a page that tries all of it: as a local address, and as a file of the project.
        $null = Js "(window.__probe = [], addEventListener('message', (e) => e.data?.probe && window.__probe.push(e.data.probe)), 1)"
        $outside = "$base/" + "$tmp\outside-frame.txt".Replace('\', '/')
        $query = "?remote=$remote&inside=beside.txt&outside=$outside&local=http://127.0.0.1:$port/self"
        (Get-Content (Join-Path $PSScriptRoot 'frame-probe.html') -Raw).Replace('<p id="said">', "<script>history.replaceState(null, '', '$query')</script><p id=`"said`">") | Set-Content "$tmp\project\probe.html"
        Follow 'web' "http://127.0.0.1:$port/probe.html?remote=$remote&local=http://localhost:$port/self&outside=$outside&literal=$literal"
        if (-not (Has 'String(window.__probe.length)' '1' 20)) { Fail 'the probe as a local address answered' $last }
        Follow 'path' 'probe.html'
        if (-not (Has 'String(window.__probe.length)' '2' 20)) { Fail 'the probe as a file answered' $last }
        Start-Sleep -Milliseconds 800
        $probes = Js 'JSON.stringify(window.__probe)' 3
        $reached = Seen 'REACHED'
        $leaked = @(Get-Content "$tmp\frames.log" | Where-Object { $_ -match '/leak' })
        if ($remote -eq 'none') { Fail 'no address that reaches this machine is remote by the rule: what a frame may load cannot be told here' }
        $every = { param($test) "$(Js "String(window.__probe.length === 2 && window.__probe.every((p) => $test))" 3)" -eq 'true' }
        $object = Js "window.__probe.map((p) => p.internals).join(' ')" 2
        if ((& $every "p.parent === 'refused' && p.records === 'refused' && p.protocol !== '200' && p.protocol !== 'loaded' && p.named !== '200' && p.named !== 'loaded' && p.invoke !== 'answered'") -and -not $reached) {
            Pass "a frame reaches nothing of the app: not the page around it or its records, and the host answers no command from it, tried through the web view's message channel, the app's own protocol and the app's own call (the app's object in the frame: $object)"
        } else { Fail 'a frame and the app''s interface' "$probes | $(@($seen | Where-Object { $_.Contains('REACHED') }) -join ' | ')" }
        if (& $every "p.top === 'refused' && p.window === 'refused'") { Pass 'a frame cannot move the window around it, and no window opens for it' } else { Fail 'a frame, the top window and new windows' $probes }
        $stopped = Seen "`"stopped`":`"http://$remote/leak-frame`"" 2
        # (A request the host refuses is answered 403, which a page that asked without leave to read sees as
        # an answer it cannot read: whether anything left is the server's to say.)
        if ($literal -eq 'none') { Fail 'the check''s server does not listen on a second loopback address: whether a socket to an address written as numbers is held back cannot be told here' }
        if ((& $every "p.picture === 'refused' && p.socket !== 'loaded'") -and "$(Js "window.__probe.find((p) => 'literal' in p)?.literal" 2)" -ne 'loaded' -and -not $leaked -and $stopped) {
            Pass "a frame loads nothing from an address that is not this machine's: a picture, a request, a socket and a frame inside it were each refused, and none reached the server ($remote); nor did a socket to a loopback address the web view is not let through to ($literal)"
        } else { Fail 'a frame and the network' "$probes | reached the server: $($leaked -join ', ') | the frame inside it stopped: $stopped" }
        $file = "$(Js "(p => String(!!p && p.inside === '200' && p.outside === '403' && p.local === 'refused'))(window.__probe.find((p) => 'inside' in p))" 3)"
        $web = "$(Js "(p => String(!!p && p.local === 'loaded' && p.outside !== '200' && p.outside !== 'loaded'))(window.__probe.find((p) => !('inside' in p)))" 3)"
        if ($file -eq 'true' -and $web -eq 'true') { Pass 'a page of the project reads the file beside it and no file outside the folders the person opened (the host''s server answers 403), and nothing of another server; a local address reads nothing from the host''s server' } else { Fail 'a frame and files' $probes }
        # Leaving for the web, by a link and by a redirect: stopped by the host, and offered to the person.
        Follow 'web' "http://127.0.0.1:$port/probe.html?remote=$remote&go=away"
        $away = Has (Text '.pv .strip') "http://$remote/leak-away" 20
        $null = Js "(document.querySelector('.pv .strip .btn')?.click(), 1)"
        Start-Sleep -Milliseconds 900
        $opened = "$(Get-Content "$tmp\opened" -Raw)".Trim()
        if ($away -and (Seen "`"stopped`":`"http://$remote/leak-away`"") -and $opened -eq "-u http://$remote/leak-away" -and -not (Get-Content "$tmp\frames.log" | Where-Object { $_ -match '/leak' })) {
            Pass 'a frame that tries to go to an address that is not this machine''s is stopped by the host; the page says where it wanted to go and the person may open that in the browser (here: the check''s own opener)'
        } else { Fail 'a frame leaving for the web' "the strip: $last | opened: $opened" }
        Follow 'web' "http://127.0.0.1:$port/probe.html?remote=$remote&go=redirect"
        $redirect = Seen "`"stopped`":`"http://$remote/leak-redirect`"" 15
        if ($redirect -and -not (Get-Content "$tmp\frames.log" | Where-Object { $_ -match '/leak' })) { Pass 'a local address that redirects to one that is not is stopped at the redirect' } else { Fail 'a redirect out of this machine' "$(@(Get-Content "$tmp\frames.log" | Where-Object { $_ -match '/leak' }) -join ', ')" }
        $null = Js "(__ws.call('terminal.stop', { id: '$shell' }), 1)"
    }

    if ($page -eq 'object') {
        # The capture key (design §12). At a desktop this system's own registers; a session
        # without one is refused every key, and the host says so, holds none and goes on.
        $refused = "e => 'refused: ' + (e.message ?? e)"
        $key = Js "__ws.call('host.capture_key', {}).then(JSON.stringify, $refused)"
        if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
            if ("$key" -match '"alt":true' -and "$key" -match '"shift":true' -and "$key" -match '"code":"Space"') { Pass 'the capture key registers: Alt-Shift-Space' } else { Fail "the capture key registers (the host said: $key)" }
        } else {
            # (Not $asked: that is app.ps1's count of the questions asked of a page.)
            $taken = Js "__ws.call('host.capture_key', { key: { control: true, alt: true, shift: false, meta: false, code: 'KeyT' } }).then(JSON.stringify, $refused)"
            if ($key -eq '{"key":null}' -and "$taken" -match '^refused: .*taken') { Pass 'no desktop here (session 0): the host holds no capture key and says that one asked for is taken' } else { Fail "the capture key without a desktop (the host said: $key, then: $taken)" }
        }
    }
    # The tab at the top edge (host\src\edge.rs): the notch's own page in a window of its own. A passive run's tab
    # takes neither the pointer nor the keyboard, so what they do is told to it here, as smoke.sh tells the notch.
    $open = "String(document.body.classList.contains('open'))"
    if ((Seen '"made":true' 20) -and (Has 'typeof __records' 'object' 20 'notch')) { Pass 'the tab''s window is made once the workspace has drawn, and the notch''s own page runs in it' } else { Fail "the tab's window and its page (the page said: $last)" }
    Send 'hover in'
    $opened = Has $open 'true' 6 'notch'
    Send 'hover out'
    if ($opened -and (Has $open 'false' 6 'notch')) { Pass 'the pointer on the tab opens its sheet and the pointer away folds it' } else { Fail "the tab opens under the pointer and folds (opened: $opened; open after: $last)" }
    Send 'capture'
    $ready = Has "document.activeElement?.id ?? ''" 'capture-input' 6 'notch'
    Send 'type notch From the tab'
    $typed = Has "document.querySelector('#capture-input')?.value ?? ''" 'From the tab' 5 'notch'
    Send 'key notch Escape'
    if ($ready -and $typed -and (Has $open 'false' 6 'notch')) { Pass 'the capture key opens the tab with the caret in its field, what is typed is there, and Escape folds it' } else { Fail "capture in the tab (the caret ready: $ready; typed: $typed; open after Escape: $last)" }
    Send 'state'
    if (Until '"event":"state"' 5) { Pass 'the app says its state' } else { Fail 'the app says its state' }
} finally {
    if ($fixture -and -not $fixture.HasExited) { $fixture.Kill($true) }
    if (-not $proc.HasExited) {
        Send 'call core.retire {"when":"now"}'
        $null = Until '"event":"reply","name":"core.retire"' 3
        Send 'quit'
        $told = Get-Date
        $heard = Until '"event":"quitting"' 5
        if ($proc.WaitForExit(10000)) {
            Pass "the app quits when told ($([int]((Get-Date) - $told).TotalMilliseconds) ms)"
        } else {
            $proc.Kill($true)
            # Seen over SSH on 2026-11-18: the app takes the request ("quitting") and its event
            # loop never ends. With no desktop (session 0) that is not known to be the app's
            # fault, so there it is said and not counted; at a desktop it is a failure.
            $why = "the app $(if ($heard) { 'took the request and' } else { 'never took the request and' }) was still running 10 s later; this script ended it"
            if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Note "no desktop here (session 0): $why" } else { Fail "the app quits when told: $why" }
        }
    } else {
        Fail "the app ended by itself with exit code $($proc.ExitCode)"
    }
    Start-Sleep -Milliseconds 500
    $line = $null
    while ($lines.TryDequeue([ref]$line)) { $seen.Add($line) }
    # Nothing of this run stays behind: its core, the shims and the agents run from the data folder and the
    # agents' folder. Found by their paths, not their command lines: those only the management service tells
    # (Win32_Process), and it refuses a standard account signed in over SSH.
    $left = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($tmp, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count) { Fail "left running: $(($left | ForEach-Object Name) -join ', ')"; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 } else { Pass 'nothing is left running' }
    if ($failed) { Write-Host '--- what the app said'; $seen | Where-Object { $_ -notmatch '"event":"report"' } | Select-Object -Last 40 | ForEach-Object { Write-Host "  $($_.Substring(0, [Math]::Min(300, $_.Length)))" } }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host $(if ($failed) { "$failed FAILED" } else { 'all passed' })
exit $failed
