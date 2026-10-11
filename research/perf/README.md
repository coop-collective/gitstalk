# Web performance harness

Measures the Gitstalk web app (`packages/web`) on **staging** (https://gitstalk.dev). Never point it at production (`measure.mjs` refuses gitstalk.io; `--compare` makes three signed-out loads of `/` there, which is fine).

| Script | What it does |
|---|---|
| `bundle.mjs` | Builds `@gitstalk/web`, sums raw/gzip/brotli of `dist/client` by type, and (with `--base`) the scripts and styles each page's HTML names plus the set shared by every page |
| `measure.mjs` | Playwright: 5 cold + 5 warm loads per route (TTFB, LCP, load, JS transferred, requests), soft navigation between repo tabs, back navigation (RSC request count), and 60 s idle polling visible vs hidden |
| `report.mjs` | Turns the two JSON files into the markdown tables |
| `setup.mjs`, `mint-token.mjs`, `seed.mjs` | One-off: create the perf account, a write token, a repo with beans and an Actions run |
| `lib.mjs` | Loads Playwright from outside the repo, finds Chrome, helpers |

The repo gains no dependency. Playwright is loaded from a folder you point `PW_DIR` at (it must contain `node_modules/playwright`; any scratch folder with `npm i playwright` works). Chrome for Testing is taken from `~/Library/Caches/ms-playwright` or `PW_CHROME`.

## Secrets live outside the repo

All session material goes to a directory you choose (`$PERF`, for example under your scratchpad), never the repo: `cookie.txt` (the `__Host-bs_session` value), `handle.txt`, `token.txt` (a personal access token), and `clone/`.

## Re-run against the existing account

```bash
export PW_DIR=<dir with node_modules/playwright>
export PERF=<secrets dir>            # holds cookie.txt and handle.txt
node research/perf/measure.mjs --base https://gitstalk.dev --cookie-file $PERF/cookie.txt \
  --compare https://gitstalk.io --out research/perf/results/<label>.raw.json
node research/perf/bundle.mjs --base https://gitstalk.dev --cookie-file $PERF/cookie.txt \
  --out research/perf/results/<label>.bundle.json          # add --no-build to skip the build
node research/perf/report.mjs --measure research/perf/results/<label>.raw.json \
  --bundle research/perf/results/<label>.bundle.json
```

Useful flags: `--runs 5`, `--idle 60` (seconds), `--only routes,soft,idle`. A full run takes about 10 minutes, most of it the six 60 s idle windows. Run it on a quiet machine and do not run `bundle.mjs` at the same time (the build loads the CPU). Compare against `results/baseline-2026-10-11.md`; staging TTFB is noisy, so compare medians and repeat when a difference is under ~100 ms.

Routes measured: `/`, `/<h>/perf-repo`, `/changes`, `/changes/<bean>`, `/history`, `/actions/runs/<run>`, `/<h>`. The bean and run links are discovered from the repo's Changes and Actions pages, so they follow the account's current data.

## Create the test account (once, or when it is lost)

Sign-up uses a Chrome virtual passkey, so the account cannot sign in again after the browser closes; the session cookie is the only handle on it, which is why it is saved. Sessions expire (the cookie's `Max-Age` applies), so when `measure.mjs` lands on `/login` or reports no discovered links, create a new account the same way and treat the next result as a new baseline.

```bash
node research/perf/setup.mjs      --base https://gitstalk.dev --out $PERF   # sign up perf-<hex>, repo "perf-repo" from the TypeScript starter
node research/perf/mint-token.mjs --base https://gitstalk.dev --dir $PERF   # read+collaborate+write token to $PERF/token.txt
node research/perf/seed.mjs       --base https://gitstalk.dev --dir $PERF   # clone, push 2 beans with `git push -o wait`; the first adds .github/workflows/ci.yml
```

(`PW_DIR` is needed for `setup.mjs` and `mint-token.mjs`.) The starter template has no workflow, so `seed.mjs` adds one in the first bean; the push starts the Actions run the run-page measurements use. Staging data is shared and not reset by this harness; keep one perf account and leave it alive for later comparisons.

## Caveats

Cold means a new browser context (empty HTTP cache) on a shared socket pool and DNS cache, not a new browser. Hidden-tab behaviour is emulated, see the method notes in the baseline. Single client location, no CPU or network throttling: use the numbers to compare runs from the same machine, not as absolute user experience.
