use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use subtle::ConstantTimeEq;
use tela_workspace_files::identity;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub mod control;
pub mod execution;

pub const BOOTSTRAP_LIMIT: usize = 128 * 1024;
pub const OUTPUT_LIMIT: usize = 512 * 1024;
const STORE_LIMIT: usize = 1024 * 1024;
const RECORD_LIMIT: usize = 4096;
fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidData)
}
fn json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    serde_json::from_slice(bytes).map_err(|_| invalid())
}
fn encode<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| invalid())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bootstrap {
    pub version: u8,
    pub operation_id: String,
    pub store_path: PathBuf,
    pub workspace_store_path: PathBuf,
    pub approved_roots_path: PathBuf,
    pub command: String,
    pub working_directory: Option<String>,
}
impl Bootstrap {
    pub fn read(reader: impl Read) -> io::Result<Self> {
        let mut bytes = Vec::new();
        reader
            .take((BOOTSTRAP_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > BOOTSTRAP_LIMIT {
            return Err(invalid());
        }
        let value: Self = json(&bytes)?;
        if value.version != 1
            || !uuid(&value.operation_id)
            || value.command.trim().is_empty()
            || value.command.len() > 64 * 1024
            || value.command.contains('\0')
            || !value.store_path.is_absolute()
            || !value.workspace_store_path.is_absolute()
            || !value.approved_roots_path.is_absolute()
        {
            return Err(invalid());
        }
        Ok(value)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u8,
    next_session_id: u64,
    request_key: String,
    operations: Vec<serde_json::Value>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reservation {
    pub operation_id: String,
    pub server_instance_id: String,
    pub workspace_id: String,
    pub session_id: u64,
    pub state: String,
    pub execution_mode: String,
    pub request_fingerprint: String,
    pub started_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    version: u8,
    roots: Vec<PathBuf>,
}
#[derive(Deserialize)]
struct Workspaces {
    version: u8,
    workspaces: Vec<Workspace>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    #[serde(default = "user_kind")]
    kind: String,
    root: PathBuf,
    device: String,
    inode: String,
}
fn user_kind() -> String {
    "user".into()
}

/// The key has no Debug/Serialize representation and is never copied to bootstrap or argv.
pub struct ExecutionKey(String);
impl ExecutionKey {
    pub fn from_hex(value: String) -> io::Result<Self> {
        if !digest(&value) {
            return Err(invalid());
        }
        Ok(Self(value))
    }
    pub fn request(&self, workspace: &str, cwd: &str, command: &str) -> io::Result<String> {
        let key = decode_hex(&self.0)?;
        Ok(sign(
            &key,
            &encode(&["tela-chat-exec-v1", workspace, cwd, command])?,
        ))
    }
    pub fn journal(&self, phase: &str, body: &[u8]) -> io::Result<String> {
        if !["claim", "live", "completed"].contains(&phase) {
            return Err(invalid());
        }
        let mut message = format!("tela-process-journal-{phase}-v1\0").into_bytes();
        message.extend_from_slice(body);
        Ok(sign(self.0.as_bytes(), &message))
    }
    pub fn owner_secret(&self, owner: &str) -> String {
        sign(
            self.0.as_bytes(),
            format!("tela-owner-control-v1\0{owner}").as_bytes(),
        )
    }
    pub fn result(&self, operation: &str, workspace: &str, bytes: &[u8]) -> io::Result<String> {
        let mut message = encode(&["tela-chat-result-v1", operation, workspace])?;
        message.extend_from_slice(bytes);
        Ok(sign(&decode_hex(&self.0)?, &message))
    }
}
pub fn sign(key: &[u8], body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(body);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn verify(key: &[u8], body: &[u8], expected: &str) -> bool {
    let Ok(signature) = decode_hex(expected) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(body);
    mac.verify_slice(&signature).is_ok()
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decode_hex(value: &str) -> io::Result<Vec<u8>> {
    if !digest(value) {
        return Err(invalid());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| invalid()))
        .collect()
}
pub(crate) fn uuid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
        && (b'1'..=b'8').contains(&b[14])
        && b"89ab".contains(&b[19])
}
fn opaque(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.contains(['\0', '\r', '\n'])
}
pub fn fresh_id() -> io::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| invalid())?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let hex: String = b.iter().map(|v| format!("{v:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
pub fn timestamp() -> io::Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| invalid())
}

/// Read a bounded regular file through a pinned parent; never follow its final symlink.
pub fn read_private(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let parent = Dir::open_ambient_dir(
        path.parent().ok_or_else(invalid)?,
        cap_std::ambient_authority(),
    )?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = parent.open_with(path.file_name().ok_or_else(invalid)?, &options)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid());
    }
    Ok(bytes)
}

pub struct AuthorizedExecution {
    pub reservation: Reservation,
    pub cwd: PathBuf,
    pub key: ExecutionKey,
    pub cwd_dir: Dir,
}
fn approved_workspace(input: &Bootstrap, workspace_id: &str) -> io::Result<(PathBuf, Dir)> {
    let approval: Approval = json(&read_private(&input.approved_roots_path, BOOTSTRAP_LIMIT)?)?;
    let workspaces: Workspaces = json(&read_private(&input.workspace_store_path, STORE_LIMIT)?)?;
    if approval.version != 1 || approval.roots.is_empty() || workspaces.version != 1 {
        return Err(invalid());
    }
    let matching: Vec<_> = workspaces
        .workspaces
        .iter()
        .filter(|w| w.id == workspace_id)
        .collect();
    if matching.len() != 1 {
        return Err(invalid());
    }
    let workspace = matching[0];
    if workspace.kind != "user" || !workspace.root.is_absolute() {
        return Err(invalid());
    }
    let stat = fs::symlink_metadata(&workspace.root)?;
    if !stat.is_dir() || stat.is_symlink() || fs::canonicalize(&workspace.root)? != workspace.root {
        return Err(invalid());
    }
    let dir = Dir::open_ambient_dir(&workspace.root, cap_std::ambient_authority())?;
    if identity(&dir.dir_metadata()?)? != (workspace.device.clone(), workspace.inode.clone()) {
        return Err(invalid());
    }
    let mut allowed = false;
    for root in approval.roots {
        if !root.is_absolute()
            || root
                .to_str()
                .is_none_or(|s| s.trim().is_empty() || s.contains(['\0', '\r', '\n']))
        {
            return Err(invalid());
        }
        let stat = fs::symlink_metadata(&root)?;
        if !stat.is_dir() || stat.is_symlink() {
            return Err(invalid());
        }
        if workspace.root.starts_with(fs::canonicalize(root)?) {
            allowed = true;
        }
    }
    if !allowed {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok((workspace.root.clone(), dir))
}
pub fn authorize(input: &Bootstrap) -> io::Result<AuthorizedExecution> {
    let store: Store = json(&read_private(&input.store_path, STORE_LIMIT)?)?;
    if store.version != 2
        || store.next_session_id == 0
        || store.next_session_id >= 9_007_199_254_740_991
        || store.operations.len() > 256
    {
        return Err(invalid());
    }
    let mut operation_ids = HashSet::new();
    let mut session_ids = HashSet::new();
    for row in &store.operations {
        let operation = row
            .get("operationId")
            .and_then(|v| v.as_str())
            .ok_or_else(invalid)?;
        let session = row
            .get("sessionId")
            .and_then(|v| v.as_u64())
            .ok_or_else(invalid)?;
        if !uuid(operation)
            || session == 0
            || session >= 9_007_199_254_740_991
            || session >= store.next_session_id
            || !operation_ids.insert(operation.to_ascii_lowercase())
            || !session_ids.insert(session)
        {
            return Err(invalid());
        }
    }
    let rows: Vec<_> = store
        .operations
        .iter()
        .filter(|r| r.get("operationId").and_then(|v| v.as_str()) == Some(&input.operation_id))
        .collect();
    if rows.len() != 1 {
        return Err(invalid());
    }
    let reservation: Reservation =
        serde_json::from_value(rows[0].clone()).map_err(|_| invalid())?;
    if reservation.state != "starting"
        || reservation.execution_mode != "owned-worker-v1"
        || !uuid(&reservation.operation_id)
        || !uuid(&reservation.server_instance_id)
        || !opaque(&reservation.workspace_id)
        || reservation.session_id == 0
        || reservation.session_id >= 9_007_199_254_740_991
        || !digest(&reservation.request_fingerprint)
    {
        return Err(invalid());
    }
    let (root, root_dir) = approved_workspace(input, &reservation.workspace_id)?;
    let working = input
        .working_directory
        .as_deref()
        .unwrap_or("")
        .replace('\\', "/");
    let relative = Path::new(&working);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        || working.contains(['\0', '\r', '\n'])
    {
        return Err(invalid());
    }
    let cwd = if working.trim().is_empty() {
        root.clone()
    } else {
        fs::canonicalize(root.join(relative))?
    };
    if !cwd.starts_with(&root) || !fs::metadata(&cwd)?.is_dir() {
        return Err(invalid());
    }
    let cwd_dir = if cwd == root {
        root_dir
    } else {
        root_dir.open_dir(cwd.strip_prefix(&root).map_err(|_| invalid())?)?
    };
    let key = ExecutionKey::from_hex(store.request_key)?;
    let expected = key.request(
        &reservation.workspace_id,
        cwd.to_str().ok_or_else(invalid)?,
        &input.command,
    )?;
    if !verify_request(&expected, &reservation.request_fingerprint) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(AuthorizedExecution {
        reservation,
        cwd,
        key,
        cwd_dir,
    })
}
fn verify_request(a: &str, b: &str) -> bool {
    let Ok(a) = decode_hex(a) else { return false };
    let Ok(b) = decode_hex(b) else { return false };
    a.ct_eq(&b).into()
}
pub fn recheck_approval(input: &Bootstrap, workspace_id: &str) -> io::Result<()> {
    approved_workspace(input, workspace_id).map(|_| ())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub version: u8,
    pub operation_id: String,
    pub workspace_id: String,
    pub owner_id: String,
    pub launching_server_id: String,
    pub request_fingerprint: String,
    pub claimed_at: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    body: String,
    signature: String,
}
/// Pinned journal directory; phase records are exclusive and never overwritten, even if incomplete.
pub struct Journal {
    dir: Dir,
}
impl Journal {
    pub fn open(path: &Path) -> io::Result<Self> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
        let stat = fs::symlink_metadata(path)?;
        if !stat.is_dir() || stat.is_symlink() {
            return Err(invalid());
        }
        let parent = Dir::open_ambient_dir(
            path.parent().ok_or_else(invalid)?,
            cap_std::ambient_authority(),
        )?;
        let dir = parent.open_dir_nofollow(path.file_name().ok_or_else(invalid)?)?;
        Ok(Self { dir })
    }
    pub fn publish<T: Serialize>(
        &self,
        key: &ExecutionKey,
        operation_id: &str,
        phase: &str,
        value: &T,
    ) -> io::Result<()> {
        if !uuid(operation_id) {
            return Err(invalid());
        }
        let body = String::from_utf8(encode(value)?).map_err(|_| invalid())?;
        let envelope = Envelope {
            signature: key.journal(phase, body.as_bytes())?,
            body,
        };
        let bytes = encode(&envelope)?;
        if bytes.len() > RECORD_LIMIT {
            return Err(invalid());
        }
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
        let mut file = self
            .dir
            .open_with(format!("{operation_id}.{phase}.json"), &options)?;
        file.write_all(&bytes)?;
        // Do not grant execution/publication authority before record bytes are flushed.
        // A failed flush preserves the exclusive claim. POSIX directory publication is
        // synchronized too; ancestor/hardware power-loss guarantees remain unverified.
        file.sync_all()?;
        #[cfg(unix)]
        self.dir.try_clone()?.into_std_file().sync_all()?;
        Ok(())
    }
    pub fn reserve(&self, authorized: &AuthorizedExecution) -> io::Result<Claim> {
        let r = &authorized.reservation;
        let claim = Claim {
            version: 1,
            operation_id: r.operation_id.clone(),
            workspace_id: r.workspace_id.clone(),
            owner_id: fresh_id()?,
            launching_server_id: r.server_instance_id.clone(),
            request_fingerprint: r.request_fingerprint.clone(),
            claimed_at: timestamp()?,
        };
        self.publish(&authorized.key, &claim.operation_id, "claim", &claim)?;
        Ok(claim)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_synthetic_key_domains_match_node_crypto_vectors() {
        let key = ExecutionKey::from_hex("1".repeat(64)).unwrap();
        assert_eq!(
            key.request("chatws_fixture", "/fixture", "printf fixture")
                .unwrap(),
            "d0489511f782df59d326702425ecc9d9d756ade01e0965834ab9359ece7d6119"
        );
        assert_eq!(
            key.journal("claim", b"fixture").unwrap(),
            "f8dba65933fa4b602aa9e61dd516a5a94d24b94bbbb4724973bb1fbe366bfecb"
        );
        assert_eq!(
            key.owner_secret("11111111-1111-4111-8111-111111111111"),
            "3f31f42e04c304b1d91d8dd4a2725d70a40338bc3c65dd78f6da6bc2a21f2c0d"
        );
        assert_eq!(
            key.result(
                "11111111-1111-4111-8111-111111111111",
                "chatws_fixture",
                b"output"
            )
            .unwrap(),
            "33a7fa717a8c15542df44b816c8a7fece6872549266fafb3c76031fb01572359"
        );
    }
    #[test]
    fn hmac_known_vector_and_direction_separation() {
        assert_eq!(
            sign(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        let signature = sign(b"secret", b"tela-process-owner-request-v1\0payload");
        assert!(verify(
            b"secret",
            b"tela-process-owner-request-v1\0payload",
            &signature
        ));
        assert!(!verify(
            b"secret",
            b"tela-process-owner-response-v1\0payload",
            &signature
        ));
    }
    #[test]
    fn bootstrap_bounds_precede_authority() {
        assert!(Bootstrap::read(&vec![b'x'; BOOTSTRAP_LIMIT + 1][..]).is_err());
        assert!(!uuid("../claim"));
        assert!(!opaque("a\nb"));
        assert!(uuid(&fresh_id().unwrap()));
    }
    #[test]
    fn journal_claims_are_exclusive_and_private() {
        let root = tempfile::tempdir().unwrap();
        let key = ExecutionKey::from_hex("1".repeat(64)).unwrap();
        let journal = Journal::open(root.path()).unwrap();
        let operation = fresh_id().unwrap();
        journal
            .publish(
                &key,
                &operation,
                "claim",
                &serde_json::json!({"fixture":true}),
            )
            .unwrap();
        assert!(
            journal
                .publish(
                    &key,
                    &operation,
                    "claim",
                    &serde_json::json!({"fixture":false})
                )
                .is_err()
        );
        let path = root.path().join(format!("{operation}.claim.json"));
        fs::write(&path, b"{").unwrap();
        assert!(
            journal
                .publish(
                    &key,
                    &operation,
                    "claim",
                    &serde_json::json!({"fixture":false})
                )
                .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), b"{");
    }
    #[test]
    fn bounded_reader_refuses_growth_and_symlink() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("data");
        fs::write(&path, b"abcd").unwrap();
        assert!(read_private(&path, 3).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&path, root.path().join("link")).unwrap();
            assert!(read_private(&root.path().join("link"), 10).is_err());
        }
    }
}
