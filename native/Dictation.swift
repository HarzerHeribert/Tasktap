import AVFoundation
import Speech

@MainActor final class Dictation {
    private var recorder: AVAudioRecorder?
    private var request: String?
    private var processing: Task<Void,Never>?
    private var meterTimer: Timer?
    var event: (String,String,String)->Void = {_,_,_ in}
    var level: (String,Double)->Void = {_,_ in}

    // Silence below the noise floor rests at zero; normal speech uses most of the display.
    static func normalizedPower(_ decibels: Float) -> Double {
        guard decibels.isFinite else { return 0 }
        return min(1, max(0, (Double(decibels) + 55) / 49))
    }
    private func startMetering(_ id: String, recorder: AVAudioRecorder) {
        let timer = Timer(timeInterval: 0.04, repeats: true) { [weak self, weak recorder] _ in
            MainActor.assumeIsolated {
                guard let self, let recorder, self.request == id, self.recorder === recorder else { return }
                guard recorder.isRecording else {
                    self.event(id,"error","Dictation stopped. Check the microphone and try again.")
                    self.cancel()
                    return
                }
                recorder.updateMeters()
                self.level(id, Self.normalizedPower(recorder.averagePower(forChannel: 0)))
            }
        }
        timer.tolerance = 0.005
        RunLoop.main.add(timer, forMode: .common)
        meterTimer = timer
    }
    private func stopMetering() {
        meterTimer?.invalidate()
        meterTimer = nil
    }
    func start(_ id:String) {
        cancel()
        request=id
        Task {
            guard await AVCaptureDevice.requestAccess(for:.audio) else {
                if request==id {event(id,"error","Allow microphone access in System Settings to dictate.");cancel()}
                return
            }
            guard request==id else {return}
            do {
                let file=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString+".caf")
                let settings:[String:Any]=[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:16000,AVNumberOfChannelsKey:1,AVLinearPCMBitDepthKey:16]
                let r=try AVAudioRecorder(url:file,settings:settings)
                recorder=r
                r.isMeteringEnabled=true
                guard r.record() else {throw CocoaError(.fileWriteUnknown)}
                event(id,"recording","")
                startMetering(id,recorder:r)
            } catch {event(id,"error",error.localizedDescription);cancel()}
        }
    }
    func cancel(_ id:String?=nil){
        if let id, request != id {return}
        stopMetering()
        request=nil;processing?.cancel();processing=nil
        if let r=recorder {r.stop();try? FileManager.default.removeItem(at:r.url)}
        recorder=nil
    }
    func finish(_ id:String){
        guard request==id,let r=recorder else {return}
        stopMetering()
        r.stop();recorder=nil
        event(id,"processing","Transcribing on this Mac…")
        processing=Task {
            defer {try? FileManager.default.removeItem(at:r.url)}
            do {
                guard #available(macOS 26.0,*) else {throw NSError(domain:"Dictation",code:1,userInfo:[NSLocalizedDescriptionKey:"On-device dictation requires macOS 26 or later."])}
                let text=try await Self.transcribe(r.url)
                guard request==id else {return}
                event(id,text.isEmpty ? "error":"text",text.isEmpty ? "No speech detected. Try again or type.":text)
            } catch {if request==id {event(id,"error",error.localizedDescription)}}
            if request==id {request=nil}
        }
    }
    @available(macOS 26.0,*) static func transcribe(_ url:URL) async throws -> String {
        let language=Locale.preferredLanguages.first ?? "en-US"
        guard let locale=await DictationTranscriber.supportedLocale(equivalentTo:Locale(identifier:language)) else {
            throw NSError(domain:"Dictation",code:2,userInfo:[NSLocalizedDescriptionKey:"Local dictation is unavailable for "+language+"."])
        }
        let module=DictationTranscriber(locale:locale,preset:.longDictation)
        if let assets=try await AssetInventory.assetInstallationRequest(supporting:[module]) {try await assets.downloadAndInstall()}
        let analyzer=SpeechAnalyzer(modules:[module])
        async let result:String = {
            var text=""
            for try await segment in module.results where segment.isFinal {
                text += String(segment.text.characters)
            }
            return text.trimmingCharacters(in:.whitespacesAndNewlines)
        }()
        try await analyzer.start(inputAudioFile:AVAudioFile(forReading:url),finishAfterFile:true)
        return try await result
    }
}
