# runner: the gateway's git and test container

The Rust crate `runner` builds the container image that `gitstalk-gateway` drives for every integration step. Artifacts has no server-side merge, so squash merges, batch composition, reverts, ref updates and test suites run here. It is one axum HTTP service on `0.0.0.0:8080`. The gateway reaches it only through its `Runner` Container Durable Object; nothing else talks to it.

```
RunDO (one per repository engine or benchmark run)
  └─ RUNNER.getByName(instance) ─▶ Runner (Container DO, port 8080) ─▶ runner binary
                                                                          └─ git fetch/push ─▶ Artifacts (HTTPS)
```

## What it does

| Endpoint | Purpose |
|---|---|
| `POST /v1/squash` | Land a bean's change on a line as one commit. git's line merge first; on a conflict, a retry with Mergiraf for the conflicted code files (`structural_merge`). Answers `clean` with the commit, or `conflict` with the files and hunks |
| `POST /v1/compose` | Squash several changes in order onto a base, skipping the ones that conflict |
| `POST /v1/revert` | Revert a commit (or every commit back to `to`) on a line |
| `POST /v1/update-ref` | Move a ref with a lease (`--force-with-lease`); idempotent |
| `POST /v1/check` | Check out a commit and run its test suite (`node --test` by default) in a loopback-only network namespace; optionally trace each test file's reads for read maps |
| `GET /healthz`, `GET /version` | Tool and network status; image commit and wire-contract version |

Each request carries the Artifacts remote and a short-lived token minted by the gateway for that job. Tokens reach git through `GIT_CONFIG_*` environment variables, never argv, disk or logs. The wire contract is versioned: `API_VERSION` in `src/app.rs` and `RUNNER_API_VERSION` in `packages/gateway/src/runner/runner-transport.ts` must change together. The full request and response fields, error codes, git cache behaviour, harness parity and measurements are in [31-gateway-engine-internals.md](../../../docs/claude-opus/31-gateway-engine-internals.md), appendix.

## The image

- Debian trixie (`linux/amd64`, the only platform Cloudflare Containers run) with git, `tini` as PID 1, `bubblewrap` (suite network isolation) and `strace` (read-map tracing).
- Node 25.8.1 and Mergiraf 0.20.0, pinned release downloads verified by SHA-256. Mergiraf is GPL-3.0 and runs only as that separate, unmodified binary.
- Dependency snapshots of the benchmark arenas under `/opt/arena-deps`, installed at build time from `research/real-arena/*/deps/`, so checks never install anything.
- The `runner` binary, running as the unprivileged user `runner` with `/work` as scratch.

## Build

[`Dockerfile`](Dockerfile) builds with the repository root as context (the Cargo workspace and `Cargo.lock` must be visible; the root `.dockerignore` keeps the rest out). `RUST_VERSION` (default 1.96.0) pins the toolchain; Rust compiles natively on the build host and links for `x86_64-unknown-linux-gnu`, with cargo-chef caching dependencies, so Apple Silicon builds avoid emulation.

```bash
docker buildx build --platform linux/amd64 -f packages/gateway/container/Dockerfile -t gitstalk-runner:dev .
docker run --rm -p 8080:8080 gitstalk-runner:dev
```

[`docker-with-git-sha.sh`](docker-with-git-sha.sh) is the Docker wrapper Wrangler uses when deploying the gateway (`WRANGLER_DOCKER_BIN`, set by `pnpm env:deploy`). It adds `--build-arg GIT_SHA=…` to `docker build`: the last commit that touched this crate, the Cargo workspace files, the arena lockfiles or `.dockerignore`, with `-dirty` for uncommitted changes. A deploy that does not change the runner keeps the same image. `GIT_SHA` in the environment overrides it; `/version` reports it as `git_sha`.

## How the gateway drives it

- `Runner` (`packages/gateway/src/runner/runner-container.ts`) extends `Container` from `@cloudflare/containers`: `defaultPort` 8080, `sleepAfter` 120 s, internet egress on (git must reach Artifacts), and env `PORT`, `WORK_DIR=/work`, `REMOTE_SCHEMES=https`, `RUST_LOG` (the gateway's `LOG_LEVEL`).
- `wrangler.jsonc` declares the class with image `./container/Dockerfile`, `image_build_context: "../.."`, `instance_type: "standard-4"` and `max_instances: 48`.
- A `RunDO` addresses instances by name: a committer for squashes and ref updates, CI slots for validations, and one pre-land sandbox per bean in check, leased from `RunnerCapacity`.
- `runner-client.ts` speaks the API; `runner-transport.ts` checks `/version` before an instance's first job, waits and retries while Cloudflare has no capacity, and maps errors.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `WORK_DIR` | `/work` | Bare-repo caches and per-request scratch |
| `REMOTE_SCHEMES` | `https` | URL schemes a request may name (`https`, `file`) |
| `COMMIT_AUTHOR_NAME`, `COMMIT_AUTHOR_EMAIL` | `gitstalk-runner`, `runner@gitstalk.invalid` | Identity of the commits it creates |
| `DEPS_DIR` | `/opt/arena-deps` | Dependency snapshots a check may name |
| `SUITE_NETWORK` | `auto` | `loopback`, `host`, or `auto` (loopback when the kernel allows it) |
| `RUST_LOG` | `info` | Log filter (JSON lines on stdout) |
| `GITSTALK_GIT_SHA` | `unknown` | Image commit, from the `GIT_SHA` build arg |

## Develop

```bash
cargo test -p runner        # unit, router, property and parity tests; remotes are local bare repos
pnpm rust:check             # fmt, clippy -D warnings and tests for every crate
PORT=8080 WORK_DIR=/tmp/runner-work REMOTE_SCHEMES=https,file cargo run -p runner
```

The suite tests need Node 25 on `PATH` and the structural tests need `mergiraf`; without them those tests return early and say so on stderr.

## Contributing

See [CONTRIBUTING.md](../../../CONTRIBUTING.md), and run `pnpm check` at the root before you open a pull request.

## Experimental pre-land test skipper

Run configuration `test_skipper: true` opts ordinary v2 pre-land checks into restricted JS/TS module-based selection; the default is false. API **5** adds the request field and `selection` evidence. Full-check reuse and promotion never treat a selected result as a full green. Custom commands, dependencies, tracing, extra files and custom environments keep their original scope.

The image bundles `packages/test-skipper` at `/opt/gitstalk/skipper.mjs` (override with `GITSTALK_SKIPPER_PATH` locally). Build it with `pnpm -F @gitstalk/test-skipper build` before standalone Cargo checks; `pnpm check` does this in the package test step. The image stamp includes the analyzer and pnpm manifests. See the [contract](../../../docs/09l-optional-test-skipper.md) and [paired benchmark](../../../research/test-skipper/README.md) for eligibility, safety boundaries and performance limits. This option has not been deployed to the hosted service.
