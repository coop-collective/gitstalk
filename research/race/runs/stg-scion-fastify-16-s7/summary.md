# Load generator run: stg-scion-fastify-16-s7

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-fastify-16-s7 | beanstalk | 16 | 38/38 | 0.9 / 3.1 | 2.0 / 3.8 | - | 0.438 / 0.333 | 3 / 6 | 9 | 9 | 39.95 (38) | 13 | 50.22 | 0 | 9.5 | True |

- schedule: `{"kind": "closed", "seed": 7, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 6, "rebase": 9, "upstream_files_taken": 9, "red": 3}`
- first push → verdict: `{"n": 38, "median": 51.2, "p90": 112.1, "mean": 66.9}`
- CI: `{"preland": {"runs": 61, "minutes": 37.67, "check_minutes": 43.31, "red": 3}, "validation": {"runs": 18, "minutes": 12.55, "red": 0, "cancelled": 3, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: r7bd8c730e25a49f9cdd
- verdicts: `{"landed": 38, "conflict": 6, "red": 3}`
- checks reused: 6
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
