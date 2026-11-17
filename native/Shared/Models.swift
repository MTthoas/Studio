// Modèles locaux : Studio pilote Ollama (http://127.0.0.1:11434) sur ce Mac ou sur un serveur SSH d'un projet.
//
// Lister, installer (pull), supprimer et décharger des modèles, installer et démarrer Ollama, relayer une requête de chat.
// Aucune URLSession : sur le Mac, /usr/bin/curl ; sur un serveur, la même commande curl lancée par SSH (jamais de port
// ouvert, jamais de tunnel). La page ne fournit ni commande ni chemin : seulement un nom de modèle, validé ici, et
// toujours passé dans un corps JSON construit par JSONSerialization (sur stdin), jamais concaténé dans une commande.
// Les tâches (pull, installation d'Ollama) vivent en mémoire : elles survivent à la navigation de la page,
// restent 10 minutes après leur fin, ou jusqu'à `dismiss`.
import Foundation
#if os(macOS)
import AppKit

final class Models {
    static let shared = Models()

    // MARK: - Types

    /// Cible d'un appel : ce Mac (`cfg == nil`) ou un serveur d'un projet.
    struct Target {
        let project: String, server: String
        let cfg: Servers.Server?
        var isMac: Bool { cfg == nil }
        var key: String { project + "~" + server }
    }

    final class Job {
        let id = UUID().uuidString
        let project: String, server: String, kind: String, model: String
        var status = "", total = 0, done = 0, state = "run", error = "", log = ""
        var finished: Date?
        var process: Process?
        var digests: [String: (total: Int, done: Int)] = [:]
        init(project: String, server: String, kind: String, model: String) {
            self.project = project; self.server = server; self.kind = kind; self.model = model
        }
        var dict: [String: Any] {
            ["id": id, "project": project, "server": server, "kind": kind, "model": model, "status": status,
             "total": total, "done": done, "state": state, "error": error, "log": log]
        }
    }

    /// Résultat d'une requête HTTP vers Ollama : `fail` est rempli si la requête n'a pas abouti (Ollama ou SSH injoignable…).
    struct Reply {
        var code = 0, text = "", fail: String?
        var json: Any? {
            guard fail == nil, let i = text.firstIndex(where: { $0 == "{" || $0 == "[" }) else { return nil }
            return try? JSONSerialization.jsonObject(with: Data(text[i...].utf8))
        }
    }

    private let lock = NSLock()
    private var jobs: [Job] = []
    private static let base = "http://127.0.0.1:11434"
    private static let remotePath = "export PATH=\"$PATH:/usr/local/bin:/snap/bin\"; "
    private static let keepFinished: TimeInterval = 600
    private static let downloadURL = "https://ollama.com/download"
    private static let macZip = "https://ollama.com/download/Ollama-darwin.zip"

    // MARK: - Validation

    /// Nom de modèle : ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$, 120 caractères au plus (sans expression régulière :
    /// `$` accepterait un retour à la ligne final).
    static func validModel(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 120, s.allSatisfy({ $0.isASCII }) else { return false }
        let parts = s.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count <= 2, let name = parts.first, let f = name.first, f.isLetter || f.isNumber else { return false }
        func plain(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "." || c == "_" || c == "-" }
        guard name.allSatisfy({ plain($0) || $0 == "/" }) else { return false }
        if parts.count == 2 { return !parts[1].isEmpty && parts[1].allSatisfy(plain) }
        return true
    }

    private static func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
    private static func str(_ v: Any?) -> String { v as? String ?? "" }

    /// Message d'une erreur d'Ollama : {"error":"…"} ou {"error":{"message":"…"}}.
    private static func ollamaError(_ json: Any?) -> String? {
        guard let d = json as? [String: Any], let e = d["error"] else { return nil }
        if let s = e as? String { return s }
        if let m = (e as? [String: Any])?["message"] as? String { return m }
        return "Erreur d'Ollama."
    }

    // MARK: - Cible et transport

    private func target(_ body: [String: Any]) -> Target? {
        let project = body["project"] as? String ?? "", server = body["server"] as? String ?? ""
        if project.isEmpty { return Target(project: "", server: "", cfg: nil) }
        guard let c = Servers.shared.config(Servers.ref(project, server)) else { return nil }
        return Target(project: project, server: server, cfg: c)
    }

