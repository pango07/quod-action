`npm-install-window.json.gz` contains the exact UTF-8 package.json,
package-lock.json, nested package.json (when present), and .npmrc bytes from
the original twelve convex/convex-helpers commits in the managed benchmark.
It is a deduplicated JSON map of SHA-256 to original text plus per-commit
file maps, compressed with gzip (mtime 0). The tests verify every digest
before constructing a temporary project. No code from the fixture executes.

`deps-v4.cjs` is the unchanged dependency-key implementation from Action
c77d86564686c439aa8e5b9d42a1f8573da771b8. Tests compare default-off keys and
cache paths against this frozen compatibility reference.

The new install profile is finite: c0-c9 differ only in root version,
non-install scripts, exports, and a nonworkspace nested manifest. npm ci
does not consume those differences to materialize node_modules in this
reviewed profile. All remaining root package fields and lock entries stay
in the key. c10 and c11 change dependencies and remain separate install
classes. Unknown bytes or root/lock pairings, local dependencies,
workspaces, install lifecycle scripts, and unexpected manifests decline
to the original key and paths. Explicit managed v0/control additionally
decline all dependency-tree restore/save authority when root binding.gyp
exists or package-lock and npm-shrinkwrap coexist, including dangling
symlinks; native npm ci runs. Default-off legacy behavior stays unchanged.

The profile remains limited to managed v0/control in check mode on Linux
x64. It does not supply build, module resolution, test, receipt, or absent
dependency authority. A hit still restores node_modules and requires the
existing install marker, arguments, tool/config/environment key, and
unchanged restored-tree stamp before the npm hook can answer npm ci.
