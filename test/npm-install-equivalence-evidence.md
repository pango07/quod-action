The bounded install profile passed the real npm materialization gate at
[run 42404970746](https://github.com/pango07/quod-action/actions/runs/42404970746),
source `bbb73ea3ed754043ed0709428d1d77cd40d4a1e0`. All 33 regression tests,
74 gate checks and nine actual npm ci invocations passed. The earlier
[attempt 42404739012](https://github.com/pango07/quod-action/actions/runs/42404739012)
stopped at two existing source tests because Action dependencies had not been
installed; it ran no materialization comparison and supplies no equivalence
evidence. The corrected attempt added only that missing setup step.

The eight unique original12 manifest/lock/roster tuples were installed from
trusted source bytes. A ninth invocation independently deleted and reinstalled
c0 at the same absolute project path. No node_modules cache was restored;
the npm download cache was shared. Results compare every installed path,
regular-file byte digest, POSIX permission mode and symlink target.

| Representative | Installed paths | Mismatches | Comparison |
| --- | ---: | ---: | --- |
| c0, c2, c3, c4, c5, c6 | 29,136 each | 0 | c0 |
| c0 repeat | 29,136 | 0 | independent c0 |
| c10 | 29,221 | 96 | c0 |
| c11 | 29,220 | 13 | c10 |

No runtime-cache or Quod-marker exclusion matched any real install. The only
normalization used was the existing hook's conditional root hidden-lock
version rewrite, targeting c0's version for comparison. Native hidden-lock
bytes and full raw/comparison inventories remain in the artifact. c6 and
later headers needed that rewrite; all other equal-class bytes, modes,
symlinks and paths matched directly. Timestamps, ownership, inode/device and
hardlink allocation are outside this materialization comparison.

Observed scope was Linux x64, Node v24.18.0, npm 11.16.0, ubuntu26 image
20261101.186.1, kernel 7.0.0-1019-azure, umask 022. Project/user/global npmrc,
npm environment, complete npm tool-tree identity, Node binary identity and
the inherited environment digest were retained and checked throughout. The
profile preserves the existing tool/config/environment key scope. Unknown
bytes and pairings still decline it. Managed v0/control disable all tree
restore/save for root binding.gyp or competing package-lock/shrinkwrap,
including dangling symlinks; default-off behavior stays unchanged.

The complete artifact is `npm-install-equivalence`, ID **13587446148**,
**22,041,404 bytes**, SHA-256
`2b27005422449e528556d7a65fbd65222c629986239d2f9770adf383656ec0bc`.
It contains 66 files, 104,226,459 uncompressed bytes. The independent data
reader [audit-npm-install-equivalence.py](audit-npm-install-equivalence.py)
passed with zero issues. It verifies the API-published archive size/digest,
exact extracted archive bytes, all inventories and source/config scopes,
the precise header rewrite, and every untruncated mismatch row. It executes
no artifact code. Reader SHA-256:
`f2ec8daccee15c8d2868d0ca7bd8b374c455e6620ca35a9feb7792e2b0a4d457`.
Retained audit result SHA-256:
`884b252b43a4fb48edb44c8a87862ac043d15d45da56cad23b18a0b761ffdf5f`.

To repeat the data audit, retain the GitHub API run, jobs and artifacts JSON
as `PREFIX-run.json`, `PREFIX-jobs.json`, `PREFIX-artifacts.json`; retain the
full log as `PREFIX.log` and the size/digest-verified archive as `PREFIX.zip`.
Safely extract that archive to `ARTIFACT_ROOT`, then run:

```sh
python3 test/audit-npm-install-equivalence.py ARTIFACT_ROOT PREFIX SOURCE_CHECKOUT OUT.json
```

This evidence supports the finite npm install equivalence under the observed
scope. It grants no absent-dependency, native-unit, build, compiler, test,
whole-command or receipt authority. Complete package.json/source inputs must
still be observed by their separate build and test decisions. The recorded
times are diagnostics from shared-cache installs, not a speedup benchmark.
