"""Open Tasktap's local launcher in macOS terminal apps and return to its recorded surface."""
from pathlib import Path
import shlex
import subprocess
import uuid


GHOSTTY_OPEN = """on run argv
    set startDir to item 1 of argv
    set runCommand to item 2 of argv
    tell application id "com.mitchellh.ghostty"
        set cfg to new surface configuration
        set initial working directory of cfg to startDir
        set command of cfg to runCommand
        set wait after command of cfg to false
        set win to new window with configuration cfg
        set term to focused terminal of selected tab of win
        focus term
        activate
        return id of term
    end tell
end run"""

GHOSTTY_FOCUS = """on run argv
    set sessionID to item 1 of argv
    tell application id "com.mitchellh.ghostty"
        set matches to every terminal whose id is sessionID
        if (count of matches) is not 1 then error "The original Ghostty terminal has closed."
        focus item 1 of matches
        activate
    end tell
end run"""

ITERM_OPEN = """on run argv
    set runCommand to item 1 of argv
    tell application id "com.googlecode.iterm2"
        set win to create window with default profile command runCommand
        activate
        return unique ID of current session of win
    end tell
end run"""

ITERM_FOCUS = """on run argv
    set sessionID to item 1 of argv
    set expectedTTY to item 2 of argv
    tell application id "com.googlecode.iterm2"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if unique ID of s is sessionID and tty of s is expectedTTY then
                        select w
                        select t
                        select s
                        activate
                        return
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    error "The original iTerm2 session has closed."
end run"""


def _script(source, *args):
    return subprocess.run(['/usr/bin/osascript','-e',source,*args],check=True,
                          capture_output=True,text=True,timeout=45).stdout.strip()


def _launcher(argv, cwd, run_dir):
    # Only runner paths enter the shell script; the reviewed agent prompt lives in its private job.
    file=run_dir/'Agent.command'
    with file.open('w',encoding='utf-8') as out:
        out.write('#!/bin/sh\ncd -- '+shlex.quote(str(cwd))+' || exit 1\nexec '+shlex.join(argv)+'\n')
    file.chmod(0o700)
    return file


def _open_warp(file):
    subprocess.run(['/usr/bin/open','-b','dev.warp.Warp-Stable',str(file)],
                   check=True,capture_output=True,timeout=15)


def open_terminal(host, argv, cwd, title, run_dir):
    run_dir=Path(run_dir)
    if host=='warp':
        # A Warp .command document opens a fresh interactive tab. screen starts attached;
        # its socket identifies this exact worker even on Warp builds without local control.
        name='tasktap-'+uuid.uuid4().hex
        (run_dir/'warp-screen').write_text(name)
        config=run_dir/'screenrc'
        config.write_text('startup_message off\nautodetach off\nescape ^]a\nbind d\nbind ^D\nbind D\nbind z\nbind ^Z\n')
        file=_launcher(['/usr/bin/screen','-U','-c',str(config),'-S',name,*argv],cwd,run_dir)
        _open_warp(file)
        return
    file=_launcher(argv,cwd,run_dir)
    if host=='ghostty':
        ident=_script(GHOSTTY_OPEN,str(cwd),'/bin/sh -c '+shlex.quote('exec '+shlex.quote(str(file))))
    elif host=='iterm2':
        ident=_script(ITERM_OPEN,'/bin/sh -c '+shlex.quote('exec '+shlex.quote(str(file))))
    else:
        raise ValueError('Unsupported terminal app.')
    if not ident:
        raise ValueError('The terminal did not return a session ID. Check the window it opened.')
    (run_dir/'host-surface-id').write_text(ident)


def focus_terminal(host, surface, run_dir):
    run_dir=Path(run_dir)
    if host=='warp':
        record=run_dir/'warp-screen'
        if not record.is_file():
            raise ValueError('This Warp session has no recorded terminal connection.')
        name=record.read_text()
        if not name.startswith('tasktap-') or uuid.UUID(hex=name[8:]).hex!=name[8:]:
            raise ValueError('Invalid Warp session identity.')
        # -x attaches a second display to this server. Unlike -R it cannot start a session.
        attach=run_dir/'Open Tasktap session.command'
        attach.write_text('#!/bin/sh\nexec /usr/bin/screen -x '+name+'\n')
        attach.chmod(0o700)
        _open_warp(attach)
        return
    identity=run_dir/'host-surface-id'
    if not identity.is_file():
        raise ValueError('The terminal has not confirmed its session ID yet.')
    if host=='iterm2':
        _script(ITERM_FOCUS,identity.read_text(),surface['tty'])
    elif host=='ghostty':
        _script(GHOSTTY_FOCUS,identity.read_text())
    else:
        raise ValueError('Unsupported terminal app.')
