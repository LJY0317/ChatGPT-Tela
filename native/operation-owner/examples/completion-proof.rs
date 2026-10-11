//! Explicit isolated proof harness, not a packaged or manager-compatible execution entry point.
use std::io;
use tela_operation_owner::{Bootstrap, execution::OwnedCommand};
fn main() {
    let result = (|| -> io::Result<()> {
        let input = Bootstrap::read(io::stdin().lock())?;
        let mut command = OwnedCommand::start(&input)?;
        command.close_stdin();
        command.finish()?;
        Ok(())
    })();
    if result.is_err() {
        eprintln!("Native completion proof failed; preserve private execution evidence.");
        std::process::exit(1);
    }
}
