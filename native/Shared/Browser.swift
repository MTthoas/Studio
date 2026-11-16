// Navigateur de l'IA de Studio (page Claude, automatisations, « Demander à l'IA »), quel que soit le fournisseur :
// Claude, OpenAI ou modèle local. La page reçoit les outils d'un serveur Playwright MCP lancé ici, et les passe au
// modèle comme ses autres outils (navigateurTools dans src/integrations/ai.ts). Mêmes réglages que les agents
// Claude Code : Réglages → Autorisations des agents → Navigateur (AgentPermissions.browserCommand) ; seuls les sites
// listés s'ouvrent. Protocole MCP sur stdio : JSON-RPC, un message par ligne. Le serveur démarre au premier appel,
// redémarre si la liste des sites change, et s'arrête après 5 minutes sans appel.
#if os(macOS)
import Foundation

final class Browser {
    static let shared = Browser()
    private let queue = DispatchQueue(label: "studio.browser")
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var nextId = 1
    private var waiting: [Int: ([String: Any]) -> Void] = [:]
    private var signature: [String] = []
    private var ready = false
    private var starters: [(String?) -> Void] = []
    private var idle: DispatchWorkItem?
    private var tools: [[String: Any]] = []
    private var sites: [String] = []
    private static let maxText = 40_000

    // ---------- Actions du pont (type « browser ») ----------

