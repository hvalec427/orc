//! orc — orchestrate many `claude` CLI agents in parallel from a ratatui TUI.

pub mod agent;
pub mod config;
pub mod mcp;
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
    // Internal: when launched as the per-agent MCP server (`orc __mcp --pane <id> --dir <dir>`),
    // speak MCP on stdio and exit. This is spawned by each agent's `claude` via `--mcp-config`.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("__mcp") {
        let (mut pane, mut dir) = (None, None);
        let mut it = args.iter().skip(2);
        while let Some(a) = it.next() {
            match a.as_str() {
                "--pane" => pane = it.next().cloned(),
                "--dir" => dir = it.next().cloned(),
                _ => {}
            }
        }
        if let (Some(pane), Some(dir)) = (pane, dir) {
            let _ = mcp::serve(&pane, std::path::Path::new(&dir));
        }
        return;
    }

    if let Err(e) = run() {
        eprintln!("orc: {e}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    use std::io::IsTerminal;
    use tmux::controller::{build_reexec_argv, detect_mode, Mode, TmuxController};

    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let flags = Cli::parse().into_flags();

    let config = match config::load_config(&flags) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            eprintln!("\nCreate ~/.orc/config.json (see examples/config.json).");
            std::process::exit(1);
        }
    };

    // Decide whether to drive tmux BEFORE touching the terminal: a bootstrap re-exec must happen on
    // the plain terminal so attaching tmux owns the screen cleanly.
    let disabled = config.tmux == Some(false);
    let is_tty = std::io::stdout().is_terminal();
    let mode = detect_mode(
        disabled,
        is_tty,
        TmuxController::is_available(),
        std::env::var_os("TMUX").is_some(),
        flags.tmux_child,
    );

    if mode == Mode::Bootstrap && !flags.tmux_child {
        // Launch our own tmux session and re-exec orc inside it; this process is replaced.
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let reexec = build_reexec_argv(&exe, &raw_args);
        TmuxController::bootstrap_and_reexec(&reexec)?;
        return Ok(());
    }

    // A dedicated multi-thread runtime drives the agent subprocesses; the UI loop runs on the main
    // thread (not a runtime worker) so it can `Handle::block_on` to start sessions synchronously.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let mut manager = agent::manager::AgentManager::new(config, rt.handle().clone());

    // Attach tmux (if any) BEFORE restoring agents, so restored agents get their shell panes too.
    if mode == Mode::Inside {
        let mut controller = TmuxController::new();
        if flags.tmux_child {
            controller.adopt();
        } else {
            controller.adopt_inside(None);
        }
        manager.set_tmux(Some(controller));
    }
    manager.restore();

    ui::app::run(&mut manager)?;

    manager.stop_all();
    // Give in-flight cancellations a moment to land, then drop the runtime.
    rt.shutdown_timeout(std::time::Duration::from_millis(200));
    Ok(())
}
