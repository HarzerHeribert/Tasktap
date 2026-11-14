import AppKit
import Security

typealias RouterJSON = [String: Any]

struct RouterFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum RouterSecrets {
    private static func query(_ name: String) -> RouterJSON {
        [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"io.github.harzerheribert.tasktap.routing", kSecAttrAccount as String:name]
    }
    static func get(_ name: String) throws -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data:data, encoding:.utf8) else {
            throw RouterFailure("Keychain could not read this connection.")
        }
        return value
    }
    static func set(_ name: String, _ value: String?) throws {
        var q = query(name)
        guard let value else {
            let status = SecItemDelete(q as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw RouterFailure("Keychain could not remove this connection.") }
            return
        }
        let data = Data(value.utf8)
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw RouterFailure("Keychain could not save this connection.") }
    }
}

// Keep each request on its chosen endpoint, including requests to a configured model server.
private final class RouterHTTPDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
enum RouterHTTP {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 90
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: RouterHTTPDelegate(), delegateQueue: nil)
    }()
    static func request(_ url: URL, headers: [String:String] = [:], json: RouterJSON? = nil) throws -> URLRequest {
        var req = URLRequest(url:url)
        if let json {
            req.httpMethod = "POST"
            req.httpBody = try JSONSerialization.data(withJSONObject:json)
            req.setValue("application/json", forHTTPHeaderField:"Content-Type")
        }
        for (key,value) in headers { req.setValue(value, forHTTPHeaderField:key) }
        return req
    }
    static func check(_ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            switch status {
            case 401, 403: throw RouterFailure("The provider denied access. Check the connection and model.")
            case 429: throw RouterFailure("The provider reached a usage or rate limit.")
            case 400, 404: throw RouterFailure("The provider rejected the request. Check the model or reconnect.")
            default: throw RouterFailure("The provider is unavailable (HTTP \(status)).")
            }
        }
    }
    static func data(_ request: URLRequest) async throws -> Data {
        let (data,response) = try await session.data(for:request)
        try check(response)
        return data
    }
    static func json(_ request: URLRequest) async throws -> RouterJSON {
        guard let value = try JSONSerialization.jsonObject(with:try await data(request)) as? RouterJSON else {
            throw RouterFailure("The provider returned an unreadable response.")
        }
        return value
    }
    static func form(_ url: URL, _ fields: [String:String]) -> URLRequest {
        var req = URLRequest(url:url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField:"Content-Type")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn:"-._~"))
        req.httpBody = Data(fields.map { key,value in key+"="+(value.addingPercentEncoding(withAllowedCharacters:allowed) ?? "") }.joined(separator:"&").utf8)
        return req
    }
}

enum RouterCLI {
    // Keep process startup and cancellation ordered, including cancellation during launch.
    private final class Child: @unchecked Sendable {
        let process = Process()
        let lock = NSLock()
        var cancelled = false
        func run() throws {
            lock.lock(); defer {lock.unlock()}
            if cancelled {throw CancellationError()}
            try process.run()
        }
        func stop() {
            lock.lock(); defer {lock.unlock()}
            cancelled = true
            if process.isRunning {process.terminate()}
        }
    }
    static func call(_ name: String, _ payload: RouterJSON) async throws -> RouterJSON {
        guard let url = Bundle.main.url(forResource:"router-provider", withExtension:nil) else { throw RouterFailure("Rebuild Tasktap to install its routing helper.") }
        let input = try JSONSerialization.data(withJSONObject:payload)
        let child = Child()
        let process = child.process
        process.executableURL = url
        process.arguments = [name]
        process.environment = LiveWorkspace.cliEnvironment
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos:.userInitiated).async {
                    do {
                        let writer = Pipe(), reader = Pipe()
                        process.standardInput = writer
                        process.standardOutput = reader
                        process.standardError = FileHandle.nullDevice
                        try child.run()
                        try writer.fileHandleForWriting.write(contentsOf:input)
                        try writer.fileHandleForWriting.close()
                        let bytes = reader.fileHandleForReading.readDataToEndOfFile()
                        process.waitUntilExit()
                        let response = (try? JSONSerialization.jsonObject(with:bytes)) as? RouterJSON
                        guard let value = response?["value"] as? RouterJSON else {
                            throw RouterFailure(response?["error"] as? String ?? "The connection was interrupted.")
                        }
                        continuation.resume(returning:value)
                    } catch { child.stop(); continuation.resume(throwing:error) }
                }
            }
        }, onCancel: { child.stop() })
    }
}

