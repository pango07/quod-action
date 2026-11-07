This remote-only gate runs the exact eight unique original12 package/lock/
manifest-roster tuples, then independently deletes and reinstalls c0 again.
It executes actual npm ci directly, without the Quod hook or a node_modules
cache restore. All invocations use the same absolute project path, inherited
environment, Node/npm binaries and npm configuration; the download cache is
shared. Each successful install must have a complete inventory.

Every regular file is hashed, every permission mode is recorded, every
symlink's target text is retained, and the entire path roster is compared.
Only the existing node_modules-root runtime caches and Quod marker are omitted
from comparison; they remain visible in the raw inventory. Only the root
hidden lock's version is rewritten to c0's version using the current npm hook's
conditional algorithm. Its native bytes are retained separately. There are
no timestamp, ownership, inode, device or hardlink allocation claims.

The gate requires c0/c2/c3/c4/c5/c6 and c0-repeat trees to compare equal, with
the same install key. c10 must differ from c0 and c11 must differ from c10,
with distinct keys. Every path mismatch is written without truncation.
Every real install's stdout/stderr, source input hashes, raw and comparison
inventories, installer/config/environment/image identities and checks remain
in the artifact, including on failure. Secret environment/config values are
represented only by digests.

This establishes bounded materialization evidence for the reviewed inputs and
observed host/tool scope. It supplies no absent-dependency, native-unit,
build, compiler, test, whole-command or replay authority. Unknown inputs still
decline the new install profile to the legacy path. Explicit managed modes
additionally disable dependency-tree restore/save when root binding.gyp is
present or package-lock and shrinkwrap coexist, including dangling symlinks.
Default-off legacy behavior stays unchanged. The remote unit step verifies
this guard as well as the complete existing Action regression suite.
