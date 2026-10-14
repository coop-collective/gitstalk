# The repository experience: from debugger to product

Written 2026-10-04. Coop's verdict on the current web UI: it "looks like a debugger versus a product". This doc covers four things:
- what GitHub's repository components are *for*, and which of them a swarm needs;
- why today's UI reads as a debugger;
- three concepts, and the one I recommend (**the Plot**);
- a roadmap to put it in `packages/web` with Jev deciding what to show.

A working prototype of the Plot is in `research/prototypes/repo-experience/`. It runs on the recorded run `7z4j84eqvl` (Beanstalk v2, 12 Sonnet agents, 40 beans).

**Jev status:** a one-question test call on 2026-10-04 returned HTTP 402, "no available TypeSafe API credits". The prototype therefore runs every pick through an adapter, and fixed rules answer when Jev is offline. Each pick on the page shows a receipt saying which picker answered.

Inputs: `docs/github-repository-map/` (00–07), `claude-12`, Codex `03`, `claude-07`, `claude-opus/04` and `13`, the screenshots of the deployed app, `packages/shared-race/src/rpc.ts`, and `packages/shared-ask` (read-only, because another agent is restructuring it).

---

## 1. What GitHub's components are for, and what a swarm needs

The map lists 464 component groups. Grouped by the job they do for a reader, they come down to eight jobs. The right-hand columns say how each job changes when most of the authors are agents.

| Job | GitHub components (map doc) | With a swarm | Beanstalk answer |
|---|---|---|---|
| **Orient:** what is this, where am I | Repository shell, About, tabs, ref selector, README (00) | Still needed, but "where am I" now includes *when*. The tree changes every few seconds. | A headline sentence about the repo's state, plus the scope chips (repo, run, ref, time) |
| **Read code** | Tree, file view, blame, symbols, search (01, 04) | Needed for verification, but rarely the starting point. Blame by commit is useless when 40 commits land in 17 minutes. | File view as a *detail*. Blame by **bean** (line → bean → intent) |
| **Understand change** | Commits, compare, PR "files changed", diff (01, 02) | Central. The unit is the bean, not the commit, and there are hundreds. | The Plot: every landing by time × area of code. Diffs per bean, per file |
| **Review and decide** | PR conversation, reviews, merge box, checks (02, 03) | Humans stop reviewing diffs. They answer **decision cards** when specs clash, and read evidence. | Decision stories with both specs, the failing tests, the outcome |
| **Know it works** | Checks, Actions runs, logs, deployments (03) | Pre-land checks and validations run per bean and per sprout. Reds must be traced to a culprit, not just shown. | Red-validation story: suspects by read set, culprit, time to green |
| **Track work** | Issues, Projects, milestones, sub-issues (02) | Tasks are dispatched by the forge, so work-in-flight is known exactly. | The growing tip: beans in flight, their state, their footprint |
| **People and responsibility** | Contributors, CODEOWNERS, insights (04) | "Who" is an agent slot plus the human who decided. Ownership becomes "which bean wrote this, under which intent". | Agent ids on buds, blame by bean, decided-by on cards |
| **Notifications and attention** | Inbox, watch, mentions (04) | The inbox is already unusable at bot volume (`04` §2). Attention must be *ranked*. | The lead and the "What happened" stories, picked from computed candidates |

Five of the eight jobs (understand change, review and decide, know it works, track work, attention) are about **time and causality**, not about the file tree. GitHub spreads them over five tabs: Code, Pull requests, Actions, Issues and Insights. A swarm makes that split unworkable, because one bean's story crosses every tab in minutes. The Plot merges those five jobs into one view and keeps code reading as the detail you drill into. That merge is the main design idea.

From `06` (visualization opportunities), the concepts this design uses are:
- VZ01 (context bar): the chips.
- VZ09 and VZ37 (lanes and attempt lanes): the tip.
- VZ22 (check lineage): the red story.
- VZ36 (focused canvas): Ask.

It also keeps that doc's warnings:
- No 3D commit galaxies, moving avatars or opaque health scores.
- Every aggregate links to its members.
- An overlap at file level is not the same as a semantic conflict.

## 2. Why today's UI reads as a debugger

From the deployed screenshots (`/`, `/race`, `/runs/7z4j84eqvl`):

1. **It shows the engine, not the repository.** The race canvas leads with agent lanes of hatched busy/blocked bars, an event log ("t026 lands without a re-check (17 landed meanwhile, no shared file)"), and KPI tiles ("Red validations 3", "Decision cards 0"). Those are the scheduler's internals. A visitor asks "what happened to my code?", and the page answers "here is my process table".
2. **The vocabulary belongs to the system.** "pre-land checking", "inherited", "validation", "sprout #21", "t024 on the stalk 13:45". Every label is accurate, and every one needs the design docs to decode.
3. **No hierarchy, no headline.** Six equal stat tiles, then five equal panels. Nothing says what matters most, so everything reads as diagnostic output.
4. **Time and place sit in separate panels.** The wavy sprout/stalk timeline is one panel and the code map is another. The question that matters, *what landed where, and when*, needs both at once, so the reader has to join them mentally.
5. **The explorer is a GitHub clone with a search result glued on top.** The Ask answer is eleven `file coupons.ts ×` chips and three equal columns of tree, diff and bean list. The question re-filters the panels, but the page does not change shape to answer it.
6. **Logs are the narrative.** The event list is the only place a story is told, one line per event, newest first. That is how a debugger tells stories.
7. **Default styling.** System blue on white, a neutral sans, monospace IDs, generic card borders. Nothing in it is specific to a plant, a stalk or a swarm.

The data underneath is excellent: full event logs, read sets, decision cards, per-bean diffs. The problem is presentation, not substance.

## 3. Three concepts

Each concept follows the house rule: **code computes, Jev picks, nothing writes layout.**

### A. The Plot: time grows up the stalk, the code runs across *(recommended)*

One chart is the repository's home:
- **Rows** are beans that landed, newest at the top. The stalk runs up the left edge, and each landing grows a leaf from it: dark green once validated on the stalk, lime while only on the sprout, red if it was named as a culprit.
- **Columns** are areas of the code ("beds": `auth`, `billing`, `orders` …).
- **Dots** sit where each bean wrote, sized by lines changed. A hollow ring means the bean only touched tests there.
- **The growing tip** sits above the newest landing and holds the **buds**: beans in flight, each with its agent, its state and where it has written so far.
- **The reading pane** on the right tells the story of whatever is selected.

Ask reshapes the Plot:
- areas that don't matter fold to slivers;
- the areas that do matter open into their files as columns;
- unrelated rows collapse into "20 other beans, folded";
- the headline becomes the answer.

**What Jev decides:** the lead facts, the suggested questions, the question's class, which files the answer is about, and the order of the pane's sections (§5).

- *Strengths:* it shows what landed, where and when, plus what is happening now, in one picture. Ask changes the shape of the view, not only its filters. It scales to a swarm, because buds and folds absorb volume. It uses the plant metaphor literally without being cute.
- *Weaknesses:* past a few hundred landings the rows need time bucketing. Areas are top-level directories, which will not fit every repository well.

### B. The Greenhouse: a spatial map of the codebase with the swarm on it *(the boldest)*

A fixed treemap of the repository, laid out once at import and stable across commits so people build spatial memory. Areas are beds sized by code, and files are plants:
- landed beans add growth rings to the plants they touched;
- in-flight beans are violet buds sitting on the beds where they write;
- conflicts draw red threads between buds.

