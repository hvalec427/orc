//! orcd: owns the requests, their agents and setup, and serves clients over
//! a Unix socket (see `proto.rs`). Runs detached, so agents keep working
//! while no TUI is open.

use crate::agent::{Agent, AgentEvent, AgentOpts};
use crate::config::{self, Config, Project};
use crate::proto::{Cmd, Ev, Item, PermState, Request, Status};
use crate::setup;
use anyhow::{anyhow, Result};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct State {
    cfg: Config,
    requests: Vec<Request>,
    agents: HashMap<String, Agent>,
    subs: Vec<Sender<String>>,
    perms: HashMap<String, (String, Sender<bool>)>, // perm id → (request id, answer)
    perm_seq: u64,
}

type Shared = Arc<Mutex<State>>;

impl State {
    fn broadcast(&mut self, ev: &Ev) {
        let line = serde_json::to_string(ev).unwrap_or_default();
        self.subs.retain(|s| s.send(line.clone()).is_ok());
    }

    fn req(&mut self, id: &str) -> Option<&mut Request> {
        self.requests.iter_mut().find(|r| r.id == id)
    }

    fn save_and_broadcast(&mut self) {
        config::save_requests(&self.requests);
        let list = self.requests.clone();
        self.broadcast(&Ev::Requests { list });
    }

    fn set_status(&mut self, id: &str, st: Status) {
        if let Some(r) = self.req(id) {
            if r.status != st {
                r.status = st;
                self.save_and_broadcast();
            }
        }
    }

    fn push(&mut self, id: &str, item: Item) {
        config::append_item(id, &item);
        self.broadcast(&Ev::Item { id: id.to_string(), item });
    }

    fn system(&mut self, id: &str, text: impl Into<String>) {
        self.push(id, Item::System { text: text.into() });
    }
}

pub fn run() -> Result<()> {
    std::fs::create_dir_all(config::dir())?;
    let path = config::socket_path();
    if UnixStream::connect(&path).is_ok() {
        return Err(anyhow!("orcd is already running ({})", path.display()));
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    let mut requests = config::load_requests();
    // Agents didn't survive the restart; they resume on the next message.
    for r in requests.iter_mut() {
        if matches!(r.status, Status::Working | Status::Approval | Status::Setup) {
            r.status = Status::Waiting;
        }
    }
    let state: Shared = Arc::new(Mutex::new(State { cfg: config::load_config()?, requests, agents: HashMap::new(), subs: Vec::new(), perms: HashMap::new(), perm_seq: 0 }));
    {
        let st = state.clone();
        std::thread::spawn(move || watch_metroctl(st));
    }
    eprintln!("orcd listening on {}", path.display());
    for stream in listener.incoming().flatten() {
        let st = state.clone();
        std::thread::spawn(move || {
            if let Err(e) = client(stream, st) {
                eprintln!("client: {e:#}");
            }
        });
    }
    Ok(())
}

fn reply(out: &mut UnixStream, ev: &Ev) -> Result<()> {
    writeln!(out, "{}", serde_json::to_string(ev)?)?;
    out.flush()?;
    Ok(())
}

fn client(stream: UnixStream, st: Shared) -> Result<()> {
    let mut out = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let cmd: Cmd = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                reply(&mut out, &Ev::Error { message: format!("bad command: {e}") })?;
                continue;
            }
        };
        match cmd {
            Cmd::Subscribe => {
                let (tx, rx) = channel();
                {
                    let mut s = st.lock().unwrap();
                    reply(&mut out, &Ev::Requests { list: s.requests.clone() })?;
                    s.subs.push(tx);
                }
                for line in rx {
                    if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                        break;
                    }
                }
                return Ok(());
            }
            Cmd::PermRequest { id, tool, input } => {
                let allow = ask_permission(&st, &id, &tool, &input);
                reply(&mut out, &Ev::Decision { allow, message: (!allow).then(|| "The user denied this in orc.".to_string()) })?;
            }
            Cmd::Shutdown => {
                // Socket first, so a client right behind us starts a new orcd
                // instead of reaching this one while it exits.
                let _ = std::fs::remove_file(config::socket_path());
                st.lock().unwrap().agents.clear(); // kills the claude processes
                reply(&mut out, &Ev::Ok { message: Some("orcd stopped".into()) })?;
                std::process::exit(0);
            }
            other => {
                let ev = handle(&st, other).unwrap_or_else(|e| Ev::Error { message: format!("{e:#}") });
                reply(&mut out, &ev)?;
            }
        }
    }
    Ok(())
}

