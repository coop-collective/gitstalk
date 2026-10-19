# Evidence and limits

Reviewed 2026-10-19. These studies inform the workflow; they do not establish TypeScript-specific style rules.

- [SWE-agent, section 5.1](https://arxiv.org/html/2405.15793v3): search presentation, bounded file views and edit feedback affected the evaluated agents. Its 100-line viewer is a harness experiment, not a function/file-size prescription. Improve navigation before restructuring source for a display window.
- [Agentless, sections 3.1 and 5.2](https://arxiv.org/html/2407.01489v2): hierarchical localization and patch validation support finding the relevant implementation before editing it. Generated reproduction tests can be wrong; establish that a test detects the intended defect. These Python issue-resolution experiments do not prove that adding modules or helpers improves modern agents.
- [Evaluating AGENTS.md, v3](https://arxiv.org/html/2602.11988v3): repository context increased average inference cost without a general success improvement in the evaluated Python tasks. Length and instruction-category ablations did not establish that shorter instructions alone improve results. Optional maintenance skills and post-merge scheduling were not tested.

Our inference is to retain non-obvious constraints, retrieve context selectively and justify changes against observed failures. Explicit post-merge use is the owner's workflow choice. Compare representative tasks with/without these skills before claiming savings; include diagnosis, verification, review and regression costs.
