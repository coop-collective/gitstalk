//! Child processes. Every git and node run goes through [`run`].
//!
//! A child starts in its own process group. On timeout the whole group gets SIGTERM, then SIGKILL
//! after a grace period, as the harness's `procs.py` does; a dropped run (a cancelled request)
//! kills the group, so no test process outlives its request.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::task::JoinHandle;

/// Bytes kept per output stream; the rest is read and dropped so the child never blocks on a full
/// pipe (the harness keeps 4 MB per stream too).
const MAX_CAPTURE_BYTES: usize = 4_000_000;
/// Time a process tree has to exit after SIGTERM before SIGKILL (the harness's grace).
const TERMINATE_GRACE: Duration = Duration::from_secs(3);
/// Time the output readers get to finish once the tree is dead.
const DRAIN_GRACE: Duration = Duration::from_secs(5);
/// Time the output readers get to reach end of file once the child itself has exited, before the
/// rest of its process group is killed.
const EXITED_OUTPUT_GRACE: Duration = Duration::from_secs(2);
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// The runner's environment, captured once at startup and filtered per kind of child.
#[derive(Clone)]
pub(crate) struct ChildEnv {
    vars: Vec<(OsString, OsString)>,
}

impl ChildEnv {
    pub(crate) fn inherit() -> Self {
        Self {
            vars: std::env::vars_os().collect(),
        }
    }

    /// A copy without the variables whose names start with any of `prefixes`.
    #[must_use]
    pub(crate) fn without_prefixes(&self, prefixes: &[&str]) -> Self {
        let vars = self
            .vars
            .iter()
            .filter(|(key, _)| {
                let key = key.to_string_lossy();
                !prefixes.iter().any(|prefix| key.starts_with(prefix))
            })
            .cloned()
            .collect();
        Self { vars }
    }

    /// The same environment with `key` set to `value`.
    #[must_use]
    pub(crate) fn with(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        let key = key.into();
        self.vars.retain(|(existing, _)| *existing != key);
        self.vars.push((key, value.into()));
        self
    }

    /// Read a captured variable without consulting mutable process-global state.
    pub(crate) fn get(&self, key: &str) -> Option<&OsStr> {
        self.vars
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_os_str())
    }
}

impl fmt::Debug for ChildEnv {
    // Values can be sensitive: show the count only.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildEnv")
            .field("vars", &self.vars.len())
            .finish()
    }
}

/// What to run, where, and for how long.
#[derive(Debug)]
pub(crate) struct ProcessSpec<'a> {
    pub(crate) program: &'a OsStr,
    pub(crate) args: &'a [OsString],
    pub(crate) cwd: &'a Path,
    pub(crate) env: &'a ChildEnv,
    /// Set on top of `env`, overriding it.
    pub(crate) extra_env: &'a [(OsString, OsString)],
    pub(crate) stdin: Option<&'a [u8]>,
    pub(crate) timeout: Duration,
}

/// How a process ended.
#[derive(Debug)]
pub(crate) struct Finished {
    /// Exit code; `None` when the process was killed (by a signal, or by us on timeout).
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) timed_out: bool,
    pub(crate) elapsed: Duration,
}

