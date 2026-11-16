// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TasktapSpeech",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "0.18.0"),
                   .package(url: "https://github.com/huggingface/swift-transformers.git", exact: "1.1.9")],
    targets: [.executableTarget(name: "tasktap-speech", dependencies: [
        .product(name: "WhisperKit", package: "argmax-oss-swift"),
        .product(name: "Tokenizers", package: "swift-transformers")
    ])]
)
