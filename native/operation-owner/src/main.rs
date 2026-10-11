use std::io;
use std::path::PathBuf;
use tela_operation_owner::{Bootstrap, Journal, authorize};
fn run() -> io::Result<()> {
    let role = std::env::args().nth(1);
    if !matches!(
        role.as_deref(),
        Some("--tela-owner-validate-v1" | "--tela-operation-owner-v1")
    ) {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    let input = Bootstrap::read(io::stdin().lock())?;
    if role.as_deref() == Some("--tela-operation-owner-v1") {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(tela_operation_owner::control::run(input));
    }
    let authorized = authorize(&input)?;
    let journal = Journal::open(&PathBuf::from(format!(
        "{}.executions",
        input.store_path.to_string_lossy()
    )))?;
    let claim = journal.reserve(&authorized)?;
    println!(
        "{}",
        serde_json::to_string(&claim).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?
    );
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("Tela native owner failed; preserve private execution evidence.");
        std::process::exit(1);
    }
}
