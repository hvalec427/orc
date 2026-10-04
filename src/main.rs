//! orc — orchestrate many `claude` CLI agents in parallel from a ratatui TUI.

pub mod agent;
pub mod config;
pub mod persist;
pub mod ports;
pub mod simulators;
pub mod tmux;
pub mod types;
pub mod ui;
pub mod worktree;

use clap::Parser;
use config::CliFlags;

/// Orchestrate many `claude` CLI agents in parallel from a ratatui TUI.
#[derive(Parser, Debug)]
#[command(name = "orc", version, about)]
struct Cli {
    /// Central config file (default: ~/.orc/config.json).
    #[arg(long)]
    config: Option<String>,
    /// Override the model for all agents.
    #[arg(long)]
    model: Option<String>,
    /// Do not attach the Maestro MCP server.
    #[arg(long = "no-maestro")]
    no_maestro: bool,
    /// Force-enable the per-agent tmux shell panes.
    #[arg(long)]
    tmux: bool,
    /// Disable the per-agent tmux shell panes.
    #[arg(long = "no-tmux")]
    no_tmux: bool,
    /// Internal: we are the re-exec child inside the tmux session orc created.
    #[arg(long = "tmux-child", hide = true)]
    tmux_child: bool,
}

impl Cli {
    fn into_flags(self) -> CliFlags {
        CliFlags {
            config: self.config,
            model: self.model,
            no_maestro: self.no_maestro,
            tmux: if self.tmux { Some(true) } else { None },
            no_tmux: self.no_tmux,
            tmux_child: self.tmux_child,
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("orc: {e}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let flags = Cli::parse().into_flags();

    let config = match config::load_config(&flags) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            eprintln!("\nCreate ~/.orc/config.json (see examples/config.json).");
            std::process::exit(1);
        }
    };

    // A dedicated multi-thread runtime drives the agent subprocesses; the UI loop runs on the main
    // thread (not a runtime worker) so it can `Handle::block_on` to start sessions synchronously.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let mut manager = agent::manager::AgentManager::new(config, rt.handle().clone());
    manager.restore();

    ui::app::run(&mut manager)?;

    manager.stop_all();
    // Give in-flight cancellations a moment to land, then drop the runtime.
    rt.shutdown_timeout(std::time::Duration::from_millis(200));
    Ok(())
}
