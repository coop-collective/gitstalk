# Load generator run: stg-scion-policy-fastify-16-s11

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-policy-fastify-16-s11 | beanstalk | 16 | 38/38 | 0.9 / 3.7 | 1.9 / 4.1 | - | 0.429 / 0.325 | 7 / 4 | 11 | 65 | 38.16 (38) | 12 | 53.05 | 0 | 10.0 | True |

- schedule: `{"kind": "closed", "seed": 11, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 4, "rebase": 11, "upstream_files_taken": 65, "red": 7, "upstream_after_red": 2}`
- first push → verdict: `{"n": 38, "median": 53.5, "p90": 106.5, "mean": 67.6}`
- CI: `{"preland": {"runs": 61, "minutes": 39.48, "check_minutes": 43.0, "red": 7}, "validation": {"runs": 20, "minutes": 13.57, "red": 0, "cancelled": 1, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: r2e1d1337b871b9c2ff8
- verdicts: `{"landed": 38, "conflict": 4, "red": 6, "timeout": 1}`
- checks reused: 6
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
