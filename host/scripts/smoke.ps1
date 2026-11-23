# host\scripts\smoke.ps1: what smoke.sh proves on the Mac, as far as it is built for Windows. It starts the built app on a temporary data folder, passive (it takes no keyboard and uses a clipboard
# of its own), with a core that has the fixture agent, drives it only through its debug channel (one command per
# line on standard input), and says PASS or FAIL for:
#   - a core ten seconds slow to start: quitting while it starts leaves nothing running (a launch of its own, first),
#     and the window does not wait for it (the main launch, whose page has the core once it is there);
#   - the core starting and the host reaching it over its pipe, the workspace page running and having the core's
#     records through the bridge, the first start's welcome coming by itself, its four steps walked and Escape leaving
#     it for Home with Finish setup, a
#     folder becoming a workspace, a terminal with the system's shell answering what is typed into it; closing a
#     terminal: a program running in it named in the sheet that asks, an idle shell closed without a question;
#   - a thought end to end: typed on Home and sent, placed in the open folder, the fixture agent working in a
#     terminal of the workspace, its folder-trust prompt and its question in the pane's strip and on Home, the
#     question answered as the global shortcut answers it, its result marked; then runs in a copy of the project
#     of their own: changes that wait, Keep bringing them in, Discard asked first and taking them away;
#   - previews beside a terminal: a page of the project and a local web address in a frame, and what a frame is
#     held to (host\src\frames.rs), tried by the page the Mac's check uses (frame-probe.html);
#   - the tab at the top edge: its window made with the notch's own page in it, opened and folded as the pointer
#     and the capture key would, told through the debug channel (a passive run's tab takes neither; what the real
#     pointer and keys do is the desktop round's, scripts\winvm\desktop.ps1);
#   - the capture key and the keys that answer a question from any app, and the app quitting with nothing left running.
#   pwsh host\scripts\build.ps1 -Fixtures
#   pwsh host\scripts\smoke.ps1
# The runs need git, the previews Node (for the check's own web server); without one, that part is said and not
# run. What smoke.sh checks beyond this (most of the notch, speech, splits, the sheets, Settings, pictures) is not here yet:
# scripts\winvm\README.md, "The smoke script".
param(
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [string]$App = (Join-Path (Split-Path $PSScriptRoot -Parent) "target\$Target-pc-windows-msvc\release\Tasktap"),
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
# no configuration but the check's own, for as long as the check runs: whoever called it has their own back after
# (scripts\winvm\host.ps1 asks git about the checkout next, whose line endings the machine's configuration says).
$git = [bool](Get-Command git -ErrorAction SilentlyContinue)
$gitWas = $env:GIT_CONFIG_GLOBAL, $env:GIT_CONFIG_NOSYSTEM
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
$build = (Get-Content (Join-Path (Split-Path $Core -Parent) 'build.txt') -Raw).Trim()
# A core slow to start, as a first start's can be (its new copy looked at by a virus scanner, a slow disk), as smoke.sh
# has it: a stand-in (slow-core.rs) that waits SMOKE_CORE_DELAY seconds (none unless a launch sets it) and then runs the
# core SMOKE_CORE names, a copy of the fixture core, with what it was given, for as long as that runs (Windows has no
# exec). It is built with the fixtures (build.ps1), or here when rustc is on the PATH. The app copies it into its data
# folder and starts it from there; the core it runs is under this run's folder, where what is left running is looked
# for.
$slow = $null
$built = Join-Path (Split-Path $Core -Parent) 'slow-core.exe'
if (Test-Path $built) { $slow = $built }
elseif (Get-Command rustc -ErrorAction SilentlyContinue) {
    $null = rustc -O -o "$tmp\slow-core.exe" "$PSScriptRoot\slow-core.rs" 2>&1
    if ($LASTEXITCODE -eq 0) { $slow = "$tmp\slow-core.exe" }
}
if ($slow) {
    New-Item -ItemType Directory -Force "$tmp\fixture-core" | Out-Null
    Copy-Item $Core "$tmp\fixture-core\tasktap.exe"
    # Told to quit at the second second of a launch of its own, its core ten seconds slow: the app ends, and 12 s after
    # the launch nothing runs from its folder (the stand-in, ended before it ran the core, is the only thing that would
    # start one).
    New-Item -ItemType Directory -Force "$tmp\early" | Out-Null
    $launched = Get-Date
    Start-App (Join-Path $App 'tasktap-app.exe') @{
        TASKTAP_PASSIVE = '1'
        TASKTAP_DATA = "$tmp\early"
        TASKTAP_CORE_EXE = $slow
        TASKTAP_CORE_BUILD = $build
        SMOKE_CORE_DELAY = '10'
        SMOKE_CORE = "$tmp\fixture-core\tasktap.exe"
        CLAUDE_CONFIG_DIR = "$tmp\no-history\claude"
        CODEX_HOME = "$tmp\no-history\codex"
    } 60
    Start-Sleep -Seconds 2
    Send 'quit'
    $ended = $proc.WaitForExit(10000)
    # The app alone: a core it started, or the stand-in, would be seen left running.
    if (-not $ended) { $proc.Kill($false) }
    $rest = 12 - ((Get-Date) - $launched).TotalSeconds
    if ($rest -gt 0) { Start-Sleep -Milliseconds ([int]($rest * 1000)) }
    $left = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$tmp\early", [StringComparison]::OrdinalIgnoreCase) })
    # With no desktop (session 0) the app takes the quit and its event loop never ends (as below, "the app quits when
    # told"): there only what is left running counts.
    $desk = [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0
    if (($ended -or -not $desk) -and -not $left.Count) { Pass "told to quit two seconds into a core's ten-second start, $(if ($ended) { 'the app ends' } else { 'the app gives the start up (no desktop here: its end is not waited for)' }), and nothing runs from its folder after or starts there" } else { Fail 'quit while the core starts' "the app ended when told: $ended; running from its folder 12 s after the launch: $(($left | ForEach-Object Name) -join ', ')"; $left | Stop-Process -Force -ErrorAction SilentlyContinue }
} else { Note 'no rustc here to build the slow core''s stand-in: the app starts with the fixture core as it is, and a core slow to start is not tried' }

# Its first start's core is slow too, through the stand-in: ten seconds pass before it listens.
Start-App (Join-Path $App 'tasktap-app.exe') @{
    TASKTAP_PASSIVE = '1'
    TASKTAP_DATA = "$tmp\data"
    TASKTAP_PICK = "$tmp\project"
    TASKTAP_OPEN = "$tmp\opener.cmd"
    TASKTAP_CORE_EXE = $(if ($slow) { $slow } else { $Core })
    TASKTAP_CORE_BUILD = $build
    SMOKE_CORE_DELAY = $(if ($slow) { '10' } else { '0' })
    SMOKE_CORE = "$tmp\fixture-core\tasktap.exe"
    PATH = "$tmp\agents;$env:PATH"
    GIT_CONFIG_GLOBAL = "$tmp\gitconfig"
    GIT_CONFIG_NOSYSTEM = '1'
    # No agent's history to offer, so that the first start is the same on every machine (as smoke.sh gives it).
    CLAUDE_CONFIG_DIR = "$tmp\no-history\claude"
    CODEX_HOME = "$tmp\no-history\codex"
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
    # Neither the window nor the page's word that it has drawn waits for the slow core. Judged by cause, as smoke.sh
    # does, not by the clock: the window is shown before the core is there, by the page's word or by the host's fallback
    # 3 s after the window is made (on a slow machine the page itself takes longer than that), and the page's word
    # reaches the host before the core is there. 5 s is only a net for the window.
    $ready = { [bool]($seen | Where-Object { $_.Contains('"event":"ready"') }) }
    if ($slow) {
        # The app's lines in order until the window and the page's word are both said, or the core is there.
        $until = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $until -and -not (& $ready) -and -not (($seen | Where-Object { $_.Contains('"event":"window"') }) -and ($seen | Where-Object { $_.Contains('"event":"page-ready"') }))) {
            $null = Until '"event":"(window|page-ready|ready)"' 1
        }
        $at = { param($what) for ($k = 0; $k -lt $seen.Count; $k++) { if ($seen[$k].Contains("`"event`":`"$what`"")) { return $k } }; -1 }
        $core = & $at 'ready'
        $first = { param($k) $k -ge 0 -and ($core -lt 0 -or $k -lt $core) }
        $window = $seen | Where-Object { $_.Contains('"event":"window"') } | Select-Object -First 1
        $page = $seen | Where-Object { $_.Contains('"event":"page-ready"') } | Select-Object -First 1
        $ms = if ("$window" -match '"ms":(\d+)') { [int]$Matches[1] }
        $by = if ("$window" -match '"by":"(\w+)"') { $Matches[1] }
        $said = if ("$page" -match '"ms":(\d+)') { [int]$Matches[1] }
        $windowFirst = & $first (& $at 'window')
        $pageFirst = & $first (& $at 'page-ready')
        if ($windowFirst -and $pageFirst -and $ms -and $ms -le 5000) { Pass "with a core ten seconds slow to start, the window is shown before it is there ($ms ms after the launch, by the $by), and the page said it had drawn before it too ($said ms)" } else { Fail 'the window does not wait for the core' "the window: $(if ($ms) { "shown by the $by at $ms ms" } else { 'not shown' }), before the core: $windowFirst; the page said it had drawn: $(if ($said) { "at $said ms" } else { 'never' }), before the core: $pageFirst" }
    }
    # The first start of the web view on a machine takes its time.
    if ((& $ready) -or (Until '"event":"ready"' 45)) { Pass 'the core starts and the host reaches it over its pipe' } else { Fail 'the core starts and the host reaches it' }
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
        # First start (ui/src/workspace/welcome.tsx), as smoke.sh tries it: with no agent's history to offer, the welcome
        # comes by itself in place of Home, one step in view (the projects, the agents, who finds the project for a
        # task, talking instead of typing), each of which can be skipped; after the last, Home shows with "Finish
        # setup" under the Composer, which comes back to a step left open; Escape leaves the welcome for Home, the
        # keyboard in the Composer. (Compared in the page: what the app prints is read here in the console's code page.)
        $stepnow = "(w => w ? w.querySelector('.wc-m').getAttribute('aria-label') + '|' + w.querySelector('h1').childNodes[0].textContent : 'none')(document.querySelector('.welcome .wc'))"
        $firstStep = "(w => w ? w.querySelector('.wc-m').getAttribute('aria-label') + ' ' + /^(Your projects|No projects found)/.test(w.querySelector('h1').textContent) + ' ' + !document.querySelector('.home:not(.row)') + ' ' + String(__ws.ui.sheet) + ' ' + __ws.records.prefs.get('setup_hidden')?.value : 'none')(document.querySelector('.welcome .wc'))"
        if (Has $firstStep 'Step 1 of 4 true true null false' 10) {
            Pass 'with no agent''s history, the first start shows the welcome by itself in place of Home: its first step, the projects, no sheet over it, and that the first start was seen is written down'
        } else { Fail 'the first start''s welcome' "it said: $last" }
        $walked = $true
        foreach ($want in 'Step 2 of 4|Your agents', 'Step 3 of 4|Let Tasktap find the project for each task', 'Step 4 of 4|Talk instead of typing') {
            $null = Js "(document.querySelector('.welcome .wc-skip')?.click(), 1)"
            if (-not (Has $stepnow $want 5)) { $walked = $false; Fail 'the welcome''s four steps are walked' "it did not reach $want; it said: $last"; break }
        }
        if ($walked) {
            $null = Js "(document.querySelector('.welcome .wc-skip')?.click(), 1)"
            if (Has "String(!document.querySelector('.welcome')) + ' ' + document.querySelector('.home .finish')?.textContent" 'true Finish setup' 5) {
                Pass 'the welcome''s four steps are walked, the agents, who finds the project and talking instead of typing, and after the last Home shows with Finish setup'
            } else { Fail 'Home shows Finish setup after the welcome''s last step' "it said: $last" }
        }
        $null = Js "(document.querySelector('.home .finish')?.click(), 1)"
        $leaves = "(document.querySelector('.welcome .wc')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)"
        if (Has "String(!!document.querySelector('.welcome .wc')) + ' ' + String(!document.querySelector('.home:not(.row)'))" 'true true' 5) { $null = Js $leaves }
        if (Has "String(!document.querySelector('.welcome')) + ' ' + document.activeElement?.id + ' ' + document.querySelector('.home .finish')?.textContent" 'true capture-input Finish setup' 5) {
            Pass 'Finish setup brings the welcome back at a step still open, and Escape leaves it for Home: the keyboard in the Composer, Finish setup still under it'
        } else { Fail 'Escape leaves the welcome for Home' "it said: $last" }
        $metal = "(k => /linear-gradient/.test(getComputedStyle(k).backgroundImage) && getComputedStyle(k).color === 'rgb(13, 13, 14)')(document.querySelector('.home .cap-row .key'))"
        $composed = "String([...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' ') === 'Auto' && $metal && (b => b.textContent === 'Start' && b.disabled)(document.querySelector('.home .cap-row .key')) && !document.querySelector('.hx.first > :not(.capture, .finish, .cols)'))"
        if ((Has "String(!__ws.ui.sheet && !!document.querySelector('.home .finish'))" 'true' 5) -and "$(Js $composed 2)" -eq 'true') {
            Pass 'after the welcome, Home is the Composer, its place saying Auto, its key the metal key that Return starts with, and Finish setup under it with nothing else'
        } else { Fail 'Home after the first start''s welcome' "no sheet, Finish setup on Home: $last; the rest: $(Js $composed 2); under the Composer: $(Js (Text '.home .hx') 2)" }
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
            # A program in front in the shell: closing its tab asks, naming it as the core says it (terminal.runs; on
            # Windows a program as a person types it, PING for PING.EXE). Ctrl+Backspace there stops the session.
            Line 'ping -n 600 127.0.0.1'
            if (-not (Has "__ws.call('terminal.runs', { id: '$terminal' }).then(r => r.state + ' ' + r.what.join(','))" 'running PING' 8)) { Fail 'the core says what runs in the shell' $last }
            $null = Js "(__ws.command('close-tab'), 1)"
            if ((Has (Text '.sheet') 'Keep running in background' 5) -and $last.Contains('Stop session') -and $last.Contains('PING is running in it.')) { Pass 'closing the tab of a shell where a program runs offers Keep running, Stop and Cancel in a sheet that names the program' } else { Fail 'the close sheet' $last }
            Press '.sheet' 'Backspace' 'true'
            if (Has "__ws.records.terminals.get('$terminal')?.state ?? ''" 'exited' 8) { Pass 'Ctrl+Backspace in it stops the session' } else { Fail 'stopping from the close sheet' $last }
            # A shell with nothing running in it closes at once, by its key and by its row's cross in the sidebar, and ends.
            foreach ($how in 'key', 'cross') {
                $idle = Js "__ws.newTerminal('$project')" 5
                if (-not (Has "__ws.call('terminal.runs', { id: '$idle' }).then(r => r.state)" 'idle' 10)) { Fail 'the core says a new shell is idle' $last }
                $close = if ($how -eq 'key') { "(__ws.focusSession('$idle'), __ws.command('close-tab'), 1)" } else { "(document.querySelector(`".srow[data-id='$idle'] > .x`")?.click(), 1)" }
                $null = Js $close
                Start-Sleep -Milliseconds 500
                $gone = Js "String(!__ws.ui.sheet && !__ws.L.tabs(__ws.layout('$project')).includes('$idle') && !__ws.layout('$project').background.includes('$idle'))" 3
                if ("$gone" -eq 'true' -and (Has "__ws.records.terminals.get('$idle')?.state ?? ''" 'exited' 5)) { Pass "closing a shell with nothing running in it by its $how asks nothing, takes its tab away and ends it" } else { Fail "closing an idle shell by its $how" "no sheet, no tab: $gone; its state: $last; the sheet: $(Js (Text '.sheet') 2)" }
            }
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
        # Keep is the row's first quiet button.
        $null = Js "(document.querySelector('.waiting .hr-a .btn')?.click(), 1)"
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
        if (& $every "p.bars === '0 none none'") { Pass "a page in a frame shows no scrollbar: the host's style for frames reaches its scrollers" } else { Fail 'scrollbars in a frame' $probes }
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
            if ("$key" -match '^\{"key":null[,}]' -and "$taken" -match '^refused: .*taken') { Pass 'no desktop here (session 0): the host holds no capture key and says that one asked for is taken' } else { Fail "the capture key without a desktop (the host said: $key, then: $taken)" }
        }
        # The keys that answer an agent's question from any app (host\src\keys.rs), held only while one waits: this
        # system's own, Alt-Shift with J (to the question), Y and N, since Control-Alt is AltGr on Windows.
        $answers = Js "__ws.call('host.answer_key', {}).then(r => ['question', 'yes', 'no'].map(w => (k => k ? [k.control, k.alt, k.shift, k.meta, k.code].join(' ') : 'none')(r[w])).join(' | '), $refused)"
        if ("$answers" -eq 'false true true false KeyJ | false true true false KeyY | false true true false KeyN') { Pass 'the answer keys are Windows'' own: Alt-Shift-J goes to the question, Alt-Shift-Y and Alt-Shift-N answer it' } else { Fail 'the answer keys' "the host said (Control Alt Shift Windows key): $answers" }
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
    $env:GIT_CONFIG_GLOBAL, $env:GIT_CONFIG_NOSYSTEM = $gitWas
}
Write-Host $(if ($failed) { "$failed FAILED" } else { 'all passed' })
exit $failed
