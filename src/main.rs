//! orc — run Claude Code agents on React Native feature requests, each in its
//! own worktree with its own Metro and simulator (via metroctl). `orc` opens
//! the TUI; the agents live in the background daemon (`orc daemon`).

mod agent;
mod client;
mod config;
mod daemon;
mod finish;
mod perm;
mod proto;
mod setup;
mod tui;
mod update;

use clap::{Parser, Subcommand};
use proto::{Cmd, Ev, Item};

#[derive(Parser)]
#[command(name = "orc", version, about = "Run Claude Code agents on feature requests, one worktree and simulator each")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run orcd in the foreground (normally started for you)
    Daemon,
    /// Stop orcd and its agents
    Stop,
    /// Start a feature request
    New {
        #[arg(long)]
        project: String,
        #[arg(long)]
        title: String,
        prompt: String,
    },
    /// Send a message to a request's agent
    Send { id: String, text: String },
    /// List requests
    Ls,
    /// Print a request's conversation
    Log { id: String },
    /// Tear a request down (agent, simulator, worktree; the branch is kept if it has commits)
    Down {
        id: String,
        /// Delete the branch even if it has commits
        #[arg(long)]
        delete_branch: bool,
    },
    /// Finish a request: pr (push + open a PR), rebase or squash (land on the base branch locally, then tear down)
    Finish { id: String, how: String },
    /// Remove a torn-down request from the list
    Rm { id: String },
    /// Permission-prompt MCP server for an agent (used by orcd)
    #[command(name = "perm-mcp", hide = true)]
    PermMcp {
        #[arg(long)]
        request: String,
    },
    /// Check whether a newer version of orc is available
    #[command(name = "check-update")]
    CheckUpdate {
        #[arg(long)]
        stable: bool,
        #[arg(long)]
        nightly: bool,
        #[arg(long)]
        dev: bool,
    },
    /// Update orc to the latest version (stays on the installed build's channel)
    Update {
        #[arg(long)]
        stable: bool,
        #[arg(long)]
        nightly: bool,
        #[arg(long)]
        dev: bool,
        /// Install the channel's latest even if it's the same or an older version
        #[arg(long)]
        force: bool,
    },
}

fn main() {
    let cli = Cli::parse();
    let res = match cli.command {
        None => tui::run(),
        Some(Command::Daemon) => daemon::run(),
        Some(Command::Stop) => print(client::request(&Cmd::Shutdown)),
        Some(Command::New { project, title, prompt }) => print(client::request(&Cmd::New { project, title, prompt })),
        Some(Command::Send { id, text }) => print(client::request(&Cmd::Send { id, text })),
        Some(Command::Down { id, delete_branch }) => print(client::request(&Cmd::Teardown { id, delete_branch })),
        Some(Command::Rm { id }) => print(client::request(&Cmd::Remove { id })),
        Some(Command::Finish { id, how }) => {
            let how = match how.as_str() {
                "pr" => proto::Finish::Pr,
                "rebase" => proto::Finish::Rebase,
                "squash" => proto::Finish::Squash,
                h => {
                    eprintln!("unknown way to finish {h:?} (pr, rebase, squash)");
                    std::process::exit(2);
                }
            };
            print(client::request(&Cmd::Finish { id, how }))
        }
        Some(Command::Ls) => client::request(&Cmd::List).map(|ev| {
            if let Ev::Requests { list } = ev {
                for r in list {
                    let app = match (r.port, &r.app) {
                        (Some(p), Some(a)) => format!(":{p} {a}"),
                        _ => String::new(),
                    };
                    println!("{:<28} {:<9} {:<14} {}", r.id, r.status.label(), app, r.title);
                }
            }
        }),
        Some(Command::Log { id }) => client::request(&Cmd::History { id }).map(|ev| {
            if let Ev::History { items, .. } = ev {
                for i in items {
                    println!("{}", plain(&i));
                }
            }
        }),
        Some(Command::PermMcp { request }) => {
            perm::run(&request);
            Ok(())
        }
        Some(Command::CheckUpdate { stable, nightly, dev }) => {
            update::check_update(stable, nightly, dev);
            Ok(())
        }
        Some(Command::Update { stable, nightly, dev, force }) => {
            update::update(stable, nightly, dev, force);
            Ok(())
        }
    };
    if let Err(e) = res {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

fn print(r: anyhow::Result<Ev>) -> anyhow::Result<()> {
    if let Ev::Ok { message: Some(m) } = r? {
        println!("{m}");
    }
    Ok(())
}

/// A conversation item as plain text (for `orc log`).
fn plain(i: &Item) -> String {
    match i {
        Item::User { text } => format!("> {text}"),
        Item::Assistant { text } => text.clone(),
        Item::Tool { name, summary, .. } => format!("  ⚙ {name} {summary}"),
        Item::ToolResult { ok, preview, .. } => format!("    {} {}", if *ok { "↳" } else { "✗" }, preview.replace('\n', "\n      ")),
        Item::System { text } => format!("· {text}"),
        Item::Permission { tool, summary, state, .. } => format!("  ? {tool} {summary} [{state:?}]"),
        Item::Turn { cost, error } => match error {
            Some(e) => format!("— turn failed: {e}"),
            None => format!("— turn done{}", cost.map(|c| format!(" (${c:.2})")).unwrap_or_default()),
        },
    }
}
