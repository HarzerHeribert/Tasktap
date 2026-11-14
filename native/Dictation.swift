import AVFoundation
import Speech

// The audio tap runs on Core Audio's thread. Yield a converted buffer owned by
// the analyzer, since the input node can reuse its buffer after this callback.
private final class MicrophoneStream: @unchecked Sendable {
    let engine = AVAudioEngine()
    let inputs: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var tapped = false

    init() {
        (inputs, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    }

    func start(format: AVAudioFormat, level: @escaping @Sendable (Double) -> Void,
               failed: @escaping @Sendable () -> Void) throws {
        let node = engine.inputNode
        let source = node.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let converter = AVAudioConverter(from: source, to: format) else {
            throw DictationProblem.microphone
        }
        let continuation = self.continuation
        node.installTap(onBus: 0, bufferSize: 2048, format: source) { buffer, _ in
            guard buffer.frameLength > 0 else {return}
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength)*format.sampleRate/source.sampleRate)) + 16
            guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {failed();return}
            var supplied = false
            let status = converter.convert(to: output, error: nil) { _, state in
                if supplied {state.pointee = .noDataNow;return nil}
                supplied = true
                state.pointee = .haveData
                return buffer
            }
            guard status != .error else {failed();return}
            if output.frameLength > 0 {continuation.yield(AnalyzerInput(buffer: output))}
            if let samples = buffer.floatChannelData?[0] {
                var sum: Float = 0
                for index in 0..<Int(buffer.frameLength) {sum += samples[index]*samples[index]}
                let db = 10 * log10(max(1e-10, sum / Float(buffer.frameLength)))
                level(min(1,max(0,(Double(db)+55)/49)))
            }
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    func stop() {
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            tapped = false
        }
        continuation.finish()
    }
}

private enum DictationProblem: LocalizedError {
    case microphone, language
    var errorDescription: String? {
        switch self {
        case .microphone: return "Couldn’t use the microphone. You can still type your request."
        case .language: return "On-device dictation is unavailable for this language. You can still type."
        }
    }
}

@MainActor final class Dictation {
    private var request: String?
    private var task: Task<Void,Never>?
    private var microphone: MicrophoneStream?
    private var analyzer: SpeechAnalyzer?
    private var analyzing=false
    private var finishing=false
    private var deviceObserver: NSObjectProtocol?
    var event: (String,String,String)->Void = {_,_,_ in}
    var level: (String,Double)->Void = {_,_ in}

    func start(_ id:String) {
        cancel()
        request=id
        task=Task {
            guard !Task.isCancelled else {return}
            guard await AVCaptureDevice.requestAccess(for:.audio) else {
                fail(id,"Allow microphone access in System Settings, or type your request.")
                return
            }
            guard request==id else {return}
            do {
                let language=Locale.preferredLanguages.first ?? "en-US"
                guard let locale=await DictationTranscriber.supportedLocale(equivalentTo:Locale(identifier:language)) else {throw DictationProblem.language}
                let module=DictationTranscriber(locale:locale,preset:.progressiveLongDictation)
                if let assets=try await AssetInventory.assetInstallationRequest(supporting:[module]) {
                    try Task.checkCancellation()
                    event(id,"preparing","Downloading on-device dictation…")
                    try await assets.downloadAndInstall()
                }
                guard let format=await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:[module]) else {throw DictationProblem.language}
                try Task.checkCancellation()
                let speech=SpeechAnalyzer(modules:[module])
                analyzer=speech
                let mic=MicrophoneStream()
                microphone=mic
                try mic.start(format:format,level:{ [weak self] value in
                    Task { @MainActor in if self?.request==id {self?.level(id,value)} }
                },failed:{ [weak self] in
                    Task { @MainActor in self?.fail(id,DictationProblem.microphone.localizedDescription) }
                })
                deviceObserver=NotificationCenter.default.addObserver(forName:.AVAudioEngineConfigurationChange,object:mic.engine,queue:.main){ [weak self] _ in
                    Task { @MainActor in self?.fail(id,"The audio input changed. Try dictating again or keep typing.") }
                }
                event(id,"recording","")
                // Capture the opening words while the recognizer warms up. A release
                // closes the input stream, so already captured buffers still drain.
                try await speech.prepareToAnalyze(in:format)
                try Task.checkCancellation()
                try await speech.start(inputSequence:mic.inputs)
                try Task.checkCancellation()
                analyzing=true
                if finishing {finalize(speech,id)}
                let text=try await Self.readTranscript(module){ [weak self] text in
                    if self?.request==id {self?.event(id,"partial",text)}
                }
                guard request==id else {return}
                event(id,text.isEmpty ? "stopped":"text",text)
                cancel(id)
            } catch {
                fail(id,error.localizedDescription)
            }
        }
    }

    // Volatile hypotheses may replace earlier ranges, split into pieces or merge.
    // Preserve other segments and always deliver one complete, replaceable string.
    static func readTranscript(_ module: DictationTranscriber, update: (String)->Void) async throws -> String {
        var parts:[(range:CMTimeRange, text:String)] = []
        var previous=""
        for try await result in module.results {
            let range=result.range
            parts.removeAll { part in
                CMTimeCompare(part.range.start,range.start)==0 ||
                (CMTimeCompare(part.range.start,range.end)<0 && CMTimeCompare(range.start,part.range.end)<0)
            }
            parts.append((range,String(result.text.characters)))
            parts.sort {CMTimeCompare($0.range.start,$1.range.start)<0}
            let text=parts.map(\.text).joined().trimmingCharacters(in:.whitespacesAndNewlines)
            if previous != text {previous=text;update(text)}
        }
        return previous
    }

    private func fail(_ id:String,_ message:String){
        guard request==id else {return}
        event(id,"error",message)
        cancel(id)
    }

    private func stopMicrophone(){
        if let deviceObserver {NotificationCenter.default.removeObserver(deviceObserver)}
        deviceObserver=nil
        microphone?.stop()
        microphone=nil
    }
    func cancel(_ id:String?=nil){
        if let id, request != id {return}
        request=nil
        analyzing=false;finishing=false
        stopMicrophone()
        task?.cancel();task=nil
        if let analyzer {Task {await analyzer.cancelAndFinishNow()}}
        analyzer=nil
    }
    func finish(_ id:String){
        guard request==id, !finishing else {return}
        guard microphone != nil else {
            event(id,"stopped","")
            cancel(id)
            return
        }
        finishing=true
        stopMicrophone()
        event(id,"processing","Finishing dictation…")
        if analyzing, let analyzer {finalize(analyzer,id)}
    }
    private func finalize(_ analyzer:SpeechAnalyzer,_ id:String){
        Task {
            do {try await analyzer.finalizeAndFinishThroughEndOfInput()}
            catch {fail(id,error.localizedDescription)}
        }
    }
}
