# Load generator run: stg-scion-policy-fastify-16-s13

| run | forge | N | integrated | ready→integrated med / p90 min | ready→stable med / p90 min | enqueue→merged med / p90 min | waiting share (change / worker) | kick-outs (red / conflict) | rebases | upstream files | per 10 min (peak) | max waiting | CI min | red validations | wall min | correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stg-scion-policy-fastify-16-s13 | beanstalk | 16 | 38/38 | 0.9 / 4.6 | 1.8 / 5.4 | - | 0.445 / 0.325 | 11 / 5 | 16 | 217 | 33.71 (38) | 12 | 55.28 | 0 | 11.3 | True |

- schedule: `{"kind": "closed", "seed": 13, "think": {"median": 88.25, "sigma": 0.462, "n": 76, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "fix": {"median": 65.07, "sigma": 0.311, "n": 10, "source": "fitted: pair-fastify-codex-4-s7-github, pair-fastify-codex-4-s7-beanstalk"}, "time_scale": 1.0, "hold": "integrate"}`
- mode: standalone
- dropped: none
- reactions: `{"conflict": 5, "rebase": 16, "red": 11, "upstream_files_taken": 217, "upstream_after_red": 5}`
- first push → verdict: `{"n": 38, "median": 51.6, "p90": 112.3, "mean": 68.3}`
- CI: `{"preland": {"runs": 66, "minutes": 42.36, "check_minutes": 45.86, "red": 11}, "validation": {"runs": 19, "minutes": 12.92, "red": 0, "cancelled": 1, "targeted": 0, "targeted_tests": 0}, "audit": {"runs": 0, "minutes": 0.0, "red": 0}}`
- aborted: None
- engine: r586844ba7be8f2b7d48
- verdicts: `{"landed": 38, "red": 10, "conflict": 5, "timeout": 1}`
- checks reused: 6
- final: suite green True, acceptance 38/38 of integrated, matches chain build False
