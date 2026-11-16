"""Private shell startup and interactive CLI shims, scoped to one Tasktap PTY.

No user shell files, CLI config or global PATH entries are changed. Explicit CLI
permission flags win; help, authentication and noninteractive commands pass through.
"""
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
sys.dont_write_bytecode = True
import termios
import uuid

from session_observer import SUPPORTED, atomic, prepare, read, ingest, codex_trust_overrides

HERE = Path(__file__).resolve().parent
RELEASE_SEQUENCE=b'\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h'


def restore_terminal(saved):
    """Release TUI modes without clearing history or sending text to the shell."""
    try: os.write(sys.stdout.fileno(),RELEASE_SEQUENCE)
    except OSError: pass
    try: termios.tcsetattr(sys.stdin.fileno(),termios.TCSANOW,saved)
    except (OSError,termios.error): pass


PASSTHROUGH = {
    'codex': {'agents','exec','e','review','login','logout','mcp','plugin','app-server','remote-control','app','completion','update','doctor','sandbox','debug','apply','queue','archive','delete','migrate-rollouts','migrate-nfs-db','unarchive','cloud','exec-server','features','help'},
    'claude': {'auth','doctor','install','mcp','plugin','plugins','setup-token','update','upgrade','help'},
    'opencode': {'acp','auth','bench','completion','db','debug','export','import','mcp','models','pr','run','serve','session','stats','uninstall','upgrade','web','help'},
    'pi': {'install','remove','update','list','config'},
}
VALUE_OPTIONS = {'-c','--config','-m','--model','-p','--profile','-s','--sandbox','-C','--cd','--add-dir','-a','--ask-for-approval','--provider','--api-key','--permission-mode','--settings','--session-id','--resume','--agent','--format','--output-format','--input-format','-e','--extension','--thinking','--remote','--remote-auth-token-env'}


def interactive(agent, args):
    if not sys.stdin.isatty() or not sys.stdout.isatty(): return False
    if any(a in ('-h','--help','-V','--version','--print','--remote','--json','--rpc') or a.startswith('--remote=') for a in args): return False
    if agent in ('claude','pi') and '-p' in args: return False
    if agent=='pi' and any(a=='--mode' or a.startswith('--mode=') for a in args): return False
    skip=False
    for arg in args:
        if skip: skip=False; continue
        if arg=='--': return True
        if arg in VALUE_OPTIONS: skip=True; continue
        if arg.startswith('-'): continue
        return arg not in PASSTHROUGH.get(agent,set())
    return True


def approval_args(agent, args):
    # Respect a caller's explicit policy, including --option=value spellings.
    names={a.split('=',1)[0] for a in args}
    explicit = {
        'codex': {'--approve-for-me','--ask-for-approval','-a','--dangerously-bypass-approvals-and-sandbox','--sandbox','-s'},
        'claude': {'--permission-mode','--dangerously-skip-permissions','--permission-prompt-tool'},
        'pi': {'--approve','-a','--no-approve','-na'},
        'opencode': {'--auto'},
    }
    if names & explicit[agent]: return []
    if agent=='codex' and any(a.startswith(('approval_policy=','approvals_reviewer=','sandbox_mode=')) for a in args): return []
    return {'codex':['--approve-for-me'],'claude':['--permission-mode','auto'],'pi':['--approve'],'opencode':['--auto']}[agent]


