import AVFoundation

enum CloudSpeech {
    static func request(audio: Data, configuration: SpeechPreferences, key: String) throws -> URLRequest {
        guard configuration.mode == "cloud", SpeechPolicy.providers.contains(configuration.provider),
              !key.isEmpty, key.rangeOfCharacter(from: .controlCharacters) == nil,
              audio.count <= 20_000_000 else { throw SpeechPreferenceError("Check the speech connection or record a shorter request.") }
        let provider = configuration.provider, model = configuration.model(for: provider)
        guard SpeechPolicy.models[provider]?.contains(model) == true else { throw SpeechPreferenceError("The selected speech model is no longer available. Choose another in Voice preferences.") }
        if provider == "deepgram" {
            var parts = URLComponents(string: "https://api.deepgram.com/v1/listen")!
            parts.queryItems = [URLQueryItem(name: "model", value: model), URLQueryItem(name: "language", value: configuration.language == "auto" ? "multi" : configuration.language),
                                URLQueryItem(name: "smart_format", value: "true")]
            var req = URLRequest(url: parts.url!); req.httpMethod = "POST"
            req.setValue("Token " + key, forHTTPHeaderField: "Authorization")
            req.setValue("audio/wav", forHTTPHeaderField: "Content-Type"); req.httpBody = audio
            return req
        }
        let boundary = "Tasktap-" + UUID().uuidString
        let url = URL(string: provider == "openai" ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.elevenlabs.io/v1/speech-to-text")!
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue(provider == "openai" ? "Bearer " + key : key, forHTTPHeaderField: provider == "openai" ? "Authorization" : "xi-api-key")
        req.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")
        var fields = [provider == "openai" ? "model" : "model_id": model]
        if configuration.language != "auto" { fields[provider == "openai" ? "language" : "language_code"] = configuration.language }
        if provider == "openai" { fields["response_format"] = "json" }
        else { fields["tag_audio_events"] = "false"; fields["diarize"] = "false" }
        var body = Data()
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
        body.append(audio); body.append(Data("\r\n--\(boundary)--\r\n".utf8)); req.httpBody = body
        return req
    }
    static func transcript(_ json: [String: Any], provider: String) throws -> String {
        let text: String?
        if provider == "deepgram" {
            let results = json["results"] as? [String: Any], channels = results?["channels"] as? [[String: Any]]
            let alternatives = channels?.first?["alternatives"] as? [[String: Any]]
            text = alternatives?.first?["transcript"] as? String
        } else { text = json["text"] as? String }
        guard let text, text.utf8.count < 1_000_000 else { throw SpeechPreferenceError("The speech provider returned an unreadable transcript.") }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func transcribe(_ file: URL, configuration: SpeechPreferences) async throws -> String {
        guard let key = try RouterSecrets.get("speech." + configuration.provider) else { throw SpeechPreferenceError("Connect your speech API account in Voice preferences first.") }
        var req = try request(audio: Data(contentsOf: file), configuration: configuration, key: key)
        req.timeoutInterval = 90
        let json = try await RouterHTTP.json(req)
        try Task.checkCancellation()
        return try transcript(json, provider: configuration.provider)
    }
}

// Batch providers get exactly the audio captured between press and release.
// Files are private, bounded to five minutes, and removed on every terminal path.
final class MicrophoneFile: @unchecked Sendable {
    let engine = AVAudioEngine()
    let fileURL: URL
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var tapped = false, failed = false
    init() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tasktap-dictation-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        fileURL = directory.appendingPathComponent("dictation.wav")
    }
    func start(level: @escaping @Sendable (Double) -> Void, failure: @escaping @Sendable () -> Void) throws {
        let node = engine.inputNode, source = node.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: format) else { throw SpeechPreferenceError("Couldn’t use the microphone.") }
        file = try AVAudioFile(forWriting: fileURL, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        node.installTap(onBus: 0, bufferSize: 2048, format: source) { [weak self] buffer, _ in
            guard let self else { return }
            lock.lock(); defer { lock.unlock() }
            guard let file, !failed, buffer.frameLength > 0 else { return }
            do {
                guard file.length < 16000 * 300 else { throw SpeechPreferenceError("Recording limit reached.") }
                let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / source.sampleRate)) + 16
                guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw SpeechPreferenceError("Audio buffer unavailable.") }
                var supplied = false
                let status = converter.convert(to: output, error: nil) { _, state in
                    if supplied { state.pointee = .noDataNow; return nil }
                    supplied = true; state.pointee = .haveData; return buffer
                }
                guard status != .error else { throw SpeechPreferenceError("Audio conversion failed.") }
                if output.frameLength > 0 { try file.write(from: output) }
                if let samples = buffer.floatChannelData?[0] {
                    var sum: Float = 0
                    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
                    let db = 10 * log10(max(1e-10, sum / Float(buffer.frameLength)))
                    level(min(1, max(0, (Double(db) + 55) / 49)))
                }
            } catch { failed = true; failure() }
        }
        tapped = true; engine.prepare(); try engine.start()
    }
    func stop() {
        if tapped { engine.inputNode.removeTap(onBus: 0); engine.stop(); tapped = false }
        lock.lock(); file = nil; lock.unlock()
    }
    func remove() { stop(); try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
    deinit { remove() }
}