@MainActor final class ChatGPTConnection {
    private let defaults = UserDefaults.standard
    private let issuer = "https://auth.openai.com"
    private let tokenURL = URL(string:"https://auth.openai.com/api/accounts/oauth/token")!
    private let resource = "https://api.openai.com/v1"
    private let scope = "chatgpt.tokens.use.direct"
    private(set) var busy = false
    private var refreshes = [String:Task<String,Error>]()
    var selected: String { defaults.string(forKey:"router.chatgpt.selected") ?? "" }
    var registrations: [String:[String:String]] {
        defaults.dictionary(forKey:"router.chatgpt.registrations") as? [String:[String:String]] ?? [:]
    }
    private func stored(_ client: String) throws -> RouterJSON {
        guard let value = try RouterSecrets.get("chatgpt."+client),
              let json = try JSONSerialization.jsonObject(with:Data(value.utf8)) as? RouterJSON else {
            throw RouterFailure("Continue with ChatGPT to connect your plan.")
        }
        return json
    }
    private func save(_ json: RouterJSON, client: String) throws {
        let data = try JSONSerialization.data(withJSONObject:json)
        try RouterSecrets.set("chatgpt."+client, String(decoding:data,as:UTF8.self))
    }
    private func scopeGranted(_ token: RouterJSON) -> Bool {
        (token["scope"] as? String ?? "").split(separator:" ").contains(Substring(scope))
    }
    func select(_ client: String) throws {
        guard !busy, registrations[client] != nil else {throw RouterFailure("Finish the current connection first.")}
        defaults.set(client,forKey:"router.chatgpt.selected")
    }
    @discardableResult func login(client prior: String, activate: Bool = true) async throws -> String {
        guard !busy, refreshes.isEmpty else { throw RouterFailure("A connection is already in progress. Try again in a moment.") }
        busy = true; defer { busy = false }
        var host = defaults.string(forKey:"router.chatgpt.host") ?? ""
        if host.isEmpty { host = "urn:uuid:"+UUID().uuidString.lowercased(); defaults.set(host,forKey:"router.chatgpt.host") }
        let account = registrations[prior]
        if !prior.isEmpty && account == nil { throw RouterFailure("Choose a saved ChatGPT connection.") }
        let cb = try await RouterCLI.call("login",["host":host,"client":prior,"email":account?["email"] ?? ""])
        guard let client = cb["client"] as? String, let code = cb["code"] as? String,
              let verifier = cb["verifier"] as? String, let nonce = cb["nonce"] as? String, let uri = cb["redirect"] as? String else {
            throw RouterFailure("ChatGPT sign-in did not finish.")
        }
        var token = try await RouterHTTP.json(RouterHTTP.form(tokenURL,["grant_type":"authorization_code",
            "client_id":client,"code":code,"code_verifier":verifier,"redirect_uri":uri,"resource":resource]))
        let claims = try await verifyID(token["id_token"] as? String ?? "", client:client, nonce:nonce)
        guard let sub = claims["sub"] as? String, !sub.isEmpty, account == nil || account?["sub"] == sub,
              let expires = token["expires_in"] as? Double, token["access_token"] is String else {
            throw RouterFailure("The returned account could not be verified.")
        }
        token["expires"] = Date().timeIntervalSince1970 + expires
        try save(token,client:client)
        var records = registrations
        records[client] = ["sub":sub,"email":claims["email"] as? String ?? "ChatGPT account","plan":scopeGranted(token) ? "enabled":"off"]
        defaults.set(records,forKey:"router.chatgpt.registrations")
        if activate {defaults.set(client,forKey:"router.chatgpt.selected")}
        return client
    }
    func access(client: String) async throws -> String {
        guard !busy, !client.isEmpty else {throw RouterFailure("Connect your ChatGPT plan in AI connections.")}
        if let pending = refreshes[client] {return try await pending.value}
        let pending = Task { @MainActor in try await self.freshAccess(client:client) }
        refreshes[client] = pending
        defer {refreshes[client] = nil}
        return try await pending.value
    }
    private func freshAccess(client: String) async throws -> String {
        var token = try stored(client)
        guard scopeGranted(token) else {throw RouterFailure("Plan usage needs consent. Open AI connections to reconnect.")}
        if (token["expires"] as? Double ?? 0) <= Date().timeIntervalSince1970+30 {
            guard let refresh = token["refresh_token"] as? String else {throw RouterFailure("Reconnect your ChatGPT plan.")}
            let fresh = try await RouterHTTP.json(RouterHTTP.form(tokenURL,["grant_type":"refresh_token","refresh_token":refresh,"client_id":client,"resource":resource]))
            guard fresh["access_token"] is String, let seconds = fresh["expires_in"] as? Double else {throw RouterFailure("Reconnect your ChatGPT plan.")}
            token.merge(fresh) { _,new in new }
            token["expires"] = Date().timeIntervalSince1970+seconds
            try save(token,client:client)
        }
        guard scopeGranted(token), let access = token["access_token"] as? String else {throw RouterFailure("ChatGPT plan usage is unavailable for this account.")}
        return access
    }
    func disconnect() async throws {
        guard !busy, refreshes[selected] == nil, !selected.isEmpty else {throw RouterFailure("Finish the current connection first.")}
        busy = true; defer {busy = false}
        let client = selected
        let token = try stored(client)
        var confirmed = true
        if let refresh = token["refresh_token"] as? String {
            do {
                let metadata = try await RouterHTTP.json(RouterHTTP.request(URL(string:issuer+"/.well-known/openid-configuration")!))
                guard let value = metadata["revocation_endpoint"] as? String, let endpoint = URL(string:value),
                      endpoint.scheme == "https", endpoint.host == "auth.openai.com" else {throw RouterFailure("Unknown revocation endpoint.")}
                _ = try await RouterHTTP.data(RouterHTTP.form(endpoint,["client_id":client,"token":refresh,"token_type_hint":"refresh_token"]))
            } catch { confirmed = false }
        }
        try RouterSecrets.set("chatgpt."+client,nil)
        var records = registrations
        records[client]?["plan"] = "signedOut"
        defaults.set(records,forKey:"router.chatgpt.registrations")
        if !confirmed {throw RouterFailure("Signed out on this Mac. Check remote access in ChatGPT Settings.")}
    }