Asking moves a camera: it zooms to the region, dims the rest and docks typed cards beside the region (the `claude-12` design).

**What Jev decides:** the camera target (a Choice over regions), the overlay (heat, ownership, in-flight, red), and the cards.

- *Strengths:* spectacular, and it uses space as memory, which nobody ships today (`claude-07` D).
- *Weaknesses:* it hides *time*, which is the main axis of a swarm, so causal questions such as what broke and why need a second view. It flirts with the "moving avatars" anti-pattern. A stable semantic-zoom layout plus a camera is about a week of work on its own, more than the deadline allows. **It is a good extension of the Plot later:** it could be the Plot's columns at higher resolution.

### C. The Almanac: the repository as a daily briefing *(the plainest)*

An editorial page per repository, rewritten whenever its state changes. Code computes candidate stories: a decision taken, a red traced, a feature shipped across six beans, an agent stuck, a test restored. Jev picks and orders the stories, and each story expands into its evidence (journey, diffs, tests). Ask produces a new briefing about the question.

**What Jev decides:** which stories lead, how they are ordered, and how they are grouped (a Choice per slot).

- *Strengths:* the most readable concept, fastest to build, very "product". It is close to what a busy owner wants on a phone.
- *Weaknesses:* it shows no structure. You never *see* the repository, so it reads as a changelog or newsletter. Judges score UX at 25%, and originality for agents at 50%, so a briefing alone undersells the concurrency story.

**The recommendation contains C:** the Plot's lead sentence and its "What happened" pane are the Almanac in small form.

## 4. The recommendation: the Plot

### 4.1 Why

- **It merges the five time-and-causality jobs** from §1 into one view. GitHub needs five tabs for them; the Plot needs one chart.
- **It shows Beanstalk's thesis without explanation:**
  - The leaf colours show the two-speed line: lime on the sprout, green once validated on the stalk.
  - Buds overlapping in a column are coordination becoming visible.
  - A red leaf at #12 with 11 buds turned to "reworking" shows how much one inherited red costs.
  - A decision story shows two specs clashing.
- **Ask changes the shape of the view.** Folding the plot to the 8 coupon files and 5 coupon beans is something a judge can watch happen. That makes the "Jev decides what to show" pitch concrete, and every pick has a receipt you can open.
- **It is buildable by 10-14:** one grid, one pane and one scrubber, on data the gateway mostly serves already (§7).

### 4.2 Information design

| Mark | Meaning | Data |
|---|---|---|
| Row | One bean that landed, at its landing time (newest at the top) | `land` events / the line |
| Leaf on the stalk | Dark green: validated on the stalk. Lime: on the sprout only. Red: named as the cause of a red validation | `green.promote`, `ticket.culprit` |
| Stalk segment | Solid green up to the stalk tip; dashed where rows are folded | stalk index at time T |
| Dot | The bean wrote in this area or file; area ∝ √(lines changed) | per-file additions and deletions |
| Hollow ring | Only test files changed there | path classification |
| Leaf vein | Thin line joining a row's dots, so the eye can follow the row | — |
| Bud (tip) | A bean in flight. Violet and breathing: writing. Rotating amber ring: being checked. Red: reworking. Blue: waiting on a decision | bean state at T |
| Dashed square (tip) | The scheduler's *predicted* footprint, where the bean hasn't written yet | `footprint.predicted` |
| Amber ring (tip) | Two beans in flight wrote the **same file** (not just the same area) | bean heads' files |
| Number in an area header | Beans in flight in that area. Red: a merge conflict there in the last 45 s | in-flight set, `merge.conflict` |
| Scrubber ticks | Green: landings. Red: red validations. Blue: decisions | events |

Rules kept from the GitHub map:
- Every dot links to the bean, and every bean links to its diffs.
- A predicted footprint is drawn differently from written files (dashed versus filled).
- Overlap in the same file is shown; overlap in the same area alone is not called a conflict.
- Folded rows say how many beans they hide.

### 4.3 The first screen

