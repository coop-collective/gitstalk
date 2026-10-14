# GitHub Actions on Cloudflare: what ports unchanged, what needs a shim, what can't run

**Short answer.** Most Linux x86 workflows can run with their YAML unchanged on Cloudflare Containers. That covers shell steps, JavaScript and composite actions, matrix, `needs`, reusable workflows, concurrency, cache, artifacts, and simple service containers. It works only if Beanstalk rebuilds the server half of GitHub Actions and ships a runner image with a Docker networking shim.

**Hard limits:**
- **Runner platforms:** macOS, Windows, arm64, GPU and KVM jobs cannot run on Cloudflare compute. They need a bring-your-own runner that connects to Beanstalk.
- **OIDC:** cloud trust policies need a one-time change.
- **Artifacts v4:** the current artifact actions refuse non-GitHub servers unless the runner presents a GitHub-shaped URL.

**Dynamic Workers** can't run Linux steps. They are still useful for parsing, policy, and a new fast path for API-only jobs (§7).

All facts come from `research/cloudflare-platform-and-actions.md`, which has primary sources and a 40-row matrix. `claude-05` (34 rows) and Codex `05` reach similar conclusions; this doc adds the decisions and an adoption path.

---

## 1. Actions is two systems

**Server: GitHub's "Actions service"**
- Picks workflows for an event.
- Evaluates job-level expressions.
- Expands matrix (up to 256 jobs), `needs` and reusable workflows (10 levels deep, 50 per run).
- Handles concurrency groups and environments.
- Resolves secrets and mints `GITHUB_TOKEN`.
- Schedules runners and resolves `uses:` to tarballs.
- Takes logs, annotations and summaries.
- Hosts cache and artifacts.
- Issues OIDC tokens.

**Runner: `actions/runner`**
- Evaluates step expressions and runs `run:` steps.
- Runs JavaScript, composite and Docker actions.
- Starts container jobs and services through the Docker CLI.
- Handles workflow commands (`GITHUB_ENV`, `GITHUB_OUTPUT`, masking, problem matchers).
- Streams logs.

"Run Actions unchanged" means rebuilding the first and hosting the second.

```
Artifacts push event ──▶ Queue ──▶ Run orchestrator (DO or Workflow per run)
                                   │  @actions/workflow-parser + @actions/expressions (MIT, run in Workers)
                                   │  matrix · needs · reusable workflows · concurrency DOs · environments
                                   ▼
                         Job dispatcher ──▶ Container DO (durable_object policy, one Firecracker VM per job)
                                              ├─ runner (act in Phase 0; official actions/runner from Phase 1)
                                              ├─ dockerd --iptables=false --ip6tables=false --ip-forward=false
                                              ├─ network shim: services and container jobs on host networking
                                              └─ in-VM proxy for *.localhost → Beanstalk services
   Beanstalk services (Workers + R2 + DO):
     cache v1/v2 · artifacts v4 (Twirp + blob uploads to R2) · logs + live feed · OIDC issuer (JWKS)
     GITHUB_TOKEN minting · GitHub-compatible REST subset · Git proxy for actions/checkout
     egress handlers: npm/PyPI/OCI mirrors on R2 · credential injection · Docker Hub pull-through
```

## 2. The decisions that matter

### 2.1 Which runner?

