This module is unused until the matrix dispatcher is wired. The v1 bridge is
unchanged. `createManagedCollection` takes an injected SDK, a private fixed
directory, a 64-hex transport-policy scope, namespace, control/write flags,
transport observer, and `withCacheAuth(operation)` wrapper. Only that wrapper
surrounds the one SDK restore and the optional one SDK save.

`lookupBytes({execution})` returns a copy of the authenticated raw receipt
bytes and `trustedReceiptSha256`, or null. `lookup` is an optional file adapter.
The runtime must independently admit those bytes for the actual current full
execution identity and instance. The module deliberately makes no passing,
native conformance, complete-plan, or whole-command reuse decision.

`record({execution,file,receiptSha256})` verifies and queues exact producer
bytes without an SDK call. `publish({exitCode})` is awaited exactly once after
the whole command finishes. Failure, control, read-only, record errors and no
new receipts produce no save. The producer remains responsible for recording
only runtime-ledger-admitted passing receipts. Existing entries requested in
this command and new records make up the next pack; unused history is pruned.

The immutable cache key contains the whole canonical collection SHA returned
by the authenticated service. A downloaded manifest cannot authorize itself.
The pack is a strict canonical schema with sorted unique execution keys and
canonical base64 receipt bytes, each with its own SHA. Limits are 512 entries,
2 MiB per receipt and 32 MiB per collection/queued raw bytes. Unknown/obsolete
schema, duplicate/extra fields, noncanonical or tampered bytes, wrong scope,
oversized data and symlinked cache authority all miss. Authentication data is
never part of the collection or transport event payload.
