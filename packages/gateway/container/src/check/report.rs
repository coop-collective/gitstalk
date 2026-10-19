//! The result of a check, assembled exactly as the harness's `CI.run` fills its `CIResult`.

use std::collections::BTreeMap;
use std::path::Path;

use super::imports::{self, ImportDepths};
use super::junit::{self, JunitSummary};
use super::paths;
use super::read_maps::ReadMapsReport;
use super::sandbox::SuiteNetwork;
use super::stack;
use super::suite::SuiteRun;
use super::tree::TreeManifest;
use crate::git::CommitSha;

/// Characters of output kept (`_excerpt`'s `limit`).
const EXCERPT_CHARS: usize = 7000;
/// Where node's spec reporter starts its summary of failures.
const FAILURES_MARKER: &str = "failing tests:";

/// One failed test, as `CIResult.failing_tests` lists it (the body is dropped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FailingTest {
    pub(crate) file: String,
    pub(crate) name: String,
    pub(crate) message: String,
}

/// `CIResult` without the fields the scheduler owns (`ci_id`, `purpose`, `slot`, `cancelled`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckReport {
    pub(crate) selection: Option<super::skipper::TestSelection>,
    pub(crate) sha: CommitSha,
    pub(crate) green: bool,
    pub(crate) tests: usize,
    pub(crate) failures: usize,
    pub(crate) failing_tests: Vec<FailingTest>,
    /// `None` when the run crashed or timed out before the reporter finished.
    pub(crate) failing_files: Option<Vec<String>>,
    pub(crate) passing_files: Vec<String>,
    pub(crate) read_set: Vec<String>,
    pub(crate) read_sets: BTreeMap<String, Vec<String>>,
    /// The passing test files' read sets, when the request asked for them (`ReadSets::All`).
    pub(crate) passing_read_sets: BTreeMap<String, Vec<String>>,
    /// Whether `passing_read_sets` hold everything each test observed (traced: every file read,
    /// probed and listed), not static import closures.
    pub(crate) read_sets_complete: bool,
    pub(crate) read_depths: BTreeMap<String, ImportDepths>,
    pub(crate) stack_files: Vec<String>,
    /// `CIResult.output`: the failure-relevant tail of stdout and stderr.
    pub(crate) output_excerpt: String,
    pub(crate) suite_seconds: f64,
    /// Checkout, suite and emulated latency; set by the caller once the latency has passed.
    pub(crate) ci_seconds: f64,
    pub(crate) timed_out: bool,
    /// The suite's network; set by the caller, which knows the instance's.
    pub(crate) network: SuiteNetwork,
    /// Per test file read maps, when the check was traced (or asked to be and could not).
    pub(crate) read_maps: Option<ReadMapsReport>,
    /// The checked tree's blob ids, when traced or asked for.
    pub(crate) tree: Option<TreeManifest>,
}

/// Builds the report from a finished run. Reads files (the junit report, sources for read sets),
/// so it runs on a blocking thread.
pub(crate) fn assess(
    sha: CommitSha,
    run: &SuiteRun,
    checkout: &Path,
    junit_path: &Path,
) -> CheckReport {
    let root_real = paths::real_path(checkout);
    let parsed = std::fs::read_to_string(junit_path)
        .ok()
        .and_then(|xml| junit::parse_junit(&xml, &root_real));
    assess_summary(sha, run, &root_real, parsed)
}

/// As [`assess`], from an already parsed junit summary (`None`: no well-formed report).
pub(crate) fn assess_summary(
    sha: CommitSha,
    run: &SuiteRun,
    root_real: &Path,
    parsed: Option<JunitSummary>,
) -> CheckReport {
    let green = run.code == Some(0)
        && !run.timed_out
        && parsed
            .as_ref()
            .is_some_and(|summary| summary.failing.is_empty());
    let mut report = CheckReport {
        selection: None,
        sha,
        green,
        tests: 0,
        failures: 0,
        failing_tests: Vec::new(),
        failing_files: None,
        passing_files: Vec::new(),
        read_set: Vec::new(),
        read_sets: BTreeMap::new(),
        passing_read_sets: BTreeMap::new(),
        read_sets_complete: false,
        read_depths: BTreeMap::new(),
        stack_files: Vec::new(),
        output_excerpt: excerpt(&combined_output(run)),
        suite_seconds: run.seconds,
        ci_seconds: run.seconds,
        timed_out: run.timed_out,
        network: SuiteNetwork::Host,
        read_maps: None,
        tree: None,
    };
    if let Some(summary) = parsed {
        record_failures(&mut report, summary, root_real);
    }
    report
}

