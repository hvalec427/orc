//! Loading + validating the central orc config (`~/.orc/config.json`).

use crate::types::{
    MaestroMcp, MergeStrategy, OrcConfig, PermissionMode, PortRange, ProjectConfig, ProjectType,
    SettingSource,
};
use serde::Deserialize;

/// Default model id used when no override is set.
pub const DEFAULT_MODEL: &str = "claude-opus-4-8";
/// Default directory (relative to repo) where worktrees are created.
pub const DEFAULT_WORKTREE_DIR: &str = ".worktrees";
/// Default merge strategy wire value.
pub const DEFAULT_MERGE_STRATEGY: MergeStrategy = MergeStrategy::Rebase;
/// Default permission mode.
pub const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode::BypassPermissions;
/// Default project type.
pub const DEFAULT_PROJECT_TYPE: ProjectType = ProjectType::ReactNative;

/// Default setting sources: user, project, local.
pub fn default_setting_sources() -> Vec<SettingSource> {
    vec![
        SettingSource::User,
        SettingSource::Project,
        SettingSource::Local,
    ]
}

/// Default maestro MCP: `maestro mcp`.
pub fn default_maestro_mcp() -> MaestroMcp {
    MaestroMcp {
        command: "maestro".to_string(),
        args: Some(vec!["mcp".to_string()]),
        env: None,
    }
}

/// CLI flags that influence config resolution.
#[derive(Debug, Clone, Default)]
pub struct CliFlags {
    pub config: Option<String>,
    pub model: Option<String>,
    pub no_maestro: bool,
    pub tmux: Option<bool>,
    pub no_tmux: bool,
    pub tmux_child: bool,
}

/// Fields overridable at the global or per-project level in the raw config document.
///
/// `deny_unknown_fields` and `#[serde(flatten)]` are mutually exclusive in serde, so rather than
/// flattening a shared struct (which would silently accept unknown keys), the overridable fields are
/// listed explicitly on both [`RawGlobalConfig`] and [`RawProjectConfig`] so each can carry
/// `deny_unknown_fields` and reject typos.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawOverridable {
    #[serde(rename = "type")]
    pub project_type: Option<ProjectType>,
    pub model: Option<String>,
    pub worktree_dir: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub setting_sources: Option<Vec<SettingSource>>,
    pub base_branch: Option<String>,
    pub merge_strategy: Option<MergeStrategy>,
    pub port_range: Option<String>,
    pub maestro_mcp: Option<MaestroMcp>,
    pub magic_link: Option<String>,
}

/// A single project entry in the raw config.json document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawProjectConfig {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub project_type: Option<ProjectType>,
    pub model: Option<String>,
    pub worktree_dir: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub setting_sources: Option<Vec<SettingSource>>,
    pub base_branch: Option<String>,
    pub merge_strategy: Option<MergeStrategy>,
    pub port_range: Option<String>,
    pub maestro_mcp: Option<MaestroMcp>,
    pub magic_link: Option<String>,
}

impl RawProjectConfig {
    fn overridable(&self) -> RawOverridable {
        RawOverridable {
            project_type: self.project_type,
            model: self.model.clone(),
            worktree_dir: self.worktree_dir.clone(),
            permission_mode: self.permission_mode,
            setting_sources: self.setting_sources.clone(),
            base_branch: self.base_branch.clone(),
            merge_strategy: self.merge_strategy,
            port_range: self.port_range.clone(),
            maestro_mcp: self.maestro_mcp.clone(),
            magic_link: self.magic_link.clone(),
        }
    }
}

/// The top-level raw config.json document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawGlobalConfig {
    #[serde(rename = "type")]
    pub project_type: Option<ProjectType>,
    pub model: Option<String>,
    pub worktree_dir: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub setting_sources: Option<Vec<SettingSource>>,
    pub base_branch: Option<String>,
    pub merge_strategy: Option<MergeStrategy>,
    pub port_range: Option<String>,
    pub maestro_mcp: Option<MaestroMcp>,
    pub magic_link: Option<String>,
    pub projects: Vec<RawProjectConfig>,
    pub tmux: Option<bool>,
}

impl RawGlobalConfig {
    fn overridable(&self) -> RawOverridable {
        RawOverridable {
            project_type: self.project_type,
            model: self.model.clone(),
            worktree_dir: self.worktree_dir.clone(),
            permission_mode: self.permission_mode,
            setting_sources: self.setting_sources.clone(),
            base_branch: self.base_branch.clone(),
            merge_strategy: self.merge_strategy,
            port_range: self.port_range.clone(),
            maestro_mcp: self.maestro_mcp.clone(),
            magic_link: self.magic_link.clone(),
        }
    }
}

