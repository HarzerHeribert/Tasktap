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
    private var generation=UUID()
    var changed:(String)->Void={_ in}
    override init(){super.init();synth.delegate=self}
    var voices:[[String:String]]{
        AVSpeechSynthesisVoice.speechVoices().filter{$0.identifier.lowercased().hasPrefix("com.apple.siri.")}.map{["id":$0.identifier,"name":"Siri · "+$0.name+" · "+$0.language]}
    }
    func stop(){generation=UUID();task?.cancel();task=nil;player?.stop();player=nil;synth.stopSpeaking(at:.immediate);changed("idle")}
    func speak(_ text:String,voice:String){
        stop()
        guard !text.isEmpty else {return}
        if voice=="kokoro" {
            let token=generation
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
