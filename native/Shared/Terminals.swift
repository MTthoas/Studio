// Terminaux intégrés à l'app (tiroir « Terminal » d'un projet) : un shell LOCAL de l'utilisateur ($SHELL, shell de connexion
// interactif) ou ssh vers le serveur du projet, tous deux dans un pseudo-terminal (openpty) ; la page affiche et saisit
// (émulateur VT dans src/lib/vt.ts). Jamais un chemin libre venant de la page : le dossier est celui du projet, d'un de ses
// dépôts (ProjectFolders.otherRepos) ou d'une copie d'agent (.claude/worktrees/<nom>, validWorktree). ssh garde les garde-fous
// de Servers.swift (hôte et chemin validés, BatchMode : clé uniquement, aucune clé vue ni stockée par Studio).
//
// Chaque terminal est son propre processus, chef de session avec le pty pour terminal de contrôle (fork + setsid + TIOCSCTTY) :
// le contrôle de tâches du shell marche, et sysctl (e_tpgid ; tcgetpgrp(master) est refusé à Studio) dit quel groupe est au premier plan (état `busy` / `fg`).
// La sortie est poussée à la page par window.carnet.term({ term, data }) (base64, regroupée toutes les ~15 ms), puis
// { term, state: { busy, fg } } quand l'occupation change (vérifiée toutes les ~800 ms) et { term, exit } à la fin. Un terminal fini
// reste listé (alive = false) jusqu'à `close` ; ses 512 Ko de sortie les plus récents se relisent par `replay`.
//
// Intégration shell (contrat B) : pour zsh, un ZDOTDIR propre à Studio dont chaque fichier source celui de l'utilisateur puis,
// dans .zshrc, ajoute les marques OSC 133 (A invite, C commande en base64, D code de sortie) et OSC 7 (dossier) ; pour bash, un
// --rcfile équivalent (PROMPT_COMMAND + trap DEBUG). Les autres shells tournent sans intégration. Rien n'est envoyé à la page
// hors du pont `project.term` (jamais dans REMOTE_ALLOWED : c'est un shell sur ce Mac).
import Foundation
#if os(macOS)
import Darwin

final class Terminals {
    static let shared = Terminals()
    /// Envoi vers la page, branché par Shell.swift.
    var emit: (([String: Any]) -> Void)?

    private final class Session {
        let id: String, project: String, ref: String, kind: String, name: String, title: String, cwd: String, cmd: String, started: Int
        var pid: pid_t = 0
        var master: Int32 = -1
        var source: DispatchSourceRead?
        var exitSource: DispatchSourceProcess?
        var pending = Data()
        var replay = Data()
        var flushing = false
        var alive = true
        var exit: Int?
        var busy = false, fg = ""
        var reaped = false                                                  // waitpid fait : le pid peut être réattribué
        let wq: DispatchQueue                                               // écritures de ce terminal (un shell figé n'en bloque pas d'autre)
        init(id: String, project: String, ref: String, kind: String, name: String, title: String, cwd: String, cmd: String) {
            self.id = id; self.project = project; self.ref = ref; self.kind = kind; self.name = name; self.title = title; self.cwd = cwd; self.cmd = cmd
            started = Int(Date().timeIntervalSince1970)
            wq = DispatchQueue(label: "studio.terminals.write.\(id)")
        }
    }
    private var sessions: [String: Session] = [:]
    private let q = DispatchQueue(label: "studio.terminals")
    private let maxSessions = 8, maxDead = 16, replayMax = 512 * 1024, cmdMax = 4000
    private var polling = false

    // MARK: Cibles proposées à la page