impl Finished {
    pub(crate) fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs a process until it exits, or until `spec.timeout`.
pub(crate) async fn run(spec: &ProcessSpec<'_>) -> std::io::Result<Finished> {
    let started = Instant::now();
    let mut child = spawn(spec)?;
    let tree = ProcessTree::of(&child);
    let stdout = capture(child.stdout.take());
    let stderr = capture(child.stderr.take());
    let stdin = child.stdin.take();
    let exited = tokio::time::timeout(spec.timeout, async {
        let ((), status) = tokio::join!(feed(stdin, spec.stdin), child.wait());
        status
    })
    .await;
    match exited {
        Ok(status) => {
            let status = status?;
            let (stdout, stderr) = collect_after_exit(tree, stdout, stderr).await;
            Ok(Finished {
                code: status.code(),
                stdout: stdout?,
                stderr: stderr?,
                timed_out: false,
                elapsed: started.elapsed(),
            })
        }
        Err(_elapsed) => {
            tree.terminate(&mut child).await;
            Ok(Finished {
                code: None,
                stdout: drain(stdout).await,
                stderr: drain(stderr).await,
                timed_out: true,
                elapsed: started.elapsed(),
            })
        }
    }
}

/// The output of a child that has exited. Its pipes normally close with it; a helper it left
/// running in the background (a test's detached server, say) inherits them and keeps them open.
/// That must not turn a finished run into a timeout, so the readers get [`EXITED_OUTPUT_GRACE`],
/// then whatever is left of the process group is killed (closing the pipes) and the readers are
/// drained. The exit status stays the child's own.
async fn collect_after_exit(
    tree: ProcessTree,
    stdout: Reader,
    stderr: Reader,
) -> (std::io::Result<Vec<u8>>, std::io::Result<Vec<u8>>) {
    let deadline = tokio::time::Instant::now() + EXITED_OUTPUT_GRACE;
    let stdout = read_until(stdout, deadline).await;
    let stderr = read_until(stderr, deadline).await;
    tree.kill();
    (stdout.finish().await, stderr.finish().await)
}

/// A reader's state at a deadline: finished, or still waiting for end of file.
enum ReadState {
    Done(std::io::Result<Vec<u8>>),
    Open(Reader),
}

impl ReadState {
    /// The bytes read; a reader still open is drained (its pipe should be closed by now).
    async fn finish(self) -> std::io::Result<Vec<u8>> {
        match self {
            Self::Done(result) => result,
            Self::Open(reader) => Ok(drain(reader).await),
        }
    }
}

async fn read_until(mut reader: Reader, deadline: tokio::time::Instant) -> ReadState {
    match tokio::time::timeout_at(deadline, &mut reader).await {
        Ok(result) => ReadState::Done(joined(result)),
        // Not finished, so the handle has not yielded its output and may be awaited again.
        Err(_elapsed) => ReadState::Open(reader),
    }
}

fn spawn(spec: &ProcessSpec<'_>) -> std::io::Result<Child> {
    let stdin = if spec.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    Command::new(spec.program)
        .args(spec.args)
        .current_dir(spec.cwd)
        .env_clear()
        .envs(spec.env.vars.iter().map(|(key, value)| (key, value)))
        .envs(spec.extra_env.iter().map(|(key, value)| (key, value)))
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
}

async fn feed(stdin: Option<ChildStdin>, input: Option<&[u8]>) {
    let (Some(mut stdin), Some(input)) = (stdin, input) else {
        return;
    };
    // A child that exits without reading closes the pipe; its exit status tells that story.
    if stdin.write_all(input).await.is_ok() {
        drop(stdin.shutdown().await);
    }
}

/// A task reading one output stream to end of file.
type Reader = JoinHandle<std::io::Result<Vec<u8>>>;

fn capture<R>(stream: Option<R>) -> Reader
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        match stream {
            Some(mut stream) => read_capped(&mut stream).await,
            None => Ok(Vec::new()),
        }
    })
}

async fn read_capped(stream: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(kept);
        }
        let room = MAX_CAPTURE_BYTES.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
}

fn joined(
    result: Result<std::io::Result<Vec<u8>>, tokio::task::JoinError>,
) -> std::io::Result<Vec<u8>> {
    result.map_err(std::io::Error::other)?
}

async fn drain(mut reader: Reader) -> Vec<u8> {
    match tokio::time::timeout(DRAIN_GRACE, &mut reader).await {
        Ok(Ok(Ok(bytes))) => bytes,
        Ok(_) => Vec::new(),
        Err(_elapsed) => {
            reader.abort();
            drop(reader.await);
            Vec::new()
        }
    }
}

/// The child's process group. Killed on drop unless released, so a cancelled request leaves no
/// processes behind.
#[derive(Debug)]
struct ProcessTree {
    group: Option<Pid>,
}

impl ProcessTree {
    fn of(child: &Child) -> Self {
        let group = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .map(Pid::from_raw);
        Self { group }
    }

