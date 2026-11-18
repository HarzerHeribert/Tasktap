// The trial of WhisperKit: one recording in, lines of JSON out, as ../apple.swift prints them.
//
//   whisperkit-trial <model folder> <tokenizer folder> <language | auto> <file.wav> [words the person uses]
//
// The model is loaded from the folder it was fetched into (../fetch.py) and nothing is ever downloaded here. Whisper
// hears a recording whole, so the transcript is made after the person lets go: "after" is what that takes when the
// model was being loaded while they spoke (loading that outlasts the recording counts), "load" and "transcribe" are
// the two parts by themselves.
import Foundation
import WhisperKit

let started = DispatchTime.now().uptimeNanoseconds
func ms() -> Int { Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) }
func emit(_ value: [String: Any]) {
    var value = value
    value["t"] = ms()
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
func peak() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_maxrss) / 1_048_576
}

do {
    let a = CommandLine.arguments
    guard a.count > 4 else { throw NSError(domain: "usage", code: 2) }
    let pipe = try await WhisperKit(WhisperKitConfig(modelFolder: a[1], tokenizerFolder: URL(fileURLWithPath: a[2]), verbose: false, logLevel: .error, prewarm: false, load: true, download: false))
    let load = ms()
    emit(["ready": true, "mb": peak()])
    let data = try Data(contentsOf: URL(fileURLWithPath: a[4])).dropFirst(44)
    let samples: [Float] = data.withUnsafeBytes { $0.bindMemory(to: Int16.self).map { Float($0) / 32768 } }
    let language = a[3] == "auto" ? nil : a[3]
    // Words the person uses, given to the model as what came before: Whisper then spells them that way.
    let prompt = a.count > 5 ? pipe.tokenizer?.encode(text: " " + a[5]).filter { $0 < pipe.tokenizer!.specialTokens.specialTokenBegin } : nil
    let options = DecodingOptions(task: .transcribe, language: language, temperature: 0, usePrefillPrompt: true, detectLanguage: language == nil,
                                  skipSpecialTokens: true, withoutTimestamps: true, promptTokens: prompt)
    let begun = ms()
    var first = 0
    let results = try await pipe.transcribe(audioArray: samples, decodeOptions: options) { progress in
        if first == 0 { first = ms() }
        return nil
    }
    let transcribe = ms() - begun, seconds = Double(samples.count) / 16000
    let text = results.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    emit(["final": text, "language": results.first?.language ?? "", "load": load, "transcribe": transcribe, "first": first - begun,
          "after": max(0, load - Int(seconds * 1000)) + transcribe, "seconds": seconds, "mb": peak()])
} catch {
    emit(["error": "\(error)"])
    exit(1)
}
