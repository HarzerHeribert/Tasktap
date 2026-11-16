import Foundation
import WhisperKit
import Tokenizers

// The helper never receives API keys. Installing is the only operation allowed
// to fetch model assets; transcription requires a completed local installation.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

@main struct SpeechRuntime {
    static func main() async {
        do {
            let args = CommandLine.arguments
            if args.count == 2, args[1] == "--verify-runtime" {
                let resources = ["swift-transformers_Hub.bundle", "swift-crypto_Crypto.bundle"]
                emit(["bundle": Bundle.main.bundleURL.path,
                      "resourcesReady": resources.allSatisfy { FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent($0).path) }])
                return
            }
            guard args.count >= 4 else { throw Failure("Missing speech operation.") }
            let operation = args[1], root = URL(fileURLWithPath: args[2], isDirectory: true), model = args[3]
            guard model == "large-v3-v20240930_626MB" else { throw Failure("Unknown speech model.") }
            let marker = root.appendingPathComponent("ready.json")
            if operation == "install" {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let folder = try await WhisperKit.download(variant: model, downloadBase: root, progressCallback: { progress in
                    emit(["phase": "downloading", "progress": progress.fractionCompleted])
                })
                emit(["phase": "preparing", "progress": 1])
                // Load once during setup, including the tokenizer and Core ML specialization.
                _ = try await WhisperKit(WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: root,
                                                        verbose: false, prewarm: true, load: true, download: false))
                guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil),
                      let tokenizer = enumerator.compactMap({ $0 as? URL }).first(where: { $0.lastPathComponent == "tokenizer.json" })?.deletingLastPathComponent() else {
                    throw Failure("The downloaded tokenizer is missing. Retry setup.")
                }
                _ = try await AutoTokenizer.from(modelFolder: tokenizer)
                let value: [String: Any] = ["model": model, "folder": folder.path, "tokenizer": tokenizer.path]
                try JSONSerialization.data(withJSONObject: value).write(to: marker, options: .atomic)
                emit(["phase": "ready"])
            } else if operation == "transcribe", args.count >= 5 {
                let value = try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as? [String: String]
                guard value?["model"] == model, let folder = value?["folder"], let tokenizer = value?["tokenizer"],
                      folder.hasPrefix(root.path + "/"), tokenizer.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: folder) else {
                    throw Failure("Set up the local speech model in Voice preferences first.")
                }
                // Validate the installed tokenizer before loading WhisperKit.
                // Missing or damaged files fail here rather than fetching assets.
                let tokenizerFolder = URL(fileURLWithPath: tokenizer)
                _ = try await AutoTokenizer.from(modelFolder: tokenizerFolder)
                let pipe = try await WhisperKit(WhisperKitConfig(modelFolder: folder, tokenizerFolder: tokenizerFolder,
                                                               verbose: false, load: true, download: false))
                let language = args.count > 5 && args[5] != "auto" ? args[5] : nil
                let options = DecodingOptions(task: .transcribe, language: language, detectLanguage: language == nil)
                let results = try await pipe.transcribe(audioPath: args[4], decodeOptions: options)
                emit(["phase": "text", "text": results.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)])
            } else { throw Failure("Unknown speech operation.") }
        } catch {
            emit(["phase": "error", "message": "Local speech failed: " + error.localizedDescription])
            exit(1)
        }
    }
    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
