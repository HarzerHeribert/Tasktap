import AVFoundation
import Speech

@MainActor final class SpeechService {
    let store: SpeechPreferenceStore
    let directory: URL
    private(set) var setupTask: Task<Void, Never>?
    private var installation: AssetInstallationRequest?
    private var generation = UUID()
    private var publication = 0
    private var progressObserver: NSKeyValueObservation?
    private var phase = "idle", detail = "", fraction: Double?
    var changed: ([String: Any]) -> Void = { _ in }

    init(directory: URL) {
        self.directory = directory
        store = SpeechPreferenceStore(file: directory.appendingPathComponent("preferences.json"))
    }
    var preferences: SpeechPreferences { store.value }
    var whisperDirectory: URL { directory.appendingPathComponent("Whisper/" + SpeechPolicy.whisperModel, isDirectory: true) }
    var whisperReady: Bool {
        guard let data = try? Data(contentsOf: whisperDirectory.appendingPathComponent("ready.json")),
              let marker = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              marker["model"] == SpeechPolicy.whisperModel, let folder = marker["folder"], let tokenizer = marker["tokenizer"],
              folder.hasPrefix(whisperDirectory.path + "/"), tokenizer.hasPrefix(whisperDirectory.path + "/") else { return false }
        return FileManager.default.fileExists(atPath: folder) &&
            FileManager.default.fileExists(atPath: tokenizer + "/tokenizer.json") &&
            FileManager.default.fileExists(atPath: tokenizer + "/tokenizer_config.json")
    }
    private var helper: URL? { Bundle.main.url(forResource: "tasktap-speech", withExtension: nil) }

