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

// Both Apple modules and batch engines deliver the same request-scoped events.
// The selected configuration is frozen at press time, including remote consent.
@MainActor final class Dictation {
    private var request: String?
    var isActive:Bool {request != nil}
    private var task: Task<Void,Never>?
    private var microphone: MicrophoneStream?
    private var recorded: MicrophoneFile?
    private var analyzer: SpeechAnalyzer?
    private var analyzing=false
    private var finishing=false
    private var deviceObserver: NSObjectProtocol?
    var event: (String,String,String)->Void = {_,_,_ in}
    var level: (String,Double)->Void = {_,_ in}

    func start(_ id:String, service:SpeechService) {
        cancel()
        request=id
        let config=service.preferences
        task=Task {
            do {
                let status=await service.snapshot(configuration:config)
                try Task.checkCancellation()
                guard request==id else {return}
                guard status["supported"] as? Bool == true, status["ready"] as? Bool == true else {
                    throw SpeechPreferenceError("Set up your selected dictation engine in Preferences → Voice. You can keep typing.")
                }
                guard await AVCaptureDevice.requestAccess(for:.audio) else {
                    throw SpeechPreferenceError("Allow microphone access in System Settings, or type your request.")
                }
                try Task.checkCancellation()
                guard request==id else {return}
                service.publish()
                let levelCallback:@Sendable (Double)->Void = { [weak self] value in
                    Task { @MainActor in if self?.request==id {self?.level(id,value)} }
                }
                let failure:@Sendable ()->Void = { [weak self] in
                    Task { @MainActor in self?.fail(id,"The microphone stopped or the five-minute recording limit was reached. You can keep typing.") }
                }
                if config.mode=="cloud" || config.resolvedEngine=="whisper-turbo" {
                    let mic=try MicrophoneFile();recorded=mic
                    try mic.start(level:levelCallback,failure:failure)
                    observeDevice(mic.engine,id:id)
                    event(id,"recording","")
                    return
                }
                let module:any SpeechModule
                let legacy:DictationTranscriber?
                let modern:SpeechTranscriber?
                if config.resolvedEngine=="apple-dictation",let locale=await DictationTranscriber.supportedLocale(equivalentTo:service.appleLocale(config.language)) {
                    let transcriber=DictationTranscriber(locale:locale,preset:.progressiveLongDictation)
                    legacy=transcriber;modern=nil;module=transcriber
                } else if config.resolvedEngine=="apple-speech",SpeechTranscriber.isAvailable,
                          let locale=await SpeechTranscriber.supportedLocale(equivalentTo:service.appleLocale(config.language)) {
                    let transcriber=SpeechTranscriber(locale:locale,preset:.progressiveTranscription)
                    legacy=nil;modern=transcriber;module=transcriber
                } else {throw DictationProblem.language}
                try Task.checkCancellation()
                guard request==id else {return}
                guard let format=await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:[module]) else {throw DictationProblem.language}
                try Task.checkCancellation()
                let speech=SpeechAnalyzer(modules:[module]);analyzer=speech
                let mic=MicrophoneStream();microphone=mic
                try mic.start(format:format,level:levelCallback,failed:failure)
                observeDevice(mic.engine,id:id)
                event(id,"recording","")
                try await speech.prepareToAnalyze(in:format)
                try Task.checkCancellation()
                try await speech.start(inputSequence:mic.inputs)
                try Task.checkCancellation()
                analyzing=true
                if finishing {finalize(speech,id)}
                var parts=TranscriptParts()
                if let legacy {
                    for try await result in legacy.results {
                        let text=parts.add(result.range,String(result.text.characters))
                        if request==id {event(id,"partial",text)}
                    }
                } else if let modern {
                    for try await result in modern.results {
                        let text=parts.add(result.range,String(result.text.characters))
                        if request==id {event(id,"partial",text)}
                    }
                }
                guard request==id else {return}
                event(id,parts.text.isEmpty ? "stopped":"text",parts.text)
                cancel(id)
            } catch {fail(id,error.localizedDescription)}
        }
        // Batch transcription is started only after release, with this same config.
        batchFinish = { [weak self, weak service] in
            guard let self,let service,let mic=recorded else {return}
            mic.stop();event(id,"processing","Transcribing…")
            task=Task {
                defer {mic.remove()}
                do {
                    let text=try await service.transcribe(mic.fileURL,configuration:config)
                    try Task.checkCancellation()
                    guard self.request==id else {return}
                    self.event(id,text.isEmpty ? "stopped":"text",text);self.cancel(id)
                } catch {self.fail(id,error.localizedDescription)}
            }
        }
    }
    private var batchFinish:(()->Void)?
    private func observeDevice(_ engine:AVAudioEngine,id:String){
        deviceObserver=NotificationCenter.default.addObserver(forName:.AVAudioEngineConfigurationChange,object:engine,queue:.main){ [weak self] _ in
            Task { @MainActor in self?.fail(id,"The audio input changed. Try dictating again or keep typing.") }
        }
    }
    private func fail(_ id:String,_ message:String){
        guard request==id else {return}
        event(id,"error",message);cancel(id)
    }
    private func stopMicrophone(){
        if let deviceObserver {NotificationCenter.default.removeObserver(deviceObserver)}
        deviceObserver=nil;microphone?.stop();microphone=nil
    }
    func cancel(_ id:String?=nil){
        if let id,request != id {return}
        request=nil;analyzing=false;finishing=false
        stopMicrophone();task?.cancel();task=nil
        recorded?.remove();recorded=nil;batchFinish=nil
        if let analyzer {Task {await analyzer.cancelAndFinishNow()}}
        analyzer=nil
    }
    func finish(_ id:String){
        guard request==id,!finishing else {return}
        guard microphone != nil || recorded != nil else {event(id,"stopped","");cancel(id);return}
        finishing=true;stopMicrophone()
        if recorded != nil {batchFinish?();return}
        event(id,"processing","Finishing dictation…")
        if analyzing,let analyzer {finalize(analyzer,id)}
    }
    private func finalize(_ analyzer:SpeechAnalyzer,_ id:String){
        Task {do {try await analyzer.finalizeAndFinishThroughEndOfInput()} catch {fail(id,error.localizedDescription)}}
    }
}

// Partial hypotheses replace overlapping audio ranges; they are never appended
// to the previous hypothesis. The editor receives a whole replaceable string.
struct TranscriptParts {
    private var parts:[(range:CMTimeRange,text:String)]=[]
    var text:String {parts.map(\.text).joined().trimmingCharacters(in:.whitespacesAndNewlines)}
    mutating func add(_ range:CMTimeRange,_ text:String)->String {
        parts.removeAll {part in CMTimeCompare(part.range.start,range.start)==0 ||
            (CMTimeCompare(part.range.start,range.end)<0 && CMTimeCompare(range.start,part.range.end)<0)}
        parts.append((range,text));parts.sort{CMTimeCompare($0.range.start,$1.range.start)<0}
        return self.text
    }
}
