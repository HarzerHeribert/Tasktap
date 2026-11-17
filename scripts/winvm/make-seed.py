#!/usr/bin/env python3
"""Create private Windows setup media next to the VM. Keep secrets out of argv."""
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile

os.umask(0o077)
stage = Path(sys.argv[1]).resolve()
stage.mkdir(mode=0o700, exist_ok=True)
source = Path(__file__).resolve().parent
key = Path.home() / ".ssh/tasktap-winvm.pub"
service = "Tasktap Windows VM local administrator"
lookup = ["security", "find-generic-password", "-a", "tasktap", "-s", service, "-w"]
result = subprocess.run(lookup, capture_output=True)
if result.returncode == 44:
    password = "Az9!" + secrets.token_urlsafe(32)
    # security -i receives the credential on stdin. Verify that storage succeeded.
    command = f'add-generic-password -s "{service}" -a tasktap -w "{password}"\n'
    subprocess.run(["security", "-i"], input=command.encode(), capture_output=True, check=True)
    if subprocess.check_output(lookup).decode().strip() != password:
        sys.exit("Keychain verification failed")
elif result.returncode == 0:
    password = result.stdout.decode().strip()
else:
    sys.exit(f"Keychain lookup failed ({result.returncode})")

from xml.sax.saxutils import escape
with tempfile.TemporaryDirectory(dir=stage) as tmp:
    seed = Path(tmp)
    (seed / "autounattend.xml").write_text((source / "autounattend.xml").read_text().replace("__PASSWORD__", escape(password)))
    (seed / "bootstrap.ps1").write_bytes((source / "bootstrap.ps1").read_bytes())
    (seed / "allow-ssh.ps1").write_bytes((source / "allow-ssh.ps1").read_bytes())
    (seed / "client.pub").write_bytes(key.read_bytes())
    subprocess.run(["hdiutil", "makehybrid", "-iso", "-joliet", "-default-volume-name",
                    "TASKTAPSEED", "-o", str(stage / "seed.iso"), str(seed)], check=True)
print(f"Administrator password stored in login Keychain under {service!r}, account tasktap.")