    private static func sshMessage(_ out: String) -> String {
        switch Servers.hostKeyProblem(out) {
        case "changed": return "L'empreinte du serveur a changé : vérifie-la dans les réglages du serveur."
        case "unknown": return "L'empreinte du serveur n'est pas encore validée : valide-la dans les réglages du serveur."
        default: break
        }
        if out.contains("Permission denied") { return "Connexion SSH refusée : vérifie la clé et l'utilisateur du serveur." }
        let last = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? ""
        return last.isEmpty ? "Serveur injoignable." : "Serveur injoignable : " + String(last.prefix(200))
    }

    /// Lance un script sur le serveur par SSH (un seul aller-retour), via `sh -c`. `fail` : SSH n'a pas abouti.
    private func remote(_ c: Servers.Server, _ script: String, input: Data? = nil, timeout: TimeInterval = 20) -> (status: Int32, out: String, fail: String?) {
        let l = Servers.shared.launch(c, "sh -c " + Servers.q(script), env: Servers.baseEnv)
        if let e = l.error { return (-1, "", e) }
        let r = Servers.exec("/usr/bin/ssh", l.args, input: input, env: l.env, timeout: timeout)
        if r.status == 255 { return (255, r.out, Self.sshMessage(r.out)) }
        return (r.status, r.out, nil)
    }

    /// Arguments de curl (sans le programme) pour une requête vers Ollama.
    private static func curlArgs(_ method: String, _ path: String, hasBody: Bool, timeout: Int, stream: Bool = false) -> [String] {
        ["-sS" + (stream ? "N" : ""), "--noproxy", "*"] + (timeout > 0 ? ["-m", String(timeout)] : [])
            + ["-X", method, "-H", "Content-Type: application/json"] + (hasBody ? ["--data-binary", "@-"] : [])
            + ["-w", "\n@@HTTP:%{http_code}", base + path]
    }

    /// Requête HTTP vers l'Ollama de la cible. Corps JSON sur stdin.
    private func http(_ t: Target, _ method: String, _ path: String, json: [String: Any]? = nil, timeout: Int = 30) -> Reply {
        var input: Data?
        if let json {
            guard JSONSerialization.isValidJSONObject(json), let d = try? JSONSerialization.data(withJSONObject: json) else { return Reply(fail: "Requête illisible.") }
            input = d
        }
        let args = Self.curlArgs(method, path, hasBody: input != nil, timeout: timeout)
        var status: Int32, out: String
        if let c = t.cfg {
            let r = remote(c, Self.remotePath + "curl " + args.map(Servers.q).joined(separator: " "), input: input, timeout: TimeInterval(timeout + 15))
            if let f = r.fail { return Reply(fail: f) }
            status = r.status; out = r.out
        } else {
            let r = Servers.exec("/usr/bin/curl", args, input: input, timeout: TimeInterval(timeout + 5))
            status = r.status; out = r.out
        }
        return Self.parse(status: status, out: out)
    }

