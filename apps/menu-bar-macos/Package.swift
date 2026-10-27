// swift-tools-version: 5.9
import PackageDescription

let menuSources = ["main.swift", "single-instance.swift", "bridge-title-read.swift", "control-center.swift", "work-connection.swift", "sparkle-update.swift"]
let maintenanceSources = ["maintenance.swift", "maintenance-main.swift"]
let auxiliaryFiles = ["build.ts", "start.ts", "single-instance.test.ts", "work-connection-tests.swift", "bridge-title-read-tests.swift"]
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