/// Parse a validated "start-end" string into a [`PortRange`].
///
/// Errors contain `portRange must look like "8000-8099"` when the shape is wrong and
/// `0 < start <= end` when the numeric bounds are invalid.
pub fn parse_port_range(range: &str) -> anyhow::Result<PortRange> {
    let re = regex::Regex::new(r"^\d+-\d+$").unwrap();
    if !re.is_match(range) {
        anyhow::bail!(r#"portRange must look like "8000-8099""#);
    }
    let (start_s, end_s) = range.split_once('-').unwrap();
    let start: u32 = start_s.parse()?;
    let end: u32 = end_s.parse()?;
    if !(start > 0 && end > 0 && start <= end) || start > u16::MAX as u32 || end > u16::MAX as u32 {
        anyhow::bail!(r#"portRange must be "start-end" with 0 < start <= end"#);
    }
    Ok(PortRange {
        start: start as u16,
        end: end as u16,
    })
}

/// Default config path: `~/.orc/config.json`.
pub fn default_config_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".orc").join("config.json")
}

/// Collapse the home dir back to `~` for friendlier messages.
pub fn display_path(p: &str) -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    if home.is_empty() {
        return p.to_string();
    }
    if p == home {
        return "~".to_string();
    }
    let prefix = format!("{home}/");
    if let Some(rest) = p.strip_prefix(&prefix) {
        format!("~/{rest}")
    } else {
        p.to_string()
    }
}

/// Expand a leading `~` and resolve to an absolute path.
pub fn expand_path(p: &str) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    if p == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home.join(rest).to_string_lossy().into_owned();
    }
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        p.to_string()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

/// Parse a raw config document from JSON text, rejecting unknown keys.
///
/// Errors are prefixed with `Invalid config` to match the TS wording.
pub fn parse_raw_config(text: &str) -> anyhow::Result<RawGlobalConfig> {
    serde_json::from_str(text).map_err(|e| anyhow::anyhow!("Invalid config: {e}"))
}

/// Resolve a raw config document into an [`OrcConfig`], overlaying global defaults per project and
/// applying CLI flag precedence. Duplicate project names error with
/// `Duplicate project name in config: "<name>"`.
pub fn resolve_config(raw: RawGlobalConfig, flags: &CliFlags) -> anyhow::Result<OrcConfig> {
    let global = raw.overridable();
    let global_maestro = if flags.no_maestro {
        None
    } else {
        global
            .maestro_mcp
            .clone()
            .or_else(|| Some(default_maestro_mcp()))
    };

    let mut projects = Vec::with_capacity(raw.projects.len());
    let mut names = std::collections::HashSet::new();

    for p in &raw.projects {
        if !names.insert(p.name.clone()) {
            anyhow::bail!("Duplicate project name in config: \"{}\"", p.name);
        }
        let po = p.overridable();

        let range_str = po.port_range.clone().or_else(|| global.port_range.clone());
        let port_range = match range_str {
            Some(ref s) => Some(parse_port_range(s)?),
            None => None,
        };

        let maestro_mcp = if flags.no_maestro {
            None
        } else {
            po.maestro_mcp.clone().or_else(|| global_maestro.clone())
        };

        projects.push(ProjectConfig {
            name: p.name.clone(),
            project_type: po
                .project_type
                .or(global.project_type)
                .unwrap_or(DEFAULT_PROJECT_TYPE),
            repo: expand_path(&p.path),
            model: flags
                .model
                .clone()
                .or_else(|| po.model.clone())
                .or_else(|| global.model.clone())
                .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            worktree_dir: po
                .worktree_dir
                .clone()
                .or_else(|| global.worktree_dir.clone())
                .unwrap_or_else(|| DEFAULT_WORKTREE_DIR.to_string()),
            permission_mode: po
                .permission_mode
                .or(global.permission_mode)
                .unwrap_or(DEFAULT_PERMISSION_MODE),
            setting_sources: po
                .setting_sources
                .clone()
                .or_else(|| global.setting_sources.clone())
                .unwrap_or_else(default_setting_sources),
            base_branch: po
                .base_branch
                .clone()
                .or_else(|| global.base_branch.clone()),
            merge_strategy: po
                .merge_strategy
                .or(global.merge_strategy)
                .unwrap_or(DEFAULT_MERGE_STRATEGY),
            port_range,
            maestro_mcp,
            magic_link: po.magic_link.clone().or_else(|| global.magic_link.clone()),
        });
    }

    let tmux = if flags.no_tmux {
        Some(false)
    } else {
        flags.tmux.or(raw.tmux)
    };

    Ok(OrcConfig { projects, tmux })
}