/// `CIResult` fields that come from the junit report, then the read sets and stack files of a
/// red run with failing files.
fn record_failures(report: &mut CheckReport, summary: JunitSummary, root_real: &Path) {
    let failing_files: Vec<String> = summary
        .failing
        .iter()
        .filter(|failure| !failure.file.is_empty())
        .map(|failure| failure.file.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    report.tests = summary.tests;
    report.failures = summary.failing.len();
    report.passing_files = summary.passing_files;
    if !report.green && !failing_files.is_empty() {
        record_read_sets(report, &failing_files, root_real);
        for failure in &summary.failing {
            for file in stack::stack_files(&failure.body, root_real) {
                if !report.stack_files.contains(&file) {
                    report.stack_files.push(file);
                }
            }
        }
    }
    report.failing_tests = summary
        .failing
        .into_iter()
        .map(|failure| FailingTest {
            file: failure.file,
            name: failure.name,
            message: failure.message,
        })
        .collect();
    report.failing_files = Some(failing_files);
}

fn record_read_sets(report: &mut CheckReport, failing_files: &[String], root_real: &Path) {
    let files = imports::list_files(root_real);
    let mut union = std::collections::BTreeSet::new();
    for test_file in failing_files {
        let depths = imports::import_depths(root_real, test_file, &files);
        let mut read_set: Vec<String> = depths.paths().map(str::to_owned).collect();
        read_set.sort();
        union.extend(read_set.iter().cloned());
        report.read_sets.insert(test_file.clone(), read_set);
        report.read_depths.insert(test_file.clone(), depths);
    }
    report.read_set = union.into_iter().collect();
}

/// The static import closure of every passing test file, so a caller can tell which tests
/// could see two changes combine. Reads sources, so it runs on a blocking thread.
pub(crate) fn record_passing_read_sets(report: &mut CheckReport, checkout: &Path) {
    let root_real = paths::real_path(checkout);
    let files = imports::list_files(&root_real);
    for test_file in &report.passing_files {
        let depths = imports::import_depths(&root_real, test_file, &files);
        let mut read_set: Vec<String> = depths.paths().map(str::to_owned).collect();
        read_set.sort();
        report.passing_read_sets.insert(test_file.clone(), read_set);
    }
}

/// `pr.stdout + ("\n" + pr.stderr if pr.stderr.strip() else "")`.
fn combined_output(run: &SuiteRun) -> String {
    if run.stderr.trim().is_empty() {
        run.stdout.clone()
    } else {
        format!("{}\n{}", run.stdout, run.stderr)
    }
}

/// `ci._excerpt`: from the failure summary on, at most 7,000 characters.
#[must_use]
pub(crate) fn excerpt(text: &str) -> String {
    let tail = text
        .find(FAILURES_MARKER)
        .map_or(text, |start| &text[start..]);
    let total = tail.chars().count();
    if total <= EXCERPT_CHARS {
        return tail.to_owned();
    }
    let kept: String = tail.chars().take(EXCERPT_CHARS).collect();
    format!("{kept}\n... [{} more chars]", total - EXCERPT_CHARS)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

    use proptest::prelude::*;

    use super::*;

    fn run(code: Option<i32>, stdout: &str) -> SuiteRun {
        SuiteRun {
            code,
            stdout: stdout.to_owned(),
            stderr: String::new(),
            timed_out: false,
            seconds: 1.5,
        }
    }

    fn sha() -> CommitSha {
        CommitSha::parse(&"a".repeat(40)).unwrap()
    }

    #[test]
    fn a_missing_report_is_a_crash_not_a_pass() {
        let root = tempfile::tempdir().unwrap();

        let report = assess(
            sha(),
            &run(Some(0), "ok"),
            root.path(),
            &root.path().join("none.xml"),
        );

        assert!(!report.green);
        assert_eq!(report.failing_files, None);
        assert_eq!(report.tests, 0);
    }

    #[test]
    fn a_clean_report_with_exit_zero_is_green() {
        let root = tempfile::tempdir().unwrap();
        let junit = root.path().join("j.xml");
        std::fs::write(
            &junit,
            "<testsuites><testcase name=\"t\" file=\"/x/a.test.ts\"/></testsuites>",
        )
        .unwrap();

        let report = assess(sha(), &run(Some(0), ""), root.path(), &junit);

        assert!(report.green);
        assert_eq!(report.failing_files, Some(Vec::new()));
        assert_eq!(report.tests, 1);
    }

    #[test]
    fn excerpt_starts_at_the_failure_summary() {
        assert_eq!(
            excerpt("noise\n✖ failing tests:\nboom"),
            "failing tests:\nboom"
        );
        assert_eq!(excerpt("all good"), "all good");
    }

    #[test]
    fn excerpt_counts_what_it_cut() {
        let text = "x".repeat(7010);

        let cut = excerpt(&text);

        assert!(cut.ends_with("\n... [10 more chars]"));
        assert_eq!(cut.chars().filter(|c| *c == 'x').count(), 7000);
    }

    proptest! {
        #[test]
        fn excerpt_never_exceeds_its_limit(text in "\\PC{0,8000}") {
            let cut = excerpt(&text);
            prop_assert!(cut.chars().count() <= EXCERPT_CHARS + 40);
        }
    }
}
