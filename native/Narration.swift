import AVFoundation

// Only produce audio for a voice explicitly exposed as Siri by the local framework.
private final class LocalSpeechRequests:NSObject,URLSessionTaskDelegate {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil)}
}
@MainActor final class Narration:NSObject,@preconcurrency AVSpeechSynthesizerDelegate,@preconcurrency AVAudioPlayerDelegate {
    private let synth=AVSpeechSynthesizer()
    private var player:AVAudioPlayer?
    private var task:URLSessionDataTask?
    private lazy var network=URLSession(configuration:.ephemeral,delegate:LocalSpeechRequests(),delegateQueue:.main)
    private let directory=LiveWorkspace.appData.appendingPathComponent("Kokoro")
    private var synthesis:Process?
    private var installation:Process?
    var kokoroStatus:(String,String)->Void={_,_ in}
    private var installed:Bool {
        ["venv/bin/python","voices-v1.0.bin","kokoro-v1.0.int8.onnx","ready-v1"].allSatisfy{FileManager.default.fileExists(atPath:directory.appendingPathComponent($0).path)}
    }
    func reportKokoro(){
        if installation != nil {kokoroStatus("installing","Setting up the local voice…");return}
        if installed {kokoroStatus("ready","Heart is ready for offline playback.");return}
        var check=URLRequest(url:URL(string:"http://127.0.0.1:8880/v1/models")!)
        check.timeoutInterval=2
        network.dataTask(with:check){[weak self] data,response,_ in
            DispatchQueue.main.async{
                guard let self,self.installation==nil else{return}
                let models=data.flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}
                let online=(response as? HTTPURLResponse)?.statusCode==200 && models?["data"] != nil
                self.kokoroStatus(online ? "ready":"missing",online ? "Connected to the local Kokoro server.":"Download the local English voice (121 MB plus runtime).")
            }
        }.resume()
    }
    func installKokoro(){
        guard installation==nil,let helper=Bundle.main.url(forResource:"kokoro-voice",withExtension:nil) else{return}
        let p=Process();p.executableURL=helper;p.arguments=["install"]
        var env=ProcessInfo.processInfo.environment
        env["PATH"]=[NSHomeDirectory()+"/.local/bin","/opt/homebrew/bin","/usr/local/bin",env["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        p.environment=env
        let log=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath:log.path,contents:nil,attributes:[.posixPermissions:0o600])
        let output=try? FileHandle(forWritingTo:log)
        p.standardError=output;p.standardOutput=output
        installation=p;kokoroStatus("installing","Setting up the local voice…")
        p.terminationHandler={ [weak self] proc in DispatchQueue.main.async {
            try? output?.close()
            let error=(try? String(contentsOf:log,encoding:.utf8))?.split(separator:"\n").last.map(String.init)
            try? FileManager.default.removeItem(at:log)
            self?.installation=nil
            if proc.terminationStatus==0 {self?.reportKokoro()} else {self?.kokoroStatus("missing",error ?? "Voice setup failed. Retry setup.")}
        }}
        do {try p.run()} catch {installation=nil;try? output?.close();try? FileManager.default.removeItem(at:log);kokoroStatus("missing",error.localizedDescription)}
    }
    private func localSpeech(_ text:String,token:UUID)throws {
        let temp=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:temp,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        do {
            let input=temp.appendingPathComponent("speech.txt"),audio=temp.appendingPathComponent("speech.wav")
            try text.write(to:input,atomically:true,encoding:.utf8)
            guard let helper=Bundle.main.url(forResource:"kokoro-voice",withExtension:nil) else{throw CocoaError(.fileNoSuchFile)}
            let p=Process();p.executableURL=directory.appendingPathComponent("venv/bin/python");p.arguments=[helper.path,input.path,audio.path]
            p.terminationHandler={ [weak self] proc in DispatchQueue.main.async{
                defer {try? FileManager.default.removeItem(at:temp)}
                guard let self,self.generation==token else{return}
                self.synthesis=nil
                do {
                    guard proc.terminationStatus==0 else {throw CocoaError(.fileReadCorruptFile)}
                    let speech=try AVAudioPlayer(data:Data(contentsOf:audio))
                    self.player=speech;speech.delegate=self;self.changed(speech.play() ? "speaking":"Could not start audio playback.")
                } catch {self.changed("Kokoro could not generate audio. "+error.localizedDescription)}
            }}
            try p.run();synthesis=p
        } catch {try? FileManager.default.removeItem(at:temp);throw error}
    }
    private var generation=UUID()
    var changed:(String)->Void={_ in}
    override init(){super.init();synth.delegate=self}
    var voices:[[String:String]]{
        AVSpeechSynthesisVoice.speechVoices().filter{$0.identifier.lowercased().hasPrefix("com.apple.siri.")}.map{["id":$0.identifier,"name":"Siri / "+$0.name+" / "+$0.language]}
    }
    func stop(){generation=UUID();if let p=synthesis,p.isRunning {p.terminate()};synthesis=nil;task?.cancel();task=nil;player?.stop();player=nil;synth.stopSpeaking(at:.immediate);changed("idle")}
    func speak(_ text:String,voice:String){
        stop()
        guard !text.isEmpty else {return}
        if voice=="kokoro" {
            let token=generation
            if installed {
                changed("preparing")
                do {try localSpeech(text,token:token)} catch {changed(error.localizedDescription)}
                return
            }
            var request=URLRequest(url:URL(string:"http://127.0.0.1:8880/v1/audio/speech")!)
            request.httpMethod="POST";request.timeoutInterval=45
            request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            request.httpBody=try? JSONSerialization.data(withJSONObject:["model":"kokoro","voice":"af_heart","input":text,"response_format":"wav"])
            changed("preparing")
            task=network.dataTask(with:request){[weak self] data,response,_ in
                DispatchQueue.main.async {
                    guard let self,token==self.generation else {return}
                    guard let data,let http=response as? HTTPURLResponse,(200..<300).contains(http.statusCode),
                          let audio=try? AVAudioPlayer(data:data) else {self.changed("Local Kokoro is unavailable at 127.0.0.1:8880.");return}
                    self.player=audio;audio.delegate=self;self.changed(audio.play() ? "speaking":"Could not play the generated audio.")
                }
            };task?.resume();return
        }
        guard voices.contains(where:{$0["id"]==voice}),let selected=AVSpeechSynthesisVoice(identifier:voice) else {
            changed("Choose an available narration voice in Preferences.");return
        }
        let utterance=AVSpeechUtterance(string:text);utterance.voice=selected
        synth.speak(utterance)
    }
    func speechSynthesizer(_ synthesizer:AVSpeechSynthesizer,didStart utterance:AVSpeechUtterance){changed("speaking")}
    func speechSynthesizer(_ synthesizer:AVSpeechSynthesizer,didFinish utterance:AVSpeechUtterance){changed("idle")}
    func audioPlayerDidFinishPlaying(_ player:AVAudioPlayer,successfully flag:Bool){changed("idle")}
}