fn handle(st: &Shared, cmd: Cmd) -> Result<Ev> {
    match cmd {
        Cmd::List => Ok(Ev::Requests { list: st.lock().unwrap().requests.clone() }),
        Cmd::Projects => {
            // Re-read so edits to config.json apply without restarting orcd.
            let mut s = st.lock().unwrap();
            if let Ok(c) = config::load_config() {
                s.cfg = c;
            }
            Ok(Ev::Projects { list: s.cfg.projects.iter().map(|p| p.name.clone()).collect() })
        }
        Cmd::History { id } => Ok(Ev::History { items: config::load_items(&id), id }),
        Cmd::New { project, title, prompt } => new_request(st, &project, &title, &prompt),
        Cmd::Send { id, text } => {
            send(st, &id, &text)?;
            Ok(Ev::Ok { message: None })
        }
        Cmd::Interrupt { id } => {
            let s = st.lock().unwrap();
            let a = s.agents.get(&id).ok_or_else(|| anyhow!("{id} has no running agent"))?;
            a.interrupt()?;
            Ok(Ev::Ok { message: Some("interrupted".into()) })
        }
        Cmd::Answer { id: _, perm, allow } => {
            let mut s = st.lock().unwrap();
            let (rid, tx) = s.perms.remove(&perm).ok_or_else(|| anyhow!("no open permission prompt {perm}"))?;
            let _ = tx.send(allow);
            let _ = rid;
            Ok(Ev::Ok { message: None })
        }
        Cmd::Teardown { id } => {
            teardown(st, &id)?;
            Ok(Ev::Ok { message: Some(format!("tearing down {id}")) })
        }
        Cmd::Finish { id, how } => {
            finish(st, &id, how)?;
            Ok(Ev::Ok { message: Some(format!("{} {id}…", match how { crate::proto::Finish::Pr => "opening a PR for", _ => "landing" })) })
        }
        Cmd::Remove { id } => {
            let mut s = st.lock().unwrap();
            let r = s.req(&id).ok_or_else(|| anyhow!("no request {id}"))?;
            if r.status != Status::Stopped {
                return Err(anyhow!("tear {id} down first"));
            }
            s.requests.retain(|r| r.id != id);
            config::remove_items(&id);
            s.save_and_broadcast();
            Ok(Ev::Ok { message: Some(format!("removed {id}")) })
        }
        Cmd::Subscribe | Cmd::PermRequest { .. } | Cmd::Shutdown => unreachable!(),
    }
}

fn new_request(st: &Shared, project: &str, title: &str, prompt: &str) -> Result<Ev> {
    let (req, p, session) = {
        let mut s = st.lock().unwrap();
        if let Ok(c) = config::load_config() {
            s.cfg = c;
        }
        let p = s.cfg.project(project)?.clone();
        let taken: Vec<String> = s.requests.iter().map(|r| r.id.clone()).collect();
        let id = config::slug(title, &taken);
        let req = Request {
            worktree: p.worktrees_dir().join(&id).display().to_string(),
            branch: id.clone(),
            id,
            project: p.name.clone(),
            title: title.to_string(),
            session_id: None,
            status: Status::Setup,
            created: config::now(),
            port: None,
            udid: None,
            app: None,
        };
        s.requests.push(req.clone());
        s.save_and_broadcast();
        s.push(&req.id, Item::User { text: prompt.to_string() });
        (req, p, s.cfg.tmux_session())
    };
    let (st2, id, prompt) = (st.clone(), req.id.clone(), prompt.to_string());
    std::thread::spawn(move || {
        if let Err(e) = prepare(&st2, &p, &session, &id, &prompt) {
            let mut s = st2.lock().unwrap();
            s.system(&id, format!("setup failed: {e:#}"));
            s.set_status(&id, Status::Error);
        }
    });
    Ok(Ev::Ok { message: Some(req.id) })
}

