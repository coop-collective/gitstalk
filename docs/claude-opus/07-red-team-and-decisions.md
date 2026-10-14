# Red team, decisions for Coop, and a demo that proves the thesis

## 1. Attacking this set's own thesis

| Risk | Why it might sink us | What retires it, and by when |
|---|---|---|
| **The A/B race shows no clear win** | On a small repo with little contention, a plain merge queue looks fine, and the originality claim becomes an assertion | Pick a demo repo and task set *with real contention*: shared hot modules, a registry file, migrations. Run the race on day 2 at small scale (20 agents, 60 tasks). The baseline is the same engine preset as a good batched merge queue (no placement, `serializable` everywhere). If Beanstalk doesn't beat it by at least 1.5x on **verified changes reaching green per hour**, change the thesis, not the slides. Scoring on fast-trunk landings would win trivially and prove nothing |
| **Read sets are noise** | Too many false suspects means the validator is just "re-test everything" with extra steps | Replay repo history (§4, experiment 3). If suspects don't beat test impact analysis by changed file, cut read sets from the demo and keep the scheduler |
| **Footprint prediction is poor** | Placement is only as good as its predictions | Experiment 4. It needs at least 0.6 recall at the module level to be worth placing on. Below that, place on co-change statistics only |
| **Artifacts surprises** (fork latency, storage per fork, fetch-by-SHA, push contention) | The whole design leans on cheap forks and a fast single committer | Experiment 1, first thing. Fall back to branches inside a few shard repos if forks are slow or costly |
| **The committer is slow** (structured merge plus push per round in a Sandbox) | It caps landings per second | Experiment 2. Target: a 10-change group commit in under 5 s warm |
| **Container cap** (1,500 vCPU) | Validation can't keep up at 3,000 active agents | Batch validation with bisection; validate suspects first; show the honest envelope (`02` §4) |
| **Jev dependency** | API-only, closed weights, a weeks-old startup; latency rose under load | The router sits behind a flag with an LLM fallback (`04` §6). The demo works with Jev off |
| **11 days** | Everything above, plus a video | Cut lines are in §5. Build the race first; it is the demo |
| **Eligibility** | The rules require a US or Canada legal resident (18+). The winner must attend in person in San Francisco on 10-21 | §3, decision 1 |

## 2. Where this set disagrees with the other two, and where it concedes

