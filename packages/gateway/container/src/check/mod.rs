//! `POST /v1/check`: the harness's `CI.run` on one commit (checkout, extra files, the run's
//! suite command, junit parsing, read sets, stack files, emulated latency), with the run's
//! dependency snapshot linked above the checkout and a loopback-only network; optionally one
//! traced process per test file for read maps ([`trace`]), or only a given set of test files.

mod deps;
mod discover;
mod imports;
mod junit;
mod paths;
mod per_file;
mod read_maps;
mod report;
mod sandbox;
pub(crate) mod skipper;
mod stack;
mod suite;
mod trace;
mod tree;

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) use deps::DepsName;
pub(crate) use imports::ImportDepths;
pub(crate) use read_maps::{ReadMapsReport, TestFileMap, TraceStatus};
pub(crate) use report::{CheckReport, FailingTest};
pub(crate) use sandbox::SuiteNetwork;
pub(crate) use suite::{SuiteCommand, SuiteEnv, SuiteLimits};
pub(crate) use trace::Tracer;
pub(crate) use tree::TreeManifest;

use crate::error::{Error, Result};
use crate::git::{CommitSha, Remote};
use crate::workspace::{JobDir, Workspace};

/// A file written into the checkout before the run (the final acceptance check's tests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExtraFile {
    path: PathBuf,
    content: String,
}