    private func verifyID(_ jwt: String, client: String, nonce: String) async throws -> RouterJSON {
        let invalid = RouterFailure("ChatGPT identity verification failed. Try signing in again.")
        let parts = jwt.components(separatedBy:".")
        func base64url(_ value: String) -> Data? {
            var s = value.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
            s += String(repeating:"=",count:(4-s.count%4)%4)
            return Data(base64Encoded:s)
        }
        guard parts.count == 3, let header = base64url(parts[0]), let body = base64url(parts[1]), let signature = base64url(parts[2]),
              let h = try JSONSerialization.jsonObject(with:header) as? RouterJSON, h["alg"] as? String == "RS256",
              let kid = h["kid"] as? String, let claims = try JSONSerialization.jsonObject(with:body) as? RouterJSON else {throw invalid}
        let keys = try await RouterHTTP.json(RouterHTTP.request(URL(string:issuer+"/.well-known/jwks.json")!))
        guard let jwk = (keys["keys"] as? [RouterJSON])?.first(where: { $0["kid"] as? String == kid && $0["kty"] as? String == "RSA" }),
              let n = base64url(jwk["n"] as? String ?? ""), n.count >= 256,
              let e = base64url(jwk["e"] as? String ?? ""), !e.isEmpty else {throw invalid}
        func der(_ tag: UInt8,_ raw: Data) -> Data {
            var size = raw.count, bytes = [UInt8]()
            while size > 0 {bytes.insert(UInt8(size & 255),at:0);size >>= 8}
            let length = raw.count < 128 ? [UInt8(raw.count)] : [0x80 | UInt8(bytes.count)]+bytes
            return Data([tag]+length)+raw
        }
        func integer(_ d: Data) -> Data {der(2,(d.first! >= 128 ? Data([0]):Data())+d)}
        let keyData = der(0x30,integer(n)+integer(e))
        let attrs = [kSecAttrKeyType:kSecAttrKeyTypeRSA,kSecAttrKeyClass:kSecAttrKeyClassPublic] as CFDictionary
        let aud = claims["aud"] as? [String] ?? [claims["aud"] as? String ?? ""]
        guard let key = SecKeyCreateWithData(keyData as CFData,attrs,nil),
              SecKeyVerifySignature(key,.rsaSignatureMessagePKCS1v15SHA256,Data((parts[0]+"."+parts[1]).utf8) as CFData,signature as CFData,nil),
              claims["iss"] as? String == issuer, aud.contains(client), aud.count == 1 || claims["azp"] as? String == client,
              (claims["exp"] as? Double ?? 0) > Date().timeIntervalSince1970, claims["nonce"] as? String == nonce else {throw invalid}
        return claims
    }
}
