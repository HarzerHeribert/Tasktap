// The trial of the system's own recognition (SpeechAnalyzer with SpeechTranscriber or DictationTranscriber, macOS 26):
// one recording in, one line of JSON per event out, each with the milliseconds since the program started.
//
//   swiftc -O -swift-version 5 -parse-as-library apple.swift -o apple
//   apple <speech|dictation> <locale[,locale]> <file.wav> [realtime|fast]
//   apple install <speech|dictation> <locale>        # asks the system for that language's model; prints progress
//   apple status
//   apple release <locale>                          # gives the language's model back: macOS removes it when it sees fit
//
// The recording is fed as the app feeds it: 16 kHz mono 16-bit, a tenth of a second at a time, at the pace of speech
// (`realtime`) or as fast as it is taken (`fast`). With two locales both listen to the same audio and the transcript
// the engine is surer of wins; each is printed.
import AVFoundation
import Speech

let started = DispatchTime.now().uptimeNanoseconds
func ms() -> Int { Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) }
func emit(_ value: [String: Any]) {
    var value = value
    value["t"] = ms()
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
/// The most memory this process has held, in megabytes.
func peak() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_maxrss) / 1_048_576
}

func module(_ engine: String, _ locale: Locale) -> any SpeechModule {
    engine == "dictation"
        ? DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults], attributeOptions: [.transcriptionConfidence])
        : SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.transcriptionConfidence])
}

/// What one module has heard: the parts that are final, and the part that may still change.
final class Heard: @unchecked Sendable {
    var final = "", volatile = "", sure = 0.0, runs = 0.0
    var text: String { (final + volatile).trimmingCharacters(in: .whitespacesAndNewlines) }
    func take(_ text: AttributedString, isFinal: Bool) {
        let words = String(text.characters)
        if isFinal {
            final += words
            volatile = ""
            for run in text.runs { if let c = run.transcriptionConfidence { sure += c; runs += 1 } }
        } else { volatile = words }
    }
}

@main struct Trial {
    static func main() async {
        _ = started
        do { try await run() } catch {
            emit(["error": "\(error)"])
            exit(1)
        }
    }
    static func run() async throws {
        let a = CommandLine.arguments
        if a.count > 1, a[1] == "status" {
            emit(["speech": await SpeechTranscriber.installedLocales.map(\.identifier).sorted(), "dictation": await DictationTranscriber.installedLocales.map(\.identifier).sorted(),
                  "reserved": await AssetInventory.reservedLocales.map(\.identifier)])
            return
        }
        if a.count > 2, a[1] == "release" {
            emit(["released": await AssetInventory.release(reservedLocale: Locale(identifier: a[2])), "reserved": await AssetInventory.reservedLocales.map(\.identifier)])
            return
        }
        if a.count > 3, a[1] == "install" {
            let m = module(a[2], Locale(identifier: a[3]))
            emit(["status": "\(await AssetInventory.status(forModules: [m]))"])
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: [m]) else { return emit(["installed": true]) }
            let watch = request.progress.observe(\.fractionCompleted) { p, _ in emit(["progress": p.fractionCompleted, "bytes": p.totalUnitCount]) }
            try await request.downloadAndInstall()
            watch.invalidate()
            emit(["installed": true, "status": "\(await AssetInventory.status(forModules: [m]))"])
            return
        }
        guard a.count > 3 else { throw NSError(domain: "usage", code: 2) }
        let engine = a[1], pace = a.count > 4 ? a[4] : "realtime"
        let samples = try Data(contentsOf: URL(fileURLWithPath: a[3])).dropFirst(44)
        var modules: [any SpeechModule] = [], heard: [Heard] = [], names: [String] = []
        for id in a[2].split(separator: ",") {
            let asked = Locale(identifier: String(id))
            let found = engine == "dictation" ? await DictationTranscriber.supportedLocale(equivalentTo: asked) : await SpeechTranscriber.supportedLocale(equivalentTo: asked)
            guard let locale = found else { throw NSError(domain: "no such language: \(id)", code: 3) }
            modules.append(module(engine, locale))
            heard.append(Heard())
            names.append(locale.identifier)
        }
        guard await AssetInventory.status(forModules: modules) == .installed else { throw NSError(domain: "the model is not installed", code: 4) }
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        let analyzer = SpeechAnalyzer(modules: modules, options: .init(priority: .userInitiated, modelRetention: .whileInUse))
        try await analyzer.prepareToAnalyze(in: format)
        emit(["ready": true, "mb": peak()])
        let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: input)
        let listening = modules.enumerated().map { i, m in
            Task {
                func took(_ text: AttributedString, _ isFinal: Bool) {
                    heard[i].take(text, isFinal: isFinal)
                    if modules.count == 1 { emit(["partial": heard[i].text]) }
                }
                if let m = m as? SpeechTranscriber { for try await r in m.results { took(r.text, r.isFinal) } }
                if let m = m as? DictationTranscriber { for try await r in m.results { took(r.text, r.isFinal) } }
            }
        }
        // A tenth of a second at a time, as the page's worklet hands it over.
        let step = 3200
        var at = samples.startIndex
        let began = ms()
        while at < samples.endIndex {
            let end = min(at + step, samples.endIndex), frames = (end - at) / 2
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
            buffer.frameLength = AVAudioFrameCount(frames)
            samples[at..<end].withUnsafeBytes { src in _ = memcpy(buffer.int16ChannelData![0], src.baseAddress!, frames * 2) }
            feed.yield(AnalyzerInput(buffer: buffer))
            at = end
            if pace == "realtime" {
                let due = began + (at - samples.startIndex) / 32
                if due > ms() { try await Task.sleep(nanoseconds: UInt64(due - ms()) * 1_000_000) }
            }
        }
        feed.finish()
        let let_go = ms()
        emit(["fed": true, "seconds": Double(samples.count) / 32000])
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        for task in listening { try await task.value }
        // The transcript the engine is surest of.
        let best = heard.indices.max { (heard[$0].runs > 0 ? heard[$0].sure / heard[$0].runs : 0) < (heard[$1].runs > 0 ? heard[$1].sure / heard[$1].runs : 0) }!
        var all: [String: Any] = [:]
        for i in heard.indices { all[names[i]] = ["text": heard[i].text, "sure": heard[i].runs > 0 ? heard[i].sure / heard[i].runs : 0] }
        emit(["final": heard[best].text, "locale": names[best], "after": ms() - let_go, "mb": peak(), "all": all])
    }
}