**Disagreements:**
1. **A single Integrator as the gate** (`claude-10`). Cursor's write-up describes building exactly that and removing it as a bottleneck. In this set integration never blocks agents. Worlds survive as *green candidates*, used where humans must choose between incompatible intents.
2. **Claims and leases held by agents** (Steward; partly `claude-11` #9). Locks held by agents failed at Cursor: forgotten, held too long, contended. Here the scheduler *places* work, and the only reservation-like object (for big refactors) belongs to the scheduler, never to an agent.
3. **Humans choosing between worlds for routine changes.** Humans should mostly read green deltas, with decision cards for real forks in the road. Choosing between worlds for every change recreates the review bottleneck.
4. **Jev as the chat interface** (Codex). It isn't one; it is a decision model. This set agrees with `claude-12`: route with Jev, narrate with Claude.

**Steward overlap: what survives.** The other Claude session's red team (`claude-14`, `claude-14b`) checked the live Steward entry (published 2026-10-02). It already has:
- forks with scoped tokens
- a claims board of declared files
- rival candidates
- a judge and referee
- a human steward
- a why-blame ledger
- earned auto-merge with drift suspension
- previews on `cand/` branches
- a 120-task run with numbers

They concluded that `claude-10`'s originality survives on one axis: world composition.

Against that list, this set's ground is:
- **placement instead of a claims board:** predicted footprints, a conflict graph, chaining, no locks held by agents;
- **no blocking gate:** fast trunk, asynchronous validation, causal repair. Steward's own numbers ("80 bounced at Gate 1" of 120) show a gate-first design;
- **read-set validation and assumption blame;**
- **isolation levels as a per-path dial;**
- **the error-budget controller;**
- **the race as proof.**

Our forks with scoped tokens, previews and why-blame are *table stakes*, not claims. The race's baseline is a preset of Beanstalk's own engine, configured as a good batched merge queue (no placement, `serializable` everywhere). It isn't a named rival. The rules prohibit "attacks on competitor products", probably meaning security attacks, but benchmarking a named rival entry on stage would read badly anyway.

**Concessions; adopt these from the other sets:**
- `claude-11`: resolver sprouts (the same thing as fixers), signed evidence receipts, the fork reaper, MCP-first, the GitHub bridge with a write path for when GitHub is down, proposal beans, the prompt-injection firewall.
- `claude-12`: the full card catalog, multiplayer and the walkthroughs.
- Codex `07`: separating claims ("registered", "active" and "useful" agents are different numbers), and the falsifiable-experiment format.
- `claude-13`: the build order, cut lines and README requirements.

**A combined design, if one is wanted:**
- the fast trunk, scheduler, isolation levels and error budget from this set;
- worlds as green candidates from `claude-10`;
- the canvas from `claude-12`, plus the cards in `04`;
- Actions Phase 0 from `05`;
- previews and proof bundles from `06`;
- receipts, reaper and MCP from `claude-11`.

## 3. Decisions only Coop can make

1. **Who enters.** The rules require a legal resident of the US or Canada, 18 or older, and the winner must be in San Francisco on 10-21. This machine's clock is on Hong Kong time. If Coop isn't eligible, the entry needs an eligible entrant (a teammate) before anything is submitted. Check this first; it decides whether the rest matters.
2. **Which thesis leads the video:**
   - this set's concurrency control plus a race;
   - `claude-10`'s worlds;
   - Codex's outcomes and candidates;
   - the combined design above.

   Recommendation: **the race opens; the canvas carries the UX score.** The race is the most *demonstrable* originality: a judge sees it, not just hears it.
3. **Licence:** MIT or Apache-2.0. Apache-2.0 includes a patent grant; MIT is shorter. Either is allowed.
4. **Is Jev on the critical path of the demo?** Recommendation: in the demo, behind a flag, with the fallback rehearsed.
5. **The demo repo.** It needs real contention and a fast test suite. Options:
   - a mid-sized TypeScript monorepo you own;
   - a fork of a public project with hot registries and migrations;
   - a purpose-built "shop" app seeded with conflicting intents.

   The purpose-built app is the safest to rehearse, and the least convincing.
6. **Spend.** Workers Paid, Containers time, Artifacts operations (billed from about 10-14), Browser Run and agent tokens. A race with 200 agents for 30 minutes, run several times, needs a budget and a kill switch, which is idea #11, dog-fooded.
7. **Whether the agents in the race are real.** Real Claude Code and Codex instances are more convincing but cost more and are noisier. Scripted "replay agents" that apply recorded diffs at realistic timings make a deterministic race. Recommendation: rehearse with replay agents, and film with a mix that is labelled honestly.

### Decided so far (Coop)

- **Names:** a bean is an agent's change, the sprout is the staged line, the stalk is the stable line.
- **Agents in the race are real:** Claude Code with Sonnet on the subscription, capped at $75 a run.
- **Licence (2026-10-14):** Apache-2.0 (`LICENSE`, `NOTICE`, `TRADEMARKS.md`), copyright Coop, as the competition rules require; this settles item 3. From 2026-10-04 to 2026-10-14 the repository was under FSL-1.1-ALv2.
- **Code mode (2026-10-04):** Coop tested code mode and is not happy with it. An `execute` tool, where the agent writes code against a typed API, stays out of everything we ship and remains highly experimental. The MCP surface is plain, task-shaped tools.

## 4. Experiments for the first 48 hours, in order

| # | Experiment | Pass if |
|---|---|---|
| 1 | **Artifacts:** time and storage for 1,000 forks (copy-on-write or full copies?); `git fetch <sha>` for a commit no ref points to; push throughput into one repo from a single writer; read latency through the binding (`readFile`/`readTree`) under 200 rps | Fork in under 2 s at p95; storage clearly shared; fetch-by-SHA works, or a workaround exists; at least 1 push/s sustained |
| 2 | **Committer:** in a warm Sandbox, tree-sitter write sets plus a Mergiraf merge plus group commit of 10 disjoint changes onto a ~200 MB repo | Under 5 s per round |
| 3 | **Read-set signal:** replay 3–6 months of the demo repo's merged PRs as if concurrent. Compute suspects from static dependencies of the diffs, then check against real follow-up fixes and reverts | Suspects catch at least 2x more of the real breaking pairs than "changed-file overlap" at the same false-positive rate |
| 4 | **Footprint prediction:** for 200 historical PRs, predict modules from the title and body alone (Jev Noul per module, then a co-change baseline, then both) | At least 0.6 recall and at least 0.5 precision at the module level for the best method |
| 5 | **Actions Phase 0:** act in a Sandbox running a real workflow with a Postgres service through the host-network shim, triggered by an Artifacts push | Green, with the YAML byte-identical to the GitHub version |
| 6 | **Previews:** an Artifacts branch → Workers Builds → Worker Preview, with a per-preview D1 seeded from a manifest; `preview_compare` against green in Browser Run | Ready in under 2 min; deterministic pixel diff across 3 reruns |

## 5. The demo: about 8 minutes, built around the race

| Time | Shows | What it proves (rubric) |
|---|---|---|
| 0:00–0:40 | "Agents broke GitHub": three numbers on screen (41.7% cross-agent conflicts; 20 agents with locks doing the work of 1–3; 2,092 silently reverted PRs) | Problem framing |
| 0:40–3:00 | **The race.** Two panes, the same 200 tasks. Left: the same engine as a good batched merge queue (no placement, `serializable` everywhere). Right: Beanstalk. Scored counters: verified changes reaching green per hour, agent-minutes spent waiting, and time to green. Shown, not scored: fast-trunk landings, conflicts, repair tickets and the error-budget gauge. Mid-race, flip `billing` to `serializable` and watch that lane slow while the rest flows | Originality (50%), concurrency and conflict handling (25%) |
| 3:00–4:30 | **The canvas.** Type "what's colliding in billing and who's fixing it?" and watch the cards morph as you type. The conflict graph shows a cluster; open a causal repair ticket; assumption blame on the broken line. Scrub the replay back ten minutes | UX (25%), context preservation |
| 4:30–5:30 | **A human with ten minutes.** The green delta grouped by intent, three decision cards, one answered in place | Review at scale |
| 5:30–6:30 | **A live branch.** An agent's checkout change: `preview_compare` against green, side by side, and a proof bundle attached | Review, ease of use |
| 6:30–7:15 | **Actions unchanged.** The same workflow file as on GitHub runs green on Beanstalk; then Actions Doctor scores another repo's workflows | Adoption |
| 7:15–8:00 | **Safety and limits.** GitLost replayed and blocked by session taint, then the honest scale envelope ("thousands with one trunk; sharding for more") | Credibility |

**Cut lines (cut from the bottom):**
1. Actions Doctor.
2. Replay scrubber.
3. Stigmergy markers.
4. The live Jev type-ahead (fall back to a router).
5. Previews (fall back to screenshots in the green delta).

**Never cut:** the race and the green delta. Without them there is no thesis.
