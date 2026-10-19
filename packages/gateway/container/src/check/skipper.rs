//! Optional pre-land test selection. Only full green runs seed this process-local cache;
//! eviction, restart, unsupported inputs or a changed recipe run the full suite.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::{
    CheckReport, CheckRequest, RunContext, SuiteCommand, SuiteLimits, TestScope, TraceMode,
};
use crate::error::Result;
use crate::git::CommitSha;
use crate::process::{self, ChildEnv, ProcessSpec};

/// A wire boolean with an explicit internal opt-in state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "bool")]
pub(crate) enum SkipperMode {
    #[default]
    Off,
    On,
}

impl From<bool> for SkipperMode {
    fn from(enabled: bool) -> Self {
        if enabled { Self::On } else { Self::Off }
    }
}

/// The optimization wraps the ordinary runner path, keeping its sandbox and report semantics.
pub(super) async fn run(context: &RunContext<'_>) -> Result<CheckReport> {
    let request = context.request;
    let before = if eligible_recipe(request) {
        analyze(context.checkout, context.workspace.suite_env()).await
    } else {
        None
    };
    let cache = &context.workspace.skipper;
    let selection = cache.plan(request, before.as_ref()).await;
    let command = selection.command(&request.command);
    let report = super::run_command(context, &command).await?;
    let after = if before.as_ref().is_some_and(Snapshot::eligible) {
        analyze(context.checkout, context.workspace.suite_env()).await
    } else {
        None
    };
    Ok(cache
        .finish(FinishedRun {
            request,
            before: before.as_ref(),
            after: after.as_ref(),
            report,
            selection,
        })
        .await)
}

fn eligible_recipe(request: &CheckRequest) -> bool {
    request.command == SuiteCommand::node_test()
        && request.extra_files.is_empty()
        && request.env == super::SuiteEnv::default()
        && request.deps.is_none()
        && request.scope == TestScope::Suite
        && request.trace == TraceMode::Off
}

const MAX_BASELINES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct Snapshot {
    files: BTreeMap<String, String>,
    tests: BTreeMap<String, Vec<String>>,
    environment: String,
    reason: Option<String>,
}

impl Snapshot {
    pub(crate) fn eligible(&self) -> bool {
        self.reason.is_none()
    }
}

#[derive(Debug, Clone)]
struct Baseline {
    sha: CommitSha,
    snapshot: Snapshot,
    limits: SuiteLimits,
}

#[derive(Debug, Default)]
pub(crate) struct SkipperCache(Mutex<BTreeMap<String, Baseline>>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SelectionMode {
    Full,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TestSelection {
    mode: SelectionMode,
    reason: String,
    baseline_sha: Option<CommitSha>,
    selected_files: Vec<String>,
    skipped_files: Vec<String>,
}

impl TestSelection {
    pub(crate) fn traced() -> Self {
        Self::full("traced-check-run-full", None)
    }

    fn full(reason: &str, snapshot: Option<&Snapshot>) -> Self {
        Self {
            mode: SelectionMode::Full,
            reason: reason.to_owned(),
            baseline_sha: None,
            selected_files: snapshot.map_or_else(Vec::new, |s| s.tests.keys().cloned().collect()),
            skipped_files: Vec::new(),
        }
    }

    pub(crate) fn command(&self, original: &SuiteCommand) -> SuiteCommand {
        if self.mode == SelectionMode::Selected {
            SuiteCommand::node_test().for_files(
                &self
                    .selected_files
                    .iter()
                    .map(|path| format!("./{path}"))
                    .collect::<Vec<_>>(),
            )
        } else {
            original.clone()
        }
    }
}

impl SkipperCache {
    pub(crate) async fn finish(&self, mut run: FinishedRun<'_>) -> CheckReport {
        let selected: BTreeSet<_> = run.selection.selected_files.iter().collect();
        let passing: BTreeSet<_> = run.report.passing_files.iter().collect();
        if run.selection.mode == SelectionMode::Selected
            && (run.before != run.after || (run.report.green && passing != selected))
        {
            run.report.green = false;
            run.report.failing_files = None;
            "Test skipper could not verify inputs or executed test inventory"
                .clone_into(&mut run.report.output_excerpt);
        }
        self.record(RecordedRun {
            request: run.request,
            before: run.before,
            after: run.after,
            report: &run.report,
            selection: &run.selection,
        })
        .await;
        run.report.selection = Some(run.selection);
        run.report
    }

    pub(crate) async fn plan(
        &self,
        request: &CheckRequest,
        snapshot: Option<&Snapshot>,
    ) -> TestSelection {
        if !eligible_recipe(request) {
            return TestSelection::full("custom-command-or-extra-files", snapshot);
        }
        let Some(snapshot) = snapshot else {
            return TestSelection::full("analyzer-unavailable", None);
        };
        if let Some(reason) = &snapshot.reason {
            return TestSelection::full(reason, Some(snapshot));
        }
        let cache = self.0.lock().await;
        let Some(baseline) = cache.get(&request.trunk.url.cache_key()) else {
            return TestSelection::full("no-full-green-baseline", Some(snapshot));
        };
        select(snapshot, baseline, request.limits)
    }

    async fn record(&self, run: RecordedRun<'_>) {
        if !run.report.green || run.before != run.after {
            self.0
                .lock()
                .await
                .remove(&run.request.trunk.url.cache_key());
            return;
        }
        let (Some(before), Some(after)) = (run.before, run.after) else {
            return;
        };
        let passing: BTreeSet<_> = run.report.passing_files.iter().collect();
        let inventory: BTreeSet<_> = before.tests.keys().collect();
        if run.selection.mode != SelectionMode::Full
            || !run.report.green
            || run.report.timed_out
            || before.reason.is_some()
            || before != after
            || inventory.is_empty()
            || passing != inventory
            || !eligible_recipe(run.request)
        {
            return;
        }
        let mut cache = self.0.lock().await;
        if cache.len() >= MAX_BASELINES {
            cache.clear();
        }
        cache.insert(
            run.request.trunk.url.cache_key(),
            Baseline {
                sha: run.request.sha.clone(),
                snapshot: before.clone(),
                limits: run.request.limits,
            },
        );
    }
}

#[derive(Debug)]
pub(crate) struct FinishedRun<'a> {
    pub(crate) request: &'a CheckRequest,
    pub(crate) before: Option<&'a Snapshot>,
    pub(crate) after: Option<&'a Snapshot>,
    pub(crate) report: CheckReport,
    pub(crate) selection: TestSelection,
}

#[derive(Debug)]
struct RecordedRun<'a> {
    request: &'a CheckRequest,
    before: Option<&'a Snapshot>,
    after: Option<&'a Snapshot>,
    report: &'a CheckReport,
    selection: &'a TestSelection,
}

