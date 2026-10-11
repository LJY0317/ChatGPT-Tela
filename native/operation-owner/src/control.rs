//! Operation-scoped loopback transport; no command replay, persistent executor or polling.
use crate::Bootstrap;
use std::io;

pub async fn run(input: Bootstrap) -> io::Result<()> {
    #[cfg(unix)]
    {
        posix::run(input).await
    }
    #[cfg(not(unix))]
    {
        let _ = input;
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

#[cfg(unix)]
mod posix {
    use super::*;
    use crate::{
        execution::{ExecutionView, OwnedCommand},
        invalid, recheck_approval, sign, uuid, verify,
    };
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::{
        Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use serde::Deserialize;
    use std::collections::HashSet;
    use std::convert::Infallible;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::process::ChildStdin;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, unix::AsyncFd};
    use tokio::net::TcpListener;
    use tokio::sync::{Mutex as AsyncMutex, Semaphore, watch};
    use tokio::task::JoinSet;

    const REQUEST_LIMIT: usize = 72 * 1024;
    const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
    const ACTIVE_LIMIT: usize = 16;
    const WRITE_LIMIT: usize = 256;
    // Bounds active local peer observation only; never times out or cancels the command.
    const PEER_LIMIT: Duration = Duration::from_secs(30);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct OperationRequest {
        version: u8,
        owner_id: String,
        operation_id: String,
        workspace_id: String,
        request_id: String,
        action: String,
        chars: Option<String>,
        yield_time_ms: Option<u64>,
    }
    struct Control {
        descriptor: serde_json::Value,
        secret: String,
        view: ExecutionView,
        bootstrap: Bootstrap,
        done: watch::Receiver<bool>,
        stdin: AsyncMutex<AsyncFd<ChildStdin>>,
        writes: Mutex<HashSet<String>>,
    }
    fn response(status: StatusCode) -> Response<Full<Bytes>> {
        Response::builder()
            .status(status)
            .header("connection", "close")
            .body(Full::new(Bytes::new()))
            .expect("constant response")
    }
    fn domain(direction: &str, body: &[u8]) -> Vec<u8> {
        let mut value = format!("tela-process-owner-{direction}-v1\0").into_bytes();
        value.extend_from_slice(body);
        value
    }
    fn nonblocking(stdin: ChildStdin) -> io::Result<AsyncFd<ChildStdin>> {
        let fd = stdin.as_raw_fd();
        // Preserve flags; readiness-driven writes cannot block the single event-loop thread.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        AsyncFd::new(stdin)
    }
    async fn write(state: &Control, bytes: &[u8]) -> io::Result<()> {
        let stdin = state.stdin.lock().await;
        // Queued inputs obtain fresh approval after acquiring exclusive write authority.
        recheck_approval(
            &state.bootstrap,
            state.descriptor["workspaceId"]
                .as_str()
                .ok_or_else(invalid)?,
        )?;
        if !state.view.input_available() {
            return Err(invalid());
        }
        let mut offset = 0;
        while offset < bytes.len() {
            let mut ready = stdin.writable().await?;
            let result = ready.try_io(|fd| {
                let mut handle = fd.get_ref();
                handle.write(&bytes[offset..])
            });
            match result {
                Err(_) => continue,
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Err(error),
                Ok(Ok(0)) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
                Ok(Ok(count)) => offset += count,
            }
        }
        Ok(())
    }
    async fn operation(
        mut request: Request<Incoming>,
        state: Arc<Control>,
    ) -> Response<Full<Bytes>> {
        if request.headers().contains_key("origin") {
            return response(StatusCode::FORBIDDEN);
        }
        if request.method() != hyper::Method::POST || request.uri().path() != "/v1/operation" {
            return response(StatusCode::NOT_FOUND);
        }
        let Some(signature) = request
            .headers()
            .get("x-tela-owner-request-signature")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
        else {
            return response(StatusCode::UNAUTHORIZED);
        };
        let mut body = Vec::new();
        while let Some(frame) = request.body_mut().frame().await {
            let Ok(frame) = frame else {
                return response(StatusCode::BAD_REQUEST);
            };
            if let Ok(bytes) = frame.into_data() {
                if body.len().saturating_add(bytes.len()) > REQUEST_LIMIT {
                    return response(StatusCode::PAYLOAD_TOO_LARGE);
                }
                body.extend_from_slice(&bytes);
            }
        }
        if !verify(
            state.secret.as_bytes(),
            &domain("request", &body),
            &signature,
        ) {
            return response(StatusCode::UNAUTHORIZED);
        }
        let Ok(input) = serde_json::from_slice::<OperationRequest>(&body) else {
            return response(StatusCode::BAD_REQUEST);
        };
        if input.version != 1
            || input.owner_id != state.descriptor["ownerId"]
            || input.operation_id != state.descriptor["operationId"]
            || input.workspace_id != state.descriptor["workspaceId"]
        {
            return response(StatusCode::CONFLICT);
        }
        if !uuid(&input.request_id) {
            return response(StatusCode::BAD_REQUEST);
        }
        let result = match input.action.as_str() {
            "status" => state.view.snapshot(false),
            "wait" => {
                let duration = input.yield_time_ms.unwrap_or(0);
                if duration > 12000 {
                    return response(StatusCode::BAD_REQUEST);
                }
                let mut done = state.done.clone();
                if !*done.borrow() && duration > 0 {
                    // Dropping this request abandons observation only; no execution cancellation.
                    tokio::select! { _=done.changed()=>{}, _=tokio::time::sleep(Duration::from_millis(duration))=>{} }
                }
                state.view.snapshot(true)
            }
            "stdin" => {
                let Some(chars) = input.chars else {
                    return response(StatusCode::BAD_REQUEST);
                };
                if chars.len() > 64 * 1024 {
                    return response(StatusCode::BAD_REQUEST);
                }
                {
                    let Ok(mut writes) = state.writes.lock() else {
                        return response(StatusCode::CONFLICT);
                    };
                    if writes.len() >= WRITE_LIMIT || !writes.insert(input.request_id.clone()) {
                        return response(StatusCode::CONFLICT);
                    }
                }
                // Reserve identity before any accepted write; failed/disconnected input is never replayed.
                if write(&state, chars.as_bytes()).await.is_err() {
                    return response(StatusCode::CONFLICT);
                }
                state.view.snapshot(false)
            }
            // No PID/signal fallback until an OS-owned-tree cancellation adapter is proved.
            "cancel" => return response(StatusCode::CONFLICT),
            _ => return response(StatusCode::BAD_REQUEST),
        };
        let Ok(result) = result else {
            return response(StatusCode::CONFLICT);
        };
        let value = serde_json::json!({"version":1,"ownerId":input.owner_id,"operationId":input.operation_id,
            "workspaceId":input.workspace_id,"requestId":input.request_id,"result":result});
        let Ok(bytes) = serde_json::to_vec(&value) else {
            return response(StatusCode::CONFLICT);
        };
        if bytes.len() > RESPONSE_LIMIT {
            return response(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let signature = sign(state.secret.as_bytes(), &domain("response", &bytes));
        Response::builder()
            .header("content-type", "application/json")
            .header("connection", "close")
            .header("x-tela-owner-signature", signature)
            .body(Full::new(Bytes::from(bytes)))
            .expect("validated response")
    }

    pub async fn run(input: Bootstrap) -> io::Result<()> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let mut command = OwnedCommand::start(&input)?;
        let claim = command.claim().clone();
        let secret = command.secret();
        let descriptor = serde_json::json!({"version":1,"ownerId":claim.owner_id,"operationId":claim.operation_id,
            "workspaceId":claim.workspace_id,"endpoint":format!("http://127.0.0.1:{}/v1/operation",listener.local_addr()?.port()),"secret":secret});
        let view = command.view();
        let (complete, done) = watch::channel(false);
        // Always retain completion ownership after the command has launched, including setup failure.
        let setup = (|| -> io::Result<_> {
            let stdin = nonblocking(command.take_stdin()?)?;
            command.publish_live(&descriptor)?;
            Ok(stdin)
        })();
        let finished_view = view.clone();
        std::thread::spawn(move || {
            if command.finish().is_err() {
                finished_view.mark_unknown();
            }
            complete.send_replace(true);
        });
        let stdin = match setup {
            Ok(stdin) => stdin,
            Err(error) => {
                let mut done = done;
                if !*done.borrow() {
                    let _ = done.changed().await;
                }
                return Err(error);
            }
        };
        let state = Arc::new(Control {
            descriptor,
            secret,
            view,
            bootstrap: input,
            done: done.clone(),
            stdin: AsyncMutex::new(stdin),
            writes: Mutex::new(HashSet::new()),
        });
        // A vanished manager must not take command ownership away or cause a replay.
        let _ = io::stdout().lock().write_all(b"TELA_OPERATION_READY\n");
        let _ = io::stdout().lock().flush();
        let permits = Arc::new(Semaphore::new(ACTIVE_LIMIT));
        let mut connections = JoinSet::new();
        let mut done = done;
        while !*done.borrow() {
            tokio::select! {
                _=done.changed()=>{},
                Some(_)=connections.join_next(), if !connections.is_empty()=>{},
                accepted=listener.accept()=>{
                    let (mut socket,_)=accepted?;
                    let Ok(permit)=permits.clone().try_acquire_owned() else {
                        // Refuse extra peers without creating another task or growing a queue.
                        let _=socket.try_write(b"HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                        let _=socket.shutdown().await;continue;
                    };
                    let state=state.clone();
                    connections.spawn(async move {
                        let _permit=permit;
                        let service=service_fn(move |request| {let state=state.clone();async move {Ok::<_,Infallible>(operation(request,state).await)}});
                        let mut builder=http1::Builder::new();builder.keep_alive(false).max_headers(32).max_buf_size(8192);
                        let connection=builder.serve_connection(TokioIo::new(socket),service);
                        let _=tokio::time::timeout(PEER_LIMIT,connection).await;
                    });
                },
            }
        }
        // Stop new admission, but deliver already-admitted terminal observations before exit.
        drop(listener);
        while connections.join_next().await.is_some() {}
        Ok(())
    }
}