```
┌ beanstalk │ beanstalk-shop · recorded run …  [ Ask about this repository      / ]  ● 2 picks  Rules ┐
│                                                                          │ Ask  ● suggested         │
│  35 of 40 changes reached the stalk                                      │ [What changed recently   │
│  in 17 minutes 30 seconds.  ● picked                                     │   on coupons?]           │
│  Two specs clashed and one was kept: … Read the decision                 │ [Why was t032 declined?] │
│  5 beans fell off: 3 unresolved conflicts, … See what fell off           │ …                        │
│  [Whole repository, 114 files] [Run 7z4j84eqvl]         legend           │ What happened            │
│                                  auth billing cart … users core (angled) │ ▌D001: two specs …       │
│  ── growing tip: buds in flight (or "nothing is growing") ──             │ ▌Red validation R001 …   │
│  16:01 🍃 Finance needs a list of overdue invoices  #34   ●──────────·   │ ▌5 beans fell off        │
│  14:36 🍃 Customers should get a receipt …          #33   ●────●─────·   │ Where the agents' time   │
│   …                                                                      │ went  ▇▇▇▇▇▇▇▇░░░        │
│  0:00  ◒  Base commit 26eecce                                            │ $5.00 · 120/h · 5:08     │
│  ▶  ▮▮ ▮ ▮▮▮ ▮  ▮ ▮ ▮▮ ▮ ▮ (ticks)  ─────────────────●  17:30 of 17:30   [End]                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The headline is a sentence, set large in a serif. It is the most important fact, and Jev picks which fact leads (§5). A live run leads with what is happening ("The sprout is red: tracking-email.test.ts has failed since #12"). A finished run leads with what happened.

### 4.4 Key interactions

1. **Ask, and the repository reshapes.** Type or pick a question. Four things happen:
   - The chips show what was understood: the class, the term, the file count and the bean count. Each chip carries the receipt of the pick behind it, and removing a chip clears the question.
   - The Plot folds, so only the relevant files and beans stay at full size.
   - The headline becomes the answer ("5 beans changed 8 files about coupons.").
   - The pane shows the sections in the order the picker chose: beans, changes by file, decision.

   Clicking an area header asks about that area. Clicking a file header opens its blame.
2. **Follow one bean.** Click a row, a bud or a list item. The row is highlighted and scrolled into view. The pane tells the bean's story in this order:
   - its intent, in the task author's words;
   - predicted versus actual footprint ("The scheduler expected it in db; it wrote in core, billing, db");
   - its journey as plain sentences with times: picked up, wrote the change (with the agent's own one-line summary quoted), pre-land check, conflict, sent back to its author, landed as #28, promoted to the stalk;
   - any decision card;
   - its diffs.
3. **See where the swarm is working now.** Scrub or press play (30× speed). Buds appear, change state and become leaves. Area headers count the beans in flight. Asking "where is the swarm working right now?" on a finished run jumps to its busiest minute and says so.
4. **Who wrote this, and why.** "Who changed tax rounding and why?" opens the main file, with each line coloured by the bean that last wrote it. A legend lists those beans, and clicking a bean opens its intent and journey.
5. **What broke.** The red story covers the failing test, the five suspects found by read set, the bisect culprit, the conflicting revert, how many checks inherited the red, and the time back to green. The culprit's leaf on the Plot turns red.
6. **See every pick.** The pick count in the top bar opens a drawer with each decision on the page: what was asked, the candidate list, what was chosen and in what order, and who chose (Jev or the rule, and the rule's text).

### 4.5 How Ask fits

Ask keeps `13`'s model: **a question becomes a view spec, not a generated layout.** Three changes:

- **The whole page responds, not just the explorer.** The view spec drives the Plot's columns (files instead of areas), its rows (matching beans at full height, others folded) and the headline.
- **The view spec gains two picked fields:**
  - `files`: Jev ranks the candidate files that code found;
  - `sections`: Jev orders the pane's sections from a catalog.

  Both appear as receipts.
- **The class catalog stays at ten**, matching `shared-ask/view-spec.ts`. The prototype's router is a copy of the keyword rules, so it already agrees with the shipping classifier.

### 4.6 Live agent activity, without logs

The event log is gone from the main view. Activity appears as:
- **state on marks**: bud colour and motion, the overlap ring, the conflict badge in an area header;
- **counts in context**: beans in flight per area, in the header of that area;
- **sentences**: the lead line ("12 agents are working right now; notifications is the busiest area with 9 beans"), and each bean's journey written in plain English;
- **time as a control**: a scrubber with event ticks, and play.

The raw event log remains reachable per bean (its journey) and as a developer view. It is never the primary story. Motion is limited to the buds: writing breathes, checking rotates. Motion is off when the user prefers reduced motion.

## 5. Where Jev picks, and what it never decides

Each pick is a `decide()` call on one adapter (`research/prototypes/repo-experience/jev.js`). Code supplies the candidate list, Jev answers with a Choice (one or more ordered slots), and the result is checked against the candidates. If Jev is offline, slow (over 1.2 s) or returns something not in the catalog, the decision's rule answers. Every call leaves a receipt.

| Decision | When | Jev sees (state) | Candidates | Output | Fallback rule |
|---|---|---|---|---|---|
| `lead` | Page load; whenever the candidate set changes (not on every scrub tick) | done or live, candidate ids and descriptions | Up to 7 computed facts: growth, swarm, red now, red history, decision, fell off, pending validation | 3 ids, ordered | Live: red > swarm > decision > pending > growth. Done: growth > decision > drops > red history |
| `suggest` | With the overview | in-flight count, suggestion ids | 5–7 question templates filled with real entities (only those with data) | 4 ids, ordered | Live runs suggest what is happening; finished runs suggest what happened |
| `route` | Each question | the question text only | 10 question classes with descriptions | 1 class | Keyword rules (same as `shared-ask` `keywordClassifier`) |
| `files` | Term questions (recent changes, who-why, tests, explore) | question, candidate paths | Top 14 files ranked by code (path match 3, content mentions ≤2, touched by the run 0.5) | up to 8 paths, ordered | Keep score ≥ 2.5, at most 8 |
| `sections` | Each answer | question, class, available section ids | Sections that have data: beans, changes, file, decision, red, swarm, tests | up to 3, ordered | Fixed arrangement per class |
| `spotlight` *(roadmap)* | Live view, every candidate-set change | in-flight beans' states, overlap facts | In-flight beans and areas | 1 to highlight | Most overlaps, then oldest red, then longest in checking |

**Jev never sees** file contents, diffs or numbers it would have to compute. The `lead` candidates carry descriptions, not counts, so Jev chooses *which* fact matters and code states the fact. This matches the measured limits: Jev is "not a calculator", and the input is kept under 2k tokens so latency stays near 200 ms. **Jev never decides** layout (columns, folds and positions are code), truth (every sentence is computed), or anything that writes (decisions on cards stay human or oracle).

The prototype's state payloads are 100–400 bytes per decision (shown on each receipt).

## 6. Visual identity

**Idea: a greenhouse.** Daylight on glass for light mode, the same house at night for dark mode. Colour carries meaning, and the plant metaphor lives in the *marks* (leaf, bud, seed, folded stalk), not in illustration.

| Token | Light | Dark | Meaning |
|---|---|---|---|
| paper | `#edf1ec` | `#0e1712` | page (sage glass, green-ink night) |
| surface / raised | `#f8faf7` / `#ffffff` | `#132019` / `#182920` | pane, cards |
| ink / ink-2 / ink-3 | `#15231a` / `#4a5b50` / `#7b897f` | `#e2ebe3` / `#a8b8ac` / `#74867a` | text levels |
| leaf | `#2d7a45` | `#5cb873` | on the stalk, validated |
| sprout | `#93c13c` | `#b6dc63` | on the sprout, not yet validated |
| bean | `#6a4bc4` | `#a28ef2` | agents, beans in flight |
| pollen | `#c98d12` | `#e6b44c` | being checked, same-file overlap |
| blight | `#c2412e` | `#ef6d58` | red, conflict, fell off |
| pick | `#2f66b3` | `#7fa9e6` | where a pick was made |

- **Type:**
  - **Newsreader** (serif, optical sizes) for anything that is a *sentence written for a person*: the headline, answers, task intents, agent summaries, story prose.
  - **Familjen Grotesk** for the interface: labels, lists, controls.
  - **IBM Plex Mono** only for code, paths and SHAs, never for labels.

  The split means humans' words appear in serif and the machine's in sans.
- **Marks:**
  - a leaf node (asymmetric rounded square) alternating left and right up the stalk;
  - a round bud;
  - a seed at the base;
  - a small bean glyph for picks.
- **Motion:** answers to the user's actions only (folding on Ask, the selected row scrolling into view, columns re-flowing), plus breathing and rotating buds. No entrance animations, nothing decorative, and reduced motion respected.
- **Copy:** sentence case, plain verbs, no ALL-CAPS eyebrows, no middle-dot meta strings. Use the reader's words: "fell off", not "dropped". Keep "sprout", "stalk" and "bean", which the legend teaches.

## 7. The prototype

**Open:** `research/prototypes/repo-experience/index.html` in a browser (double-click works; no server or build step). Fonts load from Google Fonts. Deep links for demos:
- `?ask=what changed recently on coupons?`
- `?bean=t018`
- `?file=src/billing/tax.ts`
- `?t=400` (seconds into the run)
- `?theme=dark`
- `?picks=1` (opens the picks drawer)
- `?jev=<proxy URL>` (live Jev through a key-holding proxy)

| File | What it is |
|---|---|
| `index.html`, `styles.css` | The page and the token system (light and dark) |
| `model.js` | **Code computes:** bean states at any time, in-flight beans, journeys, decisions, red tickets, bed mapping |
| `jev.js` | **The picker:** Jev adapter (System One Choice per slot, 1.2 s budget, catalog validation), rule fallback, receipts |
| `app.js` | Rendering of fixed parts: Plot, tip, headline, chips, pane views, scrubber, popovers |
| `build_data.py` → `data.js` | Builds the data from `fixtures/7z4j84eqvl/` (copied from `packages/web/fixtures`): per-file unified diffs for every landing and bean head, final file contents, line blame by bean (computed by replaying the line) |
| `shoot.sh`, `shots/` | Headless Chrome screenshots |

**Flows covered:**
- first screen (finished run, live mid-run);
- Ask with reshape (coupons, tax rounding, what broke, swarm now, agent activity, pending promotion, tests, explore, empty answers);
- follow a bean (t018 culprit, t032 declined, t024 coupons);
- blame by bean;
- the picks drawer and receipts;
- light and dark themes;
- 500 px phone width.

**Simplified in the prototype:**
- Time is a replay of a recorded run, not a live socket.
- Bed mapping is `src/<dir>`, with everything else under "core".
- The `spotlight` pick is not built.
- The file blame is computed offline in Python; the real app needs an RPC (§8).

