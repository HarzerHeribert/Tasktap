import Foundation
import CryptoKit

struct ModelServer {
    enum Kind: String, CaseIterable { case ollama, vllm, litellm, custom }

    let kind: Kind
    let base: URL
    let model: String

    init(kind: String, address: String, model: String) throws {
        guard let kind = Kind(rawValue:kind) else {throw RouterFailure("Choose a server type.")}
        var raw = address.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !raw.isEmpty, !raw.contains(where: { $0.isWhitespace || $0 == "\\" }) else {
            throw RouterFailure("Enter the server’s base URL.")
        }
        if !raw.contains("://") {
            let host = URLComponents(string:"http://"+raw)?.host ?? ""
            let local = Self.loopback(host) || host.hasSuffix(".local") || !host.contains(".") || host.hasPrefix("192.168.") || host.hasPrefix("10.")
            raw = (local ? "http://" : "https://")+raw
        }
        guard var parts = URLComponents(string:raw), let host = parts.host, !host.isEmpty,
              let scheme = parts.scheme?.lowercased(), ["http","https"].contains(scheme),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true else {
            throw RouterFailure("Use an HTTP or HTTPS base URL. Put any key in the API key field.")
        }
        parts.host = host.lowercased()
        parts.scheme = scheme
        if parts.port == (scheme == "https" ? 443 : 80) {parts.port=nil}
        while parts.percentEncodedPath.last == "/" {parts.percentEncodedPath.removeLast()}
        if parts.path.isEmpty {parts.path="/v1"}
        guard !parts.path.hasSuffix("/chat/completions"), !parts.path.hasSuffix("/models"), let base=parts.url else {
            throw RouterFailure("Enter the base URL, such as http://localhost:11434/v1.")
        }
        self.kind=kind
        self.base=base
        self.model=model.trimmingCharacters(in:.whitespacesAndNewlines)
    }
    static func loopback(_ label: String) -> Bool {
        let host=label.lowercased().trimmingCharacters(in:CharacterSet(charactersIn:"[]"))
        if host=="localhost" || host=="::1" { return true }
        let octets = host.split(separator:".",omittingEmptySubsequences:false)
        return octets.count==4 && octets.first=="127" && octets.allSatisfy { UInt8($0) != nil }
    }
    var keyName: String {
        let digest=SHA256.hash(data:Data(base.absoluteString.utf8))
        return "server."+kind.rawValue+"."+digest.map {String(format:"%02x",$0)}.joined()
    }
    private func request(_ path: String, key: String, body: RouterJSON? = nil) throws -> URLRequest {
        guard key.utf8.count<=4096, !key.contains(where:{$0.isWhitespace || $0.isNewline}) else {
            throw RouterFailure("Enter the API key without spaces or line breaks.")
        }
        var request=try RouterHTTP.request(base.appendingPathComponent(path),headers:key.isEmpty ? [:]:["Authorization":"Bearer "+key],json:body)
        request.timeoutInterval = body == nil ? 12 : 120
        return request
    }
    private func reply(_ request: URLRequest) async throws -> RouterJSON {
        let data: Data, response: URLResponse
        do { (data,response)=try await RouterHTTP.session.data(for:request) }
        catch let error as URLError where error.code != .cancelled {
            throw RouterFailure("Couldn’t reach "+(base.host ?? "the server")+". Check that it is running and that the address is reachable.")
        }
        let status=(response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300: break
        case 301...399: throw RouterFailure("The server redirected this request. Enter its final base URL.")
        case 401,403: throw RouterFailure("Access denied. Check the server’s API key.")
        case 404: throw RouterFailure("The server couldn’t find this endpoint or model. Check the base URL and model ID.")
        case 429: throw RouterFailure("The server reached a usage or rate limit.")
        default: throw RouterFailure("The server could not complete this request (HTTP \(status)).")
        }
        guard let value=(try? JSONSerialization.jsonObject(with:data)) as? RouterJSON else {
            throw RouterFailure("The server returned an unreadable API response. Check the base URL.")
        }
        return value
    }
    func models(key: String) async throws -> [String] {
        let result=try await reply(request("models",key:key))
        guard let rows=result["data"] as? [RouterJSON] else { throw RouterFailure("Model discovery is unavailable here. Enter the model ID manually.") }
        return Array(Set(rows.compactMap { $0["id"] as? String }.filter { !$0.isEmpty && $0.count<=256 })).sorted()
    }
    func completion(key: String, instructions: String, capture: String) async throws -> String {
        guard !model.isEmpty else {throw RouterFailure("Choose a chat model for this connection.")}
        let body:RouterJSON=["model":model,"stream":false,"messages":[["role":"system","content":instructions],["role":"user","content":capture]]]
        let reply=try await reply(request("chat/completions",key:key,body:body))
        guard let choice=(reply["choices"] as? [RouterJSON])?.first, choice["finish_reason"] as? String == "stop",
              let message=choice["message"] as? RouterJSON, let result=message["content"] as? String,
              !result.isEmpty, result.utf8.count<=65536 else {throw RouterFailure("The server did not return a complete text reply. Choose a chat model.")}
        var lines=result.trimmingCharacters(in:.whitespacesAndNewlines).components(separatedBy:"\n")
        if lines.count>=3, ["```json","```"].contains(lines.first?.lowercased() ?? ""), lines.last=="```" {
            lines.removeFirst();lines.removeLast()
        }
        return lines.joined(separator:"\n")
    }
}
