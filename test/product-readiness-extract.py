#!/usr/bin/env python3
"""Remote-only extraction of the shipped, SHA-pinned bin-024b929 executable."""
import hashlib
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
body = archive.read_bytes()
assert len(body) == 6101935
assert hashlib.sha256(body).hexdigest() == '639eaa8cea088ef8ef1fb2ed7f6b775ccf537861f6de71ea60a98d62fbfc148d'
assert not destination.exists()
with tarfile.open(archive, 'r:gz') as tar:
    entries = tar.getmembers()
    assert len(entries) == 1
    entry = entries[0]
    assert entry.name == 'quod' and entry.isfile() and entry.size == 14217768 and entry.mode == 0o755
    stream = tar.extractfile(entry)
    assert stream is not None
    binary = stream.read(14217769)
    assert len(binary) == entry.size
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
with destination.open('xb') as output:
    output.write(binary)
destination.chmod(0o700)