    /// Kills whatever is left of the group (after its leader has exited).
    fn kill(mut self) {
        self.signal(Signal::SIGKILL);
        self.group = None;
    }

    async fn terminate(mut self, child: &mut Child) {
        self.signal(Signal::SIGTERM);
        drop(tokio::time::timeout(TERMINATE_GRACE, child.wait()).await);
        // Grandchildren that ignored SIGTERM, or a leader that did.
        self.signal(Signal::SIGKILL);
        drop(tokio::time::timeout(DRAIN_GRACE, child.wait()).await);
        self.group = None;
    }

    /// Signals every process still in the group. A descendant that left it (`setsid`, or its
    /// own `setpgid`) is out of reach: it survives, and when it holds the output pipes the readers
    /// are aborted after [`DRAIN_GRACE`] instead of reaching end of file. Only a container restart
    /// (or a PID namespace per run) would reach it.
    fn signal(&self, signal: Signal) {
        if let Some(group) = self.group {
            // ESRCH only means the group has already gone.
            let _ = killpg(group, signal);
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.signal(Signal::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

    use super::*;

    async fn run_shell(script: &str, stdin: Option<&[u8]>, timeout: Duration) -> Finished {
        let env = ChildEnv::inherit();
        let args = [OsString::from("-c"), OsString::from(script)];
        let spec = ProcessSpec {
            program: OsStr::new("sh"),
            args: &args,
            cwd: Path::new("/"),
            env: &env,
            extra_env: &[],
            stdin,
            timeout,
        };
        run(&spec).await.unwrap()
    }

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let finished = run_shell(
            "echo out; echo err >&2; exit 3",
            None,
            Duration::from_secs(10),
        )
        .await;

        assert_eq!(finished.code, Some(3));
        assert_eq!(finished.stdout, b"out\n");
        assert_eq!(finished.stderr, b"err\n");
        assert!(!finished.timed_out);
    }

    #[tokio::test]
    async fn feeds_stdin() {
        let finished = run_shell("cat", Some(b"message\n"), Duration::from_secs(10)).await;

        assert!(finished.succeeded());
        assert_eq!(finished.stdout, b"message\n");
    }

    #[tokio::test]
    async fn timeout_kills_the_whole_process_tree() {
        // The background sleep inherits stdout, so the reader reaches end of file (and the pid
        // comes back) before DRAIN_GRACE only if the group kill reached the grandchild too.
        let finished =
            run_shell("sleep 30 & echo $!; wait", None, Duration::from_millis(300)).await;

        assert!(finished.timed_out);
        assert_eq!(finished.code, None);
        let grandchild = String::from_utf8(finished.stdout).unwrap();
        assert!(
            grandchild.trim().parse::<u32>().is_ok(),
            "stdout: {grandchild:?}"
        );
        assert!(
            finished.elapsed < DRAIN_GRACE,
            "took {:?}",
            finished.elapsed
        );
    }

    #[tokio::test]
    async fn a_helper_holding_the_output_does_not_turn_an_exit_into_a_timeout() {
        // The background sleep inherits stdout and stderr, so they stay open after `sh` exits.
        let finished = run_shell("sleep 30 & echo $!; exit 4", None, Duration::from_secs(20)).await;

        assert_eq!(finished.code, Some(4));
        assert!(!finished.timed_out);
        let helper = String::from_utf8(finished.stdout).unwrap();
        assert!(helper.trim().parse::<u32>().is_ok(), "stdout: {helper:?}");
        assert!(
            finished.elapsed < EXITED_OUTPUT_GRACE + DRAIN_GRACE,
            "took {:?}",
            finished.elapsed
        );
    }

    #[test]
    fn filters_variables_by_prefix() {
        let env = ChildEnv { vars: Vec::new() }
            .with("GIT_DIR", "/x")
            .with("NODE_OPTIONS", "--inspect")
            .with("PATH", "/bin");

        let kept = env.without_prefixes(&["GIT_", "NODE_OPTIONS"]);

        assert_eq!(
            kept.vars,
            vec![(OsString::from("PATH"), OsString::from("/bin"))]
        );
    }
}
