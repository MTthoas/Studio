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

    // MARK: Plusieurs serveurs par projet
    // Le premier serveur d'un projet est rangé sous l'identifiant du projet (comme avant), les suivants sous
    // « projet~serveur ». Cette clé (`ref`) sert partout où l'on désignait le serveur par le projet : config, status,
    // terminal, extensions, monitoring ; un appel sans `server` vise donc toujours le premier.

    static func validServerId(_ s: String) -> Bool { !s.isEmpty && s.count <= 24 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber) } }
    /// Clé de rangement du serveur `server` du projet ("" ou invalide : le premier).
    static func ref(_ pid: String, _ server: String) -> String { validServerId(server) ? pid + "~" + server : pid }
    /// Projet d'une clé de rangement.
    static func project(of ref: String) -> String { String(ref.split(separator: "~", maxSplits: 1).first ?? "") }
    private func ids(_ pid: String) -> [String] {
        all.keys.filter { $0.hasPrefix(pid + "~") }.map { String($0.dropFirst(pid.count + 1)) }.filter(Self.validServerId).sorted()
    }

    /// Serveurs du projet, le premier en tête puis par ordre d'ajout.
    func list(_ pid: String) -> [String: Any] {
        let refs = (all[pid] == nil ? [] : [("", pid)]) + ids(pid).map { ($0, Self.ref(pid, $0)) }
        let out: [[String: Any]] = refs.compactMap { id, r in
            guard let c = config(r) else { return nil }
            return ["id": id, "name": all[r]?["name"] ?? "", "host": c.host, "dest": c.dest, "path": c.path]
        }
        return ["ok": true, "servers": out]
    }

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
        for (r, c) in all { if let k = c["key"], !k.isEmpty { let pid = Self.project(of: r); if !(out[k] ?? []).contains(pid) { out[k, default: []].append(pid) } } }
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

    /// Champs du formulaire validés, sans rien enregistrer : sert à `set` et au test de connexion.
    func draft(host: String, user: String = "", path: String, port: String, key: String) -> Result<Server, SSHKeys.Failure> {
        guard Self.validHost(host) else { return .failure(.init("Hôte invalide : un alias de ~/.ssh/config ou utilisateur@hôte.")) }
        let u = user.trimmingCharacters(in: .whitespaces)
        guard u.isEmpty || Self.validUser(u) else { return .failure(.init("Utilisateur invalide : minuscules, chiffres, _ . - (ex. root, ubuntu, deploy).")) }
        guard u.isEmpty || !host.contains("@") else { return .failure(.init("L’utilisateur est indiqué deux fois : retire « utilisateur@ » de l’hôte.")) }
        guard Self.validPath(path) else { return .failure(.init("Chemin invalide : absolu (/srv/app) ou depuis ~ (~/app), sans espace ni caractère spécial.")) }
        let p = port.trimmingCharacters(in: .whitespaces)
        guard p.isEmpty || (Int(p).map { (1...65535).contains($0) } ?? false) else { return .failure(.init("Port invalide : un nombre entre 1 et 65535, ou vide pour le port habituel.")) }
        guard key.isEmpty || (SSHKeys.validId(key) && SSHKeys.shared.exists(key)) else { return .failure(.init("Clé SSH inconnue.")) }
        return .success(Server(host: host, path: path, port: Int(p) ?? 0, key: key, ext: [], user: u))
    }

    /// Enregistre un serveur du projet. `server` : "" pour le premier, "new" pour en ajouter un, sinon l'identifiant d'un serveur existant.
    func set(_ pid: String, server: String = "", name: String = "", host: String, user: String = "", path: String, port: String, key: String, ext: [String]) -> [String: Any] {
        guard !pid.isEmpty, pid.count <= 64, !pid.contains("~") else { return ["ok": false, "message": "Projet invalide."] }
        let c: Server
        switch draft(host: host, user: user, path: path, port: port, key: key) {
        case .failure(let f): return ["ok": false, "message": f.message]
        case .success(let s): c = s
        }
        let label = String(name.trimmingCharacters(in: .whitespacesAndNewlines).filter { !$0.isNewline && $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }.prefix(40))
        var id = server
        if id == "new" { id = all[pid] == nil ? "" : String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) }
        else if !id.isEmpty && (!Self.validServerId(id) || all[Self.ref(pid, id)] == nil) { return ["ok": false, "message": "Serveur introuvable."] }
        let e = Self.extensions.filter(ext.contains)
        var a = all; a[Self.ref(pid, id)] = ["name": label, "host": c.host, "user": c.user, "path": c.path, "port": c.port > 0 ? String(c.port) : "", "key": c.key, "ext": e.joined(separator: ",")]; all = a
        return ["ok": true, "server": id, "host": c.host, "user": c.user, "path": c.path]
    }
    /// Retire un serveur (clé de rangement). Retirer le premier fait passer le suivant en tête.
    func forget(_ ref: String) {
        var a = all; a.removeValue(forKey: ref)
        if !ref.contains("~"), let next = ids(ref).first { a[ref] = a.removeValue(forKey: Self.ref(ref, next)) }
        all = a
    }

    /// Test de connexion d'un serveur pas encore enregistré : joignable, empreinte, clé acceptée, dossier, Git, Claude Code.
    func test(_ c: Server) -> [String: Any] {
        let r = run(c, "echo @OK; cd \(Self.qPath(c.path)) 2>/dev/null && echo @DIR; command -v git >/dev/null 2>&1 && echo @GIT; command -v claude >/dev/null 2>&1 && echo @CLAUDE; uname -sr", timeout: 20)
        var out: [String: Any] = ["ok": true, "dest": c.dest, "ms": r.ms]
        guard !r.keyError, r.out.contains("@OK") else {
            out["online"] = false
            out["error"] = String(r.out.split(separator: "\n").last ?? "Connexion refusée").prefix(200)
            if let h = Self.hostKeyProblem(r.out) { out["hostKey"] = h }
            if r.out.contains("Permission denied") { out["denied"] = true }
            return out
        }
        out["online"] = true
        out["dir"] = r.out.contains("@DIR"); out["git"] = r.out.contains("@GIT"); out["claude"] = r.out.contains("@CLAUDE")
        out["os"] = r.out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty && !$0.hasPrefix("@") } ?? ""
        return out
    }

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
        var base: [String: Any] = ["ok": true, "configured": true, "name": all[pid]?["name"] ?? "", "host": c.host, "user": c.user, "dest": c.dest, "path": c.path, "port": c.port, "ext": c.ext, "ms": r.ms]
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

    // MARK: Fiche de la machine

    /// Lecture d'une fiche « machine » : tout ce qu'on apprendrait dans une console (Linux surtout), sans rien installer.
    /// Lancé par `sh -c` pour ne pas dépendre du shell de connexion ; `$1` = 1 demande la localisation par ipinfo.io,
    /// faite depuis le serveur et seulement sur demande de l'utilisateur. Les métadonnées de l'hébergeur (adresse
    /// locale 169.254…, jamais Internet) ne sont interrogées que si la DMI désigne cet hébergeur.
    private static let specScript = #"""
    export LC_ALL=C PATH="$PATH:/usr/sbin:/sbin"
    kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n\t' '  ' | cut -c1-300)"; }
    rd() { head -n 1 "$1" 2>/dev/null; }
    get() { command -v curl >/dev/null 2>&1 && curl -fsS -m 2 "$@" 2>/dev/null; }
    kv hostname "$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null)"
    kv fqdn "$(hostname -f 2>/dev/null)"
    kv distro "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"')"
    kv kernel "$(uname -sr)"
    kv arch "$(uname -m)"
    kv virt "$(systemd-detect-virt 2>/dev/null)"
    kv vendor "$(rd /sys/class/dmi/id/sys_vendor)"
    kv product "$(rd /sys/class/dmi/id/product_name)"
    kv threads "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
    kv cpuinfo "$(grep -m1 -E '^(model name|Hardware|Processor|cpu model)' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"
    kv mhz "$(grep -m1 '^cpu MHz' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"
    kv flags "$(grep -m1 -E '^(flags|Features)' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | tr ' ' '\n' | grep -xE 'aes|avx|avx2|avx512f|sha_ni|vmx|svm|asimd|sve|sse4_2' | sort -u | tr '\n' ' ')"
    kv memtotal "$(sed -n 's/^MemTotal: *\([0-9]*\).*/\1/p' /proc/meminfo 2>/dev/null)"
    kv swaptotal "$(sed -n 's/^SwapTotal: *\([0-9]*\).*/\1/p' /proc/meminfo 2>/dev/null)"
    kv tz "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||')"
    kv offset "$(date +%z)"
    kv uptime "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
    kv user "$(id -un 2>/dev/null)"
    kv sudo "$(sudo -n true 2>/dev/null && echo yes)"
    kv nofile "$(ulimit -n 2>/dev/null)"
    kv tools "$(for t in docker podman kubectl k3s nginx caddy apache2 httpd node bun deno python3 go java php ruby git psql mysql redis-server pm2 systemctl ufw; do command -v $t >/dev/null 2>&1 && printf '%s ' $t; done)"
    dev=$(ip route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
    kv iface "$dev"
    [ -n "$dev" ] && kv speed "$(rd /sys/class/net/$dev/speed)"
    case "$(rd /sys/class/dmi/id/sys_vendor) $(rd /sys/class/dmi/id/chassis_asset_tag) $(rd /sys/class/dmi/id/product_name)" in
      *Hetzner*) m=http://169.254.169.254/hetzner/v1/metadata; kv m_zone "$(get $m/availability-zone)"; kv m_region "$(get $m/region)"; kv m_ip "$(get $m/public-ipv4)";;
      *Amazon*) t=$(get -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token); m=http://169.254.169.254/latest/meta-data; h="X-aws-ec2-metadata-token: $t"
        kv m_region "$(get -H "$h" $m/placement/region)"; kv m_zone "$(get -H "$h" $m/placement/availability-zone)"; kv m_type "$(get -H "$h" $m/instance-type)"; kv m_ip "$(get -H "$h" $m/public-ipv4)";;
      *Google*) h='Metadata-Flavor: Google'; m=http://metadata.google.internal/computeMetadata/v1/instance
        kv m_zone "$(get -H "$h" $m/zone | sed 's|.*/||')"; kv m_type "$(get -H "$h" $m/machine-type | sed 's|.*/||')"; kv m_ip "$(get -H "$h" $m/network-interfaces/0/access-configs/0/external-ip)";;
      *Microsoft*) h='Metadata: true'; m=http://169.254.169.254/metadata/instance/compute; v='api-version=2021-02-01&format=text'
        kv m_region "$(get -H "$h" "$m/location?$v")"; kv m_zone "$(get -H "$h" "$m/zone?$v")"; kv m_type "$(get -H "$h" "$m/vmSize?$v")";;
      *DigitalOcean*) m=http://169.254.169.254/metadata/v1; kv m_region "$(get $m/region)"; kv m_ip "$(get $m/interfaces/public/0/ipv4/address)";;
      *Scaleway*) c=$(get http://169.254.42.42/conf); kv m_zone "$(printf '%s\n' "$c" | sed -n 's/^ZONE=//p')"; kv m_type "$(printf '%s\n' "$c" | sed -n 's/^COMMERCIAL_TYPE=//p')"; kv m_ip "$(printf '%s\n' "$c" | sed -n 's/^PUBLIC_IP_ADDRESS=//p')";;
      *Vultr*) m=http://169.254.169.254/v1; kv m_region "$(get $m/region/regioncode)"; kv m_ip "$(get $m/interfaces/0/ipv4/address)";;
      *Oracle*) h='Authorization: Bearer Oracle'; m=http://169.254.169.254/opc/v2/instance; kv m_region "$(get -H "$h" $m/canonicalRegionName)"; kv m_zone "$(get -H "$h" $m/availabilityDomain)"; kv m_type "$(get -H "$h" $m/shape)";;
    esac
    echo @@cpu; lscpu 2>/dev/null
    echo @@disks; lsblk -dbno NAME,SIZE,ROTA,TYPE,MODEL 2>/dev/null
    echo @@fs; df -kPT 2>/dev/null | tail -n +2
    echo @@ip; ip -o addr show scope global 2>/dev/null | awk '{print $2, $3, $4}'
    echo @@gpu; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || lspci 2>/dev/null | grep -iE 'vga|3d controller' | cut -d: -f3-
    echo @@geo; [ "$1" = 1 ] && get -m 5 https://ipinfo.io/json
    echo; echo @@end
    """#

    /// Fiche de la machine : emplacement, puissance, capacités. `geo` : localiser l'adresse IP publique (ipinfo.io).
    func specs(_ pid: String, geo: Bool) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        let r = run(c, "sh -c " + Self.q(Self.specScript) + " specs " + (geo ? "1" : "0"), timeout: 45)
        guard !r.keyError, r.out.contains("@@end") else {
            return ["ok": false, "message": String(String(r.out.split(separator: "\n").last ?? "Lecture impossible.").prefix(200))]
        }
        var kv: [String: String] = [:], sec: [String: [String]] = [:], cur = ""
        for line in r.out.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("@@") { cur = String(line.dropFirst(2)); continue }
            if cur.isEmpty, let eq = line.firstIndex(of: "=") { kv[String(line[..<eq])] = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces) }
            else if !cur.isEmpty, !line.trimmingCharacters(in: .whitespaces).isEmpty { sec[cur, default: []].append(line) }
        }
        let v = { (k: String) in (kv[k] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "'\" ")) }
        let words = { (s: String) in s.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init) }
        var out: [String: Any] = ["ok": true, "at": (Date().timeIntervalSince1970 * 1000).rounded()]

        // Processeur : lscpu d'abord, /proc/cpuinfo sinon.
        var cpu: [String: String] = [:]
        for line in sec["cpu"] ?? [] { if let i = line.firstIndex(of: ":") { cpu[line[..<i].trimmingCharacters(in: .whitespaces)] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let num = { (k: String) in Int(cpu[k] ?? "") }
        let sockets = num("Socket(s)") ?? 1, perSocket = num("Core(s) per socket") ?? num("Core(s) per cluster")
        let mhz = Double(cpu["CPU max MHz"] ?? "") ?? Double(v("mhz")) ?? 0
        out["cpu"] = ["model": cpu["Model name"] ?? v("cpuinfo"), "threads": Int(v("threads")) ?? num("CPU(s)") ?? 0,
                      "cores": perSocket.map { $0 * sockets } ?? 0, "sockets": sockets, "mhz": mhz.rounded(),
                      "l2": cpu["L2 cache"] ?? cpu["L2"] ?? "", "l3": cpu["L3 cache"] ?? cpu["L3"] ?? "",
                      "hypervisor": cpu["Hypervisor vendor"] ?? "", "vendor": cpu["Vendor ID"] ?? "",
                      "flags": words(v("flags"))] as [String: Any]
        out["mem"] = ["total": (Double(v("memtotal")) ?? 0) * 1024, "swap": (Double(v("swaptotal")) ?? 0) * 1024]

        // Disques physiques (ou virtuels) : nom, taille, SSD, modèle.
        out["disks"] = (sec["disks"] ?? []).compactMap { line -> [String: Any]? in
            let w = words(line); guard w.count >= 4, w[3] == "disk" else { return nil }
            return ["name": w[0], "size": Double(w[1]) ?? 0, "ssd": w[2] == "0", "model": w.dropFirst(4).joined(separator: " ")]
        }
        // Systèmes de fichiers réels (ni mémoire, ni conteneurs, ni images), un par périphérique.
        let virtualFS: Set<String> = ["tmpfs", "devtmpfs", "overlay", "squashfs", "efivarfs", "proc", "sysfs", "devfs", "ramfs", "nsfs", "fuse.lxcfs", "shm", "udev", "none"]
        var seen = Set<String>()
        out["fs"] = (sec["fs"] ?? []).compactMap { line -> [String: Any]? in
            let w = words(line); guard w.count >= 7, !virtualFS.contains(w[1]), !w[0].hasPrefix("/dev/loop"), seen.insert(w[0]).inserted else { return nil }
            let size = (Double(w[2]) ?? 0) * 1024; guard size > 0 else { return nil }
            return ["dev": w[0], "type": w[1], "size": size, "used": (Double(w[3]) ?? 0) * 1024, "free": (Double(w[4]) ?? 0) * 1024,
                    "pct": Int(w[5].replacingOccurrences(of: "%", with: "")) ?? 0, "mount": w[6...].joined(separator: " ")]
        }
        // Adresses : publique ou privée.
        let addrs: [[String: Any]] = (sec["ip"] ?? []).compactMap { line -> [String: Any]? in
            let w = words(line); guard w.count >= 3 else { return nil }
            let a = String(w[2].split(separator: "/").first ?? "")
            return ["iface": w[0], "v6": w[1] == "inet6", "addr": a, "public": !Self.privateIP(a)]
        }
        out["net"] = ["iface": v("iface"), "speed": Int(v("speed")).flatMap { $0 > 0 ? $0 : nil } ?? 0, "addrs": addrs] as [String: Any]
        out["gpu"] = (sec["gpu"] ?? []).map { $0.trimmingCharacters(in: .whitespaces) }

        // Emplacement : métadonnées de l'hébergeur, puis ipinfo.io si demandé.
        let pub = v("m_ip").isEmpty ? (addrs.first { $0["public"] as? Bool == true && $0["v6"] as? Bool == false }?["addr"] as? String ?? "") : v("m_ip")
        var loc: [String: Any] = ["region": v("m_region"), "zone": v("m_zone"), "type": v("m_type"), "ip": pub, "tz": v("tz"), "offset": v("offset")]
        if let json = (sec["geo"] ?? []).joined().data(using: .utf8), let g = try? JSONSerialization.jsonObject(with: json) as? [String: Any], g["bogon"] == nil {
            loc["geo"] = ["ip", "city", "region", "country", "org", "loc", "timezone", "hostname"].reduce(into: [String: String]()) { $0[$1] = g[$1] as? String ?? "" }
        } else if geo { loc["geoError"] = "ipinfo.io n’a pas répondu depuis le serveur (curl absent ou sortie bloquée)." }
        out["location"] = loc

        out["system"] = ["hostname": v("hostname"), "fqdn": v("fqdn"), "distro": v("distro"), "kernel": v("kernel"), "arch": v("arch"),
                         "virt": v("virt") == "none" ? "" : v("virt"), "vendor": v("vendor"), "product": v("product"),
                         "uptime": Double(v("uptime")) ?? 0, "user": v("user"), "sudo": v("sudo") == "yes",
                         "nofile": v("nofile"), "tools": words(v("tools"))] as [String: Any]
        return out
    }

    /// Adresse privée, locale ou partagée (pas joignable depuis Internet).
    static func privateIP(_ a: String) -> Bool {
        if a.contains(":") { let l = a.lowercased(); return l.hasPrefix("fc") || l.hasPrefix("fd") || l.hasPrefix("fe80") || l == "::1" }
        let p = a.split(separator: ".").compactMap { Int($0) }; guard p.count == 4 else { return true }
        return p[0] == 10 || p[0] == 127 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168)
            || (p[0] == 169 && p[1] == 254) || (p[0] == 100 && (64...127).contains(p[1]))
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
        return hostKeys(c)
    }
    func hostKeys(_ c: Server) -> [String: Any] {
        guard let s = scan(c) else { return ["ok": false, "message": "Le serveur n’a pas donné son empreinte (injoignable, ou port SSH différent ?)."] }
        return ["ok": true, "keys": s.prints]
    }

    /// Ajoute l'empreinte du serveur à known_hosts, seulement si c'est exactement celle que l'utilisateur a confirmée.
    func trust(_ pid: String, confirmed: [String]) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        return trust(c, confirmed: confirmed)
    }
    func trust(_ c: Server, confirmed: [String]) -> [String: Any] {
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
