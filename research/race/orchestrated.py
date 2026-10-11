#!/usr/bin/env python3
"""Orchestrated race: one coding-agent session per forge works the whole backlog with its own subagents.

  python3 orchestrated.py --forge github --gh-owner kintohubtest --arena ../real-arena/fastify --tasks 10 \\
      --model sonnet --subagents 4 --max-usd 20 --max-wall-minutes 90 --out runs/orch-fastify-sonnet-4-github
  python3 orchestrated.py --forge beanstalk --gateway https://<gateway> --arena ../real-arena/fastify --tasks 10 \\
      --model sonnet --subagents 4 --max-usd 20 --max-wall-minutes 90 --out runs/orch-fastify-sonnet-4-beanstalk
  python3 kth_green.py runs/orch-fastify-sonnet-4-github runs/orch-fastify-sonnet-4-beanstalk --k 3 5 8

See ORCHESTRATED.md. Exit status: 0 done, 3 stopped at the wall-clock cap.
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from harness.orchestrated import OrchConfig, OrchestratedRace  # noqa: E402
from harness.suite import load_suite  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], epilog=__doc__.split("\n\n", 1)[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--forge", choices=["github", "beanstalk"], required=True)
    ap.add_argument("--arena", default=os.path.join(HERE, "..", "real-arena", "fastify"))
    ap.add_argument("--repo", help="materialized arena repository (default: the arena.json's repo)")
    ap.add_argument("--tasks", nargs="+", help="task ids or a count (first N)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--seed", type=int, default=7, help="names the repository; the orchestrator is not seeded")
    ap.add_argument("--orchestrator", choices=["claude"], default="claude")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--worker-model", default="sonnet")
    ap.add_argument("--subagents", type=int, default=4)
    ap.add_argument("--max-usd", type=float, default=20.0)
    ap.add_argument("--max-wall-minutes", type=float, default=90.0)
    ap.add_argument("--drain-minutes", type=float, default=15.0,
                    help="after the session ends, wait this long at most for in-flight integrations")
    ap.add_argument("--gh-owner", default=os.environ.get("BEANSTALK_GH_OWNER"))
    ap.add_argument("--gh-repo")
    ap.add_argument("--ci-slots", type=int, default=2, help="GitHub merge queue build concurrency")
    ap.add_argument("--batch", type=int, default=4, help="GitHub merge queue max entries to merge")
    ap.add_argument("--gateway", default=os.environ.get("BEANSTALK_GATEWAY"))
    ap.add_argument("--bs-owner", default="race")
    ap.add_argument("--bs-repo")
    ap.add_argument("--preland-concurrency", type=int,
                    help="Beanstalk: pre-land checks at once (settings.engine.preland_sandboxes, with ci_slots = "
                         "--ci-slots), to match GitHub's concurrent PR check jobs (about 20 on Actions); default: the "
                         "gateway's (32 sandboxes, 2 CI slots)")
    ap.add_argument("--bs-seed", choices=["import", "race-run"], default="import",
                    help="how the Beanstalk repo gets the base: imported from a public GitHub copy (default) or a race "
                         "run's seed token (the local stack only)")
    ap.add_argument("--guidance", choices=["prompt", "plugin"], default="prompt",
                    help="--forge beanstalk: 'plugin' gives the lead and the workers the Beanstalk plugin's skill "
                         "(coop-collective/gitstalk-plugin: GITSTALK_PLUGIN_DIR, ../gitstalk-plugin, or cloned into "
                         "research/race/.plugin) in place of the shared prompt's forge section; labelled in the "
                         "summary. Default 'prompt': the shared orchestrated prompt the baseline pairs use")
    ap.add_argument("--claude-bin", default="claude")
    ap.add_argument("--remeasure", action="store_true",
                    help="--forge beanstalk: measure a finished race in --out again (its measurement died); no session")
    ap.add_argument("--wait-gateway", action="store_true",
                    help="--forge beanstalk: first wait while another race on this machine uses a gateway")
    a = ap.parse_args(argv)
    if a.guidance == "plugin" and a.forge != "beanstalk":
        ap.error("--guidance plugin is for --forge beanstalk")
    if a.forge == "github" and not a.gh_owner:
        ap.error("--forge github needs --gh-owner")
    arena = os.path.abspath(a.arena)
    repo = os.path.abspath(a.repo) if a.repo else load_suite(arena).repo
    if not repo:
        ap.error("--repo (the arena has no arena.json repo)")
    cfg = OrchConfig(forge=a.forge, arena=arena, repo=repo, tasks=a.tasks, out=a.out, seed=a.seed,
                     orchestrator=a.orchestrator, model=a.model, worker_model=a.worker_model, subagents=a.subagents,
                     max_usd=a.max_usd, max_wall_minutes=a.max_wall_minutes, drain_minutes=a.drain_minutes,
                     gh_owner=a.gh_owner, gh_repo=a.gh_repo, ci_slots=a.ci_slots, batch=a.batch, gateway=a.gateway,
                     beanstalk_owner=a.bs_owner, force=a.force, claude_bin=a.claude_bin,
                     extra={"bs_seed": a.bs_seed, "guidance": a.guidance, **({"bs_repo": a.bs_repo} if a.bs_repo else {}),
                            **({"preland_concurrency": a.preland_concurrency} if a.preland_concurrency else {})})
    if a.remeasure:
        return OrchestratedRace(cfg).remeasure()
    if a.wait_gateway and a.forge == "beanstalk":
        from pair import wait_for_gateway
        import urllib.parse
        wait_for_gateway(host=urllib.parse.urlparse(a.gateway or "").hostname)
    code = OrchestratedRace(cfg).run()
    summary = os.path.join(OrchestratedRace(cfg).out, "summary.md")
    if os.path.exists(summary):
        print(open(summary, encoding="utf-8").read())
    return code


if __name__ == "__main__":
    sys.exit(main())
