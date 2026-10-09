//! Talking to orcd: start it if needed, send commands, subscribe to events.

use crate::config;
use crate::proto::{Cmd, Ev};
use anyhow::{anyhow, bail, Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Connect to orcd, starting it (detached, in its own session) if it isn't running.
pub fn connect() -> Result<UnixStream> {
    let path = config::socket_path();
    if let Ok(s) = UnixStream::connect(&path) {
        return Ok(s);
    }
    std::fs::create_dir_all(config::dir())?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(config::dir().join("orcd.log"))?;
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("daemon").stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    // Detach from this terminal so closing it (or quitting the TUI) doesn't stop orcd.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("starting orcd")?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if let Ok(s) = UnixStream::connect(&path) {
            return Ok(s);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!("orcd didn't start; see {}", config::dir().join("orcd.log").display())
}

/// One command, one reply.
pub fn request(cmd: &Cmd) -> Result<Ev> {
    let mut s = connect()?;
    writeln!(s, "{}", serde_json::to_string(cmd)?)?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line)?;
    if line.is_empty() {
        return Err(anyhow!("orcd closed the connection"));
    }
    let ev: Ev = serde_json::from_str(&line)?;
    if let Ev::Error { message } = &ev {
        bail!("{message}");
    }
    Ok(ev)
}

/// Every event from orcd, starting with the requests list.
pub fn subscribe() -> Result<impl Iterator<Item = Ev>> {
    let mut s = connect()?;
    writeln!(s, "{}", serde_json::to_string(&Cmd::Subscribe)?)?;
    Ok(BufReader::new(s).lines().map_while(Result::ok).filter_map(|l| serde_json::from_str(&l).ok()))
}
