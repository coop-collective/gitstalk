# Load generator run: stg-scion-policy-fastify-16-s7

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-policy-fastify-16-s7 | beanstalk | 16 | 38/38 | 1.1 / 4.0 | 2.3 / 4.9 | - | 0.433 / 0.312 | 7 / 7 | 14 | 120 | 33.88 (38) | 14 | 53.37 | 0 | 11.2 | True |

- schedule: `{"kind": "closed", "seed": 7, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 7, "rebase": 14, "upstream_files_taken": 120, "red": 7, "upstream_after_red": 2}`
- first push → verdict: `{"n": 38, "median": 52.3, "p90": 115.3, "mean": 68.5}`
- CI: `{"preland": {"runs": 67, "minutes": 39.12, "check_minutes": 45.58, "red": 7}, "validation": {"runs": 19, "minutes": 14.25, "red": 0, "cancelled": 0, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: r219554a90424904f0ee
- verdicts: `{"landed": 38, "conflict": 7, "red": 6, "timeout": 1}`
- checks reused: 6
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