Screenshots (1440×900 unless noted):

| Shot | Shows |
|---|---|
| `shots/01-first-screen-light.png`, `01b-first-screen-dark.png` | Home, finished run |
| `shots/07-live-mid-run-light.png` | Home at 6:40: red sprout leads, 12 buds, overlap rings, crowd badges |
| `shots/02-ask-coupons-light.png` | Ask reshape: coupon files as columns, folded rows, answer headline, changes by file |
| `shots/03-swarm-now-dark.png` | "Where is the swarm working right now?": jumps to the busiest minute |
| `shots/10-what-broke-light.png` | The red story; the culprit leaf in red |
| `shots/05-who-why-light.png` | Blame by bean for `tax.ts` |
| `shots/04-bean-journey-dark.png`, `11-bean-on-plot-light.png` | Following a bean (declined t032; t024 highlighted on the Plot) |
| `shots/06-picks-drawer-light.png`, `09-pick-receipt-light.png` | Every pick and one receipt |
| `shots/08-phone-dark.png` (500×1000) | Phone layout |

## 8. Roadmap: into `packages/web`, with Jev live

Today is 2026-10-04 and the deadline is 2026-10-14, which leaves 10 days. Estimates are for one agent working on the web app, with gateway changes made by whoever owns the gateway after the current restructure. Total: about **7 working days plus 1.5 days of buffer**.

### Phase 0: agree and unblock (0.5 day, by 10-05)

- Coop decides the questions in §9.
- Agree with the agent restructuring `shared-ask` / `web` / `gateway` where three things live:
  - the Picker interface: proposed for `shared-ask`, next to `Classifier`;
  - the Plot components: in `packages/web`;
  - the new RPCs: in `packages/gateway`.
- Freeze `ViewSpec` additions (`files`, `sections`, `receipts`).

### Phase 1: the Plot as the repository home (2 days, by 10-07)

**Web:**
- `RepoPlot` (CSS-grid rows, the tip, angled headers);
- `ReadingPane` with the overview, bean, file and answer views;
- `Scrubber`;
- the tokens from §6 as CSS variables;
- served at `/runs/[run]`, with the old race canvas moved under `/runs/[run]/engine` for developers.

**Gateway (new RPCs, read-only, bounded):**
- `repoPlot(run, at?: number)` returns
  `{ t0, tEnd, now, stalkIdx, beds: string[], landings: { task, idx, t, promotedT, files: { path, additions, deletions }[] }[], inflight: { task, agent, state, since, predicted: string[], files: string[] }[], ticks: { t, kind: 'land'|'red'|'decision' }[] }`.
  It is derived from the RunDO event log and the line, which the gateway already reads for `beansByPath`. `beds` comes from top-level directories (capped at 14, the rest under "other").
- `beanDetail` gains a `journey: { t, kind, text, quote? }[]` field. It is computed server-side from the events, so MCP gets the same sentences.
- `repoBlame(run, ref, path)` returns `{ path, commit, ranges: { bean: string|null, lines: number }[] }`. It is computed by replaying the line's per-file diffs, as `build_data.py` does. Cache it per `(run, ref, path)`.

**Picker:** the rules only, in a shared `Picker` with receipts. Jev is not wired in yet.

**Done when:** the first screen and "follow a bean" work on both recorded runs and a fresh run.

### Phase 2: Ask reshapes the page (1.5 days, by 10-09)

- `planAnswer` returns the view spec plus `files` (ranked) and `sections` (ordered), plus `receipts[]`.
- The web app renders the folds, file columns, answer headline and chips with receipts.
- MCP `ask_repo` returns the same JSON, so an agent and a human see the same picks.
- The picks drawer.

**Jev decisions in this phase, behind the Picker:** `route`, `files` and `sections`, with the inputs, candidates and output schemas in §5. The rules from Phase 1 remain the fallback.

**Done when:** the 10 classes each have a recorded fixture test, the coupons, tax-rounding and what-broke flows match the prototype, and the "nothing matches" answer works.

### Phase 3: live (1 day, by 10-10)

- Subscribe to the run's WebSocket (`viewToken().live_path`).
- Apply events to the Plot incrementally: buds change state, a landing adds a row, a promotion recolours leaves.
- Re-pick the `lead` only when the candidate *set* changes, not on every event.
- Add `spotlight` (§5).
- Reduced motion, and a "paused, 14 events waiting" state when the user is scrolled into history.

**Done when:** a live race on the Workers deployment reads correctly at 1× speed, and nothing re-renders the pane while the user is reading it.

### Phase 4: Jev live (1 day, by 10-11; needs credits)

- A server-side adapter in the web Worker:
  - `TYPESAFE_API_KEY` as a Wrangler secret, never in the browser;
  - `@typesafe-ai/sdk` or plain `fetch`;
  - one Choice question per slot;
  - a 1.2 s budget;
  - an LRU cache keyed by `(decision id, hash of candidate ids and descriptions, question)`;
  - at most one call in flight per user, cancelling stale ones;
  - a kill-switch flag.
- An **eval set** of 60 questions plus 20 lead situations with hand-labelled answers. Measure:
  - Jev versus rules versus Workers AI on top-1 agreement;
  - latency p50 and p95;
  - cost.

  **Ship Jev on a decision only where it beats the rules.** `files` and `lead` are the likely wins; `route` may tie with the keywords.
- Receipts show "Jev, confidence 0.91, 240 ms".

**Done when:** the eval report is in `docs/claude-opus/`, and each decision is flagged Jev or rules on evidence.

### Phase 5: polish and demo (1 day, by 10-12)

- A "list" toggle for the Plot: an accessible table of the same rows, with keyboard navigation (rows are focusable; arrows move; Enter opens the bean).
- Phone pass and empty and error states.
- Wire the demo script (`12-demo-script.md`):
  1. open the home;
  2. ask "where is the swarm working right now?";
  3. follow the culprit;
  4. open the decision;
  5. show the picks drawer.
- Take screenshots for the submission.

**Buffer:** 10-13 to 10-14 (1.5 days).

### Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Jev credits stay at zero, or the vendor changes the API | No live Jev in the demo | The adapter is already rules-first. Receipts make the rule visible, so the demo can still say "this is where Jev decides". Workers AI is a second picker (`workers-ai-classifier.ts` exists) |
| Collision with the restructure under way | Merge pain, rework | Phase 0 agreement. The Plot is new files; the only shared change is `ViewSpec` and the Picker |
| Scale: 1,000+ landings, or real repos with deep trees | Rows and columns explode | Bucket rows by time (minute, hour, day) once there are more than 200 visible, using the existing fold component. Areas are capped at 14 with an "other" column. Ask is the tool for drilling in |
| Latency of Jev under concurrency (2–4 s measured at 2.3k tokens and 12 concurrent calls) | Slow reshape | Small state (100–400 bytes), cache, a 1.2 s budget, rules first, then upgrade in place |
| Blame cost on large files or long lines | Slow file view | Compute on landing in the RunDO (incremental), cache in R2 |
| Honesty | A judge reads a prediction as fact | Predicted footprints are dashed; overlap is file-level only; every sentence is computed; every pick has a receipt |
| Unfamiliar for GitHub users | Confusion in the first 10 seconds | The headline sentence and legend explain it, the pane uses familiar lists and diffs, and the "list" toggle offers the same data as a table |

## 9. Decisions for Coop