/// Worktree → copies → setup command → metroctl window → agent.
fn prepare(st: &Shared, p: &Project, session: &str, id: &str, prompt: &str) -> Result<()> {
    let log = |t: String| st.lock().unwrap().system(id, t);
    let wt = setup::create_worktree(p, id)?;
    log(format!("worktree {} on branch {id}", wt.display()));
    let copied = setup::copy_files(p, &wt)?;
    if !copied.is_empty() {
        log(format!("copied {}", copied.join(", ")));
    }
    if let Some(cmd) = &p.setup {
        log(format!("running {cmd}…"));
        setup::run_setup(cmd, &wt)?;
        log("setup done".into());
    }
    let mc = p.metroctl_command();
    setup::open_window(session, id, &wt, &mc)?;
    log(format!("tmux window {session}:{id} running `{mc}`"));
    start_agent(st, id, Some(prompt))?;
    Ok(())
}

fn system_prompt(req: &Request) -> String {
    format!(
        "You are working in a git worktree of the {project} React Native app at {wt}, on branch {branch}, as one of several \
         agents run by orc (each in its own worktree). The app runs on a dedicated iOS simulator with its own Metro, managed by \
         metroctl in a tmux window.\n\n\
         The app and Metro, through the metroctl MCP tools: `wait_ready` (blocks until the app is built and running, or the build \
         failed), `errors` and `logs` after changes, `network` and `request` for API calls, `reload` if the JS state is stale, \
         `rebuild` after native changes (Podfile, ios/, native modules; run `cd ios && pod install` first if pods changed), \
         `restart_metro` after metro config or JS dependency changes.\n\n\
         The screen, through the `touchctl` CLI (it already targets your simulator): `touchctl screenshot` prints a JPEG path, \
         read it to see the screen; `touchctl ui` lists elements with #testID, \"label\" and @x,y; `touchctl tap --id <testID>` \
         (or --label <text>, or x y); `touchctl swipe up|down|left|right`; `touchctl type <text> --id <field>`; \
         `touchctl press home|enter`; `touchctl open <url>` for deep links.\n\n\
         The app may still be building when you start: call `wait_ready` instead of ending your turn or sleeping in the \
         background to wait, since nothing wakes you up after a turn ends. Commit your work on this branch when a step is done. \
         Never push, and never touch other worktrees.",
        project = req.project,
        wt = req.worktree,
        branch = req.branch
    )
}

fn start_agent(st: &Shared, id: &str, first: Option<&str>) -> Result<()> {
    let (req, p) = {
        let s = st.lock().unwrap();
        let req = s.requests.iter().find(|r| r.id == id).cloned().ok_or_else(|| anyhow!("no request {id}"))?;
        let p = s.cfg.project(&req.project)?.clone();
        (req, p)
    };
    let exe = std::env::current_exe()?.display().to_string();
    let mcp = json!({ "mcpServers": {
        "metroctl": { "command": "metroctl", "args": ["mcp"] },
        "orc": { "command": exe, "args": ["perm-mcp", "--request", id] },
    }});
    let opts = AgentOpts {
        cwd: req.worktree.clone(),
        resume: req.session_id.clone(),
        mcp_config: mcp.to_string(),
        permission_mode: Some(p.permission_mode.clone().unwrap_or_else(|| "acceptEdits".into())),
        allowed_tools: {
            // The session tools are always allowed, on top of the project's list.
            let mut t = p.allowed_tools.clone();
            for must in ["mcp__metroctl__*", "Bash(touchctl *)"] {
                if !t.iter().any(|x| x == must) {
                    t.push(must.into());
                }
            }
            t
        },
        model: p.model.clone(),
        system_prompt: system_prompt(&req),
    };
    let (st2, rid) = (st.clone(), id.to_string());
    let agent = Agent::start(opts, move |ev| on_agent(&st2, &rid, ev))?;
    if let Some(text) = first {
        agent.send(text)?;
    }
    let mut s = st.lock().unwrap();
    s.agents.insert(id.to_string(), agent);
    s.set_status(id, if first.is_some() { Status::Working } else { Status::Waiting });
    Ok(())
}

