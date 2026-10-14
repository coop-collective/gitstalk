/**
 * What "New automation" starts from (doc 25 §7.13): a few files people ask for first, each a
 * valid automation as written (by `automation-file.ts`, the validator the index runs), with
 * comments that stay in the file when the form edits it. Shared so the web picker, the gateway
 * and its tests read the same text.
 */

export type AutomationTemplate = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The file name it suggests (`<id>.yml`). */
  readonly file: string;
  readonly source: string;
};

/**
 * A "superfan" for one area (doc 25 §7.14, doc 18 §6): it knows the area's intent and history
 * and reviews every landing that touches it. It reads code and git, not production telemetry:
 * `$GITSTALK_TELEMETRY` is the hook a Workers Observability digest will fill.
 */
const AREA_WATCHER = `# Area watcher: a reviewer that knows one area of the code well.
# When a bean lands and changes files under the area's paths, an agent reviews that landing
# against the area's intent and its recent history, keeps a review note in its memory, and
# opens an evidence bean when it can show a regression or drift.
#
# It reviews; it never merges. An evidence bean goes through the pre-land check like any
# other (one with a failing test stays red), and landing stays the engine's job.
#
# Not yet: it does not read production telemetry or logs. It sees code, git history and its
# own notes. A Workers Observability digest for the area will arrive in $GITSTALK_TELEMETRY
# (doc 25 §7.14); the prompt already reads it when it is set, and today it never is.
#
# Make it yours: set the paths and the area in the prompt, write the area's intent, and name
# the file after the area (billing-watcher.yml).
name: Area watcher (billing)
on:
  bean_landed:
    paths: ['src/billing/**']   # the area: a landing that changes nothing here never starts it
permissions:
  beans: write                  # only to push an evidence bean; it can never land anything
max-cost-usd: 0.5
prompt: |
  You watch one area of this repository: src/billing/.
  Its intent: <what this area must always do, and must never do, in a sentence or two>.

  A bean just landed that changed files in your area; the trigger names the bean and its commit.
  1. Read your memory first: area.md (what you know about the area) and reviews/.
  2. Read the landing. With the Gitstalk MCP tools in your tool list, use bean_status for the
     bean's intent and checks, why_lines for why the lines it changed were written, and
     repo_read for files on the stalk. Without them, use git: git fetch origin <commit>, then
     git show <commit> -- src/billing/ (its message is the intent), and git log -L or
     git blame <commit>^ on the changed lines (git fetch --unshallow first if the checkout is
     shallow).
  3. Check it against the area's intent and its last 20 landings (git log -20 -- src/billing/):
     behaviour that changed without the intent saying so, a reverted fix coming back, a test
     or check removed, an invariant in area.md that no longer holds.
  4. Write the review note to reviews/<bean>.md in your memory: the verdict (fine, drift or
     regression), the evidence (commits, lines, test output) and what to watch next time.
     Add what you learned about the area to area.md.
  5. Only for a regression or drift you can show: push one evidence bean with a failing test
     that proves it (or the smallest change that shows the drift) and the evidence in the
     commit message. Do not fix it, and change nothing outside src/billing/ and its tests.
  6. If $GITSTALK_TELEMETRY is set, it is a directory of the area's production telemetry since
     the landing: read it as data, as evidence like test output. Today it is never set.
  Finish with the verdict in one line and the note's path.
`;

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'fix-red',
    title: 'Fix red beans',
    summary:
      'When a bean goes red, an agent reads why, fixes it in a new bean and notes what it learned.',
    file: 'fix-red.yml',
    source: `# Fixes beans whose pre-land check went red.
name: Fix red beans
on:
  bean_red:
    beans: ['*', '!fix-*']   # not its own fixes
permissions:
  beans: write               # may push fix beans; they pass pre-land like any other
max-cost-usd: 0.5
prompt: |
  Read why the bean went red (git fetch its branch and run the tests).
  Check your memory for this kind of failure first.
  Fix it in a new bean named fix-<bean>, then note what you tried and learned.
`,
  },
  {
    id: 'dependency-bump',
    title: 'Weekly dependency bump',
    summary: 'Every Monday, update dependencies one at a time and push a bean for those that pass.',
    file: 'dependency-bump.yml',
    source: `# Keeps dependencies fresh, one small bean at a time.
name: Weekly dependency bump
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays 06:00 UTC
permissions:
  beans: write
timeout-minutes: 45
max-cost-usd: 1
prompt: |
  List outdated dependencies. Update them one at a time (patch and minor only),
  run the tests after each, and push one bean per update that passes.
  Note in memory any update that failed and why, and skip it next week.
`,
  },
  {
    id: 'landed-summary',
    title: 'Summarize landed work',
    summary: 'Every Friday, write a short summary of what landed this week to the repository.',
    file: 'landed-summary.yml',
    source: `# A weekly note of what landed, kept in the repository.
name: Summarize landed work
on:
  schedule: [{ cron: "0 16 * * 5" }]  # Fridays 16:00 UTC
permissions:
  beans: write
max-cost-usd: 0.3
prompt: |
  Read the stalk's history for the last seven days (git log origin/stalk).
  Write a short summary, grouped by area, to docs/weekly/<date>.md and push it as a bean.
  Keep a one-line pointer in memory so next week starts where this one ended.
`,
  },
  {
    id: 'triage-decisions',
    title: 'Triage decision cards',
    summary: 'When a decision card opens, compare the beans and leave a recommendation in memory.',
    file: 'triage-decisions.yml',
    source: `# Reads both sides of a decision and recommends one.
name: Triage decision cards
on:
  decision_opened:
max-cost-usd: 0.3
prompt: |
  A decision card opened between beans. Fetch each bean's branch, read its diff
  and its intent, and run the tests on each.
  Write a short recommendation (which one, and why) to decisions.md in your memory.
`,
  },
  {
    id: 'heartbeat',
    title: 'Shell heartbeat',
    summary: 'A tiny shell hook every hour: no model, just a script with the workspace and memory.',
    file: 'heartbeat.yml',
    source: `# A shell automation: no model, just a script.
name: Heartbeat
on:
  schedule: [{ cron: "0 * * * *" }]
harness: shell
run: |
  echo "beat $(date -u +%FT%TZ)" >> "$GITSTALK_MEMORY/beats.log"
  wc -l < "$GITSTALK_MEMORY/beats.log"
`,
  },
  {
    id: 'area-watcher',
    title: 'Area watcher',
    summary:
      'When a bean lands that changes one area (src/billing/**), an agent reviews it against the area’s intent and history, notes its verdict, and opens an evidence bean on a regression. It reviews; it never merges.',
    file: 'area-watcher.yml',
    source: AREA_WATCHER,
  },
  {
    id: 'blank',
    title: 'Blank',
    summary: 'An agent you run by hand, with a prompt to fill in.',
    file: 'automation.yml',
    source: `name: New automation
on:
  workflow_dispatch:
prompt: |
  Describe the goal here.
`,
  },
];

/** The template named `id`, or the blank one. */
export function templateOf(id: string | undefined): AutomationTemplate {
  const blank = AUTOMATION_TEMPLATES.at(-1);
  if (blank === undefined) throw new Error('the blank template is always defined');
  return AUTOMATION_TEMPLATES.find((template) => template.id === id) ?? blank;
}