def shell(shell_path, session, runs):
    session=str(uuid.UUID(session))
    root=Path(os.environ.get('TASKTAP_TERMINAL_ROOT') or Path.home()/'Library/Application Support/Tasktap/Terminals')
    private=root/'Shells'/session
    private.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(private,0o700)
    bindir=private/'bin';bindir.mkdir(exist_ok=True,mode=0o700)
    for agent in SUPPORTED:
        shim=bindir/agent
        shim.write_text('#!/bin/sh\nexec '+shlex.join([sys.executable,str(HERE/'tasktap_shell.py'),'cli',agent])+' "$@"\n')
        shim.chmod(0o700)
    env=dict(os.environ,TASKTAP_TERMINAL_ID=session,TASKTAP_RUNS=str(Path(runs).resolve()),
             TASKTAP_TERMINAL_FOLDER=os.getcwd(),TASKTAP_CLI_BIN=str(bindir))
    prepend='export PATH='+shlex.quote(str(bindir))+':"$PATH"\n'
    name=Path(shell_path).name
    if name=='zsh':
        env['TASKTAP_USER_ZDOTDIR']=env.get('ZDOTDIR',str(Path.home()))
        env['TASKTAP_ZDOTDIR_WAS_SET']='1' if 'ZDOTDIR' in env else '0'
        env['TASKTAP_BOOTSTRAP_ZDOTDIR']=str(private)
        env['ZDOTDIR']=str(private)
        for filename in ('.zshenv','.zprofile','.zshrc','.zlogin','.zlogout'):
            text='ZDOTDIR="$TASKTAP_USER_ZDOTDIR"\n'
            text+='[[ ! -r "$ZDOTDIR/'+filename+'" ]] || source "$ZDOTDIR/'+filename+'"\n'
            text+='TASKTAP_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"\n'
            if filename in ('.zshrc','.zlogin'): text+=prepend
            if filename in ('.zlogin','.zlogout'):
                text+='if [[ $TASKTAP_ZDOTDIR_WAS_SET == 0 && $ZDOTDIR == $HOME ]]; then unset ZDOTDIR; fi\n'
            else: text+='ZDOTDIR="$TASKTAP_BOOTSTRAP_ZDOTDIR"\n'
            (private/filename).write_text(text)
        argv=[shell_path,'-l','-i']
    elif name=='bash':
        rc=private/'bashrc'
        rc.write_text('for tasktap_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do\n  if [ -r "$tasktap_profile" ]; then . "$tasktap_profile"; break; fi\ndone\nunset tasktap_profile\n'+prepend)
        argv=[shell_path,'--rcfile',str(rc),'-i']
    elif name=='fish':
        argv=[shell_path,'-l','-i','-C','set -gx PATH '+shlex.quote(str(bindir))+' $PATH']
    else:
        env['PATH']=str(bindir)+os.pathsep+env.get('PATH',os.defpath)
        argv=[shell_path,'-l']
    os.execve(shell_path,argv,env)


def cli(agent, args):
    bindir=os.environ.get('TASKTAP_CLI_BIN','')
    # Resolve the real executable after normal user shell startup has completed.
    clean_path=os.pathsep.join(p for p in os.environ.get('PATH',os.defpath).split(os.pathsep)
                              if p and Path(p).resolve()!=Path(bindir).resolve())
    executable=shutil.which(agent,path=clean_path)
    if not executable: raise ValueError(agent+' is not installed on this shell’s PATH.')
    if not bindir or not os.environ.get('TASKTAP_TERMINAL_ID') or not interactive(agent,args):
        os.execv(executable,[executable,*args])
    session=str(uuid.UUID(os.environ['TASKTAP_TERMINAL_ID']))
    folder=Path(os.environ['TASKTAP_RUNS'])/session
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (folder/'surface.lock').open('a') as guard:
        try: fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            # A nested agent cannot replace the outer CLI's lifecycle or answers.
            os.execv(executable,[executable,*args])
        job=dict(agent=agent,host='tasktap',mode='ask',delivery='interactive',observer=True,shellLaunch=True,
                 session=session,capture=str(uuid.uuid4()),folder=os.getcwd(),terminalFolder=os.environ['TASKTAP_TERMINAL_FOLDER'],
                 task=agent+' · '+Path.cwd().name,outgoing='',instructions='')
        atomic(folder/'shell.receipt',dict(state='Opened'))
        atomic(folder/'shell.job',job)
        surface=dict(host='tasktap',open=True,tty=os.ttyname(0),pid=os.getpid(),shellLaunch=True)
        atomic(folder/'surface.json',surface)
        process=None;code=1;saved_tty=termios.tcgetattr(sys.stdin.fileno())
        try:
            hook_args,env=prepare(job,folder)
            if agent=='codex': hook_args=['--no-daemon',*codex_trust_overrides(executable,folder,os.getcwd()),*hook_args]
            argv=[executable,*hook_args,*approval_args(agent,args),*args]
            process=subprocess.Popen(argv,env=env)
            ingest(folder,read(folder/'observer-config.json')['token'],dict(kind='cli_started'))
            # The child receives the terminal's signals too. Keep this monitor alive
            # to record CLI exit and return to the shell after Ctrl-C/Ctrl-Z.
            old=signal.signal(signal.SIGINT,signal.SIG_IGN)
            try: code=process.wait()
            finally: signal.signal(signal.SIGINT,old)
        finally:
            restore_terminal(saved_tty)
            surface['open']=False;atomic(folder/'surface.json',surface)
            ingest(folder,read(folder/'observer-config.json').get('token',''),dict(kind='process_exited',exitCode=code))
        return code


if __name__=='__main__':
    try:
        if sys.argv[1]=='shell': shell(*sys.argv[2:5])
        elif sys.argv[1]=='cli': sys.exit(cli(sys.argv[2],sys.argv[3:]))
        else: raise ValueError('Unknown Tasktap shell operation.')
    except (OSError,ValueError) as error:
        print('Tasktap: '+str(error),file=sys.stderr);sys.exit(1)
