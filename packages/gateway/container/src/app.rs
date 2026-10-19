//! The HTTP surface: routes, shared state and thin handlers (parse, call the domain, map).

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::check::{self, DepsName, SuiteNetwork};
use crate::config::{Config, RemoteSchemes};
use crate::error::Result;
use crate::git::{CommitSha, RefUpdateOutcome};
use crate::integrate;
use crate::process::{self, ChildEnv, ProcessSpec};
use crate::wire::{
    CheckBody, CheckResponse, ComposeBody, ComposeResponse, HealthResponse, LandingBody,
    RevertBody, SquashBody, SquashResponse, UpdateRefBody, UpdateRefResponse, VersionResponse,
};
use crate::workspace::Workspace;

/// The version of the wire contract (request and response bodies, plan §3). Bump it with every
/// change a caller must know about (a new request field above all: bodies refuse unknown fields),
/// together with `RUNNER_API_VERSION` in `packages/gateway/src/runner/runner-transport.ts`.
///
/// 1: the contract until 2026-10-05 (no version reported). 2: squash and compose
/// `structural_merge`, revert `to`, check `all_read_sets` and `passing_read_sets`. 3: check
/// `env` and `deps` (a run's own suite: real-task arenas), and `network` on checks and `/healthz`.
/// 4: check `trace`, `only_files` and `tree_manifest`, answered with `read_maps` and `tree`, and
/// `tracing` on `/healthz`.
/// 5: optional pre-land `test_skipper` and explicit `selection` evidence.
pub const API_VERSION: u32 = 5;
/// Response header carrying [`API_VERSION`] on every response, so a caller can tell which
/// contract refused its request.
pub const API_VERSION_HEADER: &str = "x-gitstalk-runner-api";

/// Request bodies carry acceptance tests in `extra_files`; 16 MiB is far above any task's.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// `git --version` and `node --version` answer at once; this only bounds a broken binary.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The runner's routes (plan §3).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/version", get(version))
        .route("/v1/squash", post(squash))
        .route("/v1/compose", post(compose))
        .route("/v1/revert", post(revert))
        .route("/v1/update-ref", post(update_ref))
        .route("/v1/check", post(check))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::map_response(stamp_api_version))
        .with_state(state)
}

async fn stamp_api_version(mut response: Response) -> Response {
    response.headers_mut().insert(
        HeaderName::from_static(API_VERSION_HEADER),
        HeaderValue::from(API_VERSION),
    );
    response
}

/// State shared by every request.
#[derive(Debug, Clone)]
pub struct AppState {
    shared: Arc<Shared>,
}

#[derive(Debug)]
struct Shared {
    workspace: Workspace,
    schemes: RemoteSchemes,
    tools: ToolVersions,
    tracer: check::Tracer,
    git_sha: Option<String>,
}

impl AppState {
    /// Prepares `WORK_DIR` and probes git and node.
    ///
    /// # Errors
    ///
    /// [`Error::Io`](crate::error::Error::Io) when the work directory cannot be prepared.
    pub async fn prepare(config: &Config) -> Result<Self> {
        let workspace = Workspace::prepare(config).await?;
        let tools = ToolVersions::probe(workspace.suite_env()).await;
        let git_sha = config.git_sha().map(str::to_owned);
        let environment = format!(
            "node {}; runner {}",
            tools.node().unwrap_or("unknown"),
            git_sha.as_deref().unwrap_or("unknown")
        );
        let tracer = check::Tracer::probe(workspace.suite_env(), &environment).await;
        if let check::Tracer::Unavailable { reason } = &tracer {
            tracing::warn!(%reason, "traced checks will run untraced");
        }
        Ok(Self {
            shared: Arc::new(Shared {
                workspace,
                schemes: config.remote_schemes().clone(),
                tools,
                tracer,
                git_sha,
            }),
        })
    }

    pub fn tools(&self) -> &ToolVersions {
        &self.shared.tools
    }

    /// The network suites get on this instance (`loopback`, `host` or `unavailable`).
    pub fn suite_network(&self) -> &'static str {
        match self.shared.workspace.suite_network() {
            SuiteNetwork::Loopback => "loopback",
            SuiteNetwork::Host => "host",
            SuiteNetwork::Unavailable => "unavailable",
        }
    }
}

async fn healthz(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let tools = state.tools();
    let ok = tools.git.is_some() && tools.node.is_some();
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = HealthResponse {
        ok,
        git: tools.git.clone(),
        node: tools.node.clone(),
        network: state.shared.workspace.suite_network(),
        tracing: state.shared.tracer.is_ready(),
    };
    (status, Json(body))
}

async fn version(State(state): State<AppState>) -> Json<VersionResponse> {
    Json(VersionResponse {
        version: env!("CARGO_PKG_VERSION"),
        api_version: API_VERSION,
        git_sha: state
            .shared
            .git_sha
            .clone()
            .unwrap_or_else(|| "unknown".to_owned()),
    })
}

