use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use tela_workspace_files::{MAX_BYTES, export, identity, publish, recover};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    operation: String,
    journal: String,
    journal_device: String,
    journal_inode: String,
    root: String,
    device: String,
    inode: String,
    path: String,
    bytes: u64,
    sha256: String,
}

fn run() -> io::Result<serde_json::Value> {
    let mut reader = io::BufReader::new(io::stdin().lock());
    let mut header = Vec::new();
    reader.by_ref().take(8193).read_until(b'\n', &mut header)?;
    if header.len() > 8192 || header.last() != Some(&b'\n') {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let request: Request = serde_json::from_slice(&header)?;
    if request.version != 2 || request.bytes > MAX_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let mut bytes = vec![0u8; request.bytes as usize];
    reader.read_exact(&mut bytes)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() as u64 != request.bytes || digest != request.sha256 {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let path = Path::new(&request.root);
    if !path.is_absolute() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let ancestor = Dir::open_ambient_dir(
        path.parent().ok_or(io::ErrorKind::InvalidInput)?,
        cap_std::ambient_authority(),
    )?;
    let root = ancestor.open_dir_nofollow(path.file_name().ok_or(io::ErrorKind::InvalidInput)?)?;
    if identity(&root.dir_metadata()?)? != (request.device, request.inode) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let journal_path = Path::new(&request.journal);
    if !journal_path.is_absolute() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let journal_parent = Dir::open_ambient_dir(
        journal_path.parent().ok_or(io::ErrorKind::InvalidInput)?,
        cap_std::ambient_authority(),
    )?;
    let journal = journal_parent.open_dir_nofollow(
        journal_path
            .file_name()
            .ok_or(io::ErrorKind::InvalidInput)?,
    )?;
    if identity(&journal.dir_metadata()?)? != (request.journal_device, request.journal_inode) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    if request.operation == "recover" && bytes.is_empty() {
        if reader.read(&mut [0u8; 1])? != 0 {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        recover(&root, &journal)?;
        return Ok(serde_json::json!({"version":2,"recovered":true}));
    }
    if request.operation != "publish" {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let cleanup_complete = publish(&root, &journal, &request.path, &bytes, || {
        // Durable staging proof precedes any bytes on disk. The client explicitly releases publication.
        println!("{{\"version\":2,\"staged\":true}}");
        io::stdout().flush()?;
        let mut acknowledgment = Vec::new();
        reader
            .by_ref()
            .take(8)
            .read_until(b'\n', &mut acknowledgment)?;
        if acknowledgment != b"commit\n" || reader.read(&mut [0u8; 1])? != 0 {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok(())
    })?;
    Ok(
        serde_json::json!({"version":2,"published":true,"cleanupComplete":cleanup_complete,"bytes":bytes.len(),"sha256":digest}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportRequest {
    version: u8,
    root: String,
    device: String,
    inode: String,
    path: String,
}

fn run_export() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().take(8193).read_to_end(&mut input)?;
    if input.len() > 8192 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let request: ExportRequest = serde_json::from_slice(&input)?;
    let path = Path::new(&request.root);
    if request.version != 1 || !path.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let ancestor = Dir::open_ambient_dir(
        path.parent().ok_or(io::ErrorKind::InvalidInput)?,
        cap_std::ambient_authority(),
    )?;
    let root = ancestor.open_dir_nofollow(path.file_name().ok_or(io::ErrorKind::InvalidInput)?)?;
    if identity(&root.dir_metadata()?)? != (request.device, request.inode) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let bytes = export(&root, &request.path)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    println!(
        "{}",
        serde_json::json!({"version":1,"bytes":bytes.len(),"sha256":digest})
    );
    io::stdout().write_all(&bytes)?;
    Ok(())
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--protocol-version"] {
        println!("2");
        return;
    }
    if args == ["--export-version"] {
        println!("1");
        return;
    }
    if args == ["--export"] {
        if let Err(error) = run_export() {
            eprintln!(
                "{}",
                serde_json::json!({"version":1,"error":format!("{:?}", error.kind())})
            );
            std::process::exit(1);
        }
        return;
    }
    if !args.is_empty() {
        eprintln!("{{\"error\":\"InvalidInput\"}}");
        std::process::exit(1);
    }
    match run() {
        Ok(result) => println!("{result}"),
        Err(error) => {
            // Never emit paths, bytes, credentials or OS error text.
            eprintln!("{{\"version\":2,\"error\":\"{:?}\"}}", error.kind());
            std::process::exit(1);
        }
    }
}
