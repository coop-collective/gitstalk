# Rust diagnosis

Investigate signals relevant to the assigned finding; do not run a generic redesign checklist.

| Signal | Inspect | Verification |
|---|---|---|
| Repeated wrong-location edits | Crate boundaries, re-exports, macros, generated code, `cfg` and actual call sites | Show that the proposed boundary or focused documentation resolves the ambiguity |
| Hangs or poor concurrency | Blocking work on runtime threads, lock duration, queue bounds, backpressure, task ownership | Exercise contention and cancellation; measure the affected workload |
| Timeout leaves work running | Spawned tasks, subprocesses, blocking jobs and cleanup ownership | Demonstrate whether timeout cancels, detaches or merely stops waiting; verify cleanup and bounded shutdown |
| Memory/CPU grows | Retention, input bounds, copies, allocations and fan-out | Profile representative release builds; compare correctness, throughput and tail latency |
| Unused-code warning | Public crate users, binaries, `cfg` targets, supported features, build scripts, FFI | Check supported consumers/configurations before removing code |
| Inconsistent diagnostics | Toolchain, workspace lint inheritance, target/features and cached artifacts | Reproduce using the project's pinned commands; fix the cause instead of adding blanket allows |

A dropped Tokio `JoinHandle` detaches its task; it does not necessarily leak it forever or cancel it. Started `spawn_blocking` work generally cannot be aborted. A timeout wrapper is not proof that a subprocess or side effect stopped. Preserve explicit ownership of resources through failure and shutdown.

Use a newtype when it prevents a meaningful identifier/unit mix-up, not for every string. Choose `Result`, `Option`, nested combinations, borrowing and ownership for the operation. Keep repository-required panic/unsafe rules, but do not impose a new lint regime as incidental cleanup.

For container findings, inspect the actual Dockerfile, runtime user, required capabilities, writable directories, memory limits, temporary-file lifecycle and graceful shutdown. In-memory temporary storage consumes memory; adopt it only for a measured workload within the memory budget. Preserve durable storage and the Worker/container interface. Use current platform guidance before changing deployment settings; this skill is not a container bootstrap template.

Sources: [Tokio JoinHandle](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html), [spawn_blocking](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html), [Option::transpose](https://doc.rust-lang.org/std/option/enum.Option.html#method.transpose), [Clippy usage](https://doc.rust-lang.org/clippy/usage.html).
