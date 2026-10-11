//! Command and pipe ownership foundation. Not admitted as the public worker role yet:
//! authenticated live control and owned-tree cancellation remain separate gates.
use crate::{
    Bootstrap, Claim, Journal, OUTPUT_LIMIT, authorize, invalid, recheck_approval, timestamp,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    truncated: bool,
    base_offset: u64,
    read_offset: u64,
}
impl Output {
    fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(OUTPUT_LIMIT);
        if overflow > 0 {
            self.truncated = true;
            self.bytes.drain(..overflow.min(self.bytes.len()));
            self.base_offset += overflow as u64;
        }
        self.bytes.extend(
            bytes[bytes.len().saturating_sub(OUTPUT_LIMIT)..]
                .iter()
                .copied(),
        );
    }
    fn consume(&mut self) -> (String, bool) {
        let offset = self.read_offset.saturating_sub(self.base_offset) as usize;
        let bytes: Vec<u8> = self.bytes.iter().skip(offset).copied().collect();
        self.read_offset = self.base_offset + self.bytes.len() as u64;
        (
            String::from_utf8_lossy(&bytes).into_owned(),
            self.truncated && offset == 0,
        )
    }
}
fn collect(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<Output>>,
) -> JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut buffer = [0; 16 * 1024];
        loop {
            let length = match reader.read(&mut buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                other => other?,
            };
            if length == 0 {
                return Ok(());
            }
            output
                .lock()
                .map_err(|_| invalid())?
                .append(&buffer[..length]);
        }
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub state: &'static str,
    pub ended_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_truncated: Option<bool>,
}

/// Read-only execution metadata/output observations. Stdin authority is kept separately.
#[derive(Clone)]
pub struct ExecutionView {
    output: Arc<Mutex<Output>>,
    terminal: Arc<Mutex<Option<Completion>>>,
    claim: Claim,
    session_id: u64,
    started_at: String,
    pid: u32,
}
impl ExecutionView {
    pub fn snapshot(&self, consume: bool) -> io::Result<serde_json::Value> {
        let terminal = self.terminal.lock().map_err(|_| invalid())?.clone();
        let (output, truncated) = if consume {
            self.output.lock().map_err(|_| invalid())?.consume()
        } else {
            (String::new(), false)
        };
        let mut value = serde_json::json!({
            "operationId":self.claim.operation_id,"workspaceId":self.claim.workspace_id,
            "serverInstanceId":self.claim.launching_server_id,"sessionId":self.session_id,
            "state":terminal.as_ref().map_or("running", |t| t.state),
            "startedAt":self.started_at,"updatedAt":terminal.as_ref().map_or(&self.started_at,|t| &t.ended_at),
            "pid":self.pid,"ioAvailable":terminal.is_none(),"output":output,
            "outputTruncated":truncated,"outputRecovered":false
        });
        if let Some(result) = terminal {
            value["endedAt"] = serde_json::json!(result.ended_at);
            if let Some(code) = result.exit_code {
                value["exitCode"] = serde_json::json!(code);
            }
            if let Some(signal) = result.signal {
                value["signal"] = serde_json::json!(signal);
            }
        }
        Ok(value)
    }
    pub fn mark_unknown(&self) {
        if let Ok(mut terminal) = self.terminal.lock() {
            *terminal = Some(Completion {
                state: "unknown",
                ended_at: timestamp().unwrap_or_else(|_| self.started_at.clone()),
                exit_code: None,
                signal: None,
                result_fingerprint: None,
                result_truncated: None,
            });
        }
    }
    pub fn input_available(&self) -> bool {
        self.terminal.lock().is_ok_and(|value| value.is_none())
    }
}
fn terminal(status: ExitStatus) -> Completion {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(signal_name)
    };
    #[cfg(not(unix))]
    let signal: Option<String> = None;
    Completion {
        state: if signal.is_some() {
            "signaled"
        } else {
            "exited"
        },
        ended_at: String::new(),
        exit_code: status.code(),
        signal,
        result_fingerprint: None,
        result_truncated: None,
    }
}
#[cfg(unix)]
fn signal_name(value: i32) -> String {
    // POSIX adapter only; unknown numeric signals stay explicit instead of invented names.
    let known = [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
    ];
    known
        .iter()
        .find_map(|(number, name)| (*number == value).then(|| name.to_string()))
        .unwrap_or_else(|| format!("SIG{value}"))
}

