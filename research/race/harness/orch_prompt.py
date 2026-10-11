"""The orchestrated race's prompt and backlog: one text for both arms except the forge section."""
from __future__ import annotations

import json
import os
import subprocess

from .arena import Task

WORKTREES = ".worktrees"


def backlog(tasks: list[Task], test_hint: str) -> str:
    """``BACKLOG.md``: every task's id, title, description and acceptance tests (full content)."""
    out = ["# Backlog", "",
           f"{len(tasks)} tasks for this repository, in priority order. Each one is a change someone asked for. Every "
           "task comes with acceptance tests: add them to the task's change exactly as given (same path, same "
           "content) and make them pass without breaking the rest of the suite.", "",
           f"Running tests: {test_hint}", ""]
    for t in tasks:
        out += [f"## {t.id}: {t.title}", "", t.prompt.strip(), "", "Acceptance tests:", ""]
        for path, content in sorted(t.acceptance_tests.items()):
            fence = "````" if "```" in content else "```"
            out += [f"`{path}`", "", f"{fence}js", content.rstrip("\n"), fence, ""]
    return "\n".join(out) + "\n"


# How the lead waits for its workers. The baselines' sentence (``prompt``) predates the check of how ``claude -p``
# treats background agents; plugin-v2 replaces it with what Claude Code 2.1.293 does (verified 2026-10-08 with a
# background worker and ``-p``: the process stays alive after the lead ends its turn, and each worker's completion
# starts the lead's next turn with a task notification). The v1 sentence ("don't end your turn while a worker is
# running") is what made the plugin-v1 lead run ``sleep 420``.
SESSION_PROMPT = ("- Your session ends as soon as you end your turn, and that stops any worker still running. After "
                  "starting workers in the background, keep waiting for their notifications and following your changes "
                  "on the forge; don't end your turn while a worker is running or a change is not yet integrated.")
SESSION_NOTIFIED = ("- Workers you start in the background keep running when you end your turn: Claude Code starts your "
                    "next turn with a notification each time one finishes. So after starting workers, end your turn "
                    "(never `sleep` or poll to wait for them) and act on each notification: read the report, start the "
                    "next worker if work remains, end your turn again. Your session ends when you end your turn with no "
                    "worker running: do that only when every change is integrated or you judge the rest impossible.")


def shared(n_tasks: int, subagents: int, line: str, test_hint: str, wall_minutes: float,
           session: str = SESSION_PROMPT) -> str:
    return f"""You are the lead engineer on this repository. `BACKLOG.md` in this directory lists {n_tasks} tasks, each \
with acceptance tests. Ship as many of them as you can: a task is done when its change, with its acceptance tests, \
is integrated by the forge (described below). You decide how to split, order and stack the work.

How to work:
- Work in parallel: give each subagent its own branch in its own `git worktree` (create them under \
`{WORKTREES}/`, for example `git worktree add {WORKTREES}/<branch> -b <branch> origin/{line}`). You may run up to \
{subagents} `worker` subagents at the same time (several Agent calls in one message, or in the background); never \
more than {subagents} at once.
- A change for a task adds that task's acceptance tests exactly as given in `BACKLOG.md` and makes them pass without \
breaking other tests. {test_hint} The dependencies are already installed in a `node_modules` directory above \
this repository, so `require` resolves them from every worktree even though no worktree has its own `node_modules`: \
never install packages.
- Give each worker the absolute path of its worktree. A worker's shell starts in this directory for every command, so \
it uses `git -C <worktree> ...` for git and runs the tests as `cd <worktree> && node ...` in the same command. Don't \
change the given acceptance tests; you may update existing tests whose \
expectations your change intentionally alters.
- Put a `Task: <id>` line (for example `Task: t004`) at the end of the commit message of each task's change. One task \
per change unless you deliberately combine them.
- Integration happens only through the forge as described below; never push to `{line}` yourself.
- `BACKLOG.md` and `{WORKTREES}/` are local notes and scratch space: never commit them.
{session}
- You have about {wall_minutes:.0f} minutes. When every task is integrated (or you judge a task impossible), stop and \
reply with one line per task: its id, integrated or not, and why not.
"""