impl ExtraFile {
    /// # Errors
    ///
    /// A reason when `path` is absolute or climbs out of the checkout.
    pub(crate) fn new(path: &str, content: String) -> Result<Self, String> {
        let candidate = checkout_relative(path)?;
        Ok(Self {
            path: candidate,
            content,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// The path as a tree path (`./src/a.ts` is `src/a.ts`).
    pub(crate) fn relative_path(&self) -> String {
        self.path
            .components()
            .filter_map(|part| match part {
                Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}

/// A test file to run, relative to the checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TestFile(String);

impl TestFile {
    /// # Errors
    ///
    /// A reason when `path` is absolute or climbs out of the checkout.
    pub(crate) fn new(path: &str) -> Result<Self, String> {
        checkout_relative(path).map(|_| Self(paths::normalize(path)))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

fn checkout_relative(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    let parts: Vec<Component<'_>> = candidate.components().collect();
    let stays_inside = !path.contains('\0')
        && parts
            .iter()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
        && parts
            .iter()
            .any(|part| matches!(part, Component::Normal(_)));
    if stays_inside {
        Ok(candidate.to_path_buf())
    } else {
        Err(format!(
            "{path:?} must be a relative path inside the checkout"
        ))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CheckRequest {
    pub(crate) trunk: Remote,
    pub(crate) sha: CommitSha,
    pub(crate) command: SuiteCommand,
    /// Variables set for the suite on top of the runner's (`NODE_OPTIONS`, say).
    pub(crate) env: SuiteEnv,
    /// The dependency snapshot linked above the checkout (`None`: no dependencies).
    pub(crate) deps: Option<DepsName>,
    pub(crate) extra_files: Vec<ExtraFile>,
    /// Emulated CI latency: the request holds its slot this long after the suite, as `ci.py`
    /// sleeps while the slot stays busy.
    pub(crate) latency: Duration,
    pub(crate) limits: SuiteLimits,
    pub(crate) read_sets: ReadSets,
    /// The whole suite, or only some test files (affected-tests validation).
    pub(crate) scope: TestScope,
    pub(crate) trace: TraceMode,
    pub(crate) manifest: ManifestMode,
    pub(crate) test_skipper: skipper::SkipperMode,
}

/// Which test files get their read set reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ReadSets {
    /// The failing ones only (the harness's `CIResult.read_sets`).
    #[default]
    Failing,
    /// The passing ones too, in `passing_read_sets` (the gateway's targeted landing check).
    All,
}

/// The test files a check runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum TestScope {
    /// Whatever the suite command runs.
    #[default]
    Suite,
    /// Only these files (with the command's node options); files missing from the checked tree
    /// are left out, since a deleted test cannot fail.
    Only(Vec<TestFile>),
}

/// Whether test files run traced, one process each, to report read maps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum TraceMode {
    #[default]
    Off,
    PerFile,
}

/// Whether the report carries the checked tree's blob ids (always, when traced).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ManifestMode {
    #[default]
    Omit,
    Include,
}

/// Runs the suite on `request.sha` and reports as `ci.py` does.
///
/// # Errors
///
/// Unknown commits, remote and git failures, an unknown dependency snapshot, a required
/// loopback network the kernel cannot give, and a node that cannot start. A red, crashed or
/// timed-out suite is a report, not an error.
pub(crate) async fn check(
    workspace: &Workspace,
    request: &CheckRequest,
    tracer: &Tracer,
) -> Result<CheckReport> {
    let started = Instant::now();
    if workspace.suite_network() == SuiteNetwork::Unavailable {
        return Err(Error::Config(
            "SUITE_NETWORK=loopback, but this instance cannot make a network namespace".to_owned(),
        ));
    }
    let node_modules = match &request.deps {
        Some(name) => Some(deps::node_modules(workspace.deps_dir(), name).await?),
        None => None,
    };
    let cache = workspace.open_trunk(&request.trunk).await?;
    cache.ensure_commits(&[&request.sha]).await?;
    let job = workspace.new_job().await?;
    let checkout = job.path().join("checkout");
    tokio::fs::create_dir(&checkout)
        .await
        .map_err(Error::io(format!("creating {}", checkout.display())))?;
    cache
        .repo()
        .checkout(&request.sha, &job.path().join("index"), &checkout)
        .await?;
    write_extra_files(&checkout, &request.extra_files).await?;
    if let Some(node_modules) = &node_modules {
        deps::link_above(job.path(), node_modules).await?;
    }
    let wants_manifest =
        request.manifest == ManifestMode::Include || request.trace == TraceMode::PerFile;
    let manifest = if wants_manifest {
        Some(tree::manifest(cache.repo(), &request.sha, &checkout, &request.extra_files).await?)
    } else {
        None
    };
    let context = RunContext {
        workspace,
        request,
        job: &job,
        checkout: &checkout,
    };
    let mut report = match (request.trace, tracer) {
        (TraceMode::PerFile, Tracer::Ready { environment }) => {
            run_traced(&context, manifest.as_ref(), environment).await?
        }
        (TraceMode::PerFile, Tracer::Unavailable { reason }) => {
            let mut report = run_untraced(&context).await?;
            report.read_maps = Some(ReadMapsReport::unavailable(reason));
            report
        }
        (TraceMode::Off, _) => run_untraced(&context).await?,
    };
    if request.test_skipper == skipper::SkipperMode::On && request.trace != TraceMode::Off {
        report.selection = Some(skipper::TestSelection::traced());
    }
    report.tree = manifest;
    tokio::time::sleep(request.latency).await;
    report.ci_seconds = started.elapsed().as_secs_f64();
    report.network = workspace.suite_network();
    job.remove().await;
    Ok(report)
}

/// What one check's runs share.
#[derive(Debug, Clone, Copy)]
struct RunContext<'a> {
    workspace: &'a Workspace,
    request: &'a CheckRequest,
    job: &'a JobDir,
    checkout: &'a Path,
}

/// One process for the whole selection, as the harness runs its suite.
async fn run_untraced(context: &RunContext<'_>) -> Result<CheckReport> {
    if context.request.test_skipper == skipper::SkipperMode::On {
        return skipper::run(context).await;
    }
    run_command(context, &context.request.command).await
}

async fn run_command(context: &RunContext<'_>, original: &SuiteCommand) -> Result<CheckReport> {
    let request = context.request;
    let command = match &request.scope {
        TestScope::Suite => original.clone(),
        TestScope::Only(files) => {
            let present = present_files(context.checkout, files);
            if present.is_empty() {
                return Ok(empty_report(request, context.checkout));
            }
            request.command.for_files(&present)
        }
    };
    let junit = context.job.path().join("junit.xml");
    let plan = suite::SuitePlan {
        command: &command,
        limits: request.limits,
        checkout: context.checkout,
        junit: &junit,
        env: context.workspace.suite_env(),
        extra_env: &request.env,
        network: context.workspace.suite_network(),
        trace_into: None,
    };
    let run = suite::run_suite(&plan).await?;
    let sha = request.sha.clone();
    let read_sets = request.read_sets;
    let checkout = context.checkout.to_path_buf();
    blocking(move || {
        let mut report = report::assess(sha, &run, &checkout, &junit);
        if read_sets == ReadSets::All {
            report::record_passing_read_sets(&mut report, &checkout);
        }
        report
    })
    .await
}

/// One traced process per test file; the runs fold into the usual report plus read maps.
async fn run_traced(
    context: &RunContext<'_>,
    manifest: Option<&TreeManifest>,
    environment: &str,
) -> Result<CheckReport> {
    let request = context.request;
    let files = match &request.scope {
        TestScope::Suite => {
            discover::test_files(
                &request.command,
                context.checkout,
                context.workspace.suite_env(),
            )
            .await?
        }
        TestScope::Only(files) => present_files(context.checkout, files),
    };
    let checkout_real = paths::real_path(context.checkout);
    let plan = per_file::FilePlan {
        command: request.command.clone(),
        limits: request.limits,
        checkout: context.checkout.to_path_buf(),
        checkout_real: checkout_real.clone(),
        job_dir: context.job.path().to_path_buf(),
        env: context.workspace.suite_env().clone(),
        extra_env: request.env.clone(),
        network: context.workspace.suite_network(),
        concurrency: std::thread::available_parallelism().map_or(1, usize::from),
    };
    let started = Instant::now();
    let runs = per_file::run_traced(plan, &files).await?;
    let (run, summary) = per_file::combine(&runs, started.elapsed());
    let sha = request.sha.clone();
    let read_sets = request.read_sets;
    let maps = manifest.map(|tree| ReadMapsReport::traced(&runs, tree, environment));
    let observed = read_maps::ObservedReadSets::of(&runs);
    blocking(move || {
        let mut report = report::assess_summary(sha, &run, &checkout_real, Some(summary));
        // Every file that ran, by its own run's outcome (a file without test cases passes too).
        report.passing_files = observed.passing_files;
        if report.failing_files.is_some() {
            report.failing_files = Some(observed.failing_files);
        }
        if read_sets == ReadSets::All {
            report.passing_read_sets = observed.passing_read_sets;
            report.read_sets_complete = observed.complete;
        }
        report.read_maps = maps;
        report
    })
    .await
}

/// A check of no test files: green, nothing ran.
fn empty_report(request: &CheckRequest, checkout: &Path) -> CheckReport {
    let sha = request.sha.clone();
    let run = suite::SuiteRun {
        code: Some(0),
        stdout: String::new(),
        stderr: String::new(),
        timed_out: false,
        seconds: 0.0,
    };
    let root_real = paths::real_path(checkout);
    report::assess_summary(sha, &run, &root_real, Some(junit::JunitSummary::default()))
}

fn present_files(checkout: &Path, files: &[TestFile]) -> Vec<String> {
    files
        .iter()
        .filter(|file| checkout.join(file.as_str()).is_file())
        .map(|file| file.as_str().to_owned())
        .collect()
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Error::io("reading the test results")(std::io::Error::other(error)))
}

async fn write_extra_files(checkout: &Path, files: &[ExtraFile]) -> Result<()> {
    for file in files {
        let full = checkout.join(&file.path);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(Error::io(format!("creating {}", parent.display())))?;
        }
        tokio::fs::write(&full, &file.content)
            .await
            .map_err(Error::io(format!("writing {}", full.display())))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_files_stay_inside_the_checkout() {
        assert!(ExtraFile::new("src/billing/t001.test.ts", String::new()).is_ok());
        assert!(ExtraFile::new("/etc/passwd", String::new()).is_err());
        assert!(ExtraFile::new("../outside.ts", String::new()).is_err());
        assert!(ExtraFile::new("src/../../outside.ts", String::new()).is_err());
        assert!(ExtraFile::new("./src/a.ts", String::new()).is_ok());
        assert!(ExtraFile::new(".", String::new()).is_err());
        assert!(ExtraFile::new("", String::new()).is_err());
    }

    #[test]
    fn extra_file_tree_paths_drop_dot_components() {
        let file = ExtraFile::new("./src/./a.ts", String::new());

        assert_eq!(
            file.map(|file| file.relative_path()),
            Ok("src/a.ts".to_owned())
        );
    }

    #[test]
    fn test_files_are_normalised_relative_paths() {
        assert_eq!(
            TestFile::new("./test/a.test.js").map(|file| file.0),
            Ok("test/a.test.js".to_owned())
        );
        assert!(TestFile::new("/etc/x.test.js").is_err());
        assert!(TestFile::new("test/../../x.test.js").is_err());
    }
}