fn on_agent(st: &Shared, id: &str, ev: AgentEvent) {
    let mut s = st.lock().unwrap();
    match ev {
        AgentEvent::SessionId(sid) => {
            if let Some(r) = s.req(id) {
                if r.session_id.as_deref() != Some(&sid) {
                    r.session_id = Some(sid);
                    s.save_and_broadcast();
                }
            }
        }
        AgentEvent::Delta(text) => s.broadcast(&Ev::Delta { id: id.to_string(), text }),
        AgentEvent::Item(mut item) => {
            // Worktree paths → relative: shorter, and the same for every request.
            if let Some(wt) = s.req(id).map(|r| format!("{}/", r.worktree.trim_end_matches('/'))) {
                match &mut item {
                    Item::Tool { summary: t, .. } | Item::ToolResult { preview: t, .. } | Item::Permission { summary: t, .. } => *t = t.replace(&wt, ""),
                    _ => {}
                }
            }
            s.push(id, item)
        }
        AgentEvent::TurnDone => {
            if s.req(id).is_some_and(|r| r.status != Status::Stopped) {
                s.set_status(id, Status::Waiting);
            }
        }
        AgentEvent::Exited => {
            s.agents.remove(id);
            if s.req(id).is_some_and(|r| r.status == Status::Working || r.status == Status::Approval) {
                s.system(id, "the agent stopped; your next message resumes it");
                s.set_status(id, Status::Waiting);
            }
        }
    }
}

fn send(st: &Shared, id: &str, text: &str) -> Result<()> {
    let running = {
        let mut s = st.lock().unwrap();
        let r = s.req(id).ok_or_else(|| anyhow!("no request {id}"))?;
        if r.status == Status::Stopped {
            return Err(anyhow!("{id} was torn down"));
        }
        if r.status == Status::Setup {
            return Err(anyhow!("{id} is still being set up"));
        }
        s.push(id, Item::User { text: text.to_string() });
        s.agents.contains_key(id)
    };
    if running {
        let mut s = st.lock().unwrap();
        s.agents[id].send(text)?;
        s.set_status(id, Status::Working);
        Ok(())
    } else {
        start_agent(st, id, Some(text))
    }
}

fn teardown(st: &Shared, id: &str) -> Result<()> {
    let (p, session, wt) = {
        let mut s = st.lock().unwrap();
        let r = s.req(id).cloned().ok_or_else(|| anyhow!("no request {id}"))?;
        s.agents.remove(id);
        // Deny anything still waiting for an answer.
        let open: Vec<String> = s.perms.iter().filter(|(_, (rid, _))| rid == id).map(|(k, _)| k.clone()).collect();
        for k in open {
            if let Some((_, tx)) = s.perms.remove(&k) {
                let _ = tx.send(false);
            }
        }
        s.system(id, "tearing down…");
        (s.cfg.project(&r.project)?.clone(), s.cfg.tmux_session(), PathBuf::from(r.worktree))
    };
    let (st2, id) = (st.clone(), id.to_string());
    std::thread::spawn(move || {
        let problems = setup::teardown(&p, &session, &id, &wt);
        let mut s = st2.lock().unwrap();
        if problems.is_empty() {
            s.system(&id, format!("torn down (branch {id} kept)"));
        } else {
            s.system(&id, format!("torn down with problems:\n{}", problems.join("\n")));
        }
        if let Some(r) = s.req(&id) {
            r.port = None;
            r.udid = None;
            r.app = None;
        }
        s.set_status(&id, Status::Stopped);
        s.save_and_broadcast();
    });
    Ok(())
}