/// Load + resolve the config from disk per the CLI flags.
pub fn load_config(flags: &CliFlags) -> anyhow::Result<OrcConfig> {
    let config_path = match &flags.config {
        Some(c) => std::path::PathBuf::from(expand_path(c)),
        None => default_config_path(),
    };
    if !config_path.exists() {
        anyhow::bail!(
            "No config found at {}.",
            display_path(&config_path.to_string_lossy())
        );
    }
    let text = std::fs::read_to_string(&config_path)?;
    let raw = parse_raw_config(&text)?;
    resolve_config(raw, flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags() -> CliFlags {
        CliFlags::default()
    }

    #[test]
    fn parse_port_range_ok() {
        let r = parse_port_range("8000-8099").unwrap();
        assert_eq!(r.start, 8000);
        assert_eq!(r.end, 8099);
    }

    #[test]
    fn parse_port_range_reversed_errors() {
        let err = parse_port_range("8099-8000").unwrap_err().to_string();
        assert!(err.contains("0 < start <= end"), "got: {err}");
    }

    #[test]
    fn parse_port_range_garbage_errors() {
        let err = parse_port_range("abc").unwrap_err().to_string();
        assert!(err.contains("portRange must look like"), "got: {err}");
    }

    #[test]
    fn merge_strategy_per_project_override_wins() {
        let text = r#"{
            "mergeStrategy": "merge",
            "projects": [
                { "name": "A", "path": "/a", "mergeStrategy": "squash-merge" },
                { "name": "B", "path": "/b" }
            ]
        }"#;
        let raw = parse_raw_config(text).unwrap();
        let cfg = resolve_config(raw, &flags()).unwrap();
        let a = cfg.projects.iter().find(|p| p.name == "A").unwrap();
        let b = cfg.projects.iter().find(|p| p.name == "B").unwrap();
        assert_eq!(a.merge_strategy, MergeStrategy::SquashMerge);
        assert_eq!(b.merge_strategy, MergeStrategy::Merge);
    }

    #[test]
    fn merge_strategy_defaults_to_rebase() {
        let text = r#"{ "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let cfg = resolve_config(raw, &flags()).unwrap();
        assert_eq!(cfg.projects[0].merge_strategy, MergeStrategy::Rebase);
    }

    #[test]
    fn invalid_merge_strategy_errors() {
        let text =
            r#"{ "projects": [ { "name": "A", "path": "/a", "mergeStrategy": "octopus" } ] }"#;
        let err = parse_raw_config(text).unwrap_err().to_string();
        assert!(err.contains("Invalid config"), "got: {err}");
    }

    #[test]
    fn tmux_resolution_absent_is_none() {
        let text = r#"{ "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let cfg = resolve_config(raw, &flags()).unwrap();
        assert_eq!(cfg.tmux, None);
    }

    #[test]
    fn tmux_parsed_true() {
        let text = r#"{ "tmux": true, "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let cfg = resolve_config(raw, &flags()).unwrap();
        assert_eq!(cfg.tmux, Some(true));
    }

    #[test]
    fn tmux_parsed_false() {
        let text = r#"{ "tmux": false, "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let cfg = resolve_config(raw, &flags()).unwrap();
        assert_eq!(cfg.tmux, Some(false));
    }

    #[test]
    fn flag_tmux_forces_true() {
        let text = r#"{ "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let mut f = flags();
        f.tmux = Some(true);
        let cfg = resolve_config(raw, &f).unwrap();
        assert_eq!(cfg.tmux, Some(true));
    }

    #[test]
    fn no_tmux_overrides_flag() {
        let text = r#"{ "tmux": true, "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let mut f = flags();
        f.tmux = Some(true);
        f.no_tmux = true;
        let cfg = resolve_config(raw, &f).unwrap();
        assert_eq!(cfg.tmux, Some(false));
    }

    #[test]
    fn unknown_top_level_key_errors() {
        let text = r#"{ "bogus": 1, "projects": [ { "name": "A", "path": "/a" } ] }"#;
        let err = parse_raw_config(text).unwrap_err().to_string();
        assert!(err.contains("Invalid config"), "got: {err}");
    }

    #[test]
    fn duplicate_project_name_errors() {
        let text =
            r#"{ "projects": [ { "name": "X", "path": "/a" }, { "name": "X", "path": "/b" } ] }"#;
        let raw = parse_raw_config(text).unwrap();
        let err = resolve_config(raw, &flags()).unwrap_err().to_string();
        assert!(
            err.contains(r#"Duplicate project name in config: "X""#),
            "got: {err}"
        );
    }
}
