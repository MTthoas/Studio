// Serveur d'un projet (VPS, VM) joint en SSH depuis le Mac. Deux façons de s'y connecter :
// - « Ma configuration SSH » : celle de l'utilisateur (~/.ssh/config, agent SSH, clés), dont Studio ne voit rien ;
// - une clé gardée par Studio (SSHKeys.swift) : chiffrée dans le trousseau, chargée dans l'agent privé de Studio,
//   seule proposée au serveur.
//
// Garde-fous : /usr/bin/ssh sans shell local, BatchMode (jamais de mot de passe demandé), délai de connexion court ;
// l'hôte est un alias de ~/.ssh/config ou « utilisateur@hôte » validé, le port un nombre, le chemin distant est validé
// caractère par caractère, et les commandes distantes sont des modèles fixes dont chaque argument est protégé
// (guillemets simples). Une empreinte d'hôte inconnue n'est jamais acceptée en silence : `trust` l'ajoute à known_hosts
// seulement si elle est celle que l'utilisateur a vue et confirmée ; une empreinte changée reste refusée.
// Tout passe par `launch`, qui pose les options et l'agent : Monitor, Terminals, Agents et les extensions s'en servent.
// La configuration (hôte, port, clé, chemin, extensions) reste dans les réglages de l'app Mac, jamais dans une note.
import Foundation
#if os(macOS)
import AppKit

