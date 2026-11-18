#!/usr/bin/env python3
"""Fetches a model for the speech trial from its official source into a folder of your choosing, without an account:
each file from Hugging Face at a pinned revision, continued where an earlier run stopped, and checked against the
checksum the repository records for it (SHA-256 for the large files, the blob's SHA-1 for the small ones).

    fetch.py whisperkit <folder>     # WhisperKit's Core ML build of Whisper large-v3 turbo, 627 MB, and its tokenizer, 4 MB
    fetch.py --list <repo> <revision> <prefix>   # prints a manifest of that folder of a repository

Nothing is sent but the requests for the files: no token is read from this machine and none is sent.
"""
import hashlib, json, os, subprocess, sys, urllib.request

MODELS = {
    "whisperkit": [
        # (repository, revision, the folder of it, where it goes)
        ("argmaxinc/whisperkit-coreml", "0f63a7800b00dd0226abd051b906c246e1907482", "openai_whisper-large-v3-v20240930_626MB", "model"),
        ("openai/whisper-large-v3", None, "", "tokenizer"),
    ],
}
TOKENIZER = {"tokenizer.json", "tokenizer_config.json", "config.json", "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt", "normalizer.json", "generation_config.json", "preprocessor_config.json"}


def listing(repo: str, revision: str | None, prefix: str):
    revision = revision or json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}", timeout=30))["sha"]
    tree = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/{revision}/{prefix}?recursive=1", timeout=30))
    files = [{"path": e["path"], "size": e["size"], **({"sha256": e["lfs"]["oid"]} if e.get("lfs") else {"blob": e["oid"]})} for e in tree if e["type"] == "file"]
    return revision, files


def checked(path: str, f: dict) -> bool:
    if not os.path.exists(path) or os.path.getsize(path) != f["size"]:
        return False
    h = hashlib.sha256() if "sha256" in f else hashlib.sha1(b"blob %d\0" % f["size"])
    with open(path, "rb") as file:
        while chunk := file.read(1 << 20):
            h.update(chunk)
    return h.hexdigest() == f.get("sha256", f.get("blob"))


def fetch(name: str, folder: str):
    for repo, revision, prefix, to in MODELS[name]:
        revision, files = listing(repo, revision, prefix)
        print(f"{repo} at {revision}")
        for f in files:
            rel = f["path"][len(prefix):].lstrip("/")
            if "analytics" in rel or rel.startswith(".") or (to == "tokenizer" and rel not in TOKENIZER):
                continue
            path = os.path.join(folder, to, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if not checked(path, f):
                # -C - continues a file an earlier run left unfinished.
                subprocess.run(["curl", "-q", "-fL", "--retry", "3", "-C", "-", "-sS", "-o", path, f"https://huggingface.co/{repo}/resolve/{revision}/{f['path']}"], check=True)
            if not checked(path, f):
                os.remove(path)
                sys.exit(f"{rel}: the checksum does not match; removed, run again")
            print(f"  {f['size']:>11}  {rel}")


if __name__ == "__main__":
    if sys.argv[1] == "--list":
        print(json.dumps(listing(sys.argv[2], sys.argv[3], sys.argv[4]), indent=1))
    else:
        fetch(sys.argv[1], sys.argv[2])