    /// Outils du navigateur (nom, description, schéma) et sites ouverts.
    func list(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            self.ensure { err in
                if let err { return done(["ok": false, "message": err]) }
                done(["ok": true, "tools": self.tools, "sites": self.sites])
            }
        }
    }

    /// Exécute un outil ; le résultat est rendu en texte (les captures d'écran ne sont pas transmises).
    func call(_ name: String, _ args: [String: Any], done: @escaping ([String: Any]) -> Void) {
        queue.async {
            self.ensure { err in
                if let err { return done(["ok": false, "message": err]) }
                guard self.tools.contains(where: { $0["name"] as? String == name }) else { return done(["ok": false, "message": "Outil du navigateur inconnu : \(name)."]) }
                self.send("tools/call", ["name": name, "arguments": args], timeout: 90) { r in
                    if let e = r["error"] as? [String: Any] { return done(["ok": false, "message": e["message"] as? String ?? "Erreur du navigateur."]) }
                    let res = r["result"] as? [String: Any] ?? [:]
                    let parts = (res["content"] as? [[String: Any]] ?? []).map { c -> String in
                        c["type"] as? String == "text" ? (c["text"] as? String ?? "") : "[\(c["type"] as? String ?? "contenu") non transmis]"
                    }
                    var text = parts.joined(separator: "\n")
                    if text.count > Self.maxText { text = String(text.prefix(Self.maxText)) + "\n…(tronqué)" }
                    done(["ok": true, "text": text, "error": res["isError"] as? Bool ?? false])
                }
            }
        }
    }

    func stop() { queue.async { self.shutdown("Navigateur arrêté.") } }

    // ---------- Serveur MCP ----------

    /// Démarre le serveur s'il ne tourne pas (ou si les réglages ont changé), puis rappelle `done` (nil : prêt).
    private func ensure(_ done: @escaping (String?) -> Void) {
        guard let cmd = AgentPermissions.browserCommand() else {
            shutdown("Navigateur coupé.")
            let why = !AgentPermissions.browser ? "Le navigateur est coupé (Réglages → Autorisations des agents → Navigateur)."
                : AgentPermissions.sites.isEmpty ? "Aucun site n’est ouvert au navigateur (Réglages → Autorisations des agents → Navigateur)."
                : "npx introuvable : installe Node.js, ou ajoute son dossier aux dossiers des outils (Réglages → Autorisations des agents)."
            return done(why)
        }
        touch()
        if process != nil && signature == cmd.args {
            if ready { return done(nil) }
            starters.append(done); return
        }
        shutdown("Réglages du navigateur modifiés.")
        starters.append(done)
        signature = cmd.args; sites = cmd.sites

        let p = Process(), inPipe = Pipe(), outPipe = Pipe()
        p.executableURL = URL(fileURLWithPath: cmd.exe)
        p.arguments = cmd.args
        p.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = ([cmd.dir] + AgentPermissions.path + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
        env["NO_COLOR"] = "1"
        p.environment = env
        p.standardInput = inPipe; p.standardOutput = outPipe; p.standardError = FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            self?.queue.async { d.isEmpty ? self?.died(p) : self?.receive(d) }
        }
        p.terminationHandler = { [weak self] proc in self?.queue.async { self?.died(proc) } }
        do { try p.run() } catch { return fail("Impossible de lancer Playwright MCP : \(error.localizedDescription)") }
        process = p; input = inPipe.fileHandleForWriting

        // Le premier lancement télécharge Playwright MCP : délai large.
        send("initialize", ["protocolVersion": "2025-06-18", "capabilities": [String: Any](), "clientInfo": ["name": "studio", "version": "1"]], timeout: 180) { r in
            if r["error"] != nil { return self.fail("Le navigateur n’a pas démarré.") }
            self.notify("notifications/initialized")
            self.send("tools/list", [:], timeout: 30) { r in
                let list = (r["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []
                guard !list.isEmpty else { return self.fail("Le navigateur ne propose aucun outil.") }
                self.tools = list.compactMap { t in
                    guard let n = t["name"] as? String else { return nil }
                    return ["name": n, "description": t["description"] as? String ?? "", "schema": t["inputSchema"] as? [String: Any] ?? ["type": "object"]]
                }
                self.ready = true
                let s = self.starters; self.starters = []; s.forEach { $0(nil) }
            }
        }
    }

    private func fail(_ message: String) {
        let s = starters; starters = []
        shutdown(message)
        s.forEach { $0(message) }
    }

    /// Arrête le serveur ; les appels en cours reçoivent une erreur.
    private func shutdown(_ message: String) {
        idle?.cancel(); idle = nil
        if let p = process { p.terminationHandler = nil; (p.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil; if p.isRunning { p.terminate() } }
        process = nil; input = nil; buffer = Data(); ready = false; tools = []; signature = []
        let w = waiting; waiting = [:]
        w.values.forEach { $0(["error": ["message": message]]) }
    }

    private func died(_ p: Process) {
        guard p === process else { return }
        if !ready { fail("Le navigateur s’est arrêté au démarrage : vérifie que Node.js et Google Chrome sont installés.") }
        else { shutdown("Le navigateur s’est arrêté.") }
    }

    /// Arrêt après 5 minutes sans appel.
    private func touch() {
        idle?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.shutdown("Navigateur arrêté après 5 minutes sans appel.") }
        idle = w
        queue.asyncAfter(deadline: .now() + 300, execute: w)
    }

    private func write(_ msg: [String: Any]) {
        guard let input, var data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        data.append(0x0A)
        input.write(data)
    }

    private func notify(_ method: String) { write(["jsonrpc": "2.0", "method": method]) }

    private func send(_ method: String, _ params: [String: Any], timeout: Double, reply: @escaping ([String: Any]) -> Void) {
        let id = nextId; nextId += 1
        waiting[id] = reply
        write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
            if let cb = self?.waiting.removeValue(forKey: id) { cb(["error": ["message": "Le navigateur n’a pas répondu à temps."]]) }
        }
    }

    private func receive(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard !line.isEmpty, let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            if let method = obj["method"] as? String {
                // Demande du serveur : seul ping est pris en charge (Studio ne déclare aucune capacité de client).
                if let id = obj["id"] { write(method == "ping" ? ["jsonrpc": "2.0", "id": id, "result": [String: Any]()] : ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Non pris en charge"]]) }
                continue
            }
            if let id = (obj["id"] as? NSNumber)?.intValue, let cb = waiting.removeValue(forKey: id) { cb(obj) }
        }
    }
}
#endif