    func publish() {
        publication += 1; let version = publication
        Task { let value = await snapshot(); if publication == version { changed(value) } }
    }
    func snapshot(configuration: SpeechPreferences? = nil) async -> [String: Any] {
        let config = configuration ?? preferences, engine = config.resolvedEngine
        var supported = true, ready = false
        if config.mode == "cloud" {
            supported = SpeechPolicy.models[config.provider]?.contains(config.model(for: config.provider)) == true
            ready = supported && (try? RouterSecrets.get("speech." + config.provider)) != nil
        }
        else if engine == "whisper-turbo" { ready = whisperReady; supported = helper != nil }
        else if engine == "apple-dictation", let locale = await DictationTranscriber.supportedLocale(equivalentTo: appleLocale(config.language)) {
            ready = await DictationTranscriber.installedLocales.contains(locale)
        } else if engine == "apple-speech", SpeechTranscriber.isAvailable,
                  let locale = await SpeechTranscriber.supportedLocale(equivalentTo: appleLocale(config.language)) {
            ready = await SpeechTranscriber.installedLocales.contains(locale)
        } else { supported = false }
        return ["configuration": config.json, "recommendedEngine": SpeechPolicy.recommendedLocalEngine,
                "engineNames": SpeechPolicy.engineNames, "recommendedModels": SpeechPolicy.recommendedModels,
                "models": SpeechPolicy.models, "supported": supported, "ready": ready,
                "phase": phase, "detail": detail, "progress": fraction as Any? ?? NSNull(),
                "microphone": Self.microphoneStatus, "appleLanguage": appleLocale(config.language).localizedString(forLanguageCode: appleLocale(config.language).language.languageCode?.identifier ?? "") ?? appleLocale(config.language).identifier]
    }
    static var microphoneStatus: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "allowed"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }
    func save(_ json: [String: Any]) {
        guard setupTask == nil else { detail = "Finish or cancel voice setup before changing its settings."; publish(); return }
        do { try store.save(json); generation = UUID(); phase = "idle"; detail = ""; fraction = nil; publish() }
        catch { reportError(error.localizedDescription) }
    }
    func microphone() {
        Task { _ = await AVCaptureDevice.requestAccess(for: .audio); publish() }
    }
    func reportError(_ text: String) { phase = "error"; detail = text; publish() }
    func connect(provider: String, key: String) {
        guard SpeechPolicy.providers.contains(provider), key.count <= 4096,
              !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              key.rangeOfCharacter(from: .controlCharacters) == nil else { reportError("Enter a valid speech API key."); return }
        do { try RouterSecrets.set("speech." + provider, key.trimmingCharacters(in: .whitespacesAndNewlines)); phase = "idle"; detail = ""; publish() }
        catch { reportError(error.localizedDescription) }
    }
    func disconnect(provider: String) {
        guard SpeechPolicy.providers.contains(provider) else { return }
        do { try RouterSecrets.set("speech." + provider, nil); phase = "idle"; detail = ""; publish() }
        catch { reportError(error.localizedDescription) }
    }
    func appleLocale(_ language: String) -> Locale { Locale(identifier: language == "auto" ? Locale.preferredLanguages.first ?? "en-US" : language) }
    func install() {
        guard setupTask == nil, preferences.mode == "local" else { return }
        let token = UUID(), config = preferences
        generation = token; phase = "downloading"; detail = "Downloading speech assets…"; fraction = nil; publish()
        setupTask = Task {
            do {
                if config.resolvedEngine == "whisper-turbo" {
                    guard let helper else { throw SpeechPreferenceError("Rebuild Tasktap with the local speech helper.") }
                    _ = try await SpeechChild.call(helper, ["install", whisperDirectory.path, SpeechPolicy.whisperModel]) { [weak self] event in
                        Task { @MainActor in
                            guard let self, self.generation == token else { return }
                            if let progress = event["progress"] as? Double { self.fraction = progress }
                            self.detail = event["phase"] as? String == "preparing" ? "Preparing the model for this Mac…" : "Downloading the voice model…"
                            self.publish()
                        }
                    }
                } else {
                    let module: any SpeechModule
                    if config.resolvedEngine == "apple-dictation", let locale = await DictationTranscriber.supportedLocale(equivalentTo: appleLocale(config.language)) {
                        module = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
                    } else if config.resolvedEngine == "apple-speech", SpeechTranscriber.isAvailable,
                              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: appleLocale(config.language)) {
                        module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
                    } else { throw SpeechPreferenceError("This engine is unavailable for the selected language on this Mac. Choose another in More options.") }
                    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                        installation = request
                        progressObserver = request.progress.observe(\.fractionCompleted, options: [.new]) { [weak self] progress, _ in
                            Task { @MainActor in
                                guard let self, self.generation == token else { return }
                                self.fraction = progress.fractionCompleted; self.publish()
                            }
                        }
                        try await request.downloadAndInstall()
                    }
                }
                try Task.checkCancellation()
                guard generation == token else { return }
                phase = "idle"; detail = ""; fraction = nil; installation = nil; progressObserver = nil; setupTask = nil; publish()
            } catch {
                guard generation == token else { return }
                installation = nil; progressObserver = nil; setupTask = nil; fraction = nil
                phase = "error"; detail = "Voice setup failed. Check your connection and retry. " + error.localizedDescription; publish()
            }
        }
    }
    func cancelInstall() {
        generation = UUID(); installation?.progress.cancel(); setupTask?.cancel(); setupTask = nil; installation = nil; progressObserver = nil
        phase = "idle"; detail = "Setup cancelled. You can try again whenever you’re ready."; fraction = nil; publish()
    }
    func removeWhisper() {
        guard setupTask == nil else { return }
        do { if FileManager.default.fileExists(atPath: whisperDirectory.path) { try FileManager.default.removeItem(at: whisperDirectory) }; publish() }
        catch { reportError("Could not remove the downloaded voice model.") }
    }
    func transcribe(_ file: URL, configuration: SpeechPreferences) async throws -> String {
        if configuration.mode == "cloud" { return try await CloudSpeech.transcribe(file, configuration: configuration) }
        guard configuration.resolvedEngine == "whisper-turbo", whisperReady, let helper else {
            throw SpeechPreferenceError("Set up the selected speech model in Voice preferences first.")
        }
        let result = try await SpeechChild.call(helper, ["transcribe", whisperDirectory.path, SpeechPolicy.whisperModel, file.path, configuration.language]) { _ in }
        return result["text"] as? String ?? ""
    }
}

// Ordered process launch/cancel and a bounded JSON-lines protocol. No helper
// error output or provider response body is reflected into the web renderer.
enum SpeechChild {
    final class Child: @unchecked Sendable {
        let process = Process(), lock = NSLock()
        private var cancelled = false
        func run() throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CancellationError() }; try process.run() }
        func stop() { lock.lock(); defer { lock.unlock() }; cancelled = true; if process.isRunning { process.terminate() } }
    }
    static func call(_ executable: URL, _ arguments: [String], progress: @escaping @Sendable ([String: Any]) -> Void) async throws -> [String: Any] {
        let child = Child(), pipe = Pipe()
        child.process.executableURL = executable; child.process.arguments = arguments
        child.process.standardOutput = pipe; child.process.standardError = FileHandle.nullDevice
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        try child.run()
                        var pending = Data(), last = [String: Any]()
                        while true {
                            let chunk = pipe.fileHandleForReading.availableData
                            if chunk.isEmpty { break }
                            pending.append(chunk)
                            guard pending.count < 1_048_576 else { throw SpeechPreferenceError("The speech helper returned too much output.") }
                            while let newline = pending.firstIndex(of: 10) {
                                let line = Data(pending[..<newline]); pending.removeSubrange(...newline)
                                if let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { last = event; progress(event) }
                            }
                        }
                        child.process.waitUntilExit()
                        guard child.process.terminationStatus == 0 else { throw SpeechPreferenceError("The local speech helper could not finish. Retry voice setup.") }
                        continuation.resume(returning: last)
                    } catch { child.stop(); continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { child.stop() })
    }
}