    /// Dossiers, copies, serveurs et scripts où ouvrir un terminal pour ce projet (réponse en types JSON purs).
    func targets(_ pid: String) -> [String: Any] {
        let folders = ProjectFolders.shared, fm = FileManager.default
        var repos: [[String: Any]] = [], copies: [[String: Any]] = [], scripts: [[String: Any]] = []
        let main = folders.path(pid)
        if let m = main { scripts += Self.scripts(in: m, repo: "") }
        for f in folders.otherRepos(pid).found where fm.fileExists(atPath: f.dir) {
            repos.append(["name": f.repo.name, "dir": f.dir])
            scripts += Self.scripts(in: f.dir, repo: f.repo.name)
        }
        if let m = main {
            let root = m + "/.claude/worktrees"
            for n in ((try? fm.contentsOfDirectory(atPath: root)) ?? []).sorted() where ProjectFolders.validWorktree(n) {
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: root + "/" + n, isDirectory: &isDir), isDir.boolValue else { continue }
                copies.append(["name": n, "branch": folders.currentBranch(root + "/" + n) ?? "", "dir": root + "/" + n])
            }
        }
        let servers = (Servers.shared.list(pid)["servers"] as? [[String: Any]] ?? []).map { s -> [String: Any] in
            let name = s["name"] as? String ?? "", dest = s["dest"] as? String ?? ""
            return ["id": s["id"] as? String ?? "", "name": name.isEmpty ? dest : name]
        }
        return ["ok": true, "home": NSHomeDirectory(), "repos": repos, "copies": copies, "servers": servers, "scripts": Array(scripts.prefix(120))]
    }

    /// Clés « scripts » du package.json d'un dossier, avec la commande qui les lance (gestionnaire déduit du dépôt).
    private static func scripts(in dir: String, repo: String) -> [[String: Any]] {
        guard let data = FileManager.default.contents(atPath: dir + "/package.json"), data.count < 2_000_000,
              let pkg = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let map = pkg["scripts"] as? [String: Any] else { return [] }
        let fm = FileManager.default, declared = (pkg["packageManager"] as? String ?? "").split(separator: "@").first.map(String.init) ?? ""
        let tool = ["pnpm", "yarn", "bun", "npm"].contains(declared) ? declared
            : fm.fileExists(atPath: dir + "/pnpm-lock.yaml") ? "pnpm" : fm.fileExists(atPath: dir + "/yarn.lock") ? "yarn"
            : fm.fileExists(atPath: dir + "/bun.lockb") || fm.fileExists(atPath: dir + "/bun.lock") ? "bun" : "npm"
        let ok = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_.-")
        return map.keys.sorted().filter { $0.count <= 80 && $0.allSatisfy { ok.contains($0) } && $0.first != "-" }.prefix(60)
            .map { ["repo": repo, "name": $0, "cmd": "\(tool) run \($0)"] }
    }

    // MARK: Ouverture

    /// Ancien chemin (op `term-open` de `server`) : ssh vers le serveur de la clé de rangement `sref`.
    func open(_ sref: String, cols: Int, rows: Int) -> [String: Any] {
        var r = open(project: Servers.project(of: sref), where: "ssh", name: sref.contains("~") ? String(sref.split(separator: "~", maxSplits: 1).last ?? "") : "", cmd: "", cols: cols, rows: rows)
        if let t = r["term"] as? [String: Any] { r["term"] = t["id"] }  // ancien format : l'id seul
        if r["ok"] as? Bool == true, let c = Servers.shared.config(sref) { r["host"] = c.dest; r["path"] = c.path }
        return r
    }

    /// Ouvre un terminal : `kind` = project | repo | copy | ssh ; `name` = dépôt, copie ou id du serveur ; `cmd` = script lancé à la place du shell.
    func open(project pid: String, where kind: String, name: String, cmd: String, cols: Int, rows: Int) -> [String: Any] {
        let folders = ProjectFolders.shared, fm = FileManager.default
        guard cmd.utf8.count <= cmdMax, !cmd.contains("\0") else { return ["ok": false, "message": "Commande trop longue."] }
        var exe = "", args: [String] = [], env: [String: String] = [:], dir = "", title = "", ref = pid
        if kind == "ssh" {
            ref = Servers.ref(pid, name)
            guard let c = Servers.shared.config(ref) else { return ["ok": false, "message": "Aucun serveur configuré."] }
            let remote = "cd \(Servers.qPath(c.path)) 2>/dev/null; exec \"${SHELL:-/bin/sh}\" -l"
            let l = Servers.shared.launch(c, remote, tty: true, env: ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"])
            if let e = l.error { return ["ok": false, "message": e] }
            exe = "/usr/bin/ssh"; args = [exe] + l.args; env = l.env
            let label = (Servers.shared.list(pid)["servers"] as? [[String: Any]] ?? []).first { ($0["id"] as? String ?? "") == (Servers.validServerId(name) ? name : "") }
            let n = label?["name"] as? String ?? "", d = label?["dest"] as? String ?? c.dest
            title = "ssh · " + (n.isEmpty ? d : n)
        } else {
            guard let main = folders.path(pid) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
            var label = (main as NSString).lastPathComponent
            switch kind {
            case "project": dir = main
            case "repo":
                guard let f = folders.otherRepos(pid).found.first(where: { $0.repo.name == name }) else { return ["ok": false, "message": "Dépôt introuvable."] }
                dir = f.dir; label = name
            case "copy":
                guard let wt = folders.worktreeDir(pid, name) else { return ["ok": false, "message": "Copie introuvable."] }
                dir = wt
            default: return ["ok": false, "message": "Dossier non reconnu."]
            }
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { return ["ok": false, "message": "Dossier introuvable."] }
            let sh = Self.userShell(), base = (sh as NSString).lastPathComponent
            exe = sh
            let rc = base == "bash" ? Self.integration()?.bash : nil
            // bash : --rcfile n'est lu que par un shell qui n'est pas de connexion, le fichier d'intégration refait donc la connexion.
            args = [sh] + (rc.map { ["--rcfile", $0, "-i"] } ?? ["-l", "-i"]) + (cmd.isEmpty ? [] : ["-c", cmd])
            env = Self.environment(shell: sh, base: base)
            title = !cmd.isEmpty ? Self.scriptTitle(cmd) : kind == "copy" ? "copie " + name : base + " · " + label
        }
        return q.sync {
            guard sessions.values.filter({ $0.alive }).count < maxSessions else { return ["ok": false, "message": "Trop de terminaux ouverts (8 au plus) : ferme-en un."] }
            var ws = winsize(ws_row: UInt16(max(4, min(rows, 500))), ws_col: UInt16(max(10, min(cols, 500))), ws_xpixel: 0, ws_ypixel: 0)
            var master: Int32 = -1, slave: Int32 = -1
            guard openpty(&master, &slave, nil, nil, &ws) == 0 else { return ["ok": false, "message": "Pseudo-terminal indisponible."] }
            _ = fcntl(master, F_SETFD, FD_CLOEXEC)
            let s = Session(id: UUID().uuidString.lowercased(), project: pid, ref: ref, kind: kind, name: name, title: title, cwd: dir, cmd: cmd)
            guard let child = Self.spawn(exe, args, env: env, cwd: dir.isEmpty ? nil : dir, slave: slave) else {
                close(master); close(slave)
                return ["ok": false, "message": kind == "ssh" ? "SSH introuvable." : "Le shell n'a pas pu démarrer."]
            }
            close(slave)
            s.pid = child; s.master = master
            let src = DispatchSource.makeReadSource(fileDescriptor: master, queue: q)
            src.setEventHandler { [weak self, weak s] in
                guard let self, let s else { return }
                var buf = [UInt8](repeating: 0, count: 65536)
                let n = read(s.master, &buf, buf.count)
                if n <= 0 { s.source?.cancel(); s.source = nil; return }
                self.take(s, Data(buf[0..<n]))
            }
            src.setCancelHandler { [weak s] in if let s, s.master >= 0 { close(s.master); s.master = -1 } }
            s.source = src
            src.resume()
            let ex = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: q)
            ex.setEventHandler { [weak self] in                             // s gardé fortement : un terminal fermé doit quand même être récupéré (pas de zombie)
                var st: Int32 = 0
                _ = waitpid(s.pid, &st, 0); s.reaped = true
                guard let self else { return }
                let code = st & 0x7f == 0 ? Int((st >> 8) & 0xff) : 128 + Int(st & 0x7f)
                s.exitSource?.cancel(); s.exitSource = nil
                self.q.asyncAfter(deadline: .now() + 0.1) { self.finish(s, status: code) }
            }
            s.exitSource = ex
            ex.resume()
            sessions[s.id] = s
            evictDead()
            startPolling()
            return ["ok": true, "term": describe(s)]
        }
    }

    /// Shell de l'utilisateur : $SHELL s'il est exécutable, sinon son shell de connexion, sinon /bin/zsh.
    private static func userShell() -> String {
        let fm = FileManager.default
        var cands = [ProcessInfo.processInfo.environment["SHELL"] ?? ""]
        if let pw = getpwuid(getuid()), let s = pw.pointee.pw_shell { cands.append(String(cString: s)) }
        return (cands + ["/bin/zsh"]).first { $0.hasPrefix("/") && fm.isExecutableFile(atPath: $0) } ?? "/bin/zsh"
    }

    /// Environnement de l'utilisateur, moins ce qui est propre à Studio (CARNET_*, STUDIO_*), plus ce qu'il faut à un terminal.
    private static func environment(shell: String, base: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("CARNET_") && !$0.key.hasPrefix("STUDIO_") }
        let user = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
        env["HOME"] = NSHomeDirectory(); env["USER"] = user; env["LOGNAME"] = env["LOGNAME"] ?? user; env["SHELL"] = shell
        if (env["LANG"] ?? "").isEmpty { env["LANG"] = "en_US.UTF-8" }
        env["PATH"] = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["TERM"] = "xterm-256color"; env["COLORTERM"] = "truecolor"; env["TERM_PROGRAM"] = "Studio"
        if base == "zsh", let z = integration()?.zsh {
            env["STUDIO_ZD"] = ProcessInfo.processInfo.environment["ZDOTDIR"] ?? ""
            env["ZDOTDIR"] = z
        }
        return env
    }

    /// « npm run serve » → « serve » ; sinon le début de la commande.
    private static func scriptTitle(_ cmd: String) -> String {
        let t = cmd.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .whitespaces).filter { !$0.isEmpty }
        if t.count == 3, t[1] == "run" { return t[2] }
        let one = t.joined(separator: " ")
        return one.count > 40 ? String(one.prefix(40)) + "…" : one
    }

    /// Lance le programme dans une nouvelle session dont le pty `slave` est le terminal de contrôle (stdin, stdout, stderr). Rend le pid.
    /// posix_spawn ne suffit pas : macOS n'y fait pas du pty le terminal de contrôle (le shell n'aurait pas de contrôle de tâches).
    /// fork est interdit en Swift, on le prend donc par dlsym ; l'enfant n'appelle que des fonctions C sûres (tout est préparé avant).
    private static func spawn(_ exe: String, _ args: [String], env: [String: String], cwd: String?, slave: Int32) -> pid_t? {
        typealias Fork = @convention(c) () -> pid_t
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "fork") else { return nil }  // -2 : RTLD_DEFAULT
        let fork = unsafeBitCast(sym, to: Fork.self)
        let argv = args.map { strdup($0) } + [nil], envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil], dir: UnsafeMutablePointer<CChar>? = cwd.flatMap { strdup($0) }, path = strdup(exe)
        defer { argv.forEach { free($0) }; envp.forEach { free($0) }; free(dir); free(path) }
        let fds = getdtablesize()
        let pid = fork()
        if pid == 0 {
            setsid()
            _ = ioctl(slave, UInt(TIOCSCTTY), 0)
            dup2(slave, 0); dup2(slave, 1); dup2(slave, 2)
            var fd: Int32 = 3
            while fd < fds { close(fd); fd += 1 }
            for sig in Int32(1)..<32 where sig != SIGKILL && sig != SIGSTOP { signal(sig, SIG_DFL) }
            var none = sigset_t(); sigemptyset(&none); sigprocmask(SIG_SETMASK, &none, nil)
            if let d = dir, chdir(d) != 0 { _exit(126) }
            execve(path, argv, envp)
            _exit(127)
        }
        return pid > 0 ? pid : nil
    }

    // MARK: Sortie

    private func take(_ s: Session, _ d: Data) {
        s.pending.append(d)
        s.replay.append(d)
        if s.replay.count > replayMax + 65536 {
            var cut = s.replay.count - replayMax
            while cut < s.replay.count, s.replay[s.replay.startIndex + cut] & 0xC0 == 0x80 { cut += 1 }  // pas au milieu d'un caractère UTF-8
            s.replay = Data(s.replay.suffix(from: s.replay.startIndex + cut))
        }
        schedule(s)
    }
    private func schedule(_ s: Session) {
        guard !s.flushing else { return }
        s.flushing = true
        q.asyncAfter(deadline: .now() + 0.015) { [weak self] in self?.flush(s) }
    }
    private func flush(_ s: Session) {
        s.flushing = false
        guard !s.pending.isEmpty else { return }
        let chunk = s.pending; s.pending = Data()
        emit?(["term": s.id, "data": chunk.base64EncodedString()])
    }
    private func finish(_ s: Session, status: Int) {
        guard s.alive else { return }
        // Dernières lignes (message d'erreur de ssh, fin d'un script) avant la fin.
        if s.master >= 0 {
            var buf = [UInt8](repeating: 0, count: 65536)
            let flags = fcntl(s.master, F_GETFL); _ = fcntl(s.master, F_SETFL, flags | O_NONBLOCK)
            while true { let n = read(s.master, &buf, buf.count); if n <= 0 { break }; take(s, Data(buf[0..<n])) }
        }
        flush(s)
        s.alive = false; s.exit = status; s.busy = false; s.fg = ""
        if let src = s.source { s.source = nil; src.cancel() } else if s.master >= 0 { close(s.master); s.master = -1 }
        emit?(["term": s.id, "exit": status])
        evictDead()
    }
    /// Garde au plus `maxDead` terminaux finis (les plus anciens partent d'abord).
    private func evictDead() {
        let dead = sessions.values.filter { !$0.alive }.sorted { $0.started < $1.started }
        for s in dead.dropLast(maxDead) { sessions[s.id] = nil }
    }

    // MARK: État occupé / premier plan

    private func startPolling() {
        guard !polling else { return }
        polling = true
        q.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.poll() }
    }
    private func poll() {
        let live = sessions.values.filter { $0.alive }
        guard !live.isEmpty else { polling = false; return }
        for s in live {
            let (busy, fg) = Self.state(s)
            if busy != s.busy || fg != s.fg { s.busy = busy; s.fg = fg; emit?(["term": s.id, "state": ["busy": busy, "fg": fg]]) }
        }
        q.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.poll() }
    }
    /// Occupé : un programme tourne au premier plan (groupe du pty ≠ shell), ou la commande lancée est vivante ; `fg` : son nom.
    private static func state(_ s: Session) -> (Bool, String) {
        guard s.alive, s.master >= 0 else { return (false, "") }
        let pg = foreground(s.pid)
        var name = ""
        if pg > 0 {
            var buf = [CChar](repeating: 0, count: 256)
            if proc_name(pg, &buf, UInt32(buf.count)) > 0 { name = String(cString: buf) }
        }
        if !s.cmd.isEmpty { return (true, name) }
        return pg > 0 && pg != s.pid ? (true, name) : (false, "")
    }

    /// Groupe de processus au premier plan du terminal de contrôle de `pid` (e_tpgid) : tcgetpgrp(master) est refusé à Studio (EPERM),
    /// qui n'a pas ce pty pour terminal de contrôle ; sysctl donne la même réponse que `ps -o tpgid`.
    private static func foreground(_ pid: pid_t) -> pid_t {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid], info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        guard pid > 0, sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return 0 }
        return info.kp_eproc.e_tpgid
    }

    private func describe(_ s: Session) -> [String: Any] {
        ["id": s.id, "project": s.project, "where": s.kind, "name": s.name, "title": s.title, "cwd": s.cwd, "cmd": s.cmd, "started": s.started,
         "alive": s.alive, "busy": s.busy, "fg": s.fg, "exit": s.exit.map { Int($0) as Any } ?? (NSNull() as Any)]
    }

    // MARK: Opérations du pont

    // Noms choisis pour ne pas masquer read/write/close de Darwin dans cette classe.
    func input(_ id: String, _ text: String) -> [String: Any] {
        // dup sous q : la fermeture du master (sur q) ne peut pas faire écrire dans un descripteur réattribué.
        guard let (s, fd) = q.sync(execute: { () -> (Session, Int32)? in
            guard let s = sessions[id], s.alive, s.master >= 0 else { return nil }
            let fd = dup(s.master); return fd >= 0 ? (s, fd) : nil
        }) else { return ["ok": false, "message": "Terminal fermé."] }
        let bytes = Array(text.utf8.prefix(1_000_000))
        // Écriture sur la file du terminal : la lecture (file q) continue pendant un long collage, et un shell figé ne bloque que lui.
        s.wq.async {
            defer { close(fd) }
            var off = 0
            while off < bytes.count {
                let n = bytes[off...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
                if n <= 0 { if errno == EAGAIN || errno == EINTR { usleep(2000); continue }; return }
                off += n
            }
        }
        return ["ok": true]
    }

    func resize(_ id: String, cols: Int, rows: Int) -> [String: Any] {
        q.sync {
            guard let s = sessions[id], s.alive, s.master >= 0 else { return ["ok": false] }
            var ws = winsize(ws_row: UInt16(max(4, min(rows, 500))), ws_col: UInt16(max(10, min(cols, 500))), ws_xpixel: 0, ws_ypixel: 0)
            _ = ioctl(s.master, TIOCSWINSZ, &ws)  // le noyau prévient lui-même le premier plan (SIGWINCH)
            return ["ok": true]
        }
    }

    /// Arrête le processus (le terminal reste listé, fini, jusqu'à `close`).
    func stop(_ id: String) -> [String: Any] {
        q.sync { if let s = sessions[id] { hangUp(s) } }
        return ["ok": true]
    }
    /// Ferme le terminal : arrête le processus s'il tourne, puis l'oublie.
    func closeTerm(_ id: String) -> [String: Any] {
        q.sync {
            guard let s = sessions[id] else { return }
            if s.alive { hangUp(s); s.alive = false; s.exit = s.exit ?? 129; if let src = s.source { s.source = nil; src.cancel() } }
            sessions[id] = nil
        }
        return ["ok": true]
    }
    /// SIGHUP au shell et au programme du premier plan, puis SIGKILL s'ils s'accrochent.
    private func hangUp(_ s: Session) {
        guard s.alive, s.pid > 0 else { return }
        let pg = Self.foreground(s.pid), pid = s.pid
        if pg > 1 { kill(-pg, SIGHUP) }
        kill(-pid, SIGHUP); kill(pid, SIGHUP)
        q.asyncAfter(deadline: .now() + 1.5) { if !s.reaped && kill(pid, 0) == 0 { if pg > 1 { kill(-pg, SIGKILL) }; kill(-pid, SIGKILL); kill(pid, SIGKILL) } }
    }

    /// Terminaux d'un projet, finis compris (op `list`).
    func terms(_ pid: String) -> [String: Any] {
        q.sync { ["ok": true, "terms": sessions.values.filter { $0.project == pid }.sorted { $0.started < $1.started }.map { describe($0) }] }
    }
    /// Ancien format de `term-list` : les ids des terminaux vivants (d'un projet ou d'une clé de serveur).
    func list(_ pid: String) -> [String: Any] {
        q.sync { ["ok": true, "terms": sessions.values.filter { $0.alive && ($0.project == pid || $0.ref == pid) }.map { $0.id }] }
    }
    /// Sortie brute la plus récente (≤ 512 Ko), en base64.
    func replay(_ id: String) -> [String: Any] {
        q.sync {
            guard let s = sessions[id] else { return ["ok": false, "message": "Terminal introuvable."] }
            s.pending = Data()                                              // déjà dans replay : ne pas le pousser une seconde fois
            return ["ok": true, "data": s.replay.base64EncodedString()]
        }
    }

    /// Noms de ce qui tourne encore (commande lancée ou programme au premier plan), pour la sortie de l'app.
    func running() -> [String] {
        q.sync { sessions.values.filter { $0.alive }.sorted { $0.started < $1.started }.compactMap { s -> String? in
            let (busy, fg) = Self.state(s)
            guard busy else { return nil }
            return s.cmd.isEmpty ? (fg.isEmpty ? s.title : fg) : s.title
        } }
    }
    /// À la sortie de l'app : tous les terminaux s'arrêtent.
    func stopAll() {
        q.sync { for s in sessions.values where s.alive {
            let pg = Self.foreground(s.pid)
            if pg > 1 { kill(-pg, SIGHUP) }
            kill(-s.pid, SIGHUP); kill(s.pid, SIGHUP)
        } }
    }

    // MARK: Intégration shell (contrat B)

    private static let integrationVersion = "1"
    /// Écrit (si besoin) les fichiers d'intégration dans Application Support/Studio/shell-integration et rend leurs emplacements.
    private static func integration() -> (zsh: String, bash: String)? {
        let fm = FileManager.default
        let root = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Studio/shell-integration", isDirectory: true)
        let zsh = root.appendingPathComponent("zsh", isDirectory: true), bash = root.appendingPathComponent("bash", isDirectory: true)
        let stamp = root.appendingPathComponent("version")
        if (try? String(contentsOf: stamp, encoding: .utf8)) != integrationVersion {
            do {
                try fm.createDirectory(at: zsh, withIntermediateDirectories: true); try fm.createDirectory(at: bash, withIntermediateDirectories: true)
                for (n, t) in zshFiles { try t.write(to: zsh.appendingPathComponent(n), atomically: true, encoding: .utf8) }
                try bashRc.write(to: bash.appendingPathComponent("studio-bashrc"), atomically: true, encoding: .utf8)
                try integrationVersion.write(to: stamp, atomically: true, encoding: .utf8)
            } catch { return nil }
        }
        return (zsh.path, bash.appendingPathComponent("studio-bashrc").path)
    }

    /// Chaque fichier zsh source celui de l'utilisateur (son ZDOTDIR d'origine, sinon HOME) avec ZDOTDIR remis à sa valeur le temps
    /// de la lecture, sans fonction (un `typeset` de son fichier doit rester global). `STUDIO_ZD` : le ZDOTDIR d'origine (vide si aucun).
    private static func zshSource(_ file: String, tail: String = "") -> String {
        """
        # Intégration shell de Studio : charge \(file) de l'utilisateur, puis \(tail.isEmpty ? "rend la main" : "ajoute les marques du terminal").
        _studio_zd=$ZDOTDIR; ZDOTDIR=${STUDIO_ZD:-$HOME}
        [[ -r $ZDOTDIR/\(file) ]] && source $ZDOTDIR/\(file)
        [[ $ZDOTDIR != ${STUDIO_ZD:-$HOME} ]] && STUDIO_ZD=$ZDOTDIR
        ZDOTDIR=$_studio_zd
        \(tail)
        """ + "\n"
    }
    private static let zshFiles: [(String, String)] = [
        (".zshenv", zshSource(".zshenv")),
        (".zprofile", zshSource(".zprofile")),
        (".zshrc", zshSource(".zshrc", tail: #"""
        if [[ -o interactive && -z $_studio_hooked ]]; then
          _studio_hooked=1; _studio_ran=; _studio_pwd=
          _studio_precmd() {
            local c=$?
            [[ -n $_studio_ran ]] && print -rn -- $'\e]133;D;'$c$'\a'
            _studio_ran=
            print -rn -- $'\e]133;A\a'
            if [[ $PWD != $_studio_pwd ]]; then
              _studio_pwd=$PWD
              local LC_ALL=C i ch p=
              for (( i = 1; i <= ${#PWD}; ++i )); do ch=$PWD[i]; if [[ $ch == [/._~A-Za-z0-9-] ]]; then p+=$ch; else p+=$(printf '%%%02X' "'$ch"); fi; done
              print -rn -- $'\e]7;file://'${HOST}${p}$'\a'
            fi
          }
          _studio_preexec() {
            _studio_ran=1
            print -rn -- $'\e]133;C;'$(print -rn -- ${1[1,2000]} | /usr/bin/base64 | /usr/bin/tr -d '\n')$'\a'
          }
          precmd_functions=(_studio_precmd $precmd_functions)
          preexec_functions=(_studio_preexec $preexec_functions)
        fi
        """#)),
        (".zlogin", zshSource(".zlogin", tail: #"""
        if [[ -n $STUDIO_ZD ]]; then ZDOTDIR=$STUDIO_ZD; else unset ZDOTDIR; fi
        unset STUDIO_ZD _studio_zd
        """#)),
    ]

    /// bash : --rcfile reproduit un shell de connexion (profil), puis ajoute les marques par PROMPT_COMMAND et un trap DEBUG.
    private static let bashRc = #"""
    # Intégration shell de Studio pour bash : se comporte en shell de connexion, puis ajoute les marques du terminal.
    [ -r /etc/profile ] && . /etc/profile
    if [ -r ~/.bash_profile ]; then . ~/.bash_profile; elif [ -r ~/.bash_login ]; then . ~/.bash_login; elif [ -r ~/.profile ]; then . ~/.profile; fi
    if [ -z "$_studio_hooked" ]; then
      _studio_hooked=1; _studio_ran=; _studio_ready=; _studio_pwd=
      _studio_prompt() {
        local c=$?
        [ -n "$_studio_ran" ] && printf '\033]133;D;%s\007' "$c"
        _studio_ran=
        printf '\033]133;A\007'
        if [ "$PWD" != "$_studio_pwd" ]; then
          _studio_pwd=$PWD
          local LC_ALL=C i ch p=
          for ((i = 0; i < ${#PWD}; i++)); do ch=${PWD:i:1}; case $ch in [/._~A-Za-z0-9-]) p+=$ch;; *) p+=$(printf '%%%02X' "'$ch");; esac; done
          printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$p"
        fi
        return $c
      }
      _studio_arm() { _studio_ready=1; }
      _studio_pre() {
        [ -n "$_studio_ready" ] || return 0
        _studio_ready=; _studio_ran=1
        local l; l=$(HISTTIMEFORMAT= builtin history 1)
        l=${l#"${l%%[![:space:]]*}"}; l=${l#*[[:space:]]}; l=${l#"${l%%[![:space:]]*}"}
        printf '\033]133;C;%s\007' "$(printf %s "${l:0:2000}" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
      }
      if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
        PROMPT_COMMAND=(_studio_prompt "${PROMPT_COMMAND[@]}" _studio_arm)
      else
        PROMPT_COMMAND="_studio_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND};_studio_arm"
      fi
      trap '_studio_pre' DEBUG
    fi
    """# + "\n"
}
#endif
