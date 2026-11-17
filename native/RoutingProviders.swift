import AppKit

@MainActor final class RoutingProviders {
    enum Route: String, CaseIterable {
        case local, chatgpt, openai, anthropic, codex, cloud, server
    }
    private let defaults = UserDefaults.standard
    let chat = ChatGPTConnection()
    var workers = [String:String]()
    private(set) var workerHealth = [String:String]()
    var cloudName = ""
    var selected: Route {Route(rawValue:defaults.string(forKey:"router.choice") ?? "") ?? .local}
    private func model(_ route: Route) -> String {defaults.string(forKey:"router.model."+route.rawValue) ?? ""}
    private var profiles: [String:[String:String]] {
        defaults.dictionary(forKey:"router.server.profiles") as? [String:[String:String]] ?? [:]
    }
    private var serverKind: String { defaults.string(forKey:"router.server.kind") ?? "ollama" }

    private func serverKey(_ server: ModelServer, supplied: String, useSaved: Bool) throws -> String {
        if !supplied.isEmpty {return supplied}
        let record=profiles[server.kind.rawValue]
        guard useSaved, record?["url"]==server.base.absoluteString, record?["hasKey"]=="yes" else {return ""}
        guard let key=try RouterSecrets.get(server.keyName) else {throw RouterFailure("The saved server key is missing. Enter it again or use no key.")}
        return key
    }
    func serverModels(_ data: RouterJSON) async throws -> [String] {
        let server=try ModelServer(kind:data["kind"] as? String ?? "",address:data["url"] as? String ?? "",model:"")
        let key=try serverKey(server,supplied:data["key"] as? String ?? "",useSaved:data["useSaved"] as? Bool == true)
        return try await server.models(key:key)
    }
    private func saveServer(_ data: RouterJSON, model: String, key: String) throws {
        let server=try ModelServer(kind:data["kind"] as? String ?? "",address:data["url"] as? String ?? "",model:model)
        guard !server.model.isEmpty else {throw RouterFailure("Choose a chat model or enter its ID.")}
        let activeKey=try serverKey(server,supplied:key,useSaved:data["useSaved"] as? Bool == true)
        var updated=profiles
        // The credential belongs to this exact base URL, including the gateway’s path.
        if let old=updated[server.kind.rawValue], let url=old["url"], url != server.base.absoluteString, old["hasKey"]=="yes" {
            let previous=try ModelServer(kind:server.kind.rawValue,address:url,model:"")
            // Write any replacement first so a failed write preserves the working connection.
            if !activeKey.isEmpty {try RouterSecrets.set(server.keyName,activeKey)}
            try RouterSecrets.set(previous.keyName,nil)
        } else if !key.isEmpty || (activeKey.isEmpty && updated[server.kind.rawValue]?["hasKey"]=="yes") {
            try RouterSecrets.set(server.keyName,activeKey.isEmpty ? nil:activeKey)
        }
        updated[server.kind.rawValue]=["url":server.base.absoluteString,"model":server.model,"hasKey":activeKey.isEmpty ? "no":"yes"]
        defaults.set(updated,forKey:"router.server.profiles")
        defaults.set(server.kind.rawValue,forKey:"router.server.kind")
    }
    func state() -> RouterJSON {
        let accounts = chat.registrations.map { ["id":$0.key,"label":($0.value["email"] ?? "Account")+" / "+String($0.key.suffix(6)),"status":$0.value["plan"] ?? "off"] }.sorted { $0["label"]! < $1["label"]! }
        return ["routingInstructions":HandoffRouter.instructions,"serverKind":serverKind,"serverProfiles":profiles,"choice":selected.rawValue,"models":Dictionary(uniqueKeysWithValues:Route.allCases.map {($0.rawValue,model($0))}),
                "accounts":accounts,"account":chat.selected,"workers":workers,"workerHealth":workerHealth,"cloud":cloudName,
                "keys":["openai":defaults.bool(forKey:"router.key.openai"),"anthropic":defaults.bool(forKey:"router.key.anthropic")]]
    }
    func detectWorkers() async {
        guard let result = try? await RouterCLI.call("status",[:]),
              let health=result["workerHealth"] as? [String:String] else {
            workerHealth=Dictionary(uniqueKeysWithValues:["claude","codex","agy","cursor-agent","pi","opencode"].map {($0,"unknown")})
            workers=[:]
            cloudName=""
            return
        }
        workerHealth=health
        workers = result["workers"] as? [String:String] ?? [:]
        cloudName = result["cloud"] as? String ?? ""
    }
    func removeKey(_ id: String) throws {
        guard id == "openai" || id == "anthropic" else {throw RouterFailure("Choose an API connection.")}
        try RouterSecrets.set(id,nil)
        defaults.removeObject(forKey:"router.key."+id)
        if selected.rawValue == id {defaults.set("local",forKey:"router.choice")}
    }
    func configure(_ id: String, model value: String, key: String, server: RouterJSON = [:], account: String? = nil) throws {
        guard let route = Route(rawValue:id),
              key.utf8.count <= 4096, !key.contains(where:{$0.isWhitespace}),
              value.count <= (route == .server ? 256 : 160),
              !value.contains(where:{$0.isNewline || (route != .server && $0.isWhitespace)}) else {
            throw RouterFailure("Check the model ID or API key.")
        }
        switch route {
        case .local: break
        case .server: try saveServer(server,model:value,key:key)
        case .openai, .anthropic:
            guard !value.isEmpty else {throw RouterFailure("Enter a model ID available to your API account.")}
            if !key.isEmpty {try RouterSecrets.set(id,key)}
            guard try RouterSecrets.get(id) != nil else {throw RouterFailure("Enter an API key for this account.")}
            defaults.set(true,forKey:"router.key."+id)
        case .chatgpt:
            guard chat.registrations[account ?? chat.selected]?["plan"] == "enabled" else {throw RouterFailure("Continue with ChatGPT and enable plan usage first.")}
            if let account {try chat.select(account)}
        case .codex:
            guard workerHealth["codex"] != "missing" else {throw RouterFailure("Set up Codex on this Mac first.")}
            guard workerHealth["codex"] != "signedOut" else {throw RouterFailure("Sign in to Codex first.")}
        case .cloud:
            guard !cloudName.isEmpty, workers["claude"] != "CLI missing" else {throw RouterFailure("Configure a supported cloud provider for the Claude CLI in Tasktap’s environment.")}
        }
        defaults.set(value,forKey:"router.model."+id)
        defaults.set(id,forKey:"router.choice")
    }
    static func completedEvent(_ event: RouterJSON, text: inout String) throws -> Bool {
        switch event["type"] as? String {
        case "response.output_text.delta": text += event["delta"] as? String ?? ""
        case "response.completed": return true
        case "response.failed","error","response.incomplete":
            throw RouterFailure("OpenAI could not complete the handoff. Check model access and usage limits.")
        default: break
        }
        guard text.utf8.count <= 64000 else {throw RouterFailure("The provider returned an oversized handoff.")}
        return false
    }
    private func schema(estimate: Bool) -> RouterJSON {
        let text = ["type":"string"], number = ["type":"integer"]
        var fields: RouterJSON = ["mode":["type":"string","enum":["ask","note","nudge"]],"brief":text,
            "project":number,"session":number,"agent":["type":"string","enum":["unspecified","codex","claude","agy","cursor-agent","pi","opencode"]],
            "viewer":["type":"string","enum":["unspecified","Preview","Xcode","Finder"]],"note":text,
            "routeConfidence":["type":"string","enum":["clear","ambiguous","unknown"]],"routeEvidence":text,"routeQuote":text,
            "sessionCandidates":["type":"array","items":number,"maxItems":8],
            "projectCandidates":["type":"array","items":number,"maxItems":8],
            "constraints":["type":"array","items":text,"maxItems":12]]
        if estimate {fields["difficulty"]=number; fields["scopeEvidence"]=text}
        return ["type":"object","properties":fields,"required":fields.keys.sorted(),"additionalProperties":false]
    }
    func suggest(_ id: String, input: RouterJSON, reviewedServer: RouterJSON = [:], sessionName: Bool = false) async throws -> RouterJSON {
        guard let route = Route(rawValue:id), route != .local, route == selected else {
            throw RouterFailure("The routing connection changed. Review your capture again.")
        }
        let schema: RouterJSON = sessionName ? ["type":"object","properties":["name":["type":"string"]],"required":["name"],"additionalProperties":false] : schema(estimate:input["estimateDifficulty"] as? Bool == true)
        let contents = String(decoding:try JSONSerialization.data(withJSONObject:input),as:UTF8.self)
        let spec = String(decoding:try JSONSerialization.data(withJSONObject:schema),as:UTF8.self)
        let instructions = (sessionName ? SessionNames.instructions : HandoffRouter.instructions)+"\nReturn only JSON matching this schema.\n"+spec
        let model = model(route)
        var result: RouterJSON
        switch route {
        case .codex,.cloud:
            result = try await RouterCLI.call("route",["route":id,"prompt":instructions+"\n\nCapture and candidates:\n"+contents,"schema":schema,"model":model])
        case .server:
            guard let profile=profiles[serverKind], let url=profile["url"], let model=profile["model"],
                  reviewedServer["kind"] as? String==serverKind, reviewedServer["url"] as? String==url, reviewedServer["model"] as? String==model else {
                throw RouterFailure("The server connection changed. Review this capture again.")
            }
            let server=try ModelServer(kind:serverKind,address:url,model:model)
            let key=try serverKey(server,supplied:"",useSaved:true)
            result=try parse(await server.completion(key:key,instructions:instructions,capture:contents))
        case .anthropic:
            guard let key = try RouterSecrets.get(id) else {throw RouterFailure("Reconnect the Anthropic API key.")}
            let req = try RouterHTTP.request(URL(string:"https://api.anthropic.com/v1/messages")!,
                headers:["x-api-key":key,"anthropic-version":"2023-06-01"],json:["model":model,"max_tokens":1800,"system":instructions,
                "messages":[["role":"user","content":contents]]])
            let message = try await RouterHTTP.json(req)
            guard message["stop_reason"] as? String == "end_turn", let parts = message["content"] as? [RouterJSON] else {throw RouterFailure("Anthropic did not finish its handoff.")}
            result = try parse(parts.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined())
        case .openai,.chatgpt:
            let key: String
            var chosen = model
            if route == .chatgpt {
                key = try await chat.access(client:chat.selected)
                if chosen.isEmpty {
                    let list = try await RouterHTTP.json(RouterHTTP.request(URL(string:"https://api.openai.com/v1/models")!,headers:["Authorization":"Bearer "+key]))
                    guard let row = (list["models"] as? [RouterJSON])?.first(where: { $0["visibility"] as? String == "list" }),
                          let slug = row["slug"] as? String else {throw RouterFailure("This plan has no available routing model.")}
                    chosen = slug
                }
            } else {
                guard let saved = try RouterSecrets.get(id) else {throw RouterFailure("Reconnect the OpenAI API key.")}
                key = saved
            }
            let req = try RouterHTTP.request(URL(string:"https://api.openai.com/v1/responses")!,headers:["Authorization":"Bearer "+key],
                json:["model":chosen,"instructions":instructions,"store":false,"stream":true,"input":[["role":"user","content":contents]]])
            let (bytes,response) = try await RouterHTTP.session.bytes(for:req)
            try RouterHTTP.check(response)
            var output = "", complete = false
            for try await line in bytes.lines where line.hasPrefix("data:") {
                try Task.checkCancellation()
                let data = Data(line.dropFirst(5).trimmingCharacters(in:.whitespaces).utf8)
                guard let event = (try? JSONSerialization.jsonObject(with:data)) as? RouterJSON else {continue}
                complete = try Self.completedEvent(event,text:&output)
                if complete {break}
            }
            guard complete else {throw RouterFailure("The OpenAI response was interrupted.")}
            result = try parse(output)
        case .local: throw RouterFailure("Choose the local router.")
        }
        if sessionName { return result }
        guard let brief = result["brief"] as? String, !brief.isEmpty, brief.count <= 16000,
              ["ask","note","nudge"].contains(result["mode"] as? String ?? "") else {throw RouterFailure("The provider returned an incomplete handoff.")}
        result["source"] = id
        return result
    }
    func nameSession(_ input: RouterJSON) async throws -> String {
        if selected == .local { return try await SessionNames.local(input) }
        let profile = profiles[serverKind] ?? [:]
        let server: RouterJSON = ["kind":serverKind,"url":profile["url"] ?? "","model":profile["model"] ?? ""]
        let result = try await suggest(selected.rawValue, input: input, reviewedServer: server, sessionName: true)
        return result["name"] as? String ?? ""
    }
    private func parse(_ text: String) throws -> RouterJSON {
        guard let json = (try? JSONSerialization.jsonObject(with:Data(text.utf8))) as? RouterJSON else {throw RouterFailure("The provider returned an unreadable handoff.")}
        return json
    }
}