| Option | Fidelity | Effort | Use |
|---|---|---|---|
| **nektos/act** (or forgejo-runner `exec`) inside a Sandbox, in host mode | Medium. act ignores `concurrency`, `permissions`, `environment`, annotations, problem matchers, step summaries and `timeout-minutes`, and has no OIDC | Days | **Phase 0, the competition demo.** act already presents `github.com` (passing the artifacts check) and has built-in cache and artifact servers |
| **The official `actions/runner`** talking to Beanstalk's emulation of GitHub's broker, run, launch and results services | High: the same runner GitHub uses | Weeks. The protocol is undocumented and changes; [runner.server](https://github.com/ChristopherHX/runner.server) proves it can be emulated | **Phase 1.** Pin the runner version and pass `--disableupdate` |
| A custom runner | Whatever we build | Months | Never. The runner is the part not worth rewriting |

### 2.2 How to pass the "are you github.com?" check

`@actions/artifact` (behind `upload-artifact@v4+`) throws `GHESNotSupportedError` unless the server URL's host is `github.com`, `*.ghe.com` or `*.localhost`. The newer cache client uses the same test. Three ways around it:

| Shim | How | Pros | Cons |
|---|---|---|---|
| **(a) `*.localhost`** (recommended default) | Set `GITHUB_SERVER_URL=https://beanstalk.localhost`, route it to an in-VM reverse proxy at 127.0.0.1 that forwards to Beanstalk, and trust a local CA (also via `NODE_EXTRA_CA_CERTS`) | Real github.com traffic is untouched. Simple | Links built from `github.server_url` in logs say `beanstalk.localhost` (cosmetic; rewrite them in the log viewer) |
| (b) Pretend to be github.com | Cloudflare's `interceptHttps` outbound handlers serve github.com, api.github.com, `*.actions.githubusercontent.com` and blob hosts from Beanstalk, passing unknown repos through to the real GitHub | Highest fidelity; every code path believes it's on github.com | Confusing for workflows that really talk to GitHub, and needs careful per-repo routing |
| (c) Rewrite `uses:` to compatible forks | Rewrite the workflow when importing it | Simple | The YAML is no longer unchanged |

Use (a) by default and offer (b) per repo for stubborn workflows. Never do (c) silently; Actions Doctor (§6) can *suggest* it.

### 2.3 Docker without iptables

Cloudflare's Docker-in-Docker works with `--iptables=false` and host networking. Bridge networks have no outbound internet, because there is no NAT. The runner normally creates `github_network_<id>` for services and container jobs. The shim is a Docker-CLI wrapper, or the runner's container hooks (`ACTIONS_RUNNER_CONTAINER_HOOKS`), which:
- run services and job containers with `--network host`;
- write `/etc/hosts` aliases (`postgres → 127.0.0.1`);
- report each container's port as the mapped port;
- add `--network=host` to `docker build`, and `network=host` to buildx driver options.

Two services that both want port 5432 collide. Detect that at plan time and report it rather than fail mysteriously.

## 3. What runs, by tier

**Tier 1: runs as-is**
- `run:` steps (bash, sh), with root-capable sudo in the VM.
- JavaScript (node20/24), composite and local actions.
- Workflow commands, masking and groups.
- Playwright and browsers (install the system dependencies; remount `/dev/shm` larger if needed).

**Tier 2: YAML unchanged, Beanstalk-owned shims**
- `actions/checkout`, through a Git proxy at `/<owner>/<repo>` that swaps in an Artifacts token. Fetch-by-SHA is **unverified on Artifacts**; test it on day 1.
- Matrix, `needs`, outputs, `if`, `continue-on-error`, `timeout-minutes`, and reusable workflows (local, cross-repo, or fetched from GitHub).
- `concurrency`, with a Durable Object per group.
- Environments, secrets, vars and required reviewers. Reviewers can be humans or agents, subject to agent rules in `06`.
- `actions/cache` (v1 REST or v2 Twirp on R2).
- `upload-artifact` / `download-artifact` v4, with shim (a) or (b).
- Annotations, problem matchers, step summaries and live logs (results ingestion plus a WebSocket fan-out through a DO).
- `services:` such as Postgres and Redis, and `container:` jobs, through the host-network shim.
- Docker actions, `docker://` steps, `docker build` and `build-push-action`.
- `sudo systemctl start postgresql`, through a `systemctl` shim (no systemd as PID 1).
- Actions calling common REST endpoints through `GITHUB_API_URL`: contents, refs, trees, pulls, issues, comments, checks, statuses, releases, deployments.

**Tier 3: needs reconfiguration or a big build**
- **OIDC (`id-token: write`).** Beanstalk runs its own issuer and mirrors GitHub's claim shapes. **Users must add Beanstalk as a new identity provider** in AWS, GCP or Azure; GitHub's issuer can't be impersonated.
- The `gh` CLI and GraphQL-heavy actions (needs a GraphQL subset and `GH_HOST`).
- `docker compose` with custom networks (rewrite to host networking, or accept no egress).
- LFS checkout. Artifacts has no LFS and a 32 MB blob cap, so it needs an LFS API on R2.
- Long jobs of several hours. Host restarts send SIGTERM with up to 15 minutes' grace, so jobs need DO-alarm keep-alives, checkpoints and automatic retry.
- Jobs needing more than 4 vCPU, 12 GiB RAM or about 15 GB free disk.
- GitHub-only events (Discussions, Dependabot, security events).

**Tier 4: route to a bring-your-own runner**
- `runs-on: macos-*`, `windows-*`, `*-arm` (QEMU emulation is possible but slow and unverified), and GPU labels.
- kind, minikube, k3d, and anything else needing iptables in nested network namespaces (likely impossible).
- `/dev/kvm` workloads: Android emulators, nested VMs, Firecracker-in-CI.
- Inbound connections into the job (only HTTP through a Worker or DO is possible).
- SSH checkouts.

## 4. Limitations to publish

Put these on a public "Compatibility" page.

- **Linux on x86-64 only.** At most 4 vCPU, 12 GiB RAM and 20 GB disk per job (the image counts against the disk).
- **No macOS, Windows, arm64, GPU or KVM on Beanstalk compute.** Connect your own runners for these.
- **A slimmer image than GitHub's.** GitHub's full Ubuntu image is over 18 GB. Beanstalk ships the runner, Docker, git, Node, Python and build-essential, and relies on `setup-*` actions and the tool cache. Per-repo warm snapshots (up to 20 GB, kept 30 days) bring cached toolchains back.
- **Container networking is host-mode.** Two services on the same port can't coexist. Compose files with custom networks may need edits. Kubernetes-in-Docker isn't supported.
- **Cloud OIDC needs a new trust relationship** with Beanstalk's issuer.
- **Long jobs may be restarted** by the platform (SIGTERM, then 15 minutes). Beanstalk retries automatically; make long jobs resumable.
- **Concurrency is capped per account** at 1,500 vCPU running at once (about 375 four-core or 750 two-core jobs). Excess jobs queue.
- **Docker Hub anonymous pull limits** apply to shared egress IPs. Beanstalk mirrors popular images on R2.
- **GitHub-only features** (Dependabot events, Discussions triggers, the full GraphQL API) are partial or missing.

## 5. Cost compared with GitHub-hosted runners

*Illustrative, list prices, a fully busy job, from the research memo's arithmetic.*

| | Cloudflare container | GitHub-hosted Linux |
|---|---|---|
| 1 vCPU, 6 GiB (standard-2) | about $0.0022/min | (no direct equivalent; `ubuntu-slim` 1 vCPU is $0.002/min with no Docker and a 15-minute cap) |
| 2 vCPU, 8 GiB (standard-3) | about $0.0037/min | $0.006/min (2-core) |
| 4 vCPU, 12 GiB (standard-4) | about $0.0067/min | $0.012/min (4-core) |

Working: $0.000020 per vCPU-second plus $0.0000025 per GiB-second plus $0.00000007 per GB-second of disk. For standard-3 that is 2 × 0.00002 + 8 × 0.0000025 + 16 × 0.00000007 ≈ $0.000061 a second, or $0.0037 a minute.

Memory and disk are billed on what's provisioned and CPU only on use, so idle-heavy jobs look better than this and memory-heavy ones worse. The bigger saving comes from §7: run fewer jobs.

## 6. Actions Doctor: the adoption wedge

People said on HN that GitHub lock-in is "Actions, Runners, checks", not the UI, and Origin was criticized at launch for having no Actions. So the import flow should start with a scanner:

1. Read every workflow in the repo.
2. Classify each job into Tier 1–4 using the rules above. Flag service port collisions, the artifacts-v4 shim choice, OIDC users, compose networks, macOS/Windows/arm64/GPU labels, and LFS.
3. Print a **compatibility score** per job, with the exact reason for anything below Tier 2, and offer fixes. "Add Beanstalk as an OIDC provider: here is the AWS trust policy."
4. Optionally do a **dry run**: run the Tier 1–2 jobs on a Beanstalk fork and compare results with the last GitHub run of the same SHA.

Build a **conformance corpus** from the top public workflows (by stars). Publish the pass rate and track it in CI. It becomes the honest number behind "Actions port out of the box."

## 7. Where Dynamic Workers fit

Dynamic Workers are V8 isolates. They have no child processes, no native add-ons and only partial Node APIs, so they can't run `npm test`. They are still the right tool for:

- **The control plane itself:** workflow parsing, expressions, matrix and policy, all of which are just JavaScript.
- **`runs.using: worker` jobs (new):**
  - **Fits:** jobs whose steps are all allowlisted API-only JavaScript actions: labelers, stale bots, `github-script`, release-note drafters, triage bots.
  - **How:** run them in a Dynamic Worker with shims for `@actions/core` (in-memory files for `GITHUB_OUTPUT`/`GITHUB_ENV`, and `process.env`).
  - **Gain:** they start in milliseconds instead of a 1–3 s container cold start plus runner boot. For a swarm that fires triage on every one of thousands of agent changes, that is most of the latency and cost.
  - **Limits:** at most 4 Dynamic Workers in flight per Worker request and 10 per Durable Object, so fan out across DOs. Whether Workers' Node compatibility covers each action's file access has to be checked per action; that is what the allowlist is for.
- **Agent-written automation:** Dynamic Workflows (`step.do`, `sleep`, `waitForEvent`) give agent-authored automations durable steps without a container.

## 8. Better than Actions, because we own the server

- **Structured failures.** Annotations and step summaries become typed objects (file, line, test, error) through MCP (`bean_status` with `checks: true`), not log text the agent must scrape.
- **Evidence reuse.** Results keyed by `(tree hash, job definition hash)` are reused across forks and re-runs. Thousands of agents on near-identical trees shouldn't pay for the same test twice.
- **Test impact analysis on the fast lane.** The validator in `02` runs *affected* jobs and tests. The full suite runs on green promotion. Anthropic reported a 25x rise in CI jobs from agents; most of that should never run.
- **Speculative warmup.** Run the predicted footprint's tests on the fork's latest push before the agent finishes (idea #33).
- **CI budgets per agent principal**, with "explain this failure" as a canvas card.

## 9. Phases

| Phase | Scope | Exit test |
|---|---|---|
| **0, competition (2–3 days)** | act in a Sandbox, triggered by Artifacts push → Queue → Workflow; cache server on R2; results posted as checks; one real workflow (Node tests plus a Postgres service through the host-network shim) | A green run on Beanstalk with the YAML byte-identical to GitHub's |
| **1** | Beanstalk control plane with the official parser; emulated runner protocol so the official `actions/runner` connects; artifacts v4 with shim (a); OIDC issuer; REST subset; Actions Doctor | 80% of the conformance corpus at Tier 1–2 |
| **2** | Bring-your-own runners (macOS, Windows, arm64, GPU) over the same protocol; `runs.using: worker`; warm snapshots per lockfile; evidence reuse | Median time to first step under 5 s with warm snapshots |

## 10. Day-1 experiments (these decide the design)

1. **Docker networking.** In a `durable_object`-policy container with DinD, check whether `docker network create` works, whether containers on a bridge can talk to each other, and whether `-p` publishing works. Check for `/dev/kvm`, `binfmt_misc`, `/dev/fuse` and nftables.
2. **Checkout on Artifacts.** Does `git fetch origin <sha>` work for a commit no ref points to? That's what `actions/checkout` does. Check `--filter=blob:none` fallback behavior and `--atomic` push.
3. **Latency.** Cold start plus clone plus install, with and without restoring a snapshot.
4. **Cost.** Measure 1,000 forks (copy-on-write or full copies?) and the operations count of a typical CI run.
