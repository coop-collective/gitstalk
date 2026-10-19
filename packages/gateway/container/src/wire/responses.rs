//! Response bodies (plan §3). Field names follow the contract and, for checks, the harness's
//! `CIResult`.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::check::{
    CheckReport, FailingTest, ImportDepths, ReadMapsReport, SuiteNetwork, TestFileMap, TraceStatus,
    TreeManifest,
};
use crate::git::{CommitSha, RefUpdateOutcome};
use crate::integrate::{Composition, Landing, Squashed};
use crate::resolve::{ConflictHunk, Resolution};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MergeResult {
    Clean,
    Conflict,
}

/// `{result, sha?, files}`: the response of `/v1/revert`, and the core of a squash.
#[derive(Debug, Serialize)]
pub(crate) struct LandingBody {
    result: MergeResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<CommitSha>,
    files: Vec<String>,
}

impl From<Landing> for LandingBody {
    fn from(landing: Landing) -> Self {
        match landing {
            Landing::Clean { sha, files } => Self {
                result: MergeResult::Clean,
                sha: Some(sha),
                files,
            },
            Landing::Conflict { files } => Self {
                result: MergeResult::Conflict,
                sha: None,
                files,
            },
        }
    }
}

/// The tier that merged a clean squash.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ResolvedBy {
    Textual,
    Structural,
}

impl From<Resolution> for ResolvedBy {
    fn from(resolution: Resolution) -> Self {
        match resolution {
            Resolution::Textual => Self::Textual,
            Resolution::Structural => Self::Structural,
        }
    }
}

/// One conflict block: `onto` is the target's side, `change` the change's.
#[derive(Debug, Serialize)]
pub(crate) struct HunkBody {
    path: String,
    onto: String,
    change: String,
}