#[cfg(unix)]
fn pin_cwd(command: &mut Command, directory: &cap_std::fs::Dir) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let cwd = directory.try_clone()?.into_std_file();
    // Only async-signal-safe fchdir in the post-fork child. The captured descriptor pins
    // the approved directory even if its pathname is replaced before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(cwd.as_raw_fd()) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

/// Owns all command pipes independently of the requesting manager. Errors after reservation
/// preserve uncertainty; they never authorize a second launch or result-file overwrite.
pub struct OwnedCommand {
    child: Child,
    readers: Vec<JoinHandle<io::Result<()>>>,
    output: Arc<Mutex<Output>>,
    authorized: crate::AuthorizedExecution,
    claim: Claim,
    journal: Journal,
    results_path: PathBuf,
    view: ExecutionView,
}
impl OwnedCommand {
    pub fn start(input: &Bootstrap) -> io::Result<Self> {
        // No path-based cwd fallback on platforms without the verified pinned-directory adapter.
        #[cfg(not(unix))]
        {
            let _ = input;
            return Err(io::Error::from(io::ErrorKind::Unsupported));
        }
        #[cfg(unix)]
        {
            let authorized = authorize(input)?;
            let journal = Journal::open(&PathBuf::from(format!(
                "{}.executions",
                input.store_path.to_string_lossy()
            )))?;
            let claim = journal.reserve(&authorized)?;
            recheck_approval(input, &claim.workspace_id)?;
            let mut command = Command::new("/bin/sh");
            command
                .args(["-lc", &input.command])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            pin_cwd(&mut command, &authorized.cwd_dir)?;
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    let result = Completion {
                        state: "spawn_failed",
                        ended_at: timestamp()?,
                        exit_code: None,
                        signal: None,
                        result_fingerprint: None,
                        result_truncated: None,
                    };
                    journal.publish(
                        &authorized.key,
                        &claim.operation_id,
                        "completed",
                        &serde_json::json!({"claim":claim,"result":result}),
                    )?;
                    return Err(io::Error::from(io::ErrorKind::Other));
                }
            };
            let output = Arc::new(Mutex::new(Output::default()));
            let readers = vec![
                collect(child.stdout.take().ok_or_else(invalid)?, output.clone()),
                collect(child.stderr.take().ok_or_else(invalid)?, output.clone()),
            ];
            let view = ExecutionView {
                output: output.clone(),
                terminal: Arc::new(Mutex::new(None)),
                claim: claim.clone(),
                session_id: authorized.reservation.session_id,
                started_at: authorized.reservation.started_at.clone(),
                pid: child.id(),
            };
            Ok(Self {
                child,
                readers,
                output,
                authorized,
                claim,
                journal,
                results_path: PathBuf::from(format!(
                    "{}.results",
                    input.store_path.to_string_lossy()
                )),
                view,
            })
        }
    }
    /// Completion-only fixtures close stdin explicitly. Live input/control is not implemented here.
    pub fn close_stdin(&mut self) {
        self.child.stdin.take();
    }
    pub fn take_stdin(&mut self) -> io::Result<ChildStdin> {
        self.child.stdin.take().ok_or_else(invalid)
    }
    pub fn view(&self) -> ExecutionView {
        self.view.clone()
    }
    pub fn claim(&self) -> &Claim {
        &self.claim
    }
    pub fn secret(&self) -> String {
        self.authorized.key.owner_secret(&self.claim.owner_id)
    }
    pub fn publish_live(&self, descriptor: &serde_json::Value) -> io::Result<()> {
        self.journal.publish(
            &self.authorized.key,
            &self.claim.operation_id,
            "live",
            &serde_json::json!({"claim":self.claim,"descriptor":descriptor}),
        )
    }
    pub fn finish(mut self) -> io::Result<Completion> {
        let status = self.child.wait()?;
        // Completion means both streams reached EOF, including inherited background-child pipes.
        for reader in self.readers.drain(..) {
            reader.join().map_err(|_| invalid())??;
        }
        let output = self.output.lock().map_err(|_| invalid())?;
        let bytes: Vec<u8> = output.bytes.iter().copied().collect();
        let dir = Journal::open(&self.results_path)?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = dir
            .dir
            .open_with(format!("{}.bin", self.claim.operation_id), &options)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        dir.dir.try_clone()?.into_std_file().sync_all()?;
        let mut result = terminal(status);
        result.ended_at = timestamp()?;
        result.result_fingerprint = Some(self.authorized.key.result(
            &self.claim.operation_id,
            &self.claim.workspace_id,
            &bytes,
        )?);
        result.result_truncated = Some(output.truncated);
        self.journal.publish(
            &self.authorized.key,
            &self.claim.operation_id,
            "completed",
            &serde_json::json!({"claim":self.claim,"result":result}),
        )?;
        *self.view.terminal.lock().map_err(|_| invalid())? = Some(result.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_output_keeps_full_retained_tail_and_marks_lost_prefix() {
        let mut output = Output::default();
        output.append(b"first");
        assert_eq!(output.consume(), ("first".into(), false));
        output.append(b"second");
        assert_eq!(output.consume(), ("second".into(), false));
        assert_eq!(
            output.bytes.iter().copied().collect::<Vec<_>>(),
            b"firstsecond"
        );
        output.append(&vec![b'z'; OUTPUT_LIMIT + 1]);
        let (text, truncated) = output.consume();
        assert_eq!(text.len(), OUTPUT_LIMIT);
        assert!(truncated);
        assert_eq!(output.consume(), (String::new(), false));
    }
    #[cfg(unix)]
    #[test]
    fn child_cwd_remains_original_directory_after_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("approved");
        let moved = temp.path().join("moved");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("marker"), b"original").unwrap();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(&original, cap_std::ambient_authority()).unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "cat marker"]);
        pin_cwd(&mut command, &dir).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("marker"), b"replacement").unwrap();
        let result = command.output().unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"original");
    }
    #[test]
    fn output_retains_exact_tail_across_both_overflow_shapes() {
        let mut output = Output::default();
        output.append(&vec![b'a'; OUTPUT_LIMIT - 2]);
        output.append(b"bcde");
        assert_eq!(output.bytes.len(), OUTPUT_LIMIT);
        assert!(output.truncated);
        assert_eq!(
            output
                .bytes
                .iter()
                .rev()
                .take(4)
                .copied()
                .collect::<Vec<_>>(),
            b"edcb"
        );
        output.append(&vec![b'z'; OUTPUT_LIMIT + 100]);
        assert_eq!(output.bytes.len(), OUTPUT_LIMIT);
        assert!(output.bytes.iter().all(|v| *v == b'z'));
    }
    #[test]
    fn concurrent_collectors_drain_without_unbounded_queue() {
        let output = Arc::new(Mutex::new(Output::default()));
        let a = collect(io::Cursor::new(vec![b'a'; OUTPUT_LIMIT]), output.clone());
        let b = collect(io::Cursor::new(vec![b'b'; OUTPUT_LIMIT]), output.clone());
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
        let output = output.lock().unwrap();
        assert_eq!(output.bytes.len(), OUTPUT_LIMIT);
        assert!(output.truncated);
    }
}