final class Servers {
    static let shared = Servers()
    private let key = "studio.projectServers"
    private var all: [String: [String: String]] {
        get { UserDefaults.standard.dictionary(forKey: key) as? [String: [String: String]] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Extensions qu'un serveur peut activer (ServerExtensions.swift).
    static let extensions = ["docker", "kube"]

    struct Server: Equatable {
        let host: String, path: String, port: Int, key: String, ext: [String]
        /// Utilisateur SSH choisi dans Studio (passé par -l, prioritaire sur le `User` de ~/.ssh/config) ; vide : celui de la config.
        var user: String = ""
        /// Ce qui s'affiche et sert d'adresse ssh:// : utilisateur@hôte quand l'utilisateur est fixé.
        var dest: String { user.isEmpty ? host : user + "@" + host }
    }

    static func validHost(_ h: String) -> Bool {
        !h.isEmpty && h.count <= 120 && h.first != "-" && h.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "._-@".contains($0) }
    }
    /// Nom d'utilisateur Unix : minuscules, chiffres, « _ », « . », « - », sans commencer par « - ».
    static func validUser(_ u: String) -> Bool {
        !u.isEmpty && u.count <= 32 && u.first != "-" && u.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || "._-".contains($0) }
    }
    static func validPath(_ p: String) -> Bool {
        !p.isEmpty && p.count <= 300 && (p.hasPrefix("/") || p.hasPrefix("~")) && !p.contains("..") && p.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "/._~-".contains($0) }
    }
    /// Protège un argument pour le shell distant : 'a'\''b'.
    static func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    /// Chemin distant : « ~/x » reste interprété par le shell distant, le reste est protégé.
    static func qPath(_ p: String) -> String { p == "~" ? "~" : p.hasPrefix("~/") ? "~/" + q(String(p.dropFirst(2))) : q(p) }

    func config(_ pid: String) -> Server? {
        guard let c = all[pid], let h = c["host"], let p = c["path"], Self.validHost(h), Self.validPath(p) else { return nil }
        let port = Int(c["port"] ?? "") ?? 0, key = c["key"] ?? ""
        return Server(host: h, path: p, port: (1...65535).contains(port) ? port : 0, key: SSHKeys.validId(key) ? key : "",
                      ext: (c["ext"] ?? "").split(separator: ",").map(String.init).filter(Self.extensions.contains),
                      user: Self.validUser(c["user"] ?? "") && !h.contains("@") ? c["user"] ?? "" : "")
    }

    /// Projets dont le serveur utilise chaque clé de Studio.
    func keyUsage() -> [String: [String]] {
        var out: [String: [String]] = [:]
        for (pid, c) in all { if let k = c["key"], !k.isEmpty { out[k, default: []].append(pid) } }
        return out
    }

    /// Alias déclarés dans ~/.ssh/config (sans les motifs génériques).
    func hosts() -> [String: Any] {
        let file = NSHomeDirectory() + "/.ssh/config"
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        var out: [[String: String]] = [], cur: [String] = []
        var names: [String: String] = [:], users: [String: String] = [:]
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" || $0 == "=" }).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else { continue }
            switch parts[0].lowercased() {
            case "host": cur = parts[1].split(separator: " ").map(String.init).filter { !$0.contains("*") && !$0.contains("?") && Self.validHost($0) }
                cur.forEach { names[$0] = "" }
            case "hostname": cur.forEach { names[$0] = parts[1] }
            case "user": cur.forEach { users[$0] = parts[1] }
            default: break
            }
        }
        for (k, v) in names.sorted(by: { $0.key < $1.key }) { out.append(["alias": k, "hostname": v, "user": users[k] ?? ""]) }
        return ["ok": true, "hosts": out]
    }

    func set(_ pid: String, host: String, user: String = "", path: String, port: String, key: String, ext: [String]) -> [String: Any] {
        guard !pid.isEmpty, pid.count <= 64 else { return ["ok": false, "message": "Projet invalide."] }
        guard Self.validHost(host) else { return ["ok": false, "message": "Hôte invalide : un alias de ~/.ssh/config ou utilisateur@hôte."] }
        let u = user.trimmingCharacters(in: .whitespaces)
        guard u.isEmpty || Self.validUser(u) else { return ["ok": false, "message": "Utilisateur invalide : minuscules, chiffres, _ . - (ex. root, ubuntu, deploy)."] }
        guard u.isEmpty || !host.contains("@") else { return ["ok": false, "message": "L’utilisateur est indiqué deux fois : retire « utilisateur@ » de l’hôte."] }
        guard Self.validPath(path) else { return ["ok": false, "message": "Chemin invalide : absolu (/srv/app) ou depuis ~ (~/app), sans espace ni caractère spécial."] }
        let p = port.trimmingCharacters(in: .whitespaces)
        guard p.isEmpty || (Int(p).map { (1...65535).contains($0) } ?? false) else { return ["ok": false, "message": "Port invalide : un nombre entre 1 et 65535, ou vide pour le port habituel."] }
        guard key.isEmpty || (SSHKeys.validId(key) && SSHKeys.shared.exists(key)) else { return ["ok": false, "message": "Clé SSH inconnue."] }
        let e = Self.extensions.filter(ext.contains)
        var a = all; a[pid] = ["host": host, "user": u, "path": path, "port": p, "key": key, "ext": e.joined(separator: ",")]; all = a
        return ["ok": true, "host": host, "user": u, "path": path]
    }
    func forget(_ pid: String) { var a = all; a.removeValue(forKey: pid); all = a }

    /// Lancement de /usr/bin/ssh vers ce serveur : arguments (avec `command`, déjà protégée) et environnement.
    /// Avec une clé de Studio, la charge au besoin dans l'agent de Studio et ne propose qu'elle ;
    /// sinon, l'agent SSH de l'utilisateur. `error` est rempli si la clé n'a pas pu être préparée.
    func launch(_ c: Server, _ command: String, tty: Bool = false, env base: [String: String]) -> (args: [String], env: [String: String], error: String?) {
        var args = [tty ? "-tt" : "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"]
        if c.port > 0 { args += ["-p", String(c.port)] }
        if !c.user.isEmpty { args += ["-l", c.user] }
        var env = base
        if !c.key.isEmpty {
            switch SSHKeys.shared.prepare(c.key) {
            case .failure(let f): return ([], env, f.message)
            case .success(let k):
                env["SSH_AUTH_SOCK"] = k.socket
                args += ["-o", "IdentityAgent=SSH_AUTH_SOCK", "-o", "IdentitiesOnly=yes", "-o", "AddKeysToAgent=no", "-i", k.pub]
            }
        } else if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] {
            env["SSH_AUTH_SOCK"] = sock
        } else {
            env["SSH_AUTH_SOCK"] = nil
        }
        return (args + [c.host, "--", command], env, nil)
    }
    private static let ignorePipe: Void = { _ = signal(SIGPIPE, SIG_IGN) }()
    static let baseEnv: [String: String] = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "LC_ALL": "C"]

    /// Lance un programme local et rend son statut et sa sortie (stdout et stderr mêlés, 200 ko au plus).
    static func exec(_ path: String, _ args: [String], input: Data? = nil, env: [String: String] = Servers.baseEnv, timeout: TimeInterval = 20) -> (status: Int32, out: String, ms: Int) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = env
        let out = Pipe(); p.standardOutput = out; p.standardError = out
        let inPipe: Pipe? = input == nil ? nil : Pipe()
        if let inPipe { p.standardInput = inPipe } else { p.standardInput = FileHandle.nullDevice }
        var data = Data(); let lock = NSLock(); let g = DispatchGroup(); g.enter()
        DispatchQueue.global(qos: .utility).async {
            while true { let c = out.fileHandleForReading.availableData; if c.isEmpty { break }; lock.lock(); if data.count < 200_000 { data.append(c) }; lock.unlock() }
            g.leave()
        }
        let start = Date()
        do { try p.run() } catch { try? out.fileHandleForWriting.close(); return (-1, "Programme introuvable : \(path)", 0) }
        if let inPipe, let input {
            // Un programme qui se ferme sans tout lire ne doit pas emporter l'app (SIGPIPE) : l'écriture échoue simplement.
            _ = Self.ignorePipe
            try? inPipe.fileHandleForWriting.write(contentsOf: input)
            try? inPipe.fileHandleForWriting.close()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(30_000) }
        if p.isRunning { p.terminate() }
        p.waitUntilExit(); _ = g.wait(timeout: .now() + 2)
        lock.lock(); defer { lock.unlock() }
        return (p.terminationStatus, String(decoding: data, as: UTF8.self), Int(Date().timeIntervalSince(start) * 1000))
    }

    /// Exécute `command` (déjà protégée) sur le serveur. `out` porte le message d'erreur si la clé n'a pas pu être préparée.
    func run(_ c: Server, _ command: String, timeout: TimeInterval = 20) -> (status: Int32, out: String, ms: Int, keyError: Bool) {
        let l = launch(c, command, env: Self.baseEnv)
        if let e = l.error { return (-1, e, 0, true) }
        let r = Self.exec("/usr/bin/ssh", l.args, env: l.env, timeout: timeout)
        return (r.status, r.out, r.ms, false)
    }

    /// Problème d'empreinte d'hôte dans une sortie de ssh : "unknown" (jamais vue) ou "changed" (différente de celle connue).
    static func hostKeyProblem(_ out: String) -> String? {
        if out.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") { return "changed" }
        if out.contains("Host key verification failed") || out.contains("host key is known") || out.contains("No matching host key") { return "unknown" }
        return nil
    }

    /// État du serveur : joignable, latence, charge, disque, mémoire, dépôt Git, Claude Code.
    func status(_ pid: String) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": true, "configured": false] }
        let dir = Self.qPath(c.path)
        let cmd = "uptime; echo @@; df -hP \(dir) 2>/dev/null | tail -1; echo @@; (free -m 2>/dev/null | sed -n 2p) || true; echo @@; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null; echo @@; cd \(dir) 2>/dev/null && git status -sb 2>/dev/null | head -1; echo @@; (command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | head -1) || true; echo @@; uname -sr"
        let r = run(c, cmd)
        var base: [String: Any] = ["ok": true, "configured": true, "host": c.host, "user": c.user, "dest": c.dest, "path": c.path, "port": c.port, "ext": c.ext, "ms": r.ms]
        if !c.key.isEmpty, let k = SSHKeys.shared.info(c.key) { base["key"] = k }
        guard r.status == 0 || r.out.contains("@@") else {
            base["online"] = false
            base["error"] = String(r.out.split(separator: "\n").last ?? "Connexion refusée").prefix(200)
            if let h = Self.hostKeyProblem(r.out) { base["hostKey"] = h }
            if r.out.contains("Permission denied") { base["denied"] = true }
            return base
        }
        let s = r.out.components(separatedBy: "@@").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        func at(_ i: Int) -> String { i < s.count ? s[i] : "" }
        base["online"] = true
        if let r = at(0).range(of: #"load averages?: ([\d.,]+)[, ]+([\d.,]+)[, ]+([\d.,]+)"#, options: .regularExpression) {
            let nums = at(0)[r].replacingOccurrences(of: #"load averages?: "#, with: "", options: .regularExpression)
                .split(whereSeparator: { $0 == " " }).map { Double($0.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: CharacterSet(charactersIn: ","))) ?? 0 }
            base["load"] = nums
        }
        if let up = at(0).range(of: #"up [^,]+(, [^,]*\d+:\d+)?"#, options: .regularExpression) { base["uptime"] = String(at(0)[up].dropFirst(3)) }
        let df = at(1).split(whereSeparator: { $0 == " " }).map(String.init)
        if df.count >= 5 { base["disk"] = ["size": df[1], "used": df[2], "free": df[3], "pct": Int(df[4].replacingOccurrences(of: "%", with: "")) ?? 0] }
        let mem = at(2).split(whereSeparator: { $0 == " " }).map(String.init)
        if mem.count >= 3, let total = Int(mem[1]), let used = Int(mem[2]) { base["mem"] = ["total": total, "used": used] }
        base["cpus"] = Int(at(3)) ?? 0
        base["git"] = at(4)
        base["claude"] = at(5)
        base["os"] = at(6)
        return base
    }

    /// Ouvre un terminal SSH sur le serveur du projet, dans le Terminal de macOS : par une URL ssh:// avec la configuration
    /// de l'utilisateur ; avec une clé de Studio, par un petit script .command (sans rien de secret : la socket de l'agent
    /// et la clé publique) qui reprend les mêmes options.
    func terminal(_ pid: String) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        if c.key.isEmpty {
            guard let url = URL(string: "ssh://" + c.dest + (c.port > 0 ? ":\(c.port)" : "")) else { return ["ok": false, "message": "Hôte invalide."] }
            NSWorkspace.shared.open(url)
            return ["ok": true]
        }
        let l = launch(c, "cd \(Self.qPath(c.path)) 2>/dev/null; exec \"${SHELL:-/bin/sh}\" -l", tty: true, env: [:])
        if let e = l.error { return ["ok": false, "message": e] }
        let sock = l.env["SSH_AUTH_SOCK"].map { "SSH_AUTH_SOCK=" + Self.q($0) + " " } ?? ""
        let script = "#!/bin/sh\nexec env \(sock)/usr/bin/ssh " + l.args.map(Self.q).joined(separator: " ") + "\n"
        let file = SSHKeys.shared.scratch + "/terminal-" + String(pid.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(40)) + ".command"
        guard FileManager.default.createFile(atPath: file, contents: Data(script.utf8), attributes: [.posixPermissions: 0o700]) else { return ["ok": false, "message": "Impossible de préparer le terminal."] }
        chmod(file, 0o700)
        NSWorkspace.shared.open(URL(fileURLWithPath: file))
        return ["ok": true]
    }

    // MARK: Empreinte du serveur

    /// Où ssh cherche l'empreinte de ce serveur : nom réel, port et fichier known_hosts, selon ~/.ssh/config (ssh -G).
    private func resolve(_ c: Server) -> (host: String, port: Int, known: String)? {
        let r = Self.exec("/usr/bin/ssh", (c.port > 0 ? ["-p", String(c.port)] : []) + ["-G", c.host], timeout: 8)
        guard r.status == 0 else { return nil }
        var host = "", port = 22, known = NSHomeDirectory() + "/.ssh/known_hosts"
        for line in r.out.split(separator: "\n") {
            let p = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard p.count == 2 else { continue }
            switch p[0] {
            case "hostname": host = p[1]
            case "port": port = Int(p[1]) ?? 22
            case "userknownhostsfile":
                let f = String(p[1].split(separator: " ").first ?? "")
                if !f.isEmpty { known = f.hasPrefix("~/") ? NSHomeDirectory() + f.dropFirst(1) : f }
            default: break
            }
        }
        guard Self.validHost(host) else { return nil }
        return (host, port, known)
    }

    /// Empreintes publiées par le serveur (ssh-keyscan), à montrer avant de lui faire confiance.
    private func scan(_ c: Server) -> (lines: [String], prints: [[String: String]], known: String)? {
        guard let t = resolve(c) else { return nil }
        let r = Self.exec("/usr/bin/ssh-keyscan", ["-T", "8", "-p", String(t.port), "--", t.host], timeout: 15)
        let lines = r.out.split(separator: "\n").map(String.init).filter { !$0.hasPrefix("#") && $0.split(separator: " ").count >= 3 }
        guard !lines.isEmpty else { return nil }
        let f = Self.exec("/usr/bin/ssh-keygen", ["-l", "-f", "-"], input: Data((lines.joined(separator: "\n") + "\n").utf8), timeout: 8)
        let prints: [[String: String]] = f.out.split(separator: "\n").compactMap { l in
            let p = l.split(separator: " ").map(String.init)
            guard p.count >= 4, p[1].hasPrefix("SHA256:") else { return nil }
            return ["fingerprint": p[1], "type": p.last!.trimmingCharacters(in: CharacterSet(charactersIn: "()"))]
        }
        return prints.isEmpty ? nil : (lines, prints, t.known)
    }

    func hostKeys(_ pid: String) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        guard let s = scan(c) else { return ["ok": false, "message": "Le serveur n’a pas donné son empreinte (injoignable, ou port SSH différent ?)."] }
        return ["ok": true, "keys": s.prints]
    }

    /// Ajoute l'empreinte du serveur à known_hosts, seulement si c'est exactement celle que l'utilisateur a confirmée.
    func trust(_ pid: String, confirmed: [String]) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        guard let s = scan(c) else { return ["ok": false, "message": "Le serveur n’a pas donné son empreinte."] }
        guard Set(s.prints.compactMap { $0["fingerprint"] }) == Set(confirmed) else {
            return ["ok": false, "message": "L’empreinte du serveur a changé depuis que tu l’as vue : rien n’a été enregistré."]
        }
        let fm = FileManager.default, dir = (s.known as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !fm.fileExists(atPath: s.known) { fm.createFile(atPath: s.known, contents: nil, attributes: [.posixPermissions: 0o600]) }
        guard let h = FileHandle(forWritingAtPath: s.known) else { return ["ok": false, "message": "Impossible d’écrire dans \(s.known)."] }
        defer { try? h.close() }
        let end = (try? h.seekToEnd()) ?? 0
        var text = s.lines.joined(separator: "\n") + "\n"
        if end > 0, let r = FileHandle(forReadingAtPath: s.known) {
            try? r.seek(toOffset: end - 1)
            if r.readData(ofLength: 1) != Data("\n".utf8) { text = "\n" + text }
            try? r.close()
        }
        try? h.write(contentsOf: Data(text.utf8))
        return ["ok": true]
    }
}
#endif