fn finish(st: &Shared, id: &str, how: crate::proto::Finish) -> Result<()> {
    use crate::proto::Finish;
    let (r, p, session) = {
        let s = st.lock().unwrap();
        let r = s.requests.iter().find(|r| r.id == id).cloned().ok_or_else(|| anyhow!("no request {id}"))?;
        if r.status == Status::Stopped {
            return Err(anyhow!("{id} was torn down"));
        }
        if matches!(r.status, Status::Working | Status::Approval | Status::Setup) {
            return Err(anyhow!("{id}'s agent is still busy; wait for it (or ^c to interrupt)"));
        }
        (r.clone(), s.cfg.project(&r.project)?.clone(), s.cfg.tmux_session())
    };
    let (st2, id) = (st.clone(), id.to_string());
    std::thread::spawn(move || {
        let log = |t: String| st2.lock().unwrap().system(&id, t);
        match how {
            Finish::Pr => match crate::finish::create_pr(&p, &r) {
                Ok(url) => log(format!("PR: {url}")),
                Err(e) => log(format!("couldn't open a PR: {e:#}")),
            },
            Finish::Rebase | Finish::Squash => match crate::finish::land(&p, &r, how == Finish::Squash) {
                Ok(summary) => {
                    log(summary);
                    st2.lock().unwrap().agents.remove(&id);
                    let problems = setup::teardown(&p, &session, &id, Path::new(&r.worktree));
                    let deleted = std::process::Command::new("git").args(["-C", &p.root, "branch", "-D", &r.branch]).output().is_ok_and(|o| o.status.success());
                    let mut s = st2.lock().unwrap();
                    if !problems.is_empty() {
                        s.system(&id, format!("teardown problems:\n{}", problems.join("\n")));
                    }
                    s.system(&id, format!("worktree removed{}", if deleted { format!(", branch {} deleted", r.branch) } else { String::new() }));
                    if let Some(r) = s.req(&id) {
                        (r.port, r.udid, r.app) = (None, None, None);
                    }
                    s.set_status(&id, Status::Stopped);
                    s.save_and_broadcast();
                }
                Err(e) => log(format!("couldn't land {id}: {e:#}")),
            },
        }
    });
    Ok(())
}

/// Block until the user answers a permission prompt in the TUI.
fn ask_permission(st: &Shared, id: &str, tool: &str, input: &serde_json::Value) -> bool {
    let (tx, rx) = channel();
    let (perm, summary) = {
        let mut s = st.lock().unwrap();
        if s.req(id).is_none() {
            return false;
        }
        s.perm_seq += 1;
        let perm = format!("p{}-{}", config::now(), s.perm_seq);
        let wt = s.req(id).map(|r| format!("{}/", r.worktree.trim_end_matches('/'))).unwrap_or_default();
        let summary = crate::agent::tool_summary(tool, input).replace(&wt, "");
        s.perms.insert(perm.clone(), (id.to_string(), tx));
        s.push(id, Item::Permission { id: perm.clone(), tool: tool.to_string(), summary: summary.clone(), state: PermState::Pending });
        s.set_status(id, Status::Approval);
        (perm, summary)
    };
    let allow = rx.recv().unwrap_or(false);
    let mut s = st.lock().unwrap();
    s.perms.remove(&perm);
    s.push(id, Item::Permission { id: perm, tool: tool.to_string(), summary, state: if allow { PermState::Allowed } else { PermState::Denied } });
    if !s.perms.values().any(|(rid, _)| rid == id) && s.req(id).is_some_and(|r| r.status == Status::Approval) {
        s.set_status(id, Status::Working);
    }
    allow
}

/// Mirror each worktree's metroctl session (port, simulator, app status).
fn watch_metroctl(st: Shared) {
    loop {
        std::thread::sleep(Duration::from_secs(3));
        let wts: Vec<(String, String)> = st.lock().unwrap().requests.iter().filter(|r| r.status != Status::Stopped).map(|r| (r.id.clone(), r.worktree.clone())).collect();
        let found: Vec<(String, Option<(Option<u16>, Option<String>, Option<String>)>)> = wts.into_iter().map(|(id, wt)| (id, setup::metro_session(Path::new(&wt)))).collect();
        let mut s = st.lock().unwrap();
        let mut changed = false;
        for (id, ms) in found {
            let (port, udid, app) = ms.unwrap_or((None, None, None));
            if let Some(r) = s.req(&id) {
                if r.port != port || r.udid != udid || r.app != app {
                    (r.port, r.udid, r.app) = (port, udid, app);
                    changed = true;
                }
            }
        }
        if changed {
            s.save_and_broadcast();
        }
    }
}
