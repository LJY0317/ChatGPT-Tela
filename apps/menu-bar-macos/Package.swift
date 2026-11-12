// swift-tools-version: 5.9
import PackageDescription

let menuSources = ["menu-bar-main.swift", "diagnostic-retention.swift", "desktop-lifecycle.swift", "single-instance.swift", "bridge-title-read.swift", "control-center.swift", "work-connection.swift", "sparkle-update.swift"]
let maintenanceSources = ["maintenance.swift", "maintenance-main.swift"]
let auxiliaryFiles = ["desktop-open.test.ts", "build.ts", "start.ts", "diagnostic-retention.test.ts", "single-instance.test.ts", "sparkle-update.test.ts", "sparkle-recovered-abort.test.ts", "work-connection-tests.swift", "bridge-title-read-tests.swift"]
let package = Package(
  name: "TelaMenuBar",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "ChatGPTTela", targets: ["TelaMenuBar"]), .executable(name: "TelaMaintenance", targets: ["TelaMaintenance"])],
  dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")],
  targets: [
    .executableTarget(name: "TelaMenuBar", dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      path: ".", exclude: auxiliaryFiles + maintenanceSources, sources: menuSources,
      linkerSettings: [.linkedFramework("AppKit"), .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks", "-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]),
    .executableTarget(name: "TelaMaintenance", path: ".", exclude: auxiliaryFiles + menuSources, sources: maintenanceSources,
      linkerSettings: [.linkedFramework("AppKit")])
  ]
)