fn select(candidate: &Snapshot, baseline: &Baseline, limits: SuiteLimits) -> TestSelection {
    let previous = &baseline.snapshot;
    let full = |reason| TestSelection::full(reason, Some(candidate));
    if candidate.environment != previous.environment || limits != baseline.limits {
        return full("recipe-or-environment-changed");
    }
    if !candidate.files.keys().eq(previous.files.keys())
        || !candidate.tests.keys().eq(previous.tests.keys())
    {
        return full("file-inventory-changed");
    }
    let changed: BTreeSet<_> = candidate
        .files
        .iter()
        .filter(|(path, digest)| previous.files.get(*path) != Some(*digest))
        .map(|(path, _)| path)
        .collect();
    if changed.iter().any(|path| !is_source(path)) {
        return full("configuration-or-resource-changed");
    }
    let (selected, skipped): (Vec<_>, Vec<_>) = candidate.tests.keys().cloned().partition(|test| {
        candidate.tests[test]
            .iter()
            .chain(previous.tests[test].iter())
            .any(|path| changed.contains(path))
    });
    if selected.is_empty() {
        return full("no-affected-tests-run-full");
    }
    if skipped.is_empty() {
        return full("all-tests-affected");
    }
    TestSelection {
        mode: SelectionMode::Selected,
        reason: "unchanged-transitive-dependencies".to_owned(),
        baseline_sha: Some(baseline.sha.clone()),
        selected_files: selected,
        skipped_files: skipped,
    }
}

fn is_source(path: &str) -> bool {
    [".js", ".mjs", ".ts", ".mts"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

/// The packaged analyzer is outside the untrusted checkout. No repository code is imported.
pub(crate) async fn analyze(checkout: &Path, env: &ChildEnv) -> Option<Snapshot> {
    let script = env
        .get("GITSTALK_SKIPPER_PATH")
        .or_else(|| env.get("BEANSTALK_SKIPPER_PATH"))
        .map_or_else(
            || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-skipper/dist/cli.mjs"),
            PathBuf::from,
        );
    let args = [script.into_os_string(), checkout.as_os_str().to_owned()];
    let spec = ProcessSpec {
        program: OsStr::new("node"),
        args: &args,
        cwd: checkout,
        env,
        extra_env: &[],
        stdin: None,
        timeout: Duration::from_secs(10),
    };
    let output = process::run(&spec).await.ok()?;
    if !output.succeeded() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}
