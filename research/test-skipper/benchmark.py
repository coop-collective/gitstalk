#!/usr/bin/env python3
"""Paired local runner pipeline replay; no agents, external services, sleeps or fake latency."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "fixture-token-not-a-secret"
GIT_ENV = {
    **os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "init.defaultBranch", "GIT_CONFIG_VALUE_0": "main",
    "GIT_AUTHOR_NAME": "benchmark", "GIT_AUTHOR_EMAIL": "benchmark@example.invalid",
    "GIT_COMMITTER_NAME": "benchmark", "GIT_COMMITTER_EMAIL": "benchmark@example.invalid",
    "GIT_AUTHOR_DATE": "2026-10-19T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-19T00:00:00Z",
}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], env=GIT_ENV,
                                   stderr=subprocess.PIPE, text=True).strip()


def commit(root, files, message):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", message)
    return git(root, "rev-parse", "HEAD")


def modular_fixture(root, iterations):
    root.mkdir()
    git(root, "init", "--quiet", "-b", "main")
    files = {"package.json": '{"type":"module"}\n'}
    source = ("export function checksum(seed) {\n  let value = seed;\n"
              f"  for (let i = 0; i < {iterations}; i++) value = (value * 48271) % 2147483647;\n"
              "  return value;\n}\n")
    for index in range(8):
        files[f"src/module{index}.mjs"] = source
        files[f"src/barrel{index}.mjs"] = f"export {{ checksum }} from './module{index}.mjs';\n"
        expected = pow(48271, iterations, 2147483647) * (index + 1) % 2147483647
        files[f"test/module{index}.test.mjs"] = (
            "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
            f"import {{ checksum }} from '../src/barrel{index}.mjs';\n"
            f"test('checksum {index}', () => assert.equal(checksum({index + 1}), {expected}));\n"
        )
    base = commit(root, files, "baseline")
    changes = []
    for index in range(6):
        branch = f"ref/change{index}"
        git(root, "checkout", "--quiet", "-b", branch, base)
        # Equivalent arithmetic rewrite, exercised by a deterministic numerical assertion.
        commit(root, {f"src/module{index}.mjs": source.replace("value * 48271", "48271 * value")}, branch)
        changes.append({"ref": branch, "green": True})
    git(root, "checkout", "--quiet", "-b", "ref/broken", base)
    commit(root, {"src/module7.mjs": source.replace("return value;", "return value + 1;")}, "regression")
    changes.append({"ref": "ref/broken", "green": False})
    git(root, "checkout", "--quiet", "-b", "ref/config", base)
    commit(root, {"package.json": '{"type":"module","private":true}\n'}, "config fallback")
    changes.append({"ref": "ref/config", "green": True})
    return {"repo": root, "base": base, "changes": changes}


def arena_fixture(root):
    bundle = ROOT / "packages/gateway/container/tests/fixtures/arena.bundle"
    subprocess.run(["git", "clone", "--quiet", "--bare", str(bundle), str(root)], check=True, env=GIT_ENV)
    return {"repo": root, "base": git(root, "rev-parse", "main"), "changes": [
        {"ref": f"ref/{task}", "green": True, "conflict": task == "t040"}
        for task in ["t001", "t002", "t005", "t040"]
    ]}


@contextlib.contextmanager
def runner(binary, directory):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = {**os.environ, "WORK_DIR": str(directory / "work"), "PORT": str(port),
           "REMOTE_SCHEMES": "https,file", "SUITE_NETWORK": "host", "RUST_LOG": "info",
           "GITSTALK_SKIPPER_PATH": str(ROOT / "packages/test-skipper/dist/cli.mjs")}
    process = subprocess.Popen([str(binary)], env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    try:
        # Startup is measured and readiness comes from the process, not a fixed delay.
        for line in process.stdout:
            if '"message":"listening"' in line:
                break
        else:
            raise RuntimeError(f"runner exited before readiness: {process.poll()}")
        yield f"http://127.0.0.1:{port}"
    finally:
        process.terminate()
        process.communicate(timeout=15)
        if process.returncode not in (0, -15):
            raise RuntimeError(f"runner exited {process.returncode}")


def post(url, operation, body):
    request = urllib.request.Request(url + "/v1/" + operation, json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def replay(binary, fixture, enabled, directory, schedule):
    trunk = directory / "remote.git"
    git(directory, "init", "--bare", "--quiet", str(trunk))
    git(trunk, "fetch", "--quiet", str(fixture["repo"]), f'{fixture["base"]}:refs/heads/main')
    remote = {"repo": trunk.as_uri(), "token": TOKEN}
    observations = []
    conflicts = []
    operations = []
    started = time.perf_counter()
    with runner(binary, directory) as url:
        def call(operation, body):
            before = time.perf_counter()
            result = post(url, operation, body)
            operations.append({"operation": operation, "seconds": time.perf_counter() - before})
            return result

        def check(sha, phase, expected):
            body = {**remote, "sha": sha}
            if enabled and phase in ("cold", "preland"):
                body["test_skipper"] = True
            before = time.perf_counter()
            result = call("check", body)
            assert result["green"] == expected, (phase, result)
            assert not result["timed_out"], result
            if phase in ("validation", "final"):
                assert "selection" not in result, result
            observations.append({
                "phase": phase, "wall_seconds": time.perf_counter() - before,
                "ci_seconds": result["ci_seconds"], "suite_seconds": result["suite_seconds"],
                "tests": result["tests"], "green": result["green"],
                "failing_files": result["failing_files"], "passing_files": result["passing_files"],
                "selection": result.get("selection"),
            })
            return result

        head = fixture["base"]
        check(head, "cold", True)
        landed = 0
        for change in fixture["changes"]:
            result = call("squash", {**remote, "onto": head,
                "change": {"repo": fixture["repo"].as_uri(), "token": TOKEN,
                           "ref": "refs/heads/" + change["ref"], "base": fixture["base"]},
                "message": f'Benchmark {change["ref"]}', "structural_merge": False,
                "union_paths": ["CHANGELOG.md"]})
            if change.get("conflict", False):
                assert result["result"] == "conflict", result
                conflicts.append({"ref": change["ref"], "files": result["files"]})
                continue
            assert result["result"] == "clean", result
            verdict = check(result["sha"], "preland", change["green"])
            if not change["green"]:
                continue
            updated = call("update-ref", {**remote, "ref": "refs/heads/main", "old": head,
                                          "new": result["sha"]})
            assert updated["ok"], updated
            head = result["sha"]
            landed += 1
            if schedule == "batch-full" and landed % 3 == 0:
                check(head, "validation", True)
            elif schedule == "same-head-reuse" and verdict.get("selection", {}).get("mode") == "selected":
                check(head, "validation", True)
        check(head, "final", True)
        elapsed = time.perf_counter() - started
    return {"enabled": enabled, "seconds": elapsed, "checks": observations,
            "operations": operations, "tree": git(trunk, "rev-parse", head + "^{tree}"),
            "landed": landed, "conflicts": conflicts}


def assert_equivalent(off, on):
    assert off["tree"] == on["tree"]
    assert off["landed"] == on["landed"]
    assert off["conflicts"] == on["conflicts"]
    comparable = lambda arm: [c for c in arm["checks"] if c["phase"] != "validation"]
    assert len(comparable(off)) == len(comparable(on))
    for full, selected in zip(comparable(off), comparable(on)):
        for field in ("phase", "green", "failing_files"):
            assert full[field] == selected[field], (field, full, selected)
        if selected["selection"] and selected["selection"]["mode"] == "selected":
            selected_files = set(selected["selection"]["selected_files"])
            skipped_files = set(selected["selection"]["skipped_files"])
            assert selected_files and skipped_files and not selected_files & skipped_files
            assert selected_files | skipped_files == set(full["passing_files"] + full["failing_files"])
        else:
            assert selected["tests"] == full["tests"]


def summarize(pairs):
    summary = {}
    for workload in sorted({p["workload"] for p in pairs}):
        matching = [p for p in pairs if p["workload"] == workload]
        off = [p["off"]["seconds"] for p in matching]
        on = [p["on"]["seconds"] for p in matching]
        ratios = [p["off"]["seconds"] / p["on"]["seconds"] for p in matching]
        sample = matching[0]
        summary[workload] = {
            "off_median_seconds": statistics.median(off), "on_median_seconds": statistics.median(on),
            "paired_speedup_median": statistics.median(ratios),
            "paired_speedup_range": [min(ratios), max(ratios)],
            "off_tests": sum(c["tests"] for c in sample["off"]["checks"]),
            "on_tests": sum(c["tests"] for c in sample["on"]["checks"]),
            "selected_checks": sum(c["selection"] is not None and c["selection"]["mode"] == "selected"
                                   for c in sample["on"]["checks"]),
            "off_checks": len(sample["off"]["checks"]),
            "on_checks": len(sample["on"]["checks"]),
            "landed": sample["on"]["landed"], "conflicts": sample["on"]["conflicts"],
        }
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=10_000_000)
    args = parser.parse_args()
    pairs = []
    with tempfile.TemporaryDirectory(prefix="skipper-benchmark-") as scratch:
        root = Path(scratch)
        fixtures = {
            "modular-cpu": modular_fixture(root / "cpu", args.iterations),
            "modular-tiny": modular_fixture(root / "tiny", 100),
            "existing-arena": arena_fixture(root / "arena.git"),
        }
        workloads = [(name, fixture, "batch-full") for name, fixture in fixtures.items()]
        workloads.append(("modular-cpu-reuse", fixtures["modular-cpu"], "same-head-reuse"))
        for repeat in range(args.repeats):
            for name, fixture, schedule in workloads:
                pair = {"workload": name, "schedule": schedule, "repeat": repeat, "order": []}
                for enabled in ([False, True] if repeat % 2 == 0 else [True, False]):
                    arm = "on" if enabled else "off"
                    directory = root / f"{repeat}-{name}-{arm}"
                    directory.mkdir()
                    pair[arm] = replay(args.runner.resolve(), fixture, enabled, directory, schedule)
                    pair["order"].append(arm)
                    print(json.dumps({"repeat": repeat, "workload": name, "arm": arm,
                                      "seconds": pair[arm]["seconds"]}), flush=True)
                assert_equivalent(pair["off"], pair["on"])
                pairs.append(pair)
    result = {
        "schema": 1, "method": "local real-runner HTTP replay, cold per arm; batch-full or same-head-reuse validation, always final full",
        "scope": "runner startup, HTTP, Git fetch/squash/checkout/ref updates, analysis, suites, full validation; excludes agents and cloud gateway",
        "platform": platform.platform(), "cpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count(),
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "runner_sha256": hashlib.sha256(args.runner.read_bytes()).hexdigest(),
        "analyzer_sha256": hashlib.sha256((ROOT / "packages/test-skipper/dist/cli.mjs").read_bytes()).hexdigest(),
        "iterations": args.iterations, "repeats": args.repeats, "summary": summarize(pairs), "pairs": pairs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
