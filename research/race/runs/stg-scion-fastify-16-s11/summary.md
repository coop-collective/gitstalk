# Load generator run: stg-scion-fastify-16-s11

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-fastify-16-s11 | beanstalk | 16 | 38/38 | 0.9 / 3.8 | 1.8 / 4.9 | - | 0.441 / 0.315 | 6 / 5 | 11 | 60 | 36.16 (38) | 12 | 54.21 | 0 | 10.5 | True |

- schedule: `{"kind": "closed", "seed": 11, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 5, "rebase": 11, "upstream_files_taken": 60, "red": 6, "upstream_after_red": 2}`
- first push → verdict: `{"n": 38, "median": 51.4, "p90": 112.0, "mean": 68.0}`
- CI: `{"preland": {"runs": 63, "minutes": 38.96, "check_minutes": 41.17, "red": 6}, "validation": {"runs": 22, "minutes": 15.25, "red": 0, "cancelled": 2, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: rce5381bb6bcc9a30784
- verdicts: `{"landed": 38, "conflict": 5, "red": 4, "timeout": 2}`
- checks reused: 4
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