impl From<ConflictHunk> for HunkBody {
    fn from(hunk: ConflictHunk) -> Self {
        Self {
            path: hunk.path,
            onto: hunk.onto,
            change: hunk.change,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct SquashResponse {
    #[serde(flatten)]
    landing: LandingBody,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved: Option<ResolvedBy>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    hunks: Vec<HunkBody>,
    change_head: CommitSha,
    merge_base: CommitSha,
    #[serde(skip_serializing_if = "Option::is_none")]
    change_files: Option<Vec<String>>,
}

impl From<Squashed> for SquashResponse {
    fn from(squashed: Squashed) -> Self {
        let resolved = squashed
            .landing
            .sha()
            .map(|_| ResolvedBy::from(squashed.resolution));
        Self {
            landing: squashed.landing.into(),
            resolved,
            hunks: squashed.hunks.into_iter().map(HunkBody::from).collect(),
            change_head: squashed.change_head,
            merge_base: squashed.merge_base,
            change_files: squashed.change_files,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposedItemBody {
    task: String,
    #[serde(flatten)]
    squash: SquashResponse,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposeResponse {
    head: CommitSha,
    per_item: Vec<ComposedItemBody>,
}

impl From<Composition> for ComposeResponse {
    fn from(composition: Composition) -> Self {
        let per_item = composition
            .items
            .into_iter()
            .map(|item| ComposedItemBody {
                task: item.task,
                squash: item.squashed.into(),
            })
            .collect();
        Self {
            head: composition.head,
            per_item,
        }
    }
}

/// `{ok, actual}`: `actual` is the ref's value on the remote after the call (`null`: absent).
#[derive(Debug, Serialize)]
pub(crate) struct UpdateRefResponse {
    ok: bool,
    actual: Option<CommitSha>,
}

impl UpdateRefResponse {
    pub(crate) fn new(outcome: RefUpdateOutcome, new: CommitSha) -> Self {
        match outcome {
            RefUpdateOutcome::Updated => Self {
                ok: true,
                actual: Some(new),
            },
            RefUpdateOutcome::Stale { actual } => Self { ok: false, actual },
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct FailingTestBody {
    file: String,
    name: String,
    message: String,
}

impl From<FailingTest> for FailingTestBody {
    fn from(test: FailingTest) -> Self {
        Self {
            file: test.file,
            name: test.name,
            message: test.message,
        }
    }
}

/// The harness's `CIResult` fields, named as there (`output` is `output_excerpt`, per §3).
#[derive(Debug, Serialize)]
pub(crate) struct CheckResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<crate::check::skipper::TestSelection>,
    sha: CommitSha,
    green: bool,
    tests: usize,
    failures: usize,
    failing_tests: Vec<FailingTestBody>,
    failing_files: Option<Vec<String>>,
    passing_files: Vec<String>,
    read_set: Vec<String>,
    read_sets: BTreeMap<String, Vec<String>>,
    passing_read_sets: BTreeMap<String, Vec<String>>,
    /// True only when every passing test's read set was traced (`trace` with `all_read_sets`).
    read_sets_complete: bool,
    read_depths: BTreeMap<String, ImportDepths>,
    stack_files: Vec<String>,
    output_excerpt: String,
    suite_seconds: f64,
    ci_seconds: f64,
    timed_out: bool,
    /// The suite's network: `loopback` (a namespace with `lo` only) or `host`.
    network: SuiteNetwork,
    /// Present when the check was asked to trace.
    #[serde(skip_serializing_if = "Option::is_none")]
    read_maps: Option<ReadMapsBody>,
    /// Present when traced or asked for (`tree_manifest`).
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<TreeBody>,
}

/// `read_maps`: `status` is `traced` or `unavailable` (then `reason` says why and `files` is
/// empty: the check ran untraced).
#[derive(Debug, Serialize)]
pub(crate) struct ReadMapsBody {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    environment: Option<String>,
    files: Vec<TestFileMapBody>,
}

/// One test file's map; `traced: false` when its trace could not be read (the sets are then
/// empty and the file counts as unmapped).
#[derive(Debug, Serialize)]
pub(crate) struct TestFileMapBody {
    file: String,
    passed: bool,
    tests: usize,
    failures: usize,
    seconds: f64,
    timed_out: bool,
    traced: bool,
    reads: Vec<String>,
    probes: Vec<String>,
    dirs: Vec<String>,
    packages: Vec<String>,
    hashes: BTreeMap<String, String>,
}

/// The checked tree: `commit`, whether extra files were written over it, and every file's blob
/// id.
#[derive(Debug, Serialize)]
pub(crate) struct TreeBody {
    commit: CommitSha,
    extra_files: bool,
    blobs: BTreeMap<String, String>,
}

impl From<ReadMapsReport> for ReadMapsBody {
    fn from(report: ReadMapsReport) -> Self {
        let (status, reason) = match report.status {
            TraceStatus::Traced => ("traced", None),
            TraceStatus::Unavailable(reason) => ("unavailable", Some(reason)),
        };
        Self {
            status,
            reason,
            environment: report.environment,
            files: report.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TestFileMap> for TestFileMapBody {
    fn from(map: TestFileMap) -> Self {
        let traced = map.accesses.is_some();
        let accesses = map.accesses.unwrap_or_default();
        Self {
            file: map.file,
            passed: map.passed,
            tests: map.tests,
            failures: map.failures,
            seconds: map.seconds,
            timed_out: map.timed_out,
            traced,
            reads: accesses.reads.into_iter().collect(),
            probes: accesses.probes.into_iter().collect(),
            dirs: accesses.dirs.into_iter().collect(),
            packages: accesses.packages.into_iter().collect(),
            hashes: map.hashes,
        }
    }
}

impl From<TreeManifest> for TreeBody {
    fn from(tree: TreeManifest) -> Self {
        Self {
            commit: tree.commit,
            extra_files: tree.has_extra_files,
            blobs: tree.blobs,
        }
    }
}

impl From<CheckReport> for CheckResponse {
    fn from(report: CheckReport) -> Self {
        Self {
            selection: report.selection,
            sha: report.sha,
            green: report.green,
            tests: report.tests,
            failures: report.failures,
            failing_tests: report.failing_tests.into_iter().map(Into::into).collect(),
            failing_files: report.failing_files,
            passing_files: report.passing_files,
            read_set: report.read_set,
            read_sets: report.read_sets,
            passing_read_sets: report.passing_read_sets,
            read_sets_complete: report.read_sets_complete,
            read_depths: report.read_depths,
            stack_files: report.stack_files,
            output_excerpt: report.output_excerpt,
            suite_seconds: report.suite_seconds,
            ci_seconds: report.ci_seconds,
            timed_out: report.timed_out,
            network: report.network,
            read_maps: report.read_maps.map(Into::into),
            tree: report.tree.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    pub(crate) ok: bool,
    pub(crate) git: Option<String>,
    pub(crate) node: Option<String>,
    /// The network suites get on this instance.
    pub(crate) network: SuiteNetwork,
    /// Whether traced checks can trace here (they run untraced otherwise).
    pub(crate) tracing: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct VersionResponse {
    pub(crate) version: &'static str,
    /// The wire contract's version ([`crate::app::API_VERSION`]); callers compare it, not `version`.
    pub(crate) api_version: u32,
    pub(crate) git_sha: String,
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

    use super::*;

    #[test]
    fn a_clean_squash_serialises_flat() {
        let sha = CommitSha::parse(&"c".repeat(40)).unwrap();
        let response = SquashResponse::from(Squashed {
            landing: Landing::Clean {
                sha: sha.clone(),
                files: vec!["a.ts".into()],
            },
            resolution: Resolution::Structural,
            hunks: Vec::new(),
            change_head: sha.clone(),
            merge_base: sha,
            change_files: None,
        });

        let json = serde_json::to_value(response).unwrap();

        assert_eq!(json["result"], "clean");
        assert_eq!(json["files"][0], "a.ts");
        assert_eq!(json["resolved"], "structural");
        assert!(json.get("change_files").is_none());
        assert!(json.get("hunks").is_none());
    }

    #[test]
    fn a_conflicted_squash_carries_its_hunks_and_no_tier() {
        let sha = CommitSha::parse(&"c".repeat(40)).unwrap();
        let response = SquashResponse::from(Squashed {
            landing: Landing::Conflict {
                files: vec!["a.ts".into()],
            },
            resolution: Resolution::Textual,
            hunks: vec![ConflictHunk {
                path: "a.ts".into(),
                onto: "x\n".into(),
                change: "y\n".into(),
            }],
            change_head: sha.clone(),
            merge_base: sha,
            change_files: None,
        });

        let json = serde_json::to_value(response).unwrap();

        assert!(json.get("resolved").is_none());
        assert_eq!(
            json["hunks"],
            serde_json::json!([{"path": "a.ts", "onto": "x\n", "change": "y\n"}])
        );
    }

    #[test]
    fn a_conflict_has_no_sha() {
        let body = LandingBody::from(Landing::Conflict {
            files: vec!["x".into()],
        });

        let json = serde_json::to_value(body).unwrap();

        assert_eq!(
            json,
            serde_json::json!({"result": "conflict", "files": ["x"]})
        );
    }

    #[test]
    fn a_stale_lease_reports_the_actual_value() {
        let new = CommitSha::parse(&"a".repeat(40)).unwrap();

        let json = serde_json::to_value(UpdateRefResponse::new(
            RefUpdateOutcome::Stale { actual: None },
            new,
        ))
        .unwrap();

        assert_eq!(json, serde_json::json!({"ok": false, "actual": null}));
    }
}
