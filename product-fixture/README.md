This fixture checks the shipped Action's ordinary native default in fresh jobs.
Its lockfile is generated and committed by the remote Action build workflow;
acceptance consumers require that tracked lock and never rebuild the Action.

The manual `production-readiness` input on `test.yml` runs a serial
plain → record → witness → replay chain, then a separate signed Cloud readback,
Cloud-outage fallback, changed-input control and final validation. Readback
precedes the deliberately failing changed-input job's publication. Every
fixture command uses the same reporter arguments and output pathname. Reports
are copied into sanitized role records after execution; changing the report
arguments between roles would name a different Cloud suite.

The gate requires complete file/name/status multisets, including duplicate
names and a skipped assertion, controlled console output, exact exit codes,
actual replay statistics, native failure preservation after a tracked input
changes, and native unsupported-command behavior. Signed Cloud restore uses
the SHA-pinned shipped bin-024b929 in a new empty directory with local fallback
disabled. A known valid but wrong Ed25519 key must fail the signed-answer
check. A successful save process alone is never publication proof.

Artifacts contain only synthetic normalized results, controlled-output
markers and byte-pin metadata. Configuration, OIDC credentials, ledgers and
the private readback directory are excluded. Actual complete-job and post
durations are obtained separately from Actions API metadata. This finite
fixture does not establish coverage compatibility, general workload speedup,
managed-profile semantics, lineage promotion, or a cost-reduction target.

The record job uses a run-specific dependency cache namespace and must really
install on a miss. Fresh successors must restore its exact dependency key,
retain the complete node_modules content/mode/link fingerprint, and actually
skip npm ci with no synthetic fresh-install marker. Both test files read the
same public run/attempt scope value, so a repeated acceptance run must obtain
new witnesses. All native dependency projections must also equal plain npm ci,
excluding only the root `.quod-deps.json` marker. Signed readback must retain
the exact named environment state captured by the real current cold record in
both files' read sets. That state encoding comes from the shipped engine;
signed Cloud transport is checked independently, without handwritten crypto or
publication of ledgers. Console equality covers the one controlled marker, not variable
timings, color or arbitrary full stdout/stderr; only their digests are retained.
