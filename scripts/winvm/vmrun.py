#!/usr/bin/env python3
"""Run Fusion's vmrun with its encrypted-VM password prompt on a private tty."""
import errno
import os
import pty
import select
import subprocess
import sys
import termios

binary = "/Applications/VMware Fusion.app/Contents/Library/vmrun"
command = [binary, "-T", "fusion", *sys.argv[1:]]
if sys.argv[1:] == ["list"]:
    os.execv(binary, command)

master, slave = pty.openpty()
settings = termios.tcgetattr(slave)
settings[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, settings)
# Do not make this pty the controlling terminal of Fusion's VM process.
proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b""
password = b""
try:
    while True:
        if select.select([master], [], [], 0.2)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            output += data
            if b"Encrypted virtual machine password: " in output:
                if password:
                    sys.exit("Fusion rejected the VM password in Keychain")
                password = subprocess.check_output(
                    ["/usr/bin/security", "find-generic-password", "-s", sys.argv[2], "-w"]
                ).rstrip(b"\n")
                os.write(master, password + b"\n")
                output = b""
        elif proc.poll() is not None:
            break
finally:
    os.close(master)
if password:
    output = output.replace(password, b"***")
sys.stdout.buffer.write(output.replace(b"\r", b"").lstrip(b"\n"))
sys.exit(proc.wait())
