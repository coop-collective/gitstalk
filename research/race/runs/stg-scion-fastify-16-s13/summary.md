# Load generator run: stg-scion-fastify-16-s13

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-fastify-16-s13 | beanstalk | 16 | 38/38 | 0.9 / 3.4 | 1.8 / 4.2 | - | 0.421 / 0.33 | 6 / 5 | 11 | 50 | 40.56 (38) | 11 | 54.52 | 0 | 9.4 | True |

- schedule: `{"kind": "closed", "seed": 13, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 5, "rebase": 11, "upstream_files_taken": 50, "red": 6, "upstream_after_red": 1}`
- first push → verdict: `{"n": 38, "median": 49.5, "p90": 102.6, "mean": 61.3}`
- CI: `{"preland": {"runs": 63, "minutes": 41.06, "check_minutes": 43.3, "red": 6}, "validation": {"runs": 20, "minutes": 13.46, "red": 0, "cancelled": 2, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: r553789bdb384de2d4e4
- verdicts: `{"landed": 38, "red": 6, "conflict": 5}`
- checks reused: 5
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