    private static func parse(status: Int32, out: String) -> Reply {
        if let m = out.range(of: "\n@@HTTP:", options: .backwards) {
            let code = Int(out[m.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            if code > 0 { return Reply(code: code, text: String(out[..<m.lowerBound])) }
        }
        switch status {
        case 7: return Reply(fail: "Ollama ne répond pas (il n'est pas démarré ?).")
        case 28, 15, 9: return Reply(fail: "Ollama n'a pas répondu à temps.")
        case 127: return Reply(fail: "curl est introuvable sur cette machine.")
        case 0: return Reply(fail: "Réponse d'Ollama trop longue ou illisible.")
        default:
            let last = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? ""
            return Reply(fail: last.isEmpty ? "La requête vers Ollama a échoué (code \(status))." : "La requête vers Ollama a échoué : " + String(last.prefix(200)))
        }
    }

    /// Réponse `{ok, message?}` pour une requête qui ne rend rien d'utile : succès si HTTP 2xx.
    private func simple(_ r: Reply, notFound: String) -> [String: Any] {
        if let f = r.fail { return ["ok": false, "message": f] }
        if (200..<300).contains(r.code) { return ["ok": true] }
        if r.code == 404 { return ["ok": false, "message": notFound] }
        return ["ok": false, "message": Self.ollamaError(r.json) ?? "Ollama a répondu avec le code \(r.code)."]
    }

    // MARK: - Point d'entrée

    func handle(_ action: String, body: [String: Any]) -> [String: Any] {
        switch action {
        case "open":
            DispatchQueue.main.async { if let u = URL(string: Self.downloadURL) { NSWorkspace.shared.open(u) } }
            return ["ok": true]
        case "jobs":
            purge()
            lock.lock(); defer { lock.unlock() }
            return ["ok": true, "jobs": jobs.map { $0.dict }]
        case "cancel", "dismiss":
            return cancelOrDismiss(body["job"] as? String ?? "", dismiss: action == "dismiss")
        default: break
        }
        guard let t = target(body) else { return ["ok": false, "message": "Serveur inconnu pour ce projet."] }
        switch action {
        case "status": return status(t)
        case "pull":
            guard let m = body["model"] as? String, Self.validModel(m) else { return ["ok": false, "message": "Nom de modèle invalide."] }
            return pull(t, m)
        case "install": return install(t)
        case "start": return start(t)
        case "delete", "unload":
            guard let m = body["model"] as? String, Self.validModel(m) else { return ["ok": false, "message": "Nom de modèle invalide."] }
            if action == "delete" { return simple(http(t, "DELETE", "/api/delete", json: ["model": m]), notFound: "Ce modèle n'est pas installé.") }
            return simple(http(t, "POST", "/api/generate", json: ["model": m, "keep_alive": 0, "stream": false]), notFound: "Ce modèle n'est pas installé.")
        case "chat": return chat(t, body["body"])
        default: return ["ok": false, "message": "Action inconnue."]
        }
    }

    // MARK: - Chat

    private func chat(_ t: Target, _ raw: Any?) -> [String: Any] {
        guard var b = raw as? [String: Any], JSONSerialization.isValidJSONObject(b) else { return ["ok": false, "message": "Requête de chat invalide."] }
        b["stream"] = false
        guard JSONSerialization.isValidJSONObject(b), let d = try? JSONSerialization.data(withJSONObject: b), d.count <= 2 << 20 else {
            return ["ok": false, "message": "Requête de chat trop grande (2 Mo au plus)."]
        }
        let r = http(t, "POST", "/v1/chat/completions", json: b, timeout: 600)
        if let f = r.fail { return ["ok": false, "message": f] }
        let json = r.json
        if let e = Self.ollamaError(json) { return ["ok": false, "message": e] }
        guard let reply = json as? [String: Any] else {
            return ["ok": false, "message": (200..<300).contains(r.code) ? "Réponse d'Ollama illisible." : "Ollama a répondu avec le code \(r.code)."]
        }
        guard (200..<300).contains(r.code) else { return ["ok": false, "message": "Ollama a répondu avec le code \(r.code)."] }
        return ["ok": true, "reply": reply]
    }

    // MARK: - État

    private func status(_ t: Target) -> [String: Any] {
        var version = "", tags: Any?, ps: Any?
        var installed = false
        var machine: [String: Any] = [:]
        if let c = t.cfg {
            let script = Self.remotePath + #"""
            echo @@BIN; command -v ollama 2>/dev/null
            echo @@VERSION; curl -s -m 5 http://127.0.0.1:11434/api/version 2>/dev/null; echo
            echo @@TAGS; curl -s -m 8 http://127.0.0.1:11434/api/tags 2>/dev/null; echo
            echo @@PS; curl -s -m 8 http://127.0.0.1:11434/api/ps 2>/dev/null; echo
            echo @@MEM; grep -m1 MemTotal /proc/meminfo 2>/dev/null
            echo @@CORES; nproc 2>/dev/null
            echo @@CPU; c=$(grep -m1 -i "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2); [ -n "$c" ] || c=$(lscpu 2>/dev/null | awk -F: '/Model name/{print $2; exit}'); echo "$c"
            echo @@GPU; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 8
            echo @@DISK; d=""; for c in "${OLLAMA_MODELS:-}" /usr/share/ollama/.ollama/models "$HOME/.ollama/models"; do if [ -n "$c" ] && [ -d "$c" ]; then d="$c"; break; fi; done; [ -n "$d" ] || d=/; df -Pk "$d" 2>/dev/null | tail -n 1 | awk '{print $4}'
            echo @@UNAME; uname -sm 2>/dev/null
            echo @@OS; ( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" )
            """#
            let r = remote(c, script)
            if let f = r.fail { return ["ok": false, "message": f] }
            let s = Self.sections(r.out)
            guard s["BIN"] != nil else { return ["ok": false, "message": Self.sshMessage(r.out)] }
            let first = { (k: String) in (s[k] ?? "").split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? "" }
            let j = { (k: String) -> Any? in
                let t = s[k] ?? ""
                guard let i = t.firstIndex(of: "{") else { return nil }
                return try? JSONSerialization.jsonObject(with: Data(t[i...].utf8))
            }
            version = Self.str((j("VERSION") as? [String: Any])?["version"])
            tags = j("TAGS"); ps = j("PS")
            installed = !first("BIN").isEmpty || !version.isEmpty
            let kb = Int(first("MEM").split(separator: " ").dropFirst().first ?? "") ?? 0
            let uname = first("UNAME")
            let gpus = (s["GPU"] ?? "").split(separator: "\n").map { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }.filter { $0.count >= 2 }
            let vramMiB = gpus.reduce(0) { $0 + (Int($1[1]) ?? 0) }
            let osName = first("OS")
            machine = [
                "os": osName.isEmpty ? uname : osName,
                "cpu": first("CPU"),
                "cores": Int(first("CORES")) ?? 0,
                "ram": kb * 1024,
                "gpu": gpus.isEmpty ? "" : gpus[0][0] + (gpus.count > 1 ? " ×\(gpus.count)" : ""),
                "vram": vramMiB * 1_048_576,
                "disk": (Int(first("DISK")) ?? 0) * 1024,
                "apple": uname.hasPrefix("Darwin") && uname.hasSuffix("arm64"),
            ]
        } else {
            let v = http(t, "GET", "/api/version", timeout: 5)
            if v.fail == nil, v.code == 200 {
                version = Self.str((v.json as? [String: Any])?["version"])
                let a = http(t, "GET", "/api/tags", timeout: 8), b = http(t, "GET", "/api/ps", timeout: 8)
                if a.code == 200 { tags = a.json }
                if b.code == 200 { ps = b.json }
            }
            let home = NSHomeDirectory()
            installed = !version.isEmpty || ["/Applications/Ollama.app", home + "/Applications/Ollama.app", "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
                .contains { FileManager.default.fileExists(atPath: $0) }
            let cpu = Self.local("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"])
            #if arch(arm64)
            var apple = true
            #else
            var apple = Self.local("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]) == "1"
            #endif
            if cpu.hasPrefix("Apple") { apple = true }
            let free = (try? URL(fileURLWithPath: home).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage ?? 0
            let v2 = ProcessInfo.processInfo.operatingSystemVersion
            machine = [
                "os": "macOS \(v2.majorVersion).\(v2.minorVersion)" + (v2.patchVersion > 0 ? ".\(v2.patchVersion)" : ""),
                "cpu": cpu,
                "cores": ProcessInfo.processInfo.processorCount,
                "ram": Int(clamping: ProcessInfo.processInfo.physicalMemory),
                "gpu": apple ? cpu : "",
                "vram": 0,
                "disk": Int(clamping: free),
                "apple": apple,
            ]
        }
        let models: [[String: Any]] = ((tags as? [String: Any])?["models"] as? [[String: Any]] ?? []).map { m in
            let d = m["details"] as? [String: Any] ?? [:]
            return ["name": Self.str(m["name"]), "size": Self.int(m["size"]), "params": Self.str(d["parameter_size"]),
                    "quant": Self.str(d["quantization_level"]), "family": Self.str(d["family"])]
        }
        let loaded: [[String: Any]] = ((ps as? [String: Any])?["models"] as? [[String: Any]] ?? []).map { m in
            ["name": Self.str(m["name"]), "size": Self.int(m["size"]), "vram": Self.int(m["size_vram"])]
        }
        return ["ok": true, "installed": installed, "running": !version.isEmpty, "version": version,
                "models": models, "loaded": loaded, "machine": machine]
    }

    private static func sections(_ out: String) -> [String: String] {
        var sec: [String: String] = [:], cur: String?
        for line in out.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("@@") { cur = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces); sec[cur!] = "" }
            else if let cur { sec[cur, default: ""] += line + "\n" }
        }
        return sec
    }

    private static func local(_ path: String, _ args: [String]) -> String {
        let r = Servers.exec(path, args, timeout: 5)
        return r.status == 0 ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    // MARK: - Tâches

    private func purge() {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        jobs.removeAll { j in j.state != "run" && now.timeIntervalSince(j.finished ?? now) > Self.keepFinished }
    }

    private func cancelOrDismiss(_ id: String, dismiss: Bool) -> [String: Any] {
        lock.lock()
        guard let j = jobs.first(where: { $0.id == id }) else { lock.unlock(); return ["ok": false, "message": "Tâche introuvable."] }
        var p: Process?
        if j.state == "run" {
            j.state = "stopped"; j.finished = Date(); j.status = "Annulé"
            p = j.process; j.process = nil
        }
        if dismiss { jobs.removeAll { $0.id == id } }
        lock.unlock()
        p?.terminate()
        return ["ok": true]
    }

    private func isRunning(_ j: Job) -> Bool { lock.lock(); defer { lock.unlock() }; return j.state == "run" }

    /// Termine une tâche une seule fois (sans effet si elle est déjà finie ou annulée) et notifie.
    private func finish(_ j: Job, ok: Bool, error: String = "") {
        lock.lock()
        guard j.state == "run" else { lock.unlock(); return }
        j.state = ok ? "done" : "error"; j.error = ok ? "" : error; j.finished = Date(); j.process = nil
        if ok { j.status = j.kind == "install" ? "Ollama est installé" : "success"; if j.total > 0 { j.done = j.total } }
        lock.unlock()
        let title = j.kind == "install" ? (ok ? "Ollama est installé" : "Installation d'Ollama échouée") : (ok ? "Modèle installé : " + j.model : "Échec du téléchargement : " + j.model)
        Notifier.shared.post(title: title, body: ok ? "" : String(error.prefix(300)), url: nil, thread: "models")
    }

    private func add(_ j: Job) { lock.lock(); jobs.append(j); lock.unlock() }

    /// Lance un programme et lit sa sortie jusqu'au bout (bloquant). `onData` reçoit stdout (et stderr si `merge`).
    /// Le processus est rattaché à la tâche pour que `cancel` le termine.
    private func runLong(_ j: Job, _ exe: String, _ args: [String], env: [String: String], input: Data?, merge: Bool,
                         timeout: TimeInterval?, onData: @escaping (Data) -> Void) -> (status: Int32, err: String, timedOut: Bool) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe); p.arguments = args; p.environment = env
        let out = Pipe(), err = Pipe(), inPipe: Pipe? = input == nil ? nil : Pipe()
        p.standardOutput = out; p.standardError = merge ? out : err
        if let inPipe { p.standardInput = inPipe } else { p.standardInput = FileHandle.nullDevice }
        lock.lock()
        if j.state != "run" { lock.unlock(); return (-1, "", false) }
        do { try p.run() } catch { lock.unlock(); return (-1, "Programme introuvable : \(exe)", false) }
        j.process = p
        lock.unlock()
        if let inPipe, let input {
            // Un programme qui se ferme sans lire son entrée (Ollama arrêté, SSH refusé) ne doit pas emporter l'app (SIGPIPE).
            signal(SIGPIPE, SIG_IGN)
            try? inPipe.fileHandleForWriting.write(contentsOf: input)
            try? inPipe.fileHandleForWriting.close()
        }
        var errText = "", timedOut = false
        let errLock = NSLock(), g = DispatchGroup()
        if !merge {
            g.enter()
            DispatchQueue.global(qos: .utility).async {
                while true {
                    let c = err.fileHandleForReading.availableData
                    if c.isEmpty { break }
                    errLock.lock(); if errText.count < 4000 { errText += String(decoding: c, as: UTF8.self) }; errLock.unlock()
                }
                g.leave()
            }
        }
        if let timeout {
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak p] in
                if let p, p.isRunning { errLock.lock(); timedOut = true; errLock.unlock(); p.terminate() }
            }
        }
        while true {
            let c = out.fileHandleForReading.availableData
            if c.isEmpty { break }
            onData(c)
        }
        p.waitUntilExit(); _ = g.wait(timeout: .now() + 2)
        errLock.lock(); defer { errLock.unlock() }
        return (p.terminationStatus, errText, timedOut)
    }

    private func appendLog(_ j: Job, _ d: Data) {
        let s = String(decoding: d, as: UTF8.self)
        lock.lock(); j.log = String((j.log + s).suffix(2000)); lock.unlock()
    }

    // MARK: - Pull

    private func pull(_ t: Target, _ model: String) -> [String: Any] {
        purge()
        lock.lock()
        if let j = jobs.first(where: { $0.kind == "pull" && $0.state == "run" && $0.project == t.project && $0.server == t.server && $0.model == model }) {
            lock.unlock(); return ["ok": true, "job": j.id]
        }
        lock.unlock()
        guard let input = try? JSONSerialization.data(withJSONObject: ["model": model, "stream": true] as [String: Any]) else {
            return ["ok": false, "message": "Requête illisible."]
        }
        let args = Self.curlArgs("POST", "/api/pull", hasBody: true, timeout: 0, stream: true).filter { $0 != "-w" && $0 != "\n@@HTTP:%{http_code}" }
        var exe = "/usr/bin/curl", argv = args, env = Servers.baseEnv
        if let c = t.cfg {
            let l = Servers.shared.launch(c, "sh -c " + Servers.q(Self.remotePath + "curl " + args.map(Servers.q).joined(separator: " ")), env: Servers.baseEnv)
            if let e = l.error { return ["ok": false, "message": e] }
            exe = "/usr/bin/ssh"; argv = l.args; env = l.env
        }
        let j = Job(project: t.project, server: t.server, kind: "pull", model: model)
        j.status = "Démarrage…"
        add(j)
        let remote = !t.isMac
        DispatchQueue.global(qos: .utility).async { [self] in
            var buf = Data(), success = false, failure: String?
            let r = runLong(j, exe, argv, env: env, input: input, merge: false, timeout: nil) { chunk in
                buf.append(chunk)
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = buf[buf.startIndex..<nl]; buf.removeSubrange(buf.startIndex...nl)
                    guard let o = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                    if let e = Self.ollamaError(o) { failure = e; continue }
                    let st = Self.str(o["status"])
                    if st == "success" { success = true }
                    self.lock.lock()
                    if !st.isEmpty { j.status = st }
                    if let dg = o["digest"] as? String, o["total"] != nil {
                        j.digests[dg] = (Self.int(o["total"]), Self.int(o["completed"]))
                        j.total = j.digests.values.reduce(0) { $0 + $1.total }
                        j.done = j.digests.values.reduce(0) { $0 + $1.done }
                    }
                    self.lock.unlock()
                }
            }
            if success { finish(j, ok: true); return }
            if !isRunning(j) { return }
            if let f = failure {
                finish(j, ok: false, error: "Ollama a refusé le téléchargement : " + f)
            } else if remote && r.status == 255 {
                finish(j, ok: false, error: Self.sshMessage(r.err))
            } else if r.status == 7 {
                finish(j, ok: false, error: "Ollama ne répond pas : démarre-le, puis réessaie.")
            } else if r.status == 127 {
                finish(j, ok: false, error: "curl est introuvable sur cette machine.")
            } else {
                let last = r.err.split(separator: "\n").last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
                finish(j, ok: false, error: "Le téléchargement s'est interrompu (code \(r.status))." + (last.isEmpty ? "" : " " + String(last.prefix(200))))
            }
        }
        return ["ok": true, "job": j.id]
    }

    // MARK: - Installation d'Ollama

    private func install(_ t: Target) -> [String: Any] {
        purge()
        lock.lock()
        if let j = jobs.first(where: { $0.kind == "install" && $0.state == "run" && $0.project == t.project && $0.server == t.server }) {
            lock.unlock(); return ["ok": true, "job": j.id]
        }
        lock.unlock()
        let j = Job(project: t.project, server: t.server, kind: "install", model: "")
        j.status = "Préparation…"
        if let c = t.cfg {
            let script = Self.remotePath + #"""
            [ "$(uname -s)" = Linux ] || { echo "Installation automatique reservee a Linux."; exit 20; }
            if [ "$(id -u)" != 0 ]; then sudo -n true 2>/dev/null || { echo "Il faut root ou sudo sans mot de passe."; exit 21; }; fi
            t=$(mktemp) || exit 22
            curl -fsSL -o "$t" https://ollama.com/install.sh || { rm -f "$t"; echo "Telechargement du script impossible."; exit 23; }
            sh "$t"; r=$?; rm -f "$t"; exit $r
            """#
            let l = Servers.shared.launch(c, "sh -c " + Servers.q(script), env: Servers.baseEnv)
            if let e = l.error { return ["ok": false, "message": e] }
            add(j)
            DispatchQueue.global(qos: .utility).async { [self] in
                lock.lock(); j.status = "Installation sur le serveur…"; lock.unlock()
                let r = runLong(j, "/usr/bin/ssh", l.args, env: l.env, input: nil, merge: true, timeout: 900) { self.appendLog(j, $0) }
                if !isRunning(j) { return }
                switch r.status {
                case 0: finish(j, ok: true)
                case 20: finish(j, ok: false, error: "L'installation automatique n'existe que pour Linux : installe Ollama à la main depuis ollama.com.")
                case 21: finish(j, ok: false, error: "Pour installer Ollama, il faut root ou sudo sans mot de passe sur le serveur.")
                case 255: finish(j, ok: false, error: Self.sshMessage(j.log))
                default:
                    finish(j, ok: false, error: r.timedOut ? "L'installation a dépassé 15 minutes et a été arrêtée."
                           : "L'installation a échoué (code \(r.status)) : regarde le journal, ou passe par ollama.com.")
                }
            }
        } else {
            add(j)
            DispatchQueue.global(qos: .utility).async { [self] in installOnMac(j) }
        }
        return ["ok": true, "job": j.id]
    }

    private func installOnMac(_ j: Job) {
        let fm = FileManager.default, home = NSHomeDirectory()
        let site = " Tu peux l'installer à la main depuis ollama.com/download."
        func note(_ s: String) { appendLog(j, Data((s + "\n").utf8)) }
        func setStatus(_ s: String) { lock.lock(); j.status = s; lock.unlock() }
        func fail(_ s: String) { finish(j, ok: false, error: s + site) }
        func openApp(_ path: String) -> Bool { Servers.exec("/usr/bin/open", ["-g", path], timeout: 20).status == 0 }

        // Déjà installée : on ne fait que l'ouvrir.
        if let app = [ "/Applications/Ollama.app", home + "/Applications/Ollama.app"].first(where: { fm.fileExists(atPath: $0) }) {
            setStatus("Ouverture d'Ollama…"); note("Ollama est déjà installé : \(app)")
            if openApp(app) { finish(j, ok: true) } else { finish(j, ok: false, error: "Ollama est installé mais n'a pas pu s'ouvrir : lance-le à la main.") }
            return
        }
        let work = fm.temporaryDirectory.appendingPathComponent("studio-ollama-" + UUID().uuidString)
        do { try fm.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch { return fail("Impossible de créer un dossier temporaire.") }
        defer { try? fm.removeItem(at: work) }
        let zip = work.appendingPathComponent("Ollama-darwin.zip").path
        let extracted = work.appendingPathComponent("app").path

        // Taille annoncée (facultative), pour la progression.
        let head = Servers.exec("/usr/bin/curl", ["-sIL", "--noproxy", "*", "-m", "15", Self.macZip], timeout: 20).out
        let size = head.split(whereSeparator: \.isNewline).compactMap { l -> Int? in
            let s = l.lowercased(); return s.hasPrefix("content-length:") ? Int(s.dropFirst(15).trimmingCharacters(in: .whitespaces)) : nil
        }.last ?? 0
        lock.lock(); j.total = size; lock.unlock()

        setStatus("Téléchargement d'Ollama…")
        let flag = NSLock(); var downloading = true
        DispatchQueue.global(qos: .utility).async { [self] in
            while true {
                flag.lock(); let on = downloading; flag.unlock()
                if !on { break }
                let n = ((try? fm.attributesOfItem(atPath: zip))?[.size] as? NSNumber)?.intValue ?? 0
                lock.lock(); j.done = n; if n > j.total { j.total = 0 }; lock.unlock()
                usleep(500_000)
            }
        }
        let d = runLong(j, "/usr/bin/curl", ["-fsSL", "--proto", "=https", "--tlsv1.2", "--noproxy", "*", "-m", "900", "-o", zip, Self.macZip],
                        env: Servers.baseEnv, input: nil, merge: false, timeout: 920) { _ in }
        flag.lock(); downloading = false; flag.unlock()
        if !isRunning(j) { return }
        guard d.status == 0, fm.fileExists(atPath: zip) else { return fail("Le téléchargement d'Ollama a échoué.") }
        lock.lock(); if j.total > 0 { j.done = j.total }; lock.unlock()

        setStatus("Décompression…")
        let z = Servers.exec("/usr/bin/ditto", ["-x", "-k", zip, extracted], timeout: 300)
        guard isRunning(j) else { return }
        let app = extracted + "/Ollama.app"
        guard z.status == 0, fm.fileExists(atPath: app) else { return fail("L'archive téléchargée est illisible.") }

        setStatus("Vérification de la signature…")
        let v = Servers.exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "-v", app], timeout: 120)
        guard isRunning(j) else { return }
        note(v.out.trimmingCharacters(in: .whitespacesAndNewlines))
        guard v.status == 0 else { return fail("macOS n'a pas validé la signature de l'app téléchargée : rien n'a été installé.") }

        setStatus("Installation…")
        var dest = "/Applications/Ollama.app"
        do { try fm.moveItem(atPath: app, toPath: dest) }
        catch {
            let dir = home + "/Applications"
            dest = dir + "/Ollama.app"
            do {
                try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
                try fm.moveItem(atPath: app, toPath: dest)
            } catch { return fail("Impossible de copier Ollama dans Applications.") }
        }
        note("Installé : " + dest)
        setStatus("Ouverture d'Ollama…")
        guard openApp(dest) else { return finish(j, ok: false, error: "Ollama est installé dans \(dest) mais n'a pas pu s'ouvrir : lance-le à la main.") }
        finish(j, ok: true)
    }

    // MARK: - Démarrage

    private func start(_ t: Target) -> [String: Any] {
        if let c = t.cfg {
            let script = Self.remotePath + #"""
            command -v ollama >/dev/null 2>&1 || { echo "Ollama n est pas installe sur ce serveur."; exit 30; }
            if [ "$(id -u)" = 0 ]; then S=""; else S="sudo -n"; fi
            if command -v systemctl >/dev/null 2>&1 && $S systemctl start ollama >/dev/null 2>&1; then exit 0; fi
            nohup ollama serve >/dev/null 2>&1 </dev/null &
            exit 0
            """#
            let r = remote(c, script, timeout: 30)
            if let f = r.fail { return ["ok": false, "message": f] }
            if r.status == 30 { return ["ok": false, "message": "Ollama n'est pas installé sur ce serveur."] }
            if r.status != 0 { return ["ok": false, "message": "Le démarrage d'Ollama a échoué (code \(r.status))."] }
        } else {
            let fm = FileManager.default, home = NSHomeDirectory()
            if fm.fileExists(atPath: "/Applications/Ollama.app") || fm.fileExists(atPath: home + "/Applications/Ollama.app") {
                if Servers.exec("/usr/bin/open", ["-g", "-a", "Ollama"], timeout: 20).status != 0 {
                    return ["ok": false, "message": "L'app Ollama n'a pas pu s'ouvrir : lance-la à la main."]
                }
            } else if let bin = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"].first(where: { fm.isExecutableFile(atPath: $0) }) {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: bin); p.arguments = ["serve"]
                p.environment = Servers.baseEnv.merging(["PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"]) { $1 }
                p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { return ["ok": false, "message": "Impossible de lancer ollama serve."] }
            } else {
                return ["ok": false, "message": "Ollama n'est pas installé sur ce Mac."]
            }
        }
        let deadline = Date().addingTimeInterval(15)
        while true {
            let r = http(t, "GET", "/api/version", timeout: 3)
            if r.fail == nil, r.code == 200 { return ["ok": true] }
            if let f = r.fail, !f.hasPrefix("Ollama ne répond pas") && !f.hasPrefix("Ollama n'a pas répondu") { return ["ok": false, "message": f] }
            if Date() >= deadline { break }
            sleep(1)
        }
        return ["ok": false, "message": "Ollama a été lancé mais ne répond pas encore : réessaie dans un instant."]
    }
}
#endif
