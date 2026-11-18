// swift-tools-version: 5.9
// The trial of WhisperKit (Core ML Whisper): see ../run.sh. Built into a folder outside the repository:
//   swift build -c release --package-path trials/speech/whisperkit --scratch-path <folder>
import PackageDescription

let package = Package(
    name: "WhisperKitTrial",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "1.1.1")],
    targets: [.executableTarget(name: "whisperkit-trial", dependencies: [.product(name: "WhisperKit", package: "argmax-oss-swift")])]
)
