// Build with native/ModelServer.swift, RouterConnection.swift and LiveWorkspace.swift.
// An optional local fixture base exercises the same HTTP adapter used by the app.
import Foundation

@main struct ModelServerChecks {
    static func main() async throws {
        let bare = try ModelServer(kind:"ollama",address:"localhost:11434",model:"qwen3:4b")
        precondition(bare.base.absoluteString=="http://localhost:11434/v1")
        let v6 = try ModelServer(kind:"ollama",address:"http://[::1]:11434/v1/",model:"m")
        precondition(ModelServer.loopback(v6.base.host ?? ""))
        let a = try ModelServer(kind:"litellm",address:"https://MODELS.example.com:443/team-a/v1/",model:"m")
        let b = try ModelServer(kind:"litellm",address:"https://models.example.com/team-b/v1",model:"m")
        precondition(a.base.absoluteString=="https://models.example.com/team-a/v1" && a.keyName != b.keyName)
        for invalid in ["file:///tmp/models", "https://user:pass@localhost/v1", "https://host/v1?key=x", "http://host/v1/chat/completions", "http://host:70000/v1"] {
            do {_ = try ModelServer(kind:"custom",address:invalid,model:"m");fatalError("Accepted an invalid base URL.")}
            catch is RouterFailure {}
        }
        if let url=CommandLine.arguments.dropFirst().first {
            for kind in ModelServer.Kind.allCases {
                let server=try ModelServer(kind:kind.rawValue,address:url,model:"studio")
                let models=try await server.models(key:"fixture")
                precondition(models==["studio"])
                let value=try await server.completion(key:"fixture",instructions:"Return JSON.",capture:"Fixture")
                precondition(value=="{\"mode\":\"note\"}")
                do {_ = try await server.models(key:"");fatalError("Ignored a missing key.")}
                catch let error as RouterFailure {precondition(error.message.contains("Access denied"))}
            }
        }
        print("Model server URL validation, endpoint-scoped key IDs and requested adapter checks passed.")
    }
}
