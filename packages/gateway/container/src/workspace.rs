//! The `WORK_DIR` layout: `<repo-hash>.git` bare caches and `jobs/<n>/` scratch directories.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::check::SuiteNetwork;
use crate::check::skipper::SkipperCache;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::git::{Git, Remote, RepoCaches, TrunkCache};
use crate::process::ChildEnv;

/// Variables never passed to the test suite: git's own (a child must not inherit a repository)
/// and Node's option and test-runner variables, as the harness's `ci.py` drops.
const SUITE_ENV_DROP: [&str; 3] = ["GIT_", "NODE_OPTIONS", "NODE_TEST"];

/// Shared state of every request: git, the caches, scratch space and the suite's environment.
#[derive(Debug)]
pub(crate) struct Workspace {
    pub(crate) skipper: SkipperCache,
    git: Git,
    caches: RepoCaches,
    jobs_root: PathBuf,
    next_job: AtomicU64,
    suite_env: ChildEnv,
    deps_dir: PathBuf,
    suite_network: SuiteNetwork,
}

impl Workspace {
    /// Creates `WORK_DIR` and an empty `jobs/` (scratch left by a previous process is removed).
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the directories cannot be created.
    pub(crate) async fn prepare(config: &Config) -> Result<Self> {
        let root = config.work_dir();
        let jobs_root = root.join("jobs");
        match tokio::fs::remove_dir_all(&jobs_root).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(Error::io(format!("clearing {}", jobs_root.display()))(
                    error,
                ));
            }
            _ => {}
        }
        tokio::fs::create_dir_all(&jobs_root)
            .await
            .map_err(Error::io(format!("creating {}", jobs_root.display())))?;
        let inherited = ChildEnv::inherit();
        let suite_env = inherited.without_prefixes(&SUITE_ENV_DROP).with("CI", "1");
        let suite_network = SuiteNetwork::resolve(config.suite_network(), &suite_env).await;
        Ok(Self {
            skipper: SkipperCache::default(),
            git: Git::new(&inherited, config.identity()),
            caches: RepoCaches::new(root.to_path_buf()),
            jobs_root,
            next_job: AtomicU64::new(0),
            suite_env,
            deps_dir: config.deps_dir().to_path_buf(),
            suite_network,
        })
    }

    /// The environment the test suite runs with.
    pub(crate) fn suite_env(&self) -> &ChildEnv {
        &self.suite_env
    }

    /// Where the image's dependency snapshots live.
    pub(crate) fn deps_dir(&self) -> &Path {
        &self.deps_dir
    }

    /// The network every suite on this instance gets.
    pub(crate) fn suite_network(&self) -> SuiteNetwork {
        self.suite_network
    }

    /// The bare cache of `trunk`.
    ///
    /// # Errors
    ///
    /// As [`RepoCaches::open`].
    pub(crate) async fn open_trunk<'a>(&'a self, trunk: &'a Remote) -> Result<TrunkCache<'a>> {
        self.caches.open(&self.git, trunk).await
    }

    /// A fresh scratch directory for one request.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when it cannot be created.
    pub(crate) async fn new_job(&self) -> Result<JobDir> {
        loop {
            let number = self.next_job.fetch_add(1, Ordering::Relaxed);
            let path = self.jobs_root.join(number.to_string());
            match tokio::fs::create_dir(&path).await {
                Ok(()) => return Ok(JobDir { path, armed: true }),
                // Another process shares WORK_DIR and took this number: take the next one.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(Error::io(format!("creating {}", path.display()))(error));
                }
            }
        }
    }
}

/// A request's scratch directory: attributes file, throwaway index, checkout, junit report.
#[derive(Debug)]
pub(crate) struct JobDir {
    path: PathBuf,
    armed: bool,
}

impl JobDir {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Deletes the directory. Best effort: the request's work is done (a candidate may already be
    /// pushed), so a leftover scratch directory is logged rather than failing the request; the next
    /// start clears `jobs/` anyway.
    pub(crate) async fn remove(mut self) {
        self.armed = false;
        if let Err(error) = tokio::fs::remove_dir_all(&self.path).await {
            tracing::warn!(%error, path = %self.path.display(), "scratch directory not removed");
        }
    }
}

impl Drop for JobDir {
    // A request that failed or was cancelled skips `remove`: delete in the background instead of
    // blocking a runtime thread here.
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let path = std::mem::take(&mut self.path);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            drop(runtime.spawn_blocking(move || std::fs::remove_dir_all(path)));
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

    use super::*;

    async fn workspace(root: &Path) -> Workspace {
        let root = root.to_string_lossy().into_owned();
        let config =
            Config::from_lookup(|name| (name == "WORK_DIR").then(|| root.clone())).unwrap();
        Workspace::prepare(&config).await.unwrap()
    }

    #[tokio::test]
    async fn jobs_get_distinct_directories_and_are_removed() {
        let root = tempfile::tempdir().unwrap();
        let workspace = workspace(root.path()).await;

        let first = workspace.new_job().await.unwrap();
        let second = workspace.new_job().await.unwrap();

        assert_ne!(first.path(), second.path());
        let path = first.path().to_path_buf();
        first.remove().await;
        assert!(!path.exists());
        second.remove().await;
    }

    #[tokio::test]
    async fn prepare_clears_scratch_left_by_a_previous_process() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("jobs/7/checkout")).unwrap();

        let _workspace = workspace(root.path()).await;

        assert!(!root.path().join("jobs/7").exists());
        assert!(root.path().join("jobs").is_dir());
    }

    #[test]
    fn the_suite_never_sees_git_or_node_option_variables() {
        let inherited = ChildEnv::inherit()
            .with("GIT_DIR", "/x")
            .with("NODE_OPTIONS", "--require evil")
            .with("NODE_TEST_CONTEXT", "child");

        let suite = inherited.without_prefixes(&SUITE_ENV_DROP).with("CI", "1");

        assert_eq!(suite.get("GIT_DIR"), None);
        assert_eq!(suite.get("NODE_OPTIONS"), None);
        assert_eq!(suite.get("NODE_TEST_CONTEXT"), None);
        assert_eq!(suite.get("CI"), Some(std::ffi::OsStr::new("1")));
    }
}
