// Confirmation avant qu'un agent supprime ou installe quoi que ce soit (comme la demande de permission de Claude Code).
//
// Chaque agent lancé sur ce Mac avec un terminal reçoit, par `--settings`, un hook PreToolUse sur Bash : avant chaque
// commande, Claude Code l'envoie (curl) au petit serveur d'ici, qui n'écoute que sur 127.0.0.1. Une commande sans
// risque repart aussitôt. Une suppression (rm, git clean, find -delete…) ou une installation (npm install, brew, pip,
// sudo…) attend : la page affiche la demande, et seul « Autoriser » suivi de Touch ID ou du mot de passe du Mac
// (LocalAuthentication, dans l'app, hors de la bulle) la laisse passer. Refus, silence pendant 9 minutes, app fermée,
// réponse illisible : la commande est refusée (le hook sort en code 2, que Claude Code bloque dans tous les modes).
//
// Ce que ça garantit, et ce que ça ne garantit pas : la décision se prend dans l'app, que l'agent ne peut ni lire ni
// écrire ; appeler lui-même le serveur ne lui rapporte qu'une demande de plus à l'écran. En revanche le tri se fait
// sur le texte de la commande : un script du projet qui supprime (`npm run clean`) ou un programme écrit par l'agent
// passe sans question. La borne dure reste la bulle (AgentSandbox) : rien ne s'écrit ni ne s'efface hors de sa copie,
// du .git de son dépôt, des caches des outils et des dossiers temporaires.
// Chez lui, l'agent a tous les droits : une suppression dont chaque chemin, écrit en clair, tombe dans son dossier de
// travail (sa copie et celles des autres dépôts du projet) passe sans question (`local`). Dès qu'un chemin sort, ou
// qu'il n'est pas lisible tel quel (variable, `~`, sous-commande, script), on redemande.
// Seule la page de ce Mac répond (« agent.guard » et « agent.guardAnswer » ne sont pas dans REMOTE_ALLOWED, link.ts).
import Foundation
import Network
import LocalAuthentication
#if os(macOS)

final class AgentGuard {
    static let shared = AgentGuard()
    static let changed = Notification.Name("studio.agents.guard")
    /// Attente de la réponse, en secondes ; curl et le hook attendent un peu plus (570 s, 600 s).
    private static let wait = 540.0
    private static let maxBody = 262_144, maxPerRun = 5

    private final class Ask {
        let id = UUID().uuidString, at = Date()
        let run: String, project: String, kind: String, what: String, command: String, cwd: String, agent: String
        var reply: ((String) -> Void)?
        init(run: String, project: String, kind: String, what: String, command: String, cwd: String, agent: String) {
            self.run = run; self.project = project; self.kind = kind; self.what = what; self.command = command; self.cwd = cwd; self.agent = agent
        }
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "studio.agents.guard")
    private var listener: NWListener?
    private var port: UInt16 = 0
    private var tokens: [String: (run: String, project: String, roots: [String])] = [:]
    private var asks: [Ask] = []

    // MARK: Tri des commandes

