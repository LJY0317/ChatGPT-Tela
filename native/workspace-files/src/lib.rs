use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata};
#[cfg(unix)]
use cap_std::fs::MetadataExt;
#[cfg(windows)]
use cap_primitives::fs::metadata::_WindowsByHandle;
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::path::{Component, Path};

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Accept one portable path; reject Windows alternate streams/device aliases on every OS.
pub fn components(path: &str) -> io::Result<Vec<&str>> {
    let parts: Vec<_> = path.split('/').collect();
    if path.len() > 4096 || parts.is_empty() || parts.len() > 32 {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    for part in &parts {
        let basename = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&basename.as_str());
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || reserved
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || !matches!(
                Path::new(part).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
    }
    Ok(parts)
}

pub fn identity(metadata: &Metadata) -> io::Result<(String, String)> {
    #[cfg(unix)]
    {
        Ok((metadata.dev().to_string(), metadata.ino().to_string()))
    }
    #[cfg(windows)]
    {
        metadata
            .volume_serial_number()
            .zip(metadata.file_index())
            .map(|(device, inode)| (device.to_string(), inode.to_string()))
            .ok_or_else(|| io::Error::from(io::ErrorKind::Unsupported))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    path: String,
    parent_identity: (String, String),
    stage_name: String,
    stage_identity: Option<(String, String)>,
}

fn parent(root: &Dir, path: &str) -> io::Result<Dir> {
    let parts = components(path)?;
    let mut dir = root.try_clone()?;
    for part in &parts[..parts.len() - 1] {
        dir = dir.open_dir_nofollow(part)?;
    }
    Ok(dir)
}

fn write_receipt(journal: &Dir, name: &str, receipt: &Receipt) -> io::Result<()> {
    let temporary = format!("{name}.tmp");
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = journal.open_with(&temporary, &options)?;
    file.write_all(&serde_json::to_vec(receipt)?)?;
    file.sync_all()?;
    drop(file);
    journal.rename(&temporary, journal, name)
}

fn clean(root: &Dir, journal: &Dir, name: &str, receipt: &Receipt) -> io::Result<()> {
    let directory = parent(root, &receipt.path)?;
    if identity(&directory.dir_metadata()?)? != receipt.parent_identity {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let stage = match directory.open_dir_nofollow(&receipt.stage_name) {
        Ok(stage) => stage,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            journal.remove_file(name)?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if Some(identity(&stage.dir_metadata()?)?) != receipt.stage_identity {
        // Creation interrupted before its identity was durable: preserve ambiguity, block new work.
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    // The exactly proven private stage owns its cache content, never the published final name.
    // Unexpected entries are preserved. No recursive deletion or symlink traversal.
    for entry in stage.entries()?.take(2) {
        let entry = entry?;
        if entry.file_name() != "content" || !entry.file_type()?.is_file() {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
    }
    match stage.remove_file("content") {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    stage.remove_open_dir()?;
    journal.remove_file(name)
}

/// Recover only private journal records; never scan destination filename prefixes.
/// Ambiguous/replaced stages are preserved and block further allocation for this workspace.
pub fn recover(root: &Dir, journal: &Dir) -> io::Result<()> {
    let entries = journal
        .entries()?
        .take(17)
        .collect::<io::Result<Vec<_>>>()?;
    if entries.len() > 16 {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    for entry in entries {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if name.len() != 37
            || !name.ends_with(".json")
            || !name.as_bytes()[..32].iter().all(|c| c.is_ascii_hexdigit())
            || !entry.file_type()?.is_file()
        {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        let mut bytes = Vec::new();
        journal.open(&name)?.take(8193).read_to_end(&mut bytes)?;
        if bytes.len() > 8192 {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        let receipt: Receipt = serde_json::from_slice(&bytes)?;
        if receipt.stage_name != format!(".tela-import-{}", &name[..32]) {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        clean(root, journal, &name, &receipt)?;
    }
    Ok(())
}

/// Publish through pinned directory handles; on-demand recovery bounds retained scratch data.
pub fn publish(
    root: &Dir,
    journal: &Dir,
    path: &str,
    bytes: &[u8],
    staged: impl FnOnce() -> io::Result<()>,
) -> io::Result<bool> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let parts = components(path)?;
    recover(root, journal)?;
    let destination = parent(root, path)?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| io::Error::other("random source unavailable"))?;
    let nonce = nonce.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let scratch = format!(".tela-import-{nonce}");
    let name = format!("{nonce}.json");
    let mut receipt = Receipt {
        path: path.to_owned(),
        parent_identity: identity(&destination.dir_metadata()?)?,
        stage_name: scratch.clone(),
        stage_identity: None,
    };
    write_receipt(journal, &name, &receipt)?;
    let mut builder = cap_std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    destination.create_dir_with(&scratch, &builder)?;
    let stage = destination.open_dir_nofollow(&scratch)?;
    receipt.stage_identity = Some(identity(&stage.dir_metadata()?)?);
    write_receipt(journal, &name, &receipt)?;
    let result = (|| {
        staged()?;
        let mut options = cap_std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = stage.open_with("content", &options)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        stage.hard_link("content", &destination, parts[parts.len() - 1])
    })();
    drop(stage);
    let cleanup_complete = clean(root, journal, &name, &receipt).is_ok();
    result?;
    Ok(cleanup_complete)
}

/// Read one bounded regular file through pinned directory handles, without following links.
pub fn export(root: &Dir, path: &str) -> io::Result<Vec<u8>> {
    let parts = components(path)?;
    let directory = parent(root, path)?;
    let name = parts[parts.len() - 1];
    let expected = directory.symlink_metadata(name)?;
    if !expected.is_file() || expected.len() > MAX_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = directory.open_with(name, &options)?;
    let before = file.metadata()?;
    if !before.is_file() || identity(&before)? != identity(&expected)? || before.len() > MAX_BYTES {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;

    #[test]
    fn export_is_bounded_read_only_and_binary_exact() {
        let temp = tempfile::tempdir().unwrap();
        let root = Dir::open_ambient_dir(temp.path(), ambient_authority()).unwrap();
        root.create_dir("results").unwrap();
        root.write("results/a.bin", [0u8, 255, 10]).unwrap();
        assert_eq!(export(&root, "results/a.bin").unwrap(), [0u8, 255, 10]);
        assert_eq!(root.read("results/a.bin").unwrap(), [0u8, 255, 10]);
        root.write("empty", []).unwrap();
        assert!(export(&root, "empty").unwrap().is_empty());
        root.write("large", vec![0u8; MAX_BYTES as usize + 1])
            .unwrap();
        assert!(export(&root, "large").is_err());
        assert!(export(&root, "results").is_err());
        assert!(export(&root, "../outside").is_err());
        assert!(export(&root, "C:/file").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlink_files_and_parents() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private"), b"private").unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("parent")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("private"), temp.path().join("file"))
            .unwrap();
        let root = Dir::open_ambient_dir(temp.path(), ambient_authority()).unwrap();
        assert!(export(&root, "parent/private").is_err());
        assert!(export(&root, "file").is_err());
    }
    #[test]
    fn exact_binary_and_no_overwrite() {
        let journal_temp = tempfile::tempdir().unwrap();
        let journal = Dir::open_ambient_dir(journal_temp.path(), ambient_authority()).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temporary.path(), ambient_authority()).unwrap();
        dir.create_dir("uploads").unwrap();
        let binary = [0, 255, 128, 1];
        publish(&dir, &journal, "uploads/a.bin", &binary, || Ok(())).unwrap();
        assert_eq!(dir.read("uploads/a.bin").unwrap(), binary);
        assert!(publish(&dir, &journal, "uploads/a.bin", b"replace", || Ok(())).is_err());
        assert_eq!(dir.read("uploads/a.bin").unwrap(), binary);
        assert_eq!(dir.read_dir("uploads").unwrap().count(), 1);
    }

    #[test]
    fn portable_path_rejects_escapes_devices_and_alternate_streams() {
        for path in [
            "../x", "/x", "a/../x", "a\\x", "C:/x", "NUL.txt", "foo:bar", "file.", "a//x", "a/./x",
        ] {
            assert!(components(path).is_err(), "accepted {path}");
        }
        assert_eq!(
            components("folder/한글.bin").unwrap(),
            ["folder", "한글.bin"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_never_redirect_publication() {
        let journal_temp = tempfile::tempdir().unwrap();
        let journal = Dir::open_ambient_dir(journal_temp.path(), ambient_authority()).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temporary.path(), ambient_authority()).unwrap();
        std::os::unix::fs::symlink(outside.path(), temporary.path().join("link")).unwrap();
        assert!(publish(&dir, &journal, "link/x", b"data", || Ok(())).is_err());
        assert!(!outside.path().join("x").exists());
        std::os::unix::fs::symlink(outside.path().join("x"), temporary.path().join("x")).unwrap();
        assert!(publish(&dir, &journal, "x", b"data", || Ok(())).is_err());
        assert!(!outside.path().join("x").exists());
    }

    #[cfg(unix)]
    #[test]
    fn parent_symlink_swap_race_never_writes_outside() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let journal_temp = tempfile::tempdir().unwrap();
        let journal = Dir::open_ambient_dir(journal_temp.path(), ambient_authority()).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temporary.path(), ambient_authority()).unwrap();
        dir.create_dir("parent").unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let root = temporary.path().to_owned();
        let other = outside.path().to_owned();
        let attacker = std::thread::spawn(move || {
            while flag.load(Ordering::Relaxed) {
                if std::fs::rename(root.join("parent"), root.join("parked")).is_ok() {
                    let _ = std::os::unix::fs::symlink(&other, root.join("parent"));
                    let _ = std::fs::remove_file(root.join("parent"));
                    let _ = std::fs::rename(root.join("parked"), root.join("parent"));
                }
            }
        });
        for number in 0..200 {
            let _ = publish(
                &dir,
                &journal,
                &format!("parent/file{number}"),
                b"binary",
                || Ok(()),
            );
        }
        running.store(false, Ordering::Relaxed);
        attacker.join().unwrap();
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn interrupted_unproven_creation_and_invalid_journals_preserve_data_and_block_growth() {
        let temporary = tempfile::tempdir().unwrap();
        let journal_temp = tempfile::tempdir().unwrap();
        let root = Dir::open_ambient_dir(temporary.path(), ambient_authority()).unwrap();
        let journal = Dir::open_ambient_dir(journal_temp.path(), ambient_authority()).unwrap();
        let nonce = "a".repeat(32);
        let name = format!("{nonce}.json");
        let stage = format!(".tela-import-{nonce}");
        let receipt = Receipt {
            path: "final.bin".into(),
            parent_identity: identity(&root.dir_metadata().unwrap()).unwrap(),
            stage_name: stage.clone(),
            stage_identity: None,
        };
        write_receipt(&journal, &name, &receipt).unwrap();
        root.create_dir(&stage).unwrap();
        assert!(recover(&root, &journal).is_err());
        assert!(publish(&root, &journal, "next.bin", b"bytes", || Ok(())).is_err());
        assert_eq!(root.entries().unwrap().count(), 1);
        assert_eq!(journal.entries().unwrap().count(), 1);
        assert!(root.open_dir_nofollow(&stage).is_ok());
        journal.write("invalid.json", b"private-data").unwrap();
        assert!(recover(&root, &journal).is_err());
        assert_eq!(journal.read("invalid.json").unwrap(), b"private-data");
    }

    #[test]
    fn missing_parent_and_oversized_body_leave_no_partial_files() {
        let journal_temp = tempfile::tempdir().unwrap();
        let journal = Dir::open_ambient_dir(journal_temp.path(), ambient_authority()).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temporary.path(), ambient_authority()).unwrap();
        assert!(publish(&dir, &journal, "missing/x", b"data", || Ok(())).is_err());
        assert!(
            publish(
                &dir,
                &journal,
                "x",
                &vec![0; MAX_BYTES as usize + 1],
                || Ok(())
            )
            .is_err()
        );
        assert_eq!(dir.entries().unwrap().count(), 0);
    }
}