#[tracing::instrument(skip_all, fields(op = "squash"))]
async fn squash(
    State(state): State<AppState>,
    body: Result<Json<SquashBody>, JsonRejection>,
) -> Result<Json<SquashResponse>> {
    let request = body?.0.into_request(&state.shared.schemes)?;
    let squashed = integrate::squash(&state.shared.workspace, &request).await?;
    tracing::info!(
        repo = %request.trunk.url,
        onto = %request.onto,
        sha = squashed.landing.sha().map(CommitSha::as_str),
        "squashed"
    );
    Ok(Json(squashed.into()))
}

#[tracing::instrument(skip_all, fields(op = "compose"))]
async fn compose(
    State(state): State<AppState>,
    body: Result<Json<ComposeBody>, JsonRejection>,
) -> Result<Json<ComposeResponse>> {
    let request = body?.0.into_request(&state.shared.schemes)?;
    let composition = integrate::compose(&state.shared.workspace, &request).await?;
    let clean = composition
        .items
        .iter()
        .filter(|item| item.squashed.landing.sha().is_some())
        .count();
    tracing::info!(
        repo = %request.trunk.url,
        base = %request.base,
        head = %composition.head,
        items = request.items.len(),
        clean,
        "composed"
    );
    Ok(Json(composition.into()))
}

#[tracing::instrument(skip_all, fields(op = "revert"))]
async fn revert(
    State(state): State<AppState>,
    body: Result<Json<RevertBody>, JsonRejection>,
) -> Result<Json<LandingBody>> {
    let request = body?.0.into_request(&state.shared.schemes)?;
    let landing = integrate::revert(&state.shared.workspace, &request).await?;
    tracing::info!(
        repo = %request.trunk.url,
        commit = %request.commit,
        sha = landing.sha().map(CommitSha::as_str),
        "reverted"
    );
    Ok(Json(landing.into()))
}

#[tracing::instrument(skip_all, fields(op = "update-ref"))]
async fn update_ref(
    State(state): State<AppState>,
    body: Result<Json<UpdateRefBody>, JsonRejection>,
) -> Result<Json<UpdateRefResponse>> {
    let request = body?.0.into_request(&state.shared.schemes)?;
    let outcome = integrate::update_ref(&state.shared.workspace, &request).await?;
    let actual = match &outcome {
        RefUpdateOutcome::Updated => Some(&request.update.new),
        RefUpdateOutcome::Stale { actual } => actual.as_ref(),
    };
    tracing::info!(
        repo = %request.trunk.url,
        reference = %request.update.reference,
        new = %request.update.new,
        ok = outcome == RefUpdateOutcome::Updated,
        actual = actual.map(CommitSha::as_str),
        "ref update"
    );
    Ok(Json(UpdateRefResponse::new(outcome, request.update.new)))
}

#[tracing::instrument(skip_all, fields(op = "check"))]
async fn check(
    State(state): State<AppState>,
    body: Result<Json<CheckBody>, JsonRejection>,
) -> Result<Json<CheckResponse>> {
    let request = body?.0.into_request(&state.shared.schemes)?;
    let report = check::check(&state.shared.workspace, &request, &state.shared.tracer).await?;
    tracing::info!(
        repo = %request.trunk.url,
        sha = %request.sha,
        green = report.green,
        tests = report.tests,
        failures = report.failures,
        timed_out = report.timed_out,
        suite_seconds = report.suite_seconds,
        deps = request.deps.as_ref().map(DepsName::as_str),
        network = ?report.network,
        traced_files = report.read_maps.as_ref().map(|maps| maps.files.len()),
        "checked"
    );
    Ok(Json(report.into()))
}

/// Versions of git and node found at startup (`None`: not found).
#[derive(Debug, Clone, Default)]
pub struct ToolVersions {
    git: Option<String>,
    node: Option<String>,
}

impl ToolVersions {
    pub fn git(&self) -> Option<&str> {
        self.git.as_deref()
    }

    pub fn node(&self) -> Option<&str> {
        self.node.as_deref()
    }

    async fn probe(env: &ChildEnv) -> Self {
        Self {
            git: probe_version("git", env)
                .await
                .map(|text| text.trim_start_matches("git version ").to_owned()),
            node: probe_version("node", env)
                .await
                .map(|text| text.trim_start_matches('v').to_owned()),
        }
    }
}

async fn probe_version(program: &str, env: &ChildEnv) -> Option<String> {
    let args = [OsString::from("--version")];
    let spec = ProcessSpec {
        program: OsStr::new(program),
        args: &args,
        cwd: Path::new("/"),
        env,
        extra_env: &[],
        stdin: None,
        timeout: PROBE_TIMEOUT,
    };
    let finished = process::run(&spec).await.ok()?;
    let version = String::from_utf8_lossy(&finished.stdout).trim().to_owned();
    (finished.succeeded() && !version.is_empty()).then_some(version)
}