    /// Début d'une commande dans une ligne de shell : début de ligne, après `;`, `&&`, `|`, `(`, `$(`…, ou après un
    /// lanceur (sudo, xargs, env…), avec des variables (`A=1 rm`) et un chemin facultatifs devant le nom du programme.
    private static let at = #"(?:^|[;&|(`{\n]|\$\(|\b(?:sudo|xargs|exec|env|command|nohup|time|then|do|else)\s+(?:-\S+\s+)*)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:[\w./~-]*/)?"#
    private static func rules(_ list: [(String, String)]) -> [(NSRegularExpression, String)] {
        list.compactMap { p, what in (try? NSRegularExpression(pattern: p, options: [.anchorsMatchLines])).map { ($0, what) } }
    }
    private static let deletes = rules([
        (at + #"(?:rm|rmdir|unlink|trash|srm|shred)\b"#, "supprimer des fichiers"),
        (#"\bfind\b[^;&|\n]*\s-(?:delete\b|exec(?:dir)?\s+(?:\S*/)?rm\b)"#, "supprimer des fichiers (find)"),
        (at + #"git\s+(?:-[cC]\s+\S+\s+)*(?:clean|rm)\b"#, "supprimer des fichiers du dépôt"),
        (at + #"git\s+(?:-[cC]\s+\S+\s+)*reset\s+(?:\S+\s+)*--hard\b"#, "effacer les changements en cours (git reset --hard)"),
        (at + #"git\s+(?:-[cC]\s+\S+\s+)*(?:worktree\s+(?:remove|prune)|stash\s+(?:drop|clear)|branch\s+(?:\S+\s+)*(?:-[dD]\b|--delete\b)|tag\s+(?:\S+\s+)*(?:-d\b|--delete\b))"#, "supprimer une branche, une copie ou une remise Git"),
        (at + #"git\s+(?:-[cC]\s+\S+\s+)*push\b[^;&|\n]*(?:--delete\b|\s-d\b|\s:\S)"#, "supprimer une branche distante"),
        (at + #"gh\s+(?:[\w-]+\s+){1,2}delete\b|\bgh\s+api\b[^;&|\n]*\bDELETE\b"#, "supprimer sur GitHub"),
        (#"\bcurl\b[^;&|\n]*(?:-X\s*|--request[\s=]+)DELETE\b"#, "envoyer une suppression (DELETE)"),
        (#"\brsync\b[^;&|\n]*--(?:delete|remove-source-files)"#, "supprimer des fichiers (rsync)"),
        (at + #"docker\s+(?:\S+\s+)?(?:rm|rmi|prune)\b"#, "supprimer dans Docker"),
        (at + #"(?:truncate|diskutil|newfs\w*)\b"#, "effacer des données"),
        (at + #"dd\b[^;&|\n]*\bof="#, "écraser un fichier (dd)"),
        (at + #"mv\b[^;&|\n]*\s/dev/null\b"#, "supprimer des fichiers"),
        (#"(?:\bos\.(?:remove|unlink|rmdir|removedirs)\b|\bshutil\.rmtree\b|\b(?:rm|unlink|rmdir)Sync\b|\bfs(?:\.promises)?\.(?:rm|unlink|rmdir)\b|\.unlink\(|\bremoveItem\b|\bFile\.delete\b|\bFileUtils\.rm\w*|\bRemove-Item\b)"#, "supprimer des fichiers (script)"),
    ])
    private static let installs = rules([
        (at + #"(?:npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*(?:install|i|add|ci|update|upgrade|up|dlx|x|exec|create|link|uninstall|remove|rm|un)\b"#, "installer des paquets"),
        (at + #"yarn\s*(?:$|[;&|\n])"#, "installer des paquets"),
        (at + #"(?:npx|bunx|pnpx|pipx|uvx)\b"#, "télécharger et lancer un paquet"),
        (at + #"(?:pip|pip3)\s+(?:install|uninstall|download)\b"#, "installer des paquets Python"),
        (#"\bpython[\d.]*\s+-m\s+(?:pip|ensurepip)\b"#, "installer des paquets Python"),
        (at + #"uv\s+(?:pip\s+(?:install|uninstall|sync)|add|sync|remove|tool\s+install)\b"#, "installer des paquets Python"),
        (at + #"(?:poetry|conda|mamba)\s+(?:add|install|update|create|remove)\b"#, "installer des paquets Python"),
        (at + #"brew\s+(?:install|reinstall|upgrade|uninstall|remove|tap|bundle|link|unlink)\b"#, "installer avec Homebrew"),
        (at + #"(?:port|apt|apt-get|dnf|yum|apk|pacman|mas|snap)\s"#, "installer un logiciel"),
        (at + #"cargo\s+(?:install|add|uninstall|update)\b"#, "installer des paquets Rust"),
        (at + #"go\s+(?:install|get)\b"#, "installer des paquets Go"),
        (at + #"(?:gem|bundle|pod|composer|deno)\s+(?:install|update|add|require|uninstall)\b"#, "installer des paquets"),
        (at + #"swift\s+package\s+(?:resolve|update)\b"#, "installer des paquets Swift"),
        (at + #"(?:corepack|installer|softwareupdate|xcode-select)\b"#, "installer un logiciel"),
        (#"\bplaywright\s+install\b"#, "installer un navigateur"),
        (#"\b(?:curl|wget)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b"#, "télécharger et lancer un script"),
        (#"(?:^|[;&|(`{\n]|\$\()\s*sudo\b"#, "agir avec les droits d’administrateur"),
    ])

    /// Ce qu'une commande s'apprête à faire de risqué (`delete` ou `install`, et sa description), ou nil.
    static func risk(_ command: String) -> (kind: String, what: String)? {
        let r = NSRange(command.startIndex..., in: command)
        for (re, what) in deletes where re.firstMatch(in: command, range: r) != nil { return ("delete", what) }
        for (re, what) in installs where re.firstMatch(in: command, range: r) != nil { return ("install", what) }
        return nil
    }

    // MARK: Suppressions chez soi

    private struct Word {
        var text = ""
        var expands = false    // `$`, accent grave, `~` en tête : valeur inconnue d'ici
        var braces = false     // `{` `}` hors guillemets
        var globAt: Int?       // position du premier `*` `?` `[` hors guillemets
    }

    /// Découpe une ligne de shell en commandes (séparées par `;` `&` `|` `(` `)` et retours à la ligne), chacune en mots,
    /// guillemets et `\` résolus, redirections retirées. nil si la ligne contient ce qu'on ne sait pas suivre (`<<`).
    private static func segments(_ command: String) -> [[Word]]? {
        if command.contains("<<") { return nil }
        var out: [[Word]] = [], seg: [Word] = [], w = Word(), has = false, skip = false
        var quote: Character? = nil, escaped = false
        func endWord() {
            if has { if skip { skip = false } else { seg.append(w) } }
            w = Word(); has = false
        }
        func endSeg() { endWord(); if !seg.isEmpty { out.append(seg) }; seg = [] }
        let chars = Array(command)
        var i = 0
        while i < chars.count {
            let ch = chars[i]; i += 1
            if escaped { w.text.append(ch); has = true; escaped = false; continue }
            if quote == "'" { if ch == "'" { quote = nil } else { w.text.append(ch) }; continue }
            if quote == "\"" {
                if ch == "\"" { quote = nil }
                else if ch == "\\", i < chars.count { w.text.append(chars[i]); i += 1 }
                else { if ch == "$" || ch == "`" { w.expands = true }; w.text.append(ch) }
                continue
            }
            switch ch {
            case "\\": escaped = true
            case "'", "\"": quote = ch; has = true
            case " ", "\t": endWord()
            case ";", "&", "|", "(", ")", "\n": endSeg()
            case ">", "<":
                if has, w.text.allSatisfy(\.isNumber) { w = Word(); has = false } else { endWord() }
                while i < chars.count, ">&|".contains(chars[i]) { i += 1 }
                while i < chars.count, chars[i] == " " { i += 1 }
                skip = true
            default:
                if ch == "$" || ch == "`" || (ch == "~" && !has) { w.expands = true }
                if ch == "{" || ch == "}" { w.braces = true }
                if "*?[".contains(ch), w.globAt == nil { w.globAt = w.text.count }
                w.text.append(ch); has = true
            }
        }
        if quote != nil || escaped { return nil }
        endSeg()
        return out
    }

    /// Chemin absolu, `..` et liens symboliques résolus (jusqu'à la partie qui existe), comme le verra la commande.
    static func real(_ path: String) -> String {
        let p = (URL(fileURLWithPath: path).standardizedFileURL.path as NSString)
        if let r = realpath(p.fileSystemRepresentation, nil) { defer { free(r) }; return String(cString: r) }
        let parent = p.deletingLastPathComponent
        guard parent != p as String, !parent.isEmpty else { return p as String }
        return (real(parent) as NSString).appendingPathComponent(p.lastPathComponent)
    }

    private static func resolve(_ path: String, from dir: String) -> String {
        real(path.hasPrefix("/") ? path : (dir as NSString).appendingPathComponent(path))
    }

    /// Le chemin tombe-t-il dans un des dossiers ? Jamais dans un `.git` (le lien de la copie vers son dépôt).
    /// `strict` : le dossier lui-même ne compte pas (`rm -rf .` à la racine de la copie redemande).
    private static func inside(_ path: String, _ roots: [String], strict: Bool) -> Bool {
        guard !path.split(separator: "/").contains(".git") else { return false }
        return roots.contains { path.hasPrefix($0 + "/") || (!strict && path == $0) }
    }

    /// Opérande de `rm` : en clair, ou motif simple (`build/*`, `*.log`) dont le dossier est dans la copie.
    private static func operand(_ w: Word, dir: String, roots: [String]) -> Bool {
        guard !w.expands, !w.braces, !w.text.isEmpty else { return false }
        guard let g = w.globAt else { return inside(resolve(w.text, from: dir), roots, strict: true) }
        let t = Array(w.text)
        let cut = t[..<g].lastIndex(of: "/").map { $0 + 1 } ?? 0
        let last = String(t[cut...])
        // Pas de `.*` (`..` selon le shell), pas de `/` après le motif (un lien vers l'extérieur serait suivi).
        guard !last.hasPrefix("."), !last.contains("/") else { return false }
        let base = cut == 0 ? "." : String(t[..<cut])
        return inside(resolve(base, from: dir), roots, strict: false)
    }

    /// Suppression qui ne touche que le dossier de travail de l'agent : chaque commande risquée de la ligne est un `rm`,
    /// `rmdir`, `unlink`, `trash`, `find … -delete`, `git rm|clean|reset --hard` dont tous les chemins, écrits en clair,
    /// tombent dans `roots`. Les `cd` de la ligne sont suivis. Dans le doute (variable, `~`, `sudo`, `xargs`, script,
    /// branche, remise, `.git`…), non : la demande passe par l'utilisateur comme avant.
    static func local(_ command: String, cwd: String, roots: [String]) -> Bool {
        guard !roots.isEmpty, cwd.hasPrefix("/"), let segs = segments(command) else { return false }
        var dir = real(cwd)
        for seg in segs {
            var ws = seg[...]
            while let f = ws.first, !f.expands, ["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"].contains(f.text) { ws = ws.dropFirst() }
            while let f = ws.first, f.text.range(of: #"^[A-Za-z_]\w*="#, options: .regularExpression) != nil { ws = ws.dropFirst() }
            guard let head = ws.first, !["[", "[["].contains(head.text) else { continue }
            guard !head.expands, !head.braces, head.globAt == nil else { return false }
            let name = (head.text as NSString).lastPathComponent
            let args = Array(ws.dropFirst())
            switch name {
            case "cd", "pushd":
                guard let to = args.first(where: { !$0.text.hasPrefix("-") }), !to.expands, !to.braces, to.globAt == nil else { return false }
                dir = resolve(to.text, from: dir)
            case "rm", "rmdir", "unlink", "trash":
                var opts = true
                for a in args {
                    if opts && a.text == "--" { opts = false; continue }
                    if opts && a.text.hasPrefix("-") && a.text.count > 1 && !a.expands { continue }
                    guard operand(a, dir: dir, roots: roots) else { return false }
                }
            case "find":
                var i = 0, paths: [Word] = []
                while i < args.count, args[i].text.hasPrefix("-"), args[i].text.count > 1, ["-E", "-P", "-X", "-d", "-s", "-x"].contains(args[i].text) { i += 1 }
                if i < args.count, ["-H", "-L"].contains(args[i].text) { return false }
                while i < args.count, !args[i].text.hasPrefix("-"), !["!", "(", ")"].contains(args[i].text) { paths.append(args[i]); i += 1 }
                let expr = args[i...]
                guard !expr.contains(where: { $0.expands || ["-exec", "-execdir", "-ok", "-okdir", "-L", "-follow"].contains($0.text) }) else { return false }
                for p in paths.isEmpty ? [Word(text: ".")] : paths {
                    guard !p.expands, !p.braces, p.globAt == nil, inside(resolve(p.text, from: dir), roots, strict: false) else { return false }
                }
            case "git":
                guard risk(seg.map(\.text).joined(separator: " ")) != nil else { continue }
                var i = 0, at = dir
                while i < args.count, args[i].text.hasPrefix("-") {
                    let o = args[i].text
                    if o == "-C", i + 1 < args.count {
                        let p = args[i + 1]; guard !p.expands, !p.braces, p.globAt == nil else { return false }
                        at = resolve(p.text, from: at); i += 2
                    } else { return false }   // -c, --git-dir, --work-tree… : on ne suit pas
                }
                guard i < args.count, ["rm", "clean", "reset"].contains(args[i].text) else { return false }
                // Les chemins de git restent dans le dépôt de `at` : il suffit que `at` soit dans la copie.
                guard !args[(i + 1)...].contains(where: \.expands), inside(at, roots, strict: false) else { return false }
            default:
                if risk(seg.map(\.text).joined(separator: " ")) != nil { return false }
            }
        }
        return true
    }

    // MARK: Côté agent

    /// Réglages passés à Claude Code (`--settings`) pour un tour : le hook qui soumet chaque commande à ce garde.
    /// Sans serveur possible, le hook refuse toute commande : jamais de terminal sans garde.
    /// `roots` : les dossiers où l'agent supprime sans confirmation (sa copie, celles des autres dépôts) ; vide = partout.
    func settings(run: String, project: String, roots: [String] = []) -> String? {
        var command = "echo 'Studio : garde indisponible, commande refusée.' >&2; exit 2"
        if start() {
            let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            lock.lock(); tokens[token] = (run, project, roots.map(Self.real).filter { $0.count > 1 }); let p = port; lock.unlock()
            command = "r=$(/usr/bin/curl -s -m 570 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:\(p)/garde/\(token)) || r=; "
                + "[ \"$r\" = ok ] && exit 0; echo \"${r:-Studio ne répond pas : commande refusée.}\" >&2; exit 2"
        }
        let hook: [String: Any] = ["matcher": "Bash", "hooks": [["type": "command", "command": command, "timeout": 600]]]
        guard let data = try? JSONSerialization.data(withJSONObject: ["hooks": ["PreToolUse": [hook]]]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Fin d'un tour : son jeton ne vaut plus rien, et ce qu'il attendait encore est refusé.
    func release(run: String) {
        lock.lock()
        tokens = tokens.filter { $0.value.run != run }
        let gone = asks.filter { $0.run == run }
        asks.removeAll { $0.run == run }
        let replies = gone.compactMap { a -> ((String) -> Void)? in let r = a.reply; a.reply = nil; return r }
        lock.unlock()
        for r in replies { r("Tour terminé : commande refusée.") }
        if !gone.isEmpty { signal() }
    }

    // MARK: Côté page

    func list() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["ok": true, "asks": asks.map { a -> [String: Any] in
            ["id": a.id, "run": a.run, "project": a.project, "kind": a.kind, "what": a.what, "command": a.command, "cwd": a.cwd,
             "agent": a.agent, "at": Int(a.at.timeIntervalSince1970 * 1000), "until": Int((a.at.timeIntervalSince1970 + Self.wait) * 1000)]
        }]
    }

    /// Réponse de l'utilisateur. Autoriser demande Touch ID ou le mot de passe du Mac ; sans l'un des deux, rien ne passe.
    func answer(id: String, allow: Bool, done: @escaping ([String: Any]) -> Void) {
        lock.lock(); let ask = asks.first { $0.id == id }; lock.unlock()
        guard let ask else { return done(["ok": false, "message": "Cette demande n’attend plus (déjà traitée, ou délai dépassé)."]) }
        guard allow else {
            settle(ask, "Refusé par l’utilisateur. Ne cherche pas un autre moyen d’y arriver : continue sans, et dis-le dans ton compte rendu.")
            return done(["ok": true])
        }
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            return done(["ok": false, "message": "Ce Mac n’a ni Touch ID ni mot de passe de session : impossible de confirmer."])
        }
        let short = ask.command.count > 120 ? String(ask.command.prefix(120)) + "…" : ask.command
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "autoriser un agent à \(ask.what) : \(short)") { ok, _ in
            guard ok else { return done(["ok": false, "message": "Confirmation annulée : la demande attend toujours."]) }
            self.lock.lock(); let still = self.asks.contains { $0 === ask }; self.lock.unlock()
            guard still else { return done(["ok": false, "message": "Délai dépassé : la commande a déjà été refusée."]) }
            self.settle(ask, "ok")
            done(["ok": true])
        }
    }

    private func settle(_ ask: Ask, _ text: String) {
        lock.lock()
        asks.removeAll { $0 === ask }
        let reply = ask.reply; ask.reply = nil
        lock.unlock()
        reply?(text)
        signal()
    }

    private func signal() { DispatchQueue.main.async { NotificationCenter.default.post(name: Self.changed, object: nil) } }

    // MARK: Serveur (127.0.0.1 seulement)

    private func start() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if listener != nil { return true }
        for candidate in UInt16(47310)..<UInt16(47370) {
            guard let p = NWEndpoint.Port(rawValue: candidate) else { continue }
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host.ipv4(IPv4Address.loopback), port: p)
            guard let l = try? NWListener(using: params) else { continue }
            let ready = DispatchSemaphore(value: 0)
            let result = Outcome()
            l.stateUpdateHandler = { state in
                switch state {
                case .ready: result.ok = true; ready.signal()
                case .failed, .cancelled: ready.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in
                guard let self else { c.cancel(); return }
                c.start(queue: self.queue)
                self.read(c, Data())
            }
            l.start(queue: queue)
            _ = ready.wait(timeout: .now() + 2)
            l.stateUpdateHandler = nil
            if result.ok { listener = l; port = candidate; return true }
            l.cancel()
        }
        return false
    }
    private final class Outcome { var ok = false }

    /// Lit la requête entière (en-tête puis corps annoncé par Content-Length), puis la traite.
    private func read(_ c: NWConnection, _ acc: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { c.cancel(); return }
            var buf = acc
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf.subdata(in: 0..<end.lowerBound), as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                let length = lines.dropFirst().compactMap { l -> Int? in
                    let kv = l.split(separator: ":", maxSplits: 1)
                    return kv.count == 2 && kv[0].lowercased() == "content-length" ? Int(kv[1].trimmingCharacters(in: .whitespaces)) : nil
                }.first ?? 0
                guard length <= Self.maxBody else { return self.send(c, "Commande trop longue pour être vérifiée : refusée.") }
                let body = buf.subdata(in: end.upperBound..<buf.count)
                if body.count >= length { return self.handle(c, request: lines.first ?? "", body: body.prefix(length)) }
            }
            if done || error != nil || buf.count > Self.maxBody + 16_384 { c.cancel() } else { self.read(c, buf) }
        }
    }

    private func handle(_ c: NWConnection, request: String, body: Data) {
        let parts = request.components(separatedBy: " ")
        guard parts.count >= 2, parts[0] == "POST", parts[1].hasPrefix("/garde/") else { return send(c, "Demande refusée.") }
        let token = String(parts[1].dropFirst("/garde/".count))
        lock.lock(); let owner = tokens[token]; let waiting = asks.filter { $0.run == owner?.run }.count; lock.unlock()
        guard let owner else { return send(c, "Tour inconnu de Studio : commande refusée.") }
        guard let o = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return send(c, "Demande illisible : commande refusée.") }
        // Le hook ne vise que Bash ; tout autre outil arrivé ici n'a rien à faire vérifier.
        guard o["tool_name"] as? String == "Bash" else { return send(c, "ok") }
        guard let command = (o["tool_input"] as? [String: Any])?["command"] as? String else { return send(c, "Commande illisible : refusée.") }
        guard let risk = Self.risk(command) else { return send(c, "ok") }
        if risk.kind == "delete", let cwd = o["cwd"] as? String, Self.local(command, cwd: cwd, roots: owner.roots) { return send(c, "ok") }
        guard waiting < Self.maxPerRun else { return send(c, "Trop de confirmations en attente pour cet agent : commande refusée.") }

        let ask = Ask(run: owner.run, project: owner.project, kind: risk.kind, what: risk.what, command: String(command.prefix(4000)),
                      cwd: o["cwd"] as? String ?? "", agent: o["agent_type"] as? String ?? "")
        ask.reply = { [weak self] text in self?.send(c, text) }
        lock.lock(); asks.append(ask); lock.unlock()
        signal()
        Notifier.shared.post(title: ask.kind == "delete" ? "Un agent demande à supprimer" : "Un agent demande à installer",
                             body: String(command.prefix(160)), url: nil, thread: "agents")
        queue.asyncAfter(deadline: .now() + Self.wait) { [weak self] in
            self?.settle(ask, "L’utilisateur n’a pas confirmé à temps. N’essaie pas autrement : continue sans, et dis dans ton compte rendu ce qui reste à faire à la main.")
        }
    }

    private func send(_ c: NWConnection, _ text: String) {
        let body = Data(text.utf8)
        var out = Data("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        out.append(body)
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }
}
#endif
