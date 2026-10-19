# Evidence and limits

Reviewed 2026-10-19. No reviewed source establishes agent-optimal Rust function/file lengths or parameter counts.

- [SWE-agent](https://arxiv.org/html/2405.15793v3) studied tool interfaces, search/read output and edit feedback. Its bounded viewer was not an experiment on Rust source layout; it does not justify splitting files at that window size.
- [Agentless](https://arxiv.org/html/2407.01489v2) supports localizing code and validating patches in its evaluated Python tasks. It does not show that more functions, traits or indirection improve agent success.
- [SWE-Perf](https://arxiv.org/html/2507.12415v2) evaluates runtime optimization separately from correctness. It motivates measuring comparable workloads; its Python results do not establish Rust speedups or a preferred ownership style.
- [Evaluating AGENTS.md, v3](https://arxiv.org/html/2602.11988v3) found more inference cost without a general task-success gain from repository context in its Python evaluations. Its length/category ablations did not show that shortening instructions alone is the solution.

Our workflow inference is to require observed friction or measured cost before restructuring, and to test whether guidance helps on representative tasks. Post-merge invocation is an owner-selected policy, not a proven optimal schedule. Track accepted improvements, regressions, navigation failures and total diagnosis/verification/review cost instead of rewarding lines removed.
