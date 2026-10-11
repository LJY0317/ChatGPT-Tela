import Foundation
import Darwin

/// One menu bar per login user, shared by installed and development builds.
/// The OS releases the advisory lock on exit/crash; never unlink a held lock's inode.
final class TelaMenuBarInstanceLock {
  private var descriptor: Int32 = -1

  static var defaultURL: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("chatgpt-tela-menu-bar.lock")
  }

  func acquire(at url: URL = TelaMenuBarInstanceLock.defaultURL) throws -> Bool {
    guard descriptor == -1 else { return true }
    let fd = Darwin.open(url.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard fd >= 0 else { throw NSError(domain: "TelaMenuBarInstance", code: 1) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_uid == getuid(),
          metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), metadata.st_nlink == 1,
          metadata.st_mode & mode_t(0o077) == 0 else {
      Darwin.close(fd)
      throw NSError(domain: "TelaMenuBarInstance", code: 2)
    }
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
      let busy = errno == EWOULDBLOCK
      Darwin.close(fd)
      if busy { return false }
      throw NSError(domain: "TelaMenuBarInstance", code: 3)
    }
    descriptor = fd
    return true
  }

  deinit { if descriptor >= 0 { Darwin.close(descriptor) } }
}