def github_section(repo_url: str) -> str:
    return f"""The forge: GitHub, repository {repo_url} (this directory is a clone; `origin` points to it). `main` is \
protected by a merge queue: changes reach `main` only through pull requests that the queue merges. The required \
check `suite` runs the test suite on each pull request and again on each merge group.
- Submit a change: push its branch (`git push -u origin <branch>`), open a pull request against `main` \
(`gh pr create --base main --head <branch> --title "<title>" --body "Task: <id>"`), then add it to the merge queue \
with `gh pr merge <number> --auto` (it joins the queue once its own check is green).
- Follow it with `gh pr view <number> --json state,mergeStateStatus,statusCheckRollup` and `gh pr checks <number>`; \
`gh run view <run-id> --log-failed` shows a failed check's output. A pull request leaves the queue without merging when \
its merge group fails or conflicts: rebase it onto the new `origin/main` (`git fetch origin && git rebase \
origin/main`), fix it, `git push --force-with-lease`, and enqueue it again.
- It is done when the pull request is merged (state MERGED).
"""


def beanstalk_section(repo_url: str) -> str:
    return f"""The forge: Beanstalk, repository {repo_url} (this directory is a clone; `origin` points to it). It has \
two lines: `sprout` (changes land there after a check of the change merged onto it) and `stalk` (the stable line, \
which follows `sprout` once CI validates it). Branch your work from `origin/sprout`.
- Submit a change: push its branch as a bean, `git push -o wait origin HEAD:refs/heads/bean/<name>` (a bean name is \
letters, digits, `.`, `_` or `-`, up to 32). The push waits for the verdict and prints it (`remote: gitstalk:` lines).
- LANDED means it is on `sprout`. RED or CONFLICT means it was not landed: the push printed the failing tests or the \
conflicting hunks and the landed changes it met. Fix it on the same branch (`git fetch origin sprout && git rebase \
origin/sprout`, fix, commit) and push again to the same bean with `git push -f -o wait origin HEAD:refs/heads/bean/<name>`.
- `git fetch origin '+refs/beans/*:refs/beans/*'` then `git cat-file -p refs/beans/<name>/status` shows a bean's \
current state. Pushing to `sprout`, `stalk` or `main` is refused.
- It is done when the push says LANDED.
"""


# --guidance plugin (Beanstalk arm only): the forge section is replaced by the Beanstalk plugin's skill, as an agent with
# the plugin installed would read it, and the lead's session sentence by SESSION_NOTIFIED (plugin-v2). The baseline
# pairs use ``prompt`` with ``guidance="prompt"`` and never see this text.
#
# Versions: plugin-v1 = plugin 0.5.0 (push plainly, read status refs between steps, poll every 30-60 s at the end;
# the shared session sentence). plugin-v2 = plugin 0.6.0 (never sleep-poll: one blocking ``refs/wait/any`` push woken
# by the verdict when out of work; the lead ends its turn and acts on worker notifications).
PLUGIN_GUIDANCE_VERSION = "plugin-v2"
# The plugin lives in its own repository (coop-collective/gitstalk-plugin) since 2026-10-11. GITSTALK_PLUGIN_DIR names a
# checkout; otherwise a sibling clone next to this repository (../gitstalk-plugin), else research/race/.plugin, which
# ensure_plugin() clones on demand (git-ignored).
PLUGIN_REPO_URL = "https://github.com/coop-collective/gitstalk-plugin.git"
_RACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SIBLING = os.path.normpath(os.path.join(_RACE, "..", "..", "..", "gitstalk-plugin"))
_LOCAL = os.path.join(_RACE, ".plugin")


def plugin_dir() -> str:
    """Where the plugin checkout is read from (it may not exist yet; see ``ensure_plugin``)."""
    env = os.environ.get("GITSTALK_PLUGIN_DIR")
    if env:
        return os.path.abspath(env)
    return _SIBLING if os.path.isdir(_SIBLING) else _LOCAL


def ensure_plugin() -> str:
    """The plugin checkout, cloned into research/race/.plugin when there is none (needs the network once)."""
    path = plugin_dir()
    if not os.path.isfile(os.path.join(path, ".claude-plugin", "plugin.json")):
        if path != _LOCAL:
            raise FileNotFoundError(f"no gitstalk plugin checkout at {path} (GITSTALK_PLUGIN_DIR)")
        subprocess.run(["git", "clone", "-q", "--depth", "1", PLUGIN_REPO_URL, path], check=True)
    return path