1. **Adopt the Plot as the repository home** (and move the race canvas to a developer "engine" view)? Recommended: yes.
2. **Jev credits:** top up for Phase 4 (about 10-11), or ship rules-only with receipts and say so in the demo?
3. **Naming on screen:** keep "bean", "sprout" and "stalk" in the UI (with the legend), or use plainer words ("change", "staged line", "main line") and keep the plant names for the brand only? The prototype keeps them.
4. **Bold option:** should the Greenhouse (concept B) be a post-deadline goal, as a zoomed-in view of the Plot's columns?
5. **Who builds it:** the agent restructuring `packages/web` and `shared-ask`, or this session after the restructure lands?

## Disagreements with earlier docs

- **`13-ask-explorer-design.md`** made a GitHub-style three-pane explorer the base layout ("familiar first"). I now think the familiar parts (tree, file, diff) belong in the **pane as detail views**, and the home should be the Plot. The reason is that today's explorer is exactly what reads as a debugger: equal panes and chips of filenames.
- **`claude-12` and Codex `03`** put a spatial map (canvas, tldraw) at the centre. I rank that third for this deadline, because it hides time, and time is the swarm's main axis. It stays the roadmap's bold extension (concept B).
- This should be noted in `docs/claude-README.md` once the owner decides (§9.1). This session was asked to write only this doc and the prototype.

## 10. Built into the app (2026-10-04, second round)

Coop's decisions:
1. The Plot is the repository home, and the race canvas becomes the developer view.
2. Jev runs live through Cloudflare.
3. "Bean", "sprout" and "stalk" stay on screen.
4. Align the most useful and impressive GitHub components.

### What changed against the roadmap in §8

- **No new gateway RPCs were needed.**
  - The Plot is derived in the browser from the run's events, reduced at the playhead, plus the per-file line counts that `repoLog` already serves.
  - The journey comes from `BeanStep`s (`shared-ask/plot/journey.ts`).
  - Blame by bean already existed in `shared-ask/ask/blame.ts`. `Selection.view = 'blame'` now turns it on for any file.
  - `repoPlot` and `repoBlame` remain an optimisation for runs with thousands of events.
- **Jev runs through Workers AI, not a TypeSafe key.**
  - Cloudflare lists Jev as the third-party model `typesafe/jev`.
  - The web Worker calls `env.AI.run('typesafe/jev', { state, questions }, { gateway: { id: JEV_GATEWAY } })`. The AI binding is `remote` in dev, billing goes to the legacy account, and no secret is needed.
  - Measured in local dev against the real service: about 350–450 ms per pick once warm. The first call after start-up took over 1.5 s and fell back to the rule.
  - Confidence on the lead pick was 0.19, so Jev's probabilities are flat, as in earlier tests. It ranks well enough to choose the top item; ties follow the rule.
  - **Superseded 2026-10-14: Clef is the default.** `PICKER` is now `clef`: Cloudflare's Clef Flash (`@cf/cloudflare/clef-flash`, the same System One body plus a required `model: "clef-flash"`, $0.038 per million input tokens) through the gateway in `DECISION_GATEWAY` (renamed from `JEV_GATEWAY`). `clef-27b` (`@cf/cloudflare/clef`) and `jev` remain options; the model is data in `shared-ask/pick/decision-model.ts`, which other packages use to ask typed questions with a budget and a fallback. Receipts name the model that answered. Not yet measured live.
- **One question per decision.** A single Choice question returns probabilities over every candidate. The order is Jev's choice first, then the rest by probability, with ties in the rule's order.

### Where the code lives

| Piece | Path |
|---|---|
| Picker (rules, Jev, receipts) | `packages/shared-ask/src/pick/picker.ts`, `picker-from-env.ts` |
| Headline and suggestions (facts computed, then picked) | `packages/shared-ask/src/pick/lead.ts` |
| Answer picks (`route`, `files`, `sections`), wired into `planAnswer` | `packages/shared-ask/src/ask/answer-picks.ts` |
| Plot model (columns, rows, folds, buds, overlaps) | `packages/shared-ask/src/plot/plot-model.ts` |
| Journey sentences, busiest moment | `packages/shared-ask/src/plot/journey.ts`, `busiest-moment.ts` |
| Page and server action (lead re-picks when the facts change) | `packages/web/app/runs/[run]/page.tsx`, `packages/web/src/server/plot-actions.ts` |
| UI | `packages/web/components/plot/*` (greenhouse tokens are now global in `app/globals.css`; fonts are Familjen Grotesk and Newsreader) |
| Files explorer (moved), Engine view (kept) | `/runs/:run/files`, `/runs/:run/race` |
| MCP `ask_repo` returns `picks` | `packages/mcp/src/tools/ask-repo.ts` (same picker config, `AI` binding added) |

Phases from §8 that are done: phase 1 (the Plot as home), phase 2 (Ask reshapes the page, with receipts, also over MCP) and most of phase 3. Live runs reuse the race canvas's SSE feed, so buds and leaves update as events arrive, and the lead is re-picked once per new set of facts. Phase 4's switch to Jev is done; its 60-question eval is not.

### Decision 4: which GitHub components, by usefulness to a swarm and impact in a demo

| GitHub component (map) | In the Plot | Why it earned a place |
|---|---|---|
| Commits, history, network graph (01) | The rows and the stalk: every landing, in order, sprout and stalk shown separately | The most useful view for a swarm; GitHub has no time × area view |
| Blame (01) | Blame **by bean**: open any file from a column head or an answer | High impact: a line links to an intent, not just a commit |
| Files changed / compare (02) | Diffs per bean (the journey) and per file (answers) | Familiar detail, kept exact |
| Checks, Actions run, logs (03) | The journey's pre-land checks, the red-validation story (suspects, culprit, inherited reds, time to green), red ticks on the scrubber | Shows "is it green" with a cause attached |
| Merge box / review decision (02) | Decision stories: two specs, failing tests, outcome | The one place a human acts |
| Issues / Projects in progress (02) | The tip: buds in flight with agent, state and footprint; crowd counts in area headers | Most impressive live; replaces boards |
| Insights: pulse, contributors (04) | "Where the agents' time went", spend, beans to the stalk per hour, red validations | Cheap, and makes waiting time visible |
| Notifications (04) | The lead and "What happened", ranked by the picker | Attention, ranked |
| Code search (04) | Ask, with the resolver's files ranked by the picker | Already the entry point |

Left out on purpose: wiki, discussions, releases and packages, security alerts and settings. None of them carries swarm signal in these runs. The **spatial map** (concept B) did not earn its place either. The Plot's columns already are the map at area level, and a separate canvas would duplicate them while hiding time. It stays a post-deadline idea.

### Next

- **Phase 4 eval:** label 60 questions and 20 lead situations, and compare Jev against the rules on top-1 agreement and latency. Keep Jev only on the decisions where it wins.
- **Phase 5:**
  - a "list" toggle that turns the Plot into an accessible table;
  - time bucketing past 200 rows;
  - a warm-up call at boot so the first pick stays within budget;
  - an `AI Gateway` id other than `default` if Coop wants separate logs and limits.

### Streaming a bean's changeset live (scope note, 2026-10-05)

Coop asked whether the bean view can show a bean's changeset arriving while its agent writes: hunks streaming into the right side of the journey card. The design-v2 mockup simulates it (`research/prototypes/design-v2/index.html?t=630&bean=t038`, or play the run with a writing bean open). It cuts the recorded diff to the share of the invocation that has elapsed, and puts a "streaming" tag and a writing caret on the right side.

