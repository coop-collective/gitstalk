//! Request bodies (plan §3) and their validation into domain requests. Validation happens once,
//! here; errors name the offending field.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::time::Duration;

use serde::Deserialize;

use crate::check::{
    CheckRequest, DepsName, ExtraFile, ManifestMode, ReadSets, SuiteCommand, SuiteEnv, SuiteLimits,
    TestFile, TestScope, TraceMode,
};
use crate::config::RemoteSchemes;
use crate::error::{Error, Result};
use crate::git::{
    AttrPattern, CommitSha, Lease, MergeDriver, MergeRules, RefName, RefUpdate, Remote, RemoteUrl,
    StructuralTier, Token,
};
use crate::integrate::{
    ChangeSource, ComposeItem, ComposeRequest, RevertRequest, SquashRequest, UpdateRefRequest,
};

/// Longest emulated CI latency or suite timeout a request may ask for.
const MAX_WAIT_SECONDS: f64 = 3600.0;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SquashBody {
    repo: String,
    token: Token,
    onto: String,
    change: ChangeBody,
    message: String,
    #[serde(default)]
    union_paths: Vec<String>,
    #[serde(default)]
    merge_driver: MergeDriverName,
    /// Retry a conflict with Mergiraf on the conflicted paths before reporting it.
    #[serde(default = "structural_by_default")]
    structural_merge: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChangeBody {
    repo: String,
    token: Token,
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    base: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ComposeBody {
    repo: String,
    token: Token,
    base: String,
    items: Vec<ComposeItemBody>,
    #[serde(default)]
    union_paths: Vec<String>,
    #[serde(default)]
    merge_driver: MergeDriverName,
    #[serde(default = "structural_by_default")]
    structural_merge: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ComposeItemBody {
    repo: String,
    token: Token,
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    base: Option<String>,
    task: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RevertBody {
    repo: String,
    token: Token,
    onto: String,
    commit: String,
    /// Undo `to..commit` (the red-window reset); absent: `commit` alone.
    #[serde(default)]
    to: Option<String>,
    message: String,
    #[serde(default)]
    union_paths: Vec<String>,
    #[serde(default)]
    merge_driver: MergeDriverName,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateRefBody {
    repo: String,
    token: Token,
    #[serde(rename = "ref")]
    reference: String,
    new: String,
    /// Absent or null: move unconditionally. The all-zero sha: create only.
    #[serde(default)]
    old: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CheckBody {
    #[serde(default)]
    test_skipper: crate::check::skipper::SkipperMode,
    repo: String,
    token: Token,
    sha: String,
    #[serde(default)]
    cmd: Option<Vec<String>>,
    /// Variables set for the suite (`NODE_OPTIONS`, ...); the runner's own are refused.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// A dependency snapshot of the image, linked above the checkout.
    #[serde(default)]
    deps: Option<String>,
    #[serde(default)]
    extra_files: BTreeMap<String, String>,
    #[serde(default)]
    latency_seconds: f64,
    #[serde(default)]
    suite_timeout_seconds: Option<f64>,
    #[serde(default)]
    test_timeout_ms: Option<u64>,
    /// Also report the passing test files' read sets (`passing_read_sets`).
    #[serde(default)]
    all_read_sets: bool,
    /// Run each test file in its own traced process and report its read map (`read_maps`).
    #[serde(default)]
    trace: bool,
    /// Run only these test files, with `cmd`'s node options (affected-tests validation).
    #[serde(default)]
    only_files: Option<Vec<String>>,
    /// Report the checked tree's blob ids (`tree`); always on when traced.
    #[serde(default)]
    tree_manifest: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MergeDriverName {
    #[default]
    Git,
    Mergiraf,
}

impl SquashBody {
    pub(crate) fn into_request(self, schemes: &RemoteSchemes) -> Result<SquashRequest> {
        Ok(SquashRequest {
            trunk: Remote {
                url: remote_url("repo", &self.repo, schemes)?,
                token: self.token,
            },
            onto: sha("onto", &self.onto)?,
            change: self.change.into_source("change", schemes)?,
            message: self.message,
            rules: rules(
                &self.union_paths,
                self.merge_driver,
                tier(self.structural_merge),
            )?,
        })
    }
}

impl ChangeBody {
    fn into_source(self, field: &str, schemes: &RemoteSchemes) -> Result<ChangeSource> {
        Ok(ChangeSource {
            remote: Remote {
                url: remote_url(&format!("{field}.repo"), &self.repo, schemes)?,
                token: self.token,
            },
            reference: reference(&format!("{field}.ref"), &self.reference)?,
            base: optional_sha(&format!("{field}.base"), self.base.as_deref())?,
        })
    }
}

impl ComposeBody {
    pub(crate) fn into_request(self, schemes: &RemoteSchemes) -> Result<ComposeRequest> {
        let items = self
            .items
            .into_iter()
            .enumerate()
            .map(|(index, item)| item.into_item(&format!("items[{index}]"), schemes))
            .collect::<Result<Vec<_>>>()?;
        Ok(ComposeRequest {
            trunk: Remote {
                url: remote_url("repo", &self.repo, schemes)?,
                token: self.token,
            },
            base: sha("base", &self.base)?,
            items,
            rules: rules(
                &self.union_paths,
                self.merge_driver,
                tier(self.structural_merge),
            )?,
        })
    }
}

impl ComposeItemBody {
    fn into_item(self, field: &str, schemes: &RemoteSchemes) -> Result<ComposeItem> {
        let message = self
            .message
            .unwrap_or_else(|| format!("{task}\n\nTask: {task}\n", task = self.task));
        let change = ChangeBody {
            repo: self.repo,
            token: self.token,
            reference: self.reference,
            base: self.base,
        };
        Ok(ComposeItem {
            change: change.into_source(field, schemes)?,
            task: self.task,
            message,
        })
    }
}

impl RevertBody {
    pub(crate) fn into_request(self, schemes: &RemoteSchemes) -> Result<RevertRequest> {
        Ok(RevertRequest {
            trunk: Remote {
                url: remote_url("repo", &self.repo, schemes)?,
                token: self.token,
            },
            onto: sha("onto", &self.onto)?,
            commit: sha("commit", &self.commit)?,
            to: self.to.as_deref().map(|to| sha("to", to)).transpose()?,
            message: self.message,
            // A revert undoes a commit exactly; it never guesses structurally.
            rules: rules(&self.union_paths, self.merge_driver, StructuralTier::Off)?,
        })
    }
}

impl UpdateRefBody {
    pub(crate) fn into_request(self, schemes: &RemoteSchemes) -> Result<UpdateRefRequest> {
        let lease = match optional_sha("old", self.old.as_deref())? {
            None => Lease::Any,
            Some(old) if old.is_null() => Lease::Absent,
            Some(old) => Lease::At(old),
        };
        Ok(UpdateRefRequest {
            trunk: Remote {
                url: remote_url("repo", &self.repo, schemes)?,
                token: self.token,
            },
            update: RefUpdate {
                reference: reference("ref", &self.reference)?,
                new: sha("new", &self.new)?,
                lease,
            },
        })
    }
}

impl CheckBody {
    pub(crate) fn into_request(self, schemes: &RemoteSchemes) -> Result<CheckRequest> {
        let command = match self.cmd {
            None => SuiteCommand::node_test(),
            Some(argv) => SuiteCommand::parse(argv).map_err(|reason| invalid("cmd", reason))?,
        };
        let env = SuiteEnv::parse(self.env).map_err(|reason| invalid("env", reason))?;
        let deps = self
            .deps
            .as_deref()
            .map(DepsName::parse)
            .transpose()
            .map_err(|reason| invalid("deps", reason))?;
        let extra_files = self
            .extra_files
            .into_iter()
            .map(|(path, content)| {
                ExtraFile::new(&path, content).map_err(|reason| invalid("extra_files", reason))
            })
            .collect::<Result<Vec<_>>>()?;
        let defaults = SuiteLimits::default();
        let suite_timeout = match self.suite_timeout_seconds {
            None => defaults.suite_timeout,
            Some(seconds) => seconds_between("suite_timeout_seconds", seconds, f64::MIN_POSITIVE)?,
        };
        let test_timeout_ms = match self.test_timeout_ms {
            Some(0) => return Err(invalid("test_timeout_ms", "must be positive")),
            other => other.unwrap_or(defaults.test_timeout_ms),
        };
        let scope = match self.only_files {
            None => TestScope::Suite,
            Some(files) => TestScope::Only(
                files
                    .iter()
                    .map(|file| TestFile::new(file).map_err(|reason| invalid("only_files", reason)))
                    .collect::<Result<Vec<_>>>()?,
            ),
        };
        let trace = if self.trace {
            TraceMode::PerFile
        } else {
            TraceMode::Off
        };
        let runs_per_file = trace == TraceMode::PerFile || scope != TestScope::Suite;
        if runs_per_file && !command.runs_tests() {
            return Err(invalid(
                if self.trace { "trace" } else { "only_files" },
                "needs a cmd that runs node --test",
            ));
        }
        Ok(CheckRequest {
            test_skipper: self.test_skipper,
            trunk: Remote {
                url: remote_url("repo", &self.repo, schemes)?,
                token: self.token,
            },
            sha: sha("sha", &self.sha)?,
            command,
            env,
            deps,
            extra_files,
            latency: seconds_between("latency_seconds", self.latency_seconds, 0.0)?,
            limits: SuiteLimits {
                suite_timeout,
                test_timeout_ms,
            },
            read_sets: if self.all_read_sets {
                ReadSets::All
            } else {
                ReadSets::Failing
            },
            scope,
            trace,
            manifest: if self.tree_manifest {
                ManifestMode::Include
            } else {
                ManifestMode::Omit
            },
        })
    }
}

fn invalid(field: &str, reason: impl Display) -> Error {
    Error::InvalidRequest(format!("{field}: {reason}"))
}

fn remote_url(field: &str, raw: &str, schemes: &RemoteSchemes) -> Result<RemoteUrl> {
    RemoteUrl::parse(raw, schemes).map_err(|reason| invalid(field, reason))
}

fn sha(field: &str, raw: &str) -> Result<CommitSha> {
    CommitSha::parse(raw).map_err(|reason| invalid(field, reason))
}

fn optional_sha(field: &str, raw: Option<&str>) -> Result<Option<CommitSha>> {
    raw.map(|raw| sha(field, raw)).transpose()
}

fn reference(field: &str, raw: &str) -> Result<RefName> {
    RefName::parse(raw).map_err(|reason| invalid(field, reason))
}

fn structural_by_default() -> bool {
    true
}

/// The wire's `structural_merge` flag as the tier it selects.
fn tier(structural_merge: bool) -> StructuralTier {
    if structural_merge {
        StructuralTier::Mergiraf
    } else {
        StructuralTier::Off
    }
}

fn rules(
    union_paths: &[String],
    driver: MergeDriverName,
    tier: StructuralTier,
) -> Result<MergeRules> {
    let patterns = union_paths
        .iter()
        .map(|pattern| AttrPattern::parse(pattern).map_err(|reason| invalid("union_paths", reason)))
        .collect::<Result<Vec<_>>>()?;
    let driver = match driver {
        MergeDriverName::Git => MergeDriver::Git,
        MergeDriverName::Mergiraf => MergeDriver::Mergiraf,
    };
    Ok(MergeRules::new(patterns, driver, tier))
}

fn seconds_between(field: &str, seconds: f64, minimum: f64) -> Result<Duration> {
    if seconds.is_finite() && (minimum..=MAX_WAIT_SECONDS).contains(&seconds) {
        Ok(Duration::from_secs_f64(seconds))
    } else {
        Err(invalid(
            field,
            format!("must be between {minimum} and {MAX_WAIT_SECONDS} seconds"),
        ))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

    use super::*;
    use crate::config::Config;

    fn schemes() -> RemoteSchemes {
        Config::from_lookup(|_| None)
            .unwrap()
            .remote_schemes()
            .clone()
    }

    fn update_ref(old: &serde_json::Value) -> Result<UpdateRefRequest> {
        let body: UpdateRefBody = serde_json::from_value(serde_json::json!({
            "repo": "https://h/r.git", "token": "t0ken", "ref": "refs/heads/trunk",
            "new": "a".repeat(40), "old": old,
        }))
        .unwrap();
        body.into_request(&schemes())
    }

    #[test]
    fn old_selects_the_lease() {
        let null = serde_json::Value::Null;
        let zero = serde_json::Value::from("0".repeat(40));
        let old = serde_json::Value::from("b".repeat(40));

        assert_eq!(update_ref(&null).unwrap().update.lease, Lease::Any);
        assert_eq!(update_ref(&zero).unwrap().update.lease, Lease::Absent);
        assert_eq!(
            update_ref(&old).unwrap().update.lease,
            Lease::At(CommitSha::parse(&"b".repeat(40)).unwrap())
        );
    }

    #[test]
    fn validation_errors_name_the_field() {
        let error = update_ref(&"abc".into()).unwrap_err().to_string();

        assert!(error.contains("old:"), "{error}");
    }

    #[test]
    fn unknown_fields_are_refused() {
        let parsed = serde_json::from_value::<UpdateRefBody>(serde_json::json!({
            "repo": "https://h/r.git", "token": "t", "ref": "refs/heads/x", "new": "a".repeat(40),
            "force": true,
        }));

        assert!(parsed.is_err());
    }

    #[test]
    fn check_defaults_follow_the_harness() {
        let body: CheckBody = serde_json::from_value(serde_json::json!({
            "repo": "https://h/r.git", "token": "t", "sha": "a".repeat(40),
        }))
        .unwrap();

        let request = body.into_request(&schemes()).unwrap();

        assert_eq!(request.command, SuiteCommand::node_test());
        assert_eq!(request.env, SuiteEnv::default());
        assert_eq!(request.deps, None);
        assert_eq!(request.limits, SuiteLimits::default());
        assert_eq!(request.latency, Duration::ZERO);
    }

    #[test]
    fn check_takes_an_arena_suite() {
        let body: CheckBody = serde_json::from_value(serde_json::json!({
            "repo": "https://h/r.git", "token": "t", "sha": "a".repeat(40),
            "cmd": ["node", "--no-use-env-proxy", "--test", "test/!(listen.5).test.js"],
            "env": {"TZ": "UTC"}, "deps": "fastify",
        }))
        .unwrap();

        let request = body.into_request(&schemes()).unwrap();

        assert_eq!(request.deps, Some(DepsName::parse("fastify").unwrap()));
        assert_eq!(
            request.env,
            SuiteEnv::parse([("TZ".to_owned(), "UTC".to_owned())]).unwrap()
        );
    }

    #[test]
    fn check_refuses_a_suite_that_escapes() {
        let refused = [
            serde_json::json!({"cmd": ["sh", "-c", "curl evil"]}),
            serde_json::json!({"env": {"LD_PRELOAD": "/tmp/x.so"}}),
            serde_json::json!({"env": {"PATH": "/tmp"}}),
            serde_json::json!({"deps": "../../etc"}),
        ];
        for extra in refused {
            let mut body = serde_json::json!({
                "repo": "https://h/r.git", "token": "t", "sha": "a".repeat(40),
            });
            if let (Some(target), Some(fields)) = (body.as_object_mut(), extra.as_object()) {
                target.extend(fields.clone());
            }
            let parsed: CheckBody = serde_json::from_value(body).unwrap();

            assert!(parsed.into_request(&schemes()).is_err(), "{extra}");
        }
    }

    #[test]
    fn refuses_negative_latency() {
        let body: CheckBody = serde_json::from_value(serde_json::json!({
            "repo": "https://h/r.git", "token": "t", "sha": "a".repeat(40), "latency_seconds": -1,
        }))
        .unwrap();

        let error = body.into_request(&schemes()).unwrap_err().to_string();

        assert!(error.contains("latency_seconds"), "{error}");
    }
}
