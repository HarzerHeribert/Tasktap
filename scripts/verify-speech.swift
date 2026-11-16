import Foundation
import CoreMedia

// Link production policy, request construction and transcript handling without
// credentials, network requests, microphone access or speech model downloads.
enum RouterSecrets { static func get(_ name:String)throws->String? { nil }; static func set(_ name:String,_ value:String?)throws {} }
enum RouterHTTP { static func json(_ request:URLRequest)async throws->[String:Any] { throw SpeechPreferenceError("Network disabled in fixture") } }

@main struct SpeechChecks {
 static func main() async throws {
  let root=FileManager.default.temporaryDirectory.appendingPathComponent("tasktap-speech-test-"+UUID().uuidString)
  defer {try? FileManager.default.removeItem(at:root)}
  let file=root.appendingPathComponent("preferences.json"),store=SpeechPreferenceStore(file:file)
  precondition(store.value.localEngine=="recommended")
  precondition(store.value.engine(recommendation:"apple-speech")=="apple-speech")
  var prefs=SpeechPreferences();prefs.localEngine="apple-dictation";prefs.mode="cloud";prefs.models["openai"]="gpt-4o-transcribe"
  try store.save(prefs.json)
  let restored=SpeechPreferenceStore(file:file).value
  precondition(restored.engine(recommendation:"whisper-turbo")=="apple-dictation")
  precondition(restored.model(for:"openai",recommendations:["openai":"future-model"])=="gpt-4o-transcribe")
  let old=try JSONDecoder().decode(SpeechPreferences.self,from:Data("{\"localEngine\":\"apple-speech\"}".utf8))
  precondition(old.localEngine=="apple-speech"&&old.language=="auto")
  let unknown=try JSONDecoder().decode(SpeechPreferences.self,from:Data("{\"localEngine\":\"retired-engine\"}".utf8))
  precondition(unknown.resolvedEngine=="retired-engine","never silently switch an explicit retired engine")
  do {try store.save(["mode":"cloud","provider":"untrusted","localEngine":"recommended"]);preconditionFailure("invalid provider accepted")} catch {}
  precondition(store.value==restored,"invalid save preserves prior config")
  let audio=Data([1,2,3,4])
  for provider in SpeechPolicy.providers {
   var config=SpeechPreferences();config.mode="cloud";config.provider=provider
   let request=try CloudSpeech.request(audio:audio,configuration:config,key:"fixture-key")
   precondition(request.url?.scheme=="https")
   precondition(!(request.url?.absoluteString.contains("fixture-key") ?? true))
   precondition(request.httpMethod=="POST")
   if provider=="deepgram" {precondition(request.httpBody==audio);precondition(request.url!.query!.contains("language=multi"))}
   else {precondition(request.httpBody!.range(of:audio) != nil);precondition(!String(decoding:request.httpBody!,as:UTF8.self).contains("fixture-key"))}
  }
  let simple=try CloudSpeech.transcript(["text":" Hallo "],provider:"openai")
  let nested=try CloudSpeech.transcript(["results":["channels":[["alternatives":[["transcript":"Guten Tag"]]]]]],provider:"deepgram")
  precondition(simple=="Hallo"&&nested=="Guten Tag")
  var parts=TranscriptParts()
  func range(_ start:Double,_ length:Double)->CMTimeRange {CMTimeRange(start:CMTime(seconds:start,preferredTimescale:1000),duration:CMTime(seconds:length,preferredTimescale:1000))}
  precondition(parts.add(range(0,1),"Mach den ")=="Mach den")
  precondition(parts.add(range(0,2),"Mach den Button ")=="Mach den Button")
  precondition(parts.add(range(2,1),"größer.")=="Mach den Button größer.")
  precondition(parts.add(range(0,3),"Mach den Button größer, but keep the shortcut.")=="Mach den Button größer, but keep the shortcut.")
  print("PASS: durable pinned choices, recommendation changes, future/partial config decoding, provider endpoint/body isolation, transcript parsing, and overlapping live hypotheses.")
 }
}