**What exists today.** The engine sees a bean's change only once per invocation. The slot driver runs the harness (Claude Code or Codex) in the bean's worktree. When the invocation ends, the driver commits (`commit_task`) and replies with an `InvocationResult` carrying `head_sha`. The gateway then logs `invocation.end` and `task.commit` (`packages/gateway/src/engine/tasks.ts`, `recordCommit`). Nothing in between reaches the RunDO, so the web app can only show the change after the agent finishes.

**What streaming needs:**

1. **The driver reports progress mid-invocation.** It needs a way to know the agent has edited something, then sends a diff of the worktree against the bean's base, using the same `git diff` the commit already uses (scoped to the bean's own files, capped at 64 KB).
   - **Claude Code:** a `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` names the touched path.
   - **Codex, or as a fallback:** a timer that checks the worktree every 3–5 s and sends only when it changed.
2. **A gateway route and RunDO channel for the progress.** Each report goes to the RunDO as a `bean.progress {task, inv, seq, files: [{path, additions, deletions, patch}]}` message. It is **ephemeral**:
   - not written to `events.jsonl`, so replays and the reducer stay as they are;
   - the DO keeps only the latest snapshot per bean, so anyone who opens the page late sees the current state;
   - it is broadcast on the existing live WebSocket feed, so the web app's server-sent-events bridge needs no new transport.
3. **Guards.** Before anything is broadcast, the same secret scan the fixtures get, plus a size cap and a rate limit per slot (at most one report a second). The commit at the end of the invocation stays the source of truth: when `task.commit` arrives it replaces the streamed snapshot.
4. **Web.** In the journey card, render the latest snapshot under "All changes" and on the live step, with the streaming tag and caret from the mockup. Diffs update in place; motion stays limited to the caret.
5. **MCP (optional).** `bean_status` (then `change_status`) can return the latest snapshot, so other agents see work in progress. It would also feed overlap warnings before a commit exists, a real coordination gain.

**Effort**, against the 2026-10-14 deadline:

| Piece | Days |
|---|---|
| Driver: hook and timer, diff, POST with retry | 0.5–1 |
| Gateway route, RunDO snapshot and broadcast, guards, tests | 1 |
| Web: live snapshot in the journey card (the mockup's rendering is done) | 0.5 |
| **Total, with tests** | **2–2.5** |

A cheaper first step is the timer only (no harness hooks), sending changed-file stats and patches every 5 s: about 1.5 days. It is good enough for the demo, because writing invocations in the recorded runs last 10–40 s. I'd only take it on after the Plot and design-v2 work land, since it touches the driver protocol that both the queue and Beanstalk policies share.

#### Prototype built and measured (2026-10-06)

Streaming diffs now exist behind the run setting `stream_diffs` (default `false`, so parity and the published races are unchanged; `race.py --forge cloudflare --stream-diffs`). The design follows the steps above:

- **Driver** (`research/race/harness/streamdiff.py`, `StreamReporter` in `remote.py`). Claude Code touches a marker after every `Edit`/`Write`/`MultiEdit` (a `PostToolUse` hook running `touch`); the driver polls it every 0.25 s, lets a burst settle for 0.3 s, and also looks every 3 s for Bash or Codex edits. It diffs the worktree through a private index against the bean's base (untracked files in, binaries without a patch, 64 KB of patch text, secret-looking lines redacted), skips an unchanged tree and the state before the agent started, and posts at most once per 1.5 s, with a seq per invocation.
- **Gateway.** `POST …/invocations/:inv/stream`; the RunDO keeps the latest snapshot per bean in SQLite (never the event log), redacts again, refuses stale seqs and more than one snapshot a second, broadcasts a `bean.streaming` summary (paths and counts, no patches) on the live feed, and drops the snapshot with `bean.streaming.end` when the invocation closes. RPC: `beanStreams(run)`, `beanStream(run, bean)` (gateway README, "Streaming diffs").
- **Web.** The SSE bridge forwards `stream` events (and the beans streaming now after its catch-up). "All changes" and the live step show the snapshot with the `streaming` chip and "aN is writing" caret; the file changed last is open in a scroll box that follows the hunk changed last (since 2026-10-06; it followed the file's last 30 lines before), the others folded, in git's order. When the stream ends the card says "finished writing; its commit is on the way" and refreshes the server render, so the committed diff replaces it. Growing now shows "N files +a −d"; the stalk shows a blinking caret on the bean (counts on hover).
- **MCP.** `bean_status` returns `editing_now` (files and counts, the snapshot number); `work_overlaps` counts the files a bean's agent is editing now, so a bean with no commit yet on a path is reported (`editing_now` per bean).

**How it was proven.** Without the deployed gateway: `research/race/stream_e2e/` runs the real gateway Worker and RunDO under `wrangler dev`, the real web app under `vite dev`, the real driver and real `claude -p` sessions. Artifacts is replaced by bare repos behind a local smart-HTTP server, and the runner by a local one that squashes for real and passes every check. Six races (Haiku and Sonnet, 2–3 agents, 3 tasks each, about $0.30 in all), watched by a headless Chrome that timestamps every DOM change. Screenshots: `exp/streaming-diffs/journey-mid-stream.png`, `journey-mid-stream-2.png`, `home-growing-now.png`, `journey-after-commit.png`.

| Measure (local, machine shared with other agents) | Result |
|---|---|
| Edit tool call → stalk / Growing now | median 0.55–0.7 s, max 1.5 s (the 1.5 s minimum interval) |
| Edit tool call → journey diff | median 0.5–1.0 s, max 1.4 s |
| Gateway accepted → stalk (feed) | median 4–5 ms, max 13 ms |
| Gateway accepted → journey (feed, then the `beanStream` fetch) | median 40–180 ms, max 360 ms |
| Snapshot size (POST body) | median 1.2–4.7 KB, max 6.1 KB; the feed summary is a few hundred bytes |
| Agent overhead: the hook | 12 ms median (p95 27 ms) per edit tool call; 10–12 per invocation, about 0.15 s of an 85–130 s invocation (≈0.15%) |
| Driver overhead | 50–290 ms of git per snapshot, beside the agent, never in its way |

**Usability, honestly.**

- **No half-written junk, but chunky.** A snapshot is one tool call: Claude Code writes whole files (`Write`) or whole replacements (`Edit`), so a line is never half typed. Haiku wrote each file in one `Write`, so a bean jumped twice and was done: it reads as "appeared", not "streamed". Sonnet on a multi-file task produced 5–6 snapshots in 37 s, a good rhythm. Intermediate states can still be wrong (a helper used before it is written, tests not yet passing): the chip says "streaming", not "passing".
- **Flicker, found and fixed.** The first cut reordered files to put the newest first (the list jumped every snapshot), showed the driver's acceptance tests as the first "edit", and flashed a rework's previous snapshot for a frame. Now files keep git's order and only which one is open changes; the baseline excludes what was there before the agent started; a new invocation starts empty. The end used to be one jump ("finished writing", then about 0.8 s later the committed diff replaced the followed view); since 2026-10-06 the commit is drawn by the same view, so it settles in place (below).
- **Readable.** Following the tail of the file being written worked for new files and appends, but not for an edit in the middle of a long file. Fixed on 2026-10-06: the view follows the hunk that changed (below).
- **Debounce.** Keep it edit-triggered: 0.3 s settle, 1.5 s minimum interval, and the 3 s timer as a fallback. Faster gains nothing (one snapshot per tool call is the real granularity); slower makes the stalk lag what the agent visibly did. The web needs no extra debounce: the journey fetches only the bean on screen, the newest request wins, and the old diff stays until the new one arrives.

#### Following the changed hunk (2026-10-06)

The journey's streaming view now follows what the agent just changed, not the end of the file.

- **What changed between snapshots.** `packages/web/src/stream/followed-change.ts` gives every diff row a stable id: a line diff (`diffArrays` from `diff`) matches the new snapshot's rows of each file to the previous one's (hunk headers match each other whatever their numbers), matched rows keep their ids, new rows get new ones. Added or deleted rows with new ids are **fresh**. The focus is the last file in git's order with fresh rows, at the first fresh row of its last changed hunk; with nothing fresh it stays where it was. The first snapshot a page sees highlights nothing and looks at the last hunk of the last file; a new invocation starts from nothing, so its first snapshot is all fresh. Unit tests beside it.
- **The view** (`components/home/streaming-diff.tsx`). The open file sits in a scroll box (30 rows, at most 60% of the screen height) that scrolls itself, never the page, so the focus row lands 3 rows below its top (smooth, instant under reduced motion). Rows are keyed by their ids, so a snapshot repaints only what changed; files keep git's order. Fresh rows get a wash and a left bar in the human colour that fade over 2.4 s (`--fresh-wash`, stronger at night; under reduced motion the mark stays until the next snapshot instead of fading).
- **A reader who scrolls away.** A scroll of the box within 1 s of a wheel, touch, key or pointer on it is the reader's. If the edit is then out of view, following pauses: the box stays where the reader put it, the open file stays open even when the agent moves to another one, and the caret line gets a button ("follow", then "new edit, follow" or "new edit in index.ts, follow"). Scrolling back to the edit resumes following without a jump; the button resumes and scrolls to the newest edit.
- **The commit replacing the stream.** When the committed diff arrives while the card is open, it is drawn by the same view: rows carry their ids over, nothing is highlighted, the focus and the scroll position stay, and only the note changes ("N files, its whole change as it landed", faded in). Files the commit adds (the acceptance tests) appear folded in their place. Opening the card later shows the usual committed view.

**Proven with real races** (the `stream_e2e` stack on this worktree's own ports and Worker names: `STREAM_E2E_PORTS`, `STREAM_E2E_SUFFIX` in `devstack.py`). The throwaway arena gained t103, five ordered edits to a 155-line `src/catalog/index.ts`: a field on every row of the table at the top, a function at the end, two fixes in the middle (lines 76 and 92), then the first line. Three Sonnet races: t103 with t101 (2 agents), t103 with t102 (2 agents), t103 alone; $0.47 in all. A headless Chrome watched each t103 journey on three pages: night desktop, day phone (390 px), and night desktop with a scripted reader who wheels the box away after the second snapshot.

- Every snapshot brought its changed hunk into view, on all three pages: the middle fixes with the end of the file below them (`exp/streaming-diffs/follow-hunk-middle-night.png`, `follow-hunk-middle-phone-day.png`), and the last edit, the first line, by scrolling the box back to its top, where the old tail-following would have stayed at the end (`follow-hunk-top-edit-night.png`, `follow-hunk-top-edit-phone-day.png`). The highlight was measured on the page: its opacity was 0.3–1 half a second after a snapshot was drawn and near 0 two seconds later.
- The scripted reader's box stayed put through the next snapshot with "new edit, follow" showing (`follow-hunk-reader-paused.png`); the button brought the newest edit back into view.
- The commit swap kept the open file and scroll position on all three pages (`follow-hunk-commit-swap.png`); the note was the only change.

**Still rough.** Each t103 invocation's first snapshot held only the driver's acceptance test file (+20), before the agent's first real edit, so the view opens on it for a second or two; the driver's baseline only suppresses the state before the agent's first change. When the changed hunk is near the end of a file, the box is clamped at its bottom and the hunk sits lower than 3 rows from the top (it is still in view). The highlight marks rows of the newest snapshot only: two quick edits within one 1.5 s window arrive as one snapshot and are highlighted together. Not yet tried on a real Cloudflare race.

**To verify in a real Cloudflare race:** the feed through the deployed web's SSE bridge (buffering between Cloudflare and the browser), latency with the driver across the internet, RunDO SQLite writes at 12 agents (about 8 snapshots a second at most, 64 KB each at worst), `router.refresh()` under vinext on Workers, the hook with `--restricted` and without `--safe-mode` on the race box, the secret scan's false positives on real code, and an old web against the new gateway (the stream methods are optional on the binding).

## 11. Nightshift built into the app, and how real use works (2026-10-05)

The design-v2 direction (Nightshift) replaced the Plot as the repository home at `/runs/:run`.

### What is built

- **Shell.** The repository is named once (`coop / beanstalk-shop`). Its tabs are:
  - **Code**: the home;
  - **Files**: the explorer, at `/files`;
  - **Beans**, **Decisions** and **Checks**: the home explorer opened on that tab's question;
  - **Engine**: the race canvas, at `/race`.

  The site header links to the benchmark runs and the race. A ☀/☾ toggle follows the system until the viewer picks; a day-mode menu offers phosphor (the default), paper and blueprint. Both choices persist in cookies (`bs_theme`, `bs_day`), and the server renders in them.
- **The stalk** (`shared-ask/home/stalk.ts`, `components/home/stalk-list.tsx`):
  - beans in flight at the tip, by session;
  - lime sprout leaves, then a pointer to the stalk, then mature stalk leaves;
  - a red leaf for the culprit and faint, struck-through rows for beans that fell off;
  - "Fertilized by <owner>" at the root.

  Leaves keep their keys, so during playback they grow in and change colour in place. Validated landings pulse, the sprout shimmers, and an answer dims every leaf it is not about. The scrubber has play and 1×/10×/60× speeds. Old leaves fold by validation past 60 landings.
- **The explorer.** The Ask is a command prompt: completions appear only on focus, ⌘K or `/`, and three example chips sit under the closed box. With nothing asked, it shows Growing now, What happened, then Files with the last bean of each area and "N in flight" chips. A question becomes a composition (`shared-ask/home/composition.ts`):
  - **Ordering.** The picker's `sections` order maps onto components, and a "This view" line with a receipt behind ⓘ appears only after a question.
  - **Recent changes and who-why** also feature the newest bean's journey.
  - **"Why red" and "what did we decide"** lead with their card.
  - **Swarm questions** show who is working, collision hot spots and recent conflicts.
  - **On a finished run, "who is working now?"** answers "Nobody, the run finished at …" and offers the busiest moment.
- **The bean journey** has "All changes" first and selected by default. Each step shows its details on the right, and a step in progress spins, for example a pre-land check running, with a progress bar.
- **Status line.** Sprout #, stalk #, the sprout's health, beans growing, "N people, M sessions active", the picks (with a drawer of every receipt), replay or live, and the clock.
- **Jev.** Jev still runs live through the AI binding, with the rule fallback.
  - The rules and keywords now outrank Jev on routing. Jev's route stands only when the keyword router could not place the question (`explore`). In testing, Jev's flat probabilities had sent "why did the sprout go red?" to Explore.
  - Jev still orders suggestions, files and sections.
- **Streaming diffs.** Prototyped behind `stream_diffs` (§10 note, "Prototype built and measured").

### People, sessions and repositories, not "agents" and "runs"

Agents are not persistent: they are **sessions** (Claude Code, Codex …) that **people** connect and own, often 5–10 people per repository. The UI therefore says "1 person, 6 sessions active" and "a6, Claude Code session of coop". It never says "12 agents".

The recorded runs carry no owner data. `packages/web/src/people/` attributes every session to the repository's owner, and that folder is where real owner data goes. A **run** is a benchmark artifact: the home reads as a living repository, and runs stay reachable from "Benchmark runs" and the Engine tab.

### How real use would work (roadmap, not built)

1. **Connect.** A person installs the Beanstalk plugin in Claude Code or Codex and signs in. The plugin registers a **session** with the gateway (session id, owner, harness, repository) and gets a session token scoped to that repository. The token is an agent principal under the owner, as in `06`.
2. **Get work, or bring it.** A connected session either:
   - **asks for work**: `task_next` over MCP returns a bean the scheduler placed, footprint-checked against everything in flight; or
   - **brings its own task**: `bean_open {intent}` creates a bean the session owns, and the scheduler checks its predicted footprint before it starts.

   Assignment is optional and owner-controlled: a repository setting says whether sessions may take placed work, and whose.
3. **Write, check, land.** The session writes in its bean branch, as in today's driver. Pre-land checks, the sprout, validation and the stalk work as now. Decision cards go to the people who own the specs.

**What the gateway needs:**

| Piece | Description |
|---|---|
| Session identity | `sessions` table (id, owner, harness, repository, connected_at, last_seen) |
| MCP verbs | `session_connect`, `task_next`, `bean_open`, plus a heartbeat |
| Event fields | `owner` and `session` on `task.start` and `invocation.*` events |
| Web read path | A `sessions(repo)` RPC, replacing the placeholder in `src/people/` |
| Repository identity | Separate from runs, so `/:owner/:repo` can replace `/runs/:run` |

About 2–3 days. It belongs after the competition demo unless Coop wants a live "connect your session" moment in it.

### Screenshots

In `research/prototypes/repo-experience/shots/app-v2/`:

| Mode | Shots |
|---|---|
| Night | home mid-run, coupons, bean journey, finished, what broke, who's on billing, a step selected, the Files tab |
| Day (phosphor) | home mid-run, coupons, bean journey, finished |

### Performance note: the live Ask path (2026-10-05, not yet measured span by span)

On a live run, the coupons question took about 22 s through the gateway, against 2 s for a recorded run. I haven't traced it yet; this is a read of the code path, to verify with the gateway's traces before fixing.

**What one answer reads.** `planAnswer` makes four kinds of read:

1. **Run context:** `loadPlanContext` pages the whole event log (`runEvents`, 5,000 at a time), then reads the tree at the sprout, `beansByPath` for every bean, `decisions` and `repoLog`.
2. **The feature's files:** `loadCorpus` reads the tree again, the beans again and `testsFor` for every test, plus one `repoGrep` per stem of the feature word.
3. **The answer's body:** a `repoDiff` across the range, and for the featured bean its `beanDetail` and a second `repoDiff`.
4. **The suggestions:** reduced from the events, which are already loaded.

**What probably dominates:** the reads that touch file contents, run one after another rather than together.

- **`repoGrep`** reads every file at the ref from Artifacts to scan it: 114 file reads per stem, two stems for "coupons".
- **`testsFor`** with no paths builds the import closure of every test, which means reading every test and the sources it imports.
- **`repoDiff`** reads both trees and the changed blobs, twice per answer.
- **The rest:** the tree read at the sprout three times, and `beansByPath` for every bean twice, each reconstructed from the event log.

On Artifacts each blob read is a network round trip; on the recorded runs every read is in memory, which explains the 10×.

**Fix**, in the order I'd do it:

1. **Memoise per request.** One `ForgeSource` wrapper caches tree, beans, tests and events within a request. This removes the duplicate reads, under an hour of work.
2. **Precompute indexes on landing.** When a commit lands on the sprout, the gateway (a queue consumer or the RunDO's alarm) updates three indexes, keyed by ref sha and stored in D1 or the DO's SQLite:
   - a **term index** (path tokens and identifier tokens per file), so the resolver's grep becomes one indexed query;
   - each **test's import closure**;
   - each landing's **numstat and patch**, so diffs between line commits are concatenations, not tree walks.

   About 1.5 days.
3. **Cache answers.** Cache by (run, question class, entities, sprout sha) in the Cache API for a few seconds. Repeated questions and tab clicks then return immediately; the live feed invalidates the cache when the sprout moves.
4. **Stream the page.** Render the stalk and defaults first, then stream the explorer in with React's streaming render (`Suspense`), so the page appears in under a second while the answer finishes.

**Target:** under 2 s for an answer on a live run, under 300 ms for a repeated question.

**Done (2026-10-06): fixes 1 and 2; 3 and 4 were not needed.**

- **Fix 1, per-request memo.** `shared-ask/forge/memo-source.ts` wraps the live source once per request (the page and the MCP server). The page now passes one source to the home's data, the answer and the featured bean. Inside `gatewaySource`, the app's paging and the reducer's log share event pages. The tree, the beans and the log are read once per request instead of two or three times.
- **Fix 2, a read index in the RunDO, keyed by git object id.** The gateway's repo RPCs (`repoTree/File/Diff/Log/Grep`, and `testsFor`) now run in the run's Durable Object, through `gateway/src/repo/object-cache.ts`:
  - Trees, blobs and commits are stored by id in the DO's SQLite (`git_objects`). An object never changes under its id, so the cache is never stale.
  - Only ref heads go to Artifacts. A head read is reused for 5 s, and a landing clears it.
  - The repo handle opens only on a cache miss.
  - On `race.start`, `task.commit` and `green.promote`, the DO warms the new head in the background (`waitUntil`). A landing then costs its new objects only.
  - Grep, import closures and diffs read the index. A word index or stored patches were not needed at this repository's size.

  The engine is untouched: the warm-up only reads.
- **Measured** with `packages/web/src/forge/live-ask-timing.test.ts`. The harness is not the deployed gateway: it runs the gateway's own explorer and closure code over a simulated Artifacts repo built from the recorded run `7z4j84eqvl`, under fake timers. That run is kept as the test's own fixture (`packages/web/src/forge/testing/fixtures/`), so rebuilding the demo fixtures does not move the calibration. One model reproduces the 22 s measured live: the repo answers one call at a time, at 70 ms a call, with 5 ms per RPC hop. Totals for the page with "what changed recently on coupons?":

  | | Calls to Artifacts | One call at a time, 70 ms | Overlapping calls, 70 ms |
  |---|---|---|---|
  | Before | 308 | 21.6 s | 4.4 s |
  | Fix 1 | 276 | 19.4 s | 4.0 s |
  | Fix 1 + 2, run indexed by its landings | 4 | 0.34 s | 0.34 s |
  | Repeat question (within 5 s, or later) | 2 or 4 | 0.20 s or 0.34 s | 0.20 s or 0.34 s |
  | A run never warmed (live before the deploy), first question only | 169 | 11.9 s | 2.6 s |

  CPU time is not in the model; at zero latency the whole page costs about 0.1–0.2 s of CPU on a laptop. The indexed answer equals the direct one (a test checks this).
- **To verify after deploy:**
  - In the gateway's traces, an Ask on a live run makes a handful of Artifacts calls, not hundreds.
  - `git_objects` grows by a landing's objects only.
  - "read index warm-up failed" does not appear in the logs.
  - The per-call latency of Artifacts is still unmeasured (`claude-15` B1). If it turns out far above 70 ms, the cold first question on a run that was live during the deploy is the only slow case.