def skill_path() -> str:
    return os.path.join(plugin_dir(), "skills", "gitstalk", "SKILL.md")


def plugin_skill() -> str:
    """The Beanstalk plugin's skill body (frontmatter removed), with its references named by absolute path."""
    path = skill_path()
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if text.startswith("---"):
        text = text.split("---", 2)[2]
    refs = os.path.join(os.path.dirname(path), "references")
    return text.replace("`references/", f"`{refs}/").strip() + "\n"


def beanstalk_plugin_section(repo_url: str) -> str:
    return f"""The forge: Beanstalk, repository {repo_url} (this directory is a clone; `origin` points to it; git is \
already connected). The Beanstalk plugin is installed: its skill follows and is how you and your workers submit and \
follow changes. The beanstalk MCP server is not connected in this session, so use git only. A task is done when its \
bean has landed on `sprout`.

<beanstalk-skill>
{plugin_skill()}</beanstalk-skill>
"""


def worker_prompt(guidance: str = "prompt") -> str:
    if guidance != "plugin":
        return WORKER_PROMPT
    return (WORKER_PROMPT + " The repository's forge is Beanstalk and the Beanstalk plugin is installed; its skill "
            "follows (the MCP server is not connected: use git only).\n\n<beanstalk-skill>\n" + plugin_skill()
            + "</beanstalk-skill>\n")


def prompt(arm: str, *, repo_url: str, n_tasks: int, subagents: int, test_hint: str, wall_minutes: float,
           guidance: str = "prompt") -> str:
    line = "main" if arm == "github" else "sprout"
    session = SESSION_PROMPT
    if arm == "github":
        section = github_section(repo_url)
    elif guidance == "plugin":
        section, session = beanstalk_plugin_section(repo_url), SESSION_NOTIFIED
    else:
        section = beanstalk_section(repo_url)
    return shared(n_tasks, subagents, line, test_hint, wall_minutes, session) + "\n" + section


def plugin_version() -> str:
    """The Beanstalk plugin's version (``.claude-plugin/plugin.json``)."""
    with open(os.path.join(plugin_dir(), ".claude-plugin", "plugin.json"), encoding="utf-8") as fh:
        return json.load(fh)["version"]


def continuation(guidance: str = "prompt", undelivered: set[str] | frozenset[str] = frozenset()) -> str:
    """The resume prompt. Since 2026-10-08 (both arms) it names the tasks the harness does not find delivered: their
    acceptance tests are not on the line (``orchestrated.tests_not_on_line``)."""
    text = CONTINUE_NOTIFIED if guidance == "plugin" else CONTINUE
    if not undelivered:
        return text
    return (text + " Not delivered on the line yet (its acceptance tests are not there): "
            + ", ".join(sorted(undelivered)) + ".")


CONTINUE = ("Continue. Your session ended while work remained. Check the state of every task in BACKLOG.md (your "
            "worktrees, branches and the forge), restart what was stopped, and carry on until every task is integrated "
            "or you judge it impossible. Keep waiting for your workers' notifications; don't end your turn while a "
            "worker is running or a change is not yet integrated.")

CONTINUE_NOTIFIED = ("Continue. Your session ended while work remained. Check the state of every task in BACKLOG.md "
                     "(your worktrees, branches and the forge), restart what was stopped in background workers, then end "
                     "your turn and act on each worker's notification as before; carry on until every task is "
                     "integrated or you judge it impossible.")

WORKER_PROMPT = ("You are a software engineer working on one change in your own git worktree, whose absolute path "
                 "the lead gives you. Each shell command starts in the lead's directory, so use `git -C <worktree>` "
                 "for git and `cd <worktree> && <command>` for anything else, in one command. The dependencies are "
                 "installed above the repository and resolve from your worktree: never install packages. Use the "
                 "Read, Edit and Write tools with absolute paths inside your worktree. Do exactly what the lead asks, "
                 "run the tests, commit on your branch, and report briefly what you did, the branch and commit, and "
                 "the test result. Stay inside your worktree.")
