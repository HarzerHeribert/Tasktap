import Foundation

// Recommendations are release policy, never migrations of a person's choices.
// Only the literal "recommended" follows policy changes; explicit IDs stay pinned.
enum SpeechPolicy {
    static let recommendedLocalEngine = "apple-dictation"
    static let whisperModel = "large-v3-v20240930_626MB"
    static let engines = ["apple-dictation", "apple-speech", "whisper-turbo"]
    static let providers = ["openai", "deepgram", "elevenlabs"]
    static let recommendedModels = ["openai": "gpt-transcribe", "deepgram": "nova-3", "elevenlabs": "scribe_v3"]
    static let models = ["openai": ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
                         "deepgram": ["nova-3"], "elevenlabs": ["scribe_v3", "scribe_v2"]]
    static let engineNames = ["apple-dictation": "Apple dictation", "apple-speech": "Apple SpeechTranscriber", "whisper-turbo": "Whisper large-v3 Turbo"]
}

struct SpeechPreferences: Codable, Equatable {
    var mode = "local"
    var localEngine = "recommended"
    var provider = "openai"
    var language = "auto"
    var models = [String: String]()
    init() {}
    private enum CodingKeys: String, CodingKey { case mode, localEngine, provider, language, models }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decodeIfPresent(String.self, forKey: .mode) ?? "local"
        localEngine = try values.decodeIfPresent(String.self, forKey: .localEngine) ?? "recommended"
        provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
        language = try values.decodeIfPresent(String.self, forKey: .language) ?? "auto"
        models = try values.decodeIfPresent([String: String].self, forKey: .models) ?? [:]
    }

    var resolvedEngine: String { engine(recommendation: SpeechPolicy.recommendedLocalEngine) }
    func engine(recommendation: String) -> String { localEngine == "recommended" ? recommendation : localEngine }
    func model(for provider: String, recommendations: [String: String] = SpeechPolicy.recommendedModels) -> String {
        let choice = models[provider] ?? "recommended"
        return choice == "recommended" ? recommendations[provider] ?? "" : choice
    }
    var json: [String: Any] {
        ["mode": mode, "localEngine": localEngine, "provider": provider, "language": language, "models": models]
    }
    static func validated(_ json: [String: Any]) throws -> SpeechPreferences {
        var result = SpeechPreferences()
        result.mode = json["mode"] as? String ?? "local"
        result.localEngine = json["localEngine"] as? String ?? "recommended"
        result.provider = json["provider"] as? String ?? "openai"
        result.language = json["language"] as? String ?? "auto"
        result.models = json["models"] as? [String: String] ?? [:]
        guard ["local", "cloud"].contains(result.mode), SpeechPolicy.providers.contains(result.provider),
              result.localEngine == "recommended" || SpeechPolicy.engines.contains(result.localEngine),
              result.language == "auto" || result.language.range(of: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$", options: .regularExpression) != nil,
              result.models.allSatisfy({ provider, model in
                  SpeechPolicy.providers.contains(provider) && (model == "recommended" || SpeechPolicy.models[provider]?.contains(model) == true)
              }) else { throw SpeechPreferenceError("Choose a supported speech engine, model, and language.") }
        return result
    }
}

struct SpeechPreferenceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class SpeechPreferenceStore {
    let file: URL
    private(set) var value: SpeechPreferences
    init(file: URL) {
        self.file = file
        // Do not normalize saved IDs against today's catalog: a removed engine
        // should be shown as unavailable, never silently replaced by another.
        value = (try? JSONDecoder().decode(SpeechPreferences.self, from: Data(contentsOf: file))) ?? SpeechPreferences()
    }
    func save(_ json: [String: Any]) throws {
        let updated = try SpeechPreferences.validated(json)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(updated).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        value = updated
    }
}
