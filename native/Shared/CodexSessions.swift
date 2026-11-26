// Conversations OpenAI Codex d'un projet (Mac uniquement), lues en local depuis ~/.codex/sessions/ (ou $CODEX_HOME).
// Codex (CLI, extension VS Code, app Codex) écrit chaque fil dans sessions/AAAA/MM/JJ/rollout-<date>-<uuid>.jsonl :
// une première ligne `session_meta` (id, cwd, originator, git), puis des lignes { timestamp, type, payload }.
// Lecture seule et incrémentale, comme ClaudeSessions. Un fil appartient au projet si son dossier de travail est
// le dossier d'un des dépôts du projet (ou un sous-dossier : un « sous-projet » de Codex), ou si son dépôt git en est un.
// Les fils archivés dans Codex (archived_sessions/) ne sont pas montrés.
import Foundation
#if os(macOS)
import AppKit

final class CodexSessions {
    static let shared = CodexSessions()
    /// Préfixe des identifiants rendus à la page : un fil Codex ne se confond jamais avec une session Claude Code.
    static let prefix = "codex:"

    private typealias Action = ClaudeSessions.Action
    private struct Meta { let id: String; let cwd: String; let repo: String; let branch: String; let origin: String; let started: String }
    private final class State {
        var offset: UInt64 = 0
        var started = ""; var updated = ""; var active = ""; var firstPrompt = ""; var lastPrompt = ""
        var models = Set<String>(); var prompts = 0
        var tokIn = 0, tokOut = 0, tokCacheRead = 0
        var tools: [String: Int] = [:]; var files: [String] = []; var added = 0, removed = 0
        /// Messages tirés des `event_msg` (fiables, sans le contexte injecté par Codex) et, à défaut (anciens fichiers),
        /// des `response_item` de type message.
        var events: [Action] = []; var items: [Action] = []; var hasEvents = false; var itemPrompts = 0
        var actions: [Action] = []
    }
    private var metas: [String: Meta] = [:]
    private var states: [String: State] = [:]
    private let queue = DispatchQueue(label: "studio.codex")

    static var home: URL {
        if let h = ProcessInfo.processInfo.environment["CODEX_HOME"], !h.isEmpty { return URL(fileURLWithPath: h, isDirectory: true) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
    }
    static func validID(_ s: String) -> Bool { !s.isEmpty && s.count <= 64 && s.allSatisfy { $0.isHexDigit || $0 == "-" } }

    // MARK: Fichiers

    /// Les journaux les plus récents (le nom porte la date : l'ordre des noms est celui des dates).
    private func recentFiles(limit: Int = 800) -> [URL] {
        let root = Self.home.appendingPathComponent("sessions", isDirectory: true)
        guard let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        var out: [URL] = []
        for case let u as URL in en where u.pathExtension == "jsonl" && u.lastPathComponent.hasPrefix("rollout-") { out.append(u) }
        return Array(out.sorted { $0.lastPathComponent > $1.lastPathComponent }.prefix(limit))
    }
    private func mtime(_ u: URL) -> Date { (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
    private func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

    /// Première ligne du journal (`session_meta`), lue une fois par fichier : elle ne change plus.
    private func meta(_ url: URL) -> Meta? {
        if let m = metas[url.path] { return m }
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        // Les consignes de base peuvent être longues : on lit jusqu'à la première fin de ligne, 2 Mo au plus.
        var buf = Data()
        while buf.count < 2_000_000, let d = try? h.read(upToCount: 65536), !d.isEmpty {
            buf.append(d)
            if let nl = buf.firstIndex(of: 0x0A) { buf = buf[buf.startIndex..<nl]; break }
        }
        guard let e = try? JSONSerialization.jsonObject(with: buf) as? [String: Any] else { return nil }
        // Format actuel { type: "session_meta", payload: {…} } ; ancien format : la méta à plat.
        let p = (e["type"] as? String == "session_meta" ? e["payload"] as? [String: Any] : nil) ?? e
        guard let id = p["id"] as? String, Self.validID(id) else { return nil }
        let git = p["git"] as? [String: Any] ?? [:]
        let m = Meta(id: id, cwd: p["cwd"] as? String ?? "", repo: Self.github(git["repository_url"] as? String ?? ""),
                     branch: git["branch"] as? String ?? "", origin: Self.origin(p["originator"] as? String ?? ""), started: p["timestamp"] as? String ?? e["timestamp"] as? String ?? "")
        metas[url.path] = m
        return m
    }
    static func github(_ url: String) -> String {
        guard let r = url.range(of: #"github\.com[:/]([\w.-]+/[\w.-]+?)(\.git)?/?$"#, options: .regularExpression) else { return "" }
        return String(url[r]).replacingOccurrences(of: #"^github\.com[:/]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(\.git)?/?$"#, with: "", options: .regularExpression).lowercased()
    }
    /// D'où vient le fil : « CLI », « VS Code », « App »…
    static func origin(_ o: String) -> String {
        let l = o.lowercased()
        if l.contains("vscode") { return "VS Code" }
        if l.contains("desktop") || l.contains("app") || l.contains("mac") { return "App" }
        if l.contains("exec") { return "exec" }
        if l.contains("cli") || l.hasPrefix("codex_") { return "CLI" }
        return o.isEmpty ? "" : clipStatic(o, 20)
    }
    private static func clipStatic(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) : s }

    // MARK: Projet

    /// Où le projet vit sur ce Mac : dossiers de ses dépôts (le premier est le dépôt principal) et dépôts GitHub.
    struct Scope { var roots: [String]; var home: String?; var repos: Set<String> }

    /// Sous-projet d'un fil : dépôt (nom du dossier) et sous-dossier, ou nil si le fil n'est pas de ce projet.
    private func sub(_ m: Meta, _ s: Scope) -> String? {
        let cwd = (m.cwd as NSString).standardizingPath
        for r in s.roots.map({ ($0 as NSString).standardizingPath }) {
            let name = (r as NSString).lastPathComponent
            if cwd == r { return name }
            if cwd.hasPrefix(r + "/") {
                let rest = String(cwd.dropFirst(r.count + 1))
                if let w = rest.range(of: ".claude/worktrees/") { return name + " · " + String(rest[w.upperBound...]) }
                return name + "/" + rest
            }
        }
        if let h = s.home, cwd == h { return (h as NSString).lastPathComponent }
        // Copie isolée créée par Codex ailleurs (~/.codex/worktrees…), ou dossier déplacé : reconnue par son dépôt.
        if !m.repo.isEmpty, s.repos.contains(m.repo) { return String(m.repo.split(separator: "/").last ?? "") + (cwd.contains("/.codex/") ? " · copie Codex" : "") }
        return nil
    }

    // MARK: Lecture

    private func refresh(_ url: URL) -> State? {
        if let known = states[url.path],
           let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value,
           size == known.offset { return known }
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let st = states[url.path] ?? State()
        let size = (try? h.seekToEnd()) ?? 0
        if size < st.offset { states[url.path] = State(); return refresh(url) }
        if size == st.offset { states[url.path] = st; return st }
        try? h.seek(toOffset: st.offset)
        let data = h.readDataToEndOfFile()
        guard let lastNL = data.lastIndex(of: 0x0A) else { states[url.path] = st; return st }
        let chunk = data[data.startIndex...lastNL]
        for line in chunk.split(separator: 0x0A) {
            if let e = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] { ingest(e, into: st) }
        }
        st.offset += UInt64(chunk.count)
        st.actions = (st.hasEvents ? st.events : st.items).suffix(120)
        states[url.path] = st
        return st
    }

    /// Texte que Codex ajoute lui-même aux messages de la personne (contexte, AGENTS.md) : pas une demande.
    private static func injected(_ t: String) -> Bool {
        let s = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.hasPrefix("<environment_context>") || s.hasPrefix("<user_instructions>") || s.hasPrefix("# AGENTS.md") || s.hasPrefix("<INSTRUCTIONS>") || s.hasPrefix("<user_shell_command>")
    }
    private func push(_ list: inout [Action], _ a: Action) { list.append(a); if list.count > 160 { list.removeFirst(list.count - 160) } }

    private func ingest(_ e: [String: Any], into st: State) {
        let ts = e["timestamp"] as? String ?? ""
        if !ts.isEmpty { if st.started.isEmpty { st.started = ts }; st.updated = ts }
        let type = e["type"] as? String ?? ""
        let p = e["payload"] as? [String: Any]
        switch type {
        case "session_meta": return
        case "turn_context":
            if let m = p?["model"] as? String, !m.isEmpty { st.models.insert(m) }
        case "event_msg":
            guard let p else { return }
            switch p["type"] as? String ?? "" {
            case "user_message":
                let t = (p["message"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty, !Self.injected(t) else { return }
                // Premier message d'événement : les demandes comptées d'après les `response_item` ne comptent plus.
                if !st.hasEvents { st.prompts = 0 }
                st.hasEvents = true; st.prompts += 1; st.active = ts; st.lastPrompt = clip(t, 300)
                if st.firstPrompt.isEmpty { st.firstPrompt = clip(t, 300) }
                push(&st.events, Action(at: ts, kind: "prompt", text: clip(t, 4000)))
            case "agent_message":
                let t = p["message"] as? String ?? ""
                guard !t.isEmpty else { return }
                st.hasEvents = true; st.active = ts
                push(&st.events, Action(at: ts, kind: "text", text: clip(t, 4000)))
            case "token_count":
                if let info = p["info"] as? [String: Any], let u = info["total_token_usage"] as? [String: Any] {
                    let n = { (k: String) in (u[k] as? Int) ?? (u[k] as? NSNumber)?.intValue ?? 0 }
                    st.tokCacheRead = n("cached_input_tokens"); st.tokIn = max(0, n("input_tokens") - st.tokCacheRead); st.tokOut = n("output_tokens")
                }
            default: return
            }
        case "response_item":
            if let p { item(p, ts, st) }
        default:
            // Ancien format : les éléments de la réponse sont écrits à plat.
            if p == nil, e["role"] != nil || ["function_call", "local_shell_call", "custom_tool_call"].contains(type) { item(e, ts, st) }
        }
    }

    private func item(_ p: [String: Any], _ ts: String, _ st: State) {
        switch p["type"] as? String ?? "" {
        case "message":
            let role = p["role"] as? String ?? ""
            let text = (p["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
            guard !text.isEmpty, role == "user" || role == "assistant" else { return }
            if role == "user" {
                guard !Self.injected(text) else { return }
                st.itemPrompts += 1
                if !st.hasEvents { st.prompts = st.itemPrompts; st.lastPrompt = clip(text, 300); if st.firstPrompt.isEmpty { st.firstPrompt = clip(text, 300) } }
            }
            if !st.hasEvents { st.active = ts }
            push(&st.items, Action(at: ts, kind: role == "user" ? "prompt" : "text", text: clip(text, 4000)))
        case "function_call", "custom_tool_call", "local_shell_call":
            let name = p["name"] as? String ?? (p["type"] as? String == "local_shell_call" ? "shell" : "")
            var args: [String: Any] = [:]
            if let s = p["arguments"] as? String, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { args = o }
            if let a = (p["action"] as? [String: Any]) { args.merge(a) { x, _ in x } }
            let patch = p["input"] as? String ?? args["input"] as? String ?? ""
            if name == "apply_patch" || patch.hasPrefix("*** Begin Patch") {
                tool(st, ts, kind: "Edit", patch: patch)
            } else if ["shell", "exec_command", "container.exec", "local_shell"].contains(name) || p["type"] as? String == "local_shell_call" {
                var cmd = args["cmd"] as? String ?? ""
                if cmd.isEmpty, let c = args["command"] as? [String] { cmd = c.count >= 3 && c[1] == "-lc" ? c[2] : c.joined(separator: " ") }
                if cmd.isEmpty, let c = args["command"] as? String { cmd = c }
                // Une commande qui n'est qu'un patch (ancien Codex) compte comme une écriture.
                if cmd.contains("*** Begin Patch") { tool(st, ts, kind: "Edit", patch: cmd); return }
                st.tools["Bash", default: 0] += 1
                push(&st.items, Action(at: ts, kind: "tool:Bash", text: clip(cmd, 240))); push(&st.events, Action(at: ts, kind: "tool:Bash", text: clip(cmd, 240)))
            } else if !name.isEmpty {
                st.tools[name, default: 0] += 1
                let a = Action(at: ts, kind: "tool:" + name, text: clip(args["query"] as? String ?? args["path"] as? String ?? "", 240))
                push(&st.items, a); push(&st.events, a)
            }
        case "web_search_call":
            st.tools["WebSearch", default: 0] += 1
            let a = Action(at: ts, kind: "tool:WebSearch", text: clip((p["action"] as? [String: Any])?["query"] as? String ?? "", 240))
            push(&st.items, a); push(&st.events, a)
        default: return
        }
    }

    /// Un patch de Codex (*** Update File: …) : fichiers touchés, lignes ajoutées et retirées.
    private func tool(_ st: State, _ ts: String, kind: String, patch: String) {
        var files: [String] = [], add = 0, del = 0
        for l in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            for h in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] where l.hasPrefix(h) { files.append(String(l.dropFirst(h.count))) }
            if l.hasPrefix("+"), !l.hasPrefix("+++") { add += 1 } else if l.hasPrefix("-"), !l.hasPrefix("---") { del += 1 }
        }
        let k = patch.contains("*** Add File: ") && !patch.contains("*** Update File: ") ? "Write" : kind
        st.tools[k, default: 0] += 1; st.added += add; st.removed += del
        for f in files where !st.files.contains(f) { st.files.append(f) }
        if st.files.count > 40 { st.files.removeFirst(st.files.count - 40) }
        var a = Action(at: ts, kind: "tool:" + k, text: clip(files.joined(separator: ", "), 240), add: add, del: del)
        a.file = files.first ?? ""; a.new = clip(patch, 1500)
        push(&st.items, a); push(&st.events, a)
    }

    private func summary(_ url: URL, _ m: Meta, _ st: State, sub: String) -> [String: Any] {
        let title = st.firstPrompt.isEmpty ? "Conversation Codex" : clip(st.firstPrompt.replacingOccurrences(of: "\n", with: " "), 80)
        let started = st.started.isEmpty ? m.started : st.started
        return ["id": Self.prefix + m.id, "engine": "codex", "sub": sub, "origin": m.origin, "cwd": m.cwd,
                "worktree": "", "title": title, "aiTitle": "", "firstPrompt": st.firstPrompt,
                "branch": m.branch, "started": started, "updated": st.updated, "active": st.active.isEmpty ? st.updated : st.active,
                "live": Date().timeIntervalSince(mtime(url)) < 45,
                "models": Array(st.models).sorted(), "prompts": st.prompts, "lastPrompt": st.lastPrompt,
                "tokens": ["input": st.tokIn, "output": st.tokOut, "cacheRead": st.tokCacheRead, "cacheWrite": 0],
                "tools": st.tools, "files": Array(st.files.suffix(15)), "lines": ["add": st.added, "del": st.removed]]
    }

    /// Fichiers du projet, du plus récent au plus ancien, avec leur sous-projet.
    private func matching(_ s: Scope, limit: Int) -> [(URL, Meta, String)] {
        var out: [(URL, Meta, String)] = []
        for f in recentFiles() {
            guard let m = meta(f), let sub = sub(m, s) else { continue }
            out.append((f, m, sub))
            if out.count >= limit { break }
        }
        return out
    }

    /// Fils Codex du projet (40 au plus), les plus récents d'abord. `found` : Codex est présent sur ce Mac.
    func list(_ s: Scope, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            let present = FileManager.default.fileExists(atPath: Self.home.appendingPathComponent("sessions").path)
            guard present else { return done(["ok": true, "found": false, "sessions": []]) }
            var out: [[String: Any]] = []
            for (f, m, sub) in self.matching(s, limit: 40) {
                guard let st = self.refresh(f), st.prompts > 0 else { continue }
                out.append(self.summary(f, m, st, sub: sub))
            }
            out.sort { ($0["active"] as? String ?? "") > ($1["active"] as? String ?? "") }
            done(["ok": true, "found": true, "sessions": out])
        }
    }

    private func find(_ s: Scope, _ session: String) -> (URL, Meta, String)? {
        let id = session.hasPrefix(Self.prefix) ? String(session.dropFirst(Self.prefix.count)) : session
        guard Self.validID(id) else { return nil }
        // Le nom du fichier finit par l'identifiant : pas besoin de lire les autres.
        guard let f = recentFiles(limit: 5000).first(where: { $0.deletingPathExtension().lastPathComponent.hasSuffix(id) }),
              let m = meta(f), let sub = sub(m, s) else { return nil }
        return (f, m, sub)
    }

    /// Fil d'une conversation Codex : ses dernières actions, au même format que les sessions Claude Code.
    func detail(_ s: Scope, session: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let (f, m, sub) = self.find(s, session), let st = self.refresh(f) else { return done(["ok": false, "message": "Conversation Codex introuvable."]) }
            var r = self.summary(f, m, st, sub: sub)
            r["ok"] = true
            r["actions"] = st.actions.suffix(80).map { $0.json }
            r["subagents"] = [Any]()
            done(r)
        }
    }

    // MARK: Reprendre

    /// Reprend le fil : dans le Terminal (`codex resume <id>` dans son dossier) ou dans l'app Codex.
    func open(_ s: Scope, session: String, app: String, fallback dir: String) -> [String: Any] {
        let found: (URL, Meta, String)? = queue.sync { self.find(s, session) }
        guard let (_, m, _) = found else { return ["ok": false, "message": "Conversation Codex introuvable."] }
        let ws = NSWorkspace.shared
        if app == "app" {
            let ids = ["com.openai.codex", "com.openai.codex.desktop", "com.openai.Codex"]
            guard let url = ids.lazy.compactMap({ ws.urlForApplication(withBundleIdentifier: $0) }).first
                    ?? ["/Applications/Codex.app", NSHomeDirectory() + "/Applications/Codex.app"].first(where: { FileManager.default.fileExists(atPath: $0) }).map({ URL(fileURLWithPath: $0) })
            else { return ["ok": false, "message": "L'app Codex n'est pas installée sur ce Mac."] }
            ws.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            return ["ok": true]
        }
        guard let term = ws.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { return ["ok": false, "message": "Terminal introuvable."] }
        var isDir: ObjCBool = false
        let cwd = FileManager.default.fileExists(atPath: m.cwd, isDirectory: &isDir) && isDir.boolValue ? m.cwd : dir
        // Petit script .command ouvert par le Terminal : pas d'AppleScript, donc pas d'autorisation d'automatisation.
        let q = { (x: String) in "'" + x.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let script = """
        #!/bin/zsh -l
        export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/Applications/Codex.app/Contents/Resources"
        cd \(q(cwd)) || exit 1
        command -v codex >/dev/null || { echo "Codex CLI introuvable : npm install -g @openai/codex (ou brew install codex)"; exec $SHELL -l; }
        codex resume \(m.id)
        exec $SHELL -l
        """
        let dirURL = FileManager.default.temporaryDirectory.appendingPathComponent("studio-codex", isDirectory: true)
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        let file = dirURL.appendingPathComponent("codex-\(m.id.prefix(8)).command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        } catch { return ["ok": false, "message": "Impossible de préparer la reprise : \(error.localizedDescription)"] }
        ws.open([file], withApplicationAt: term, configuration: NSWorkspace.OpenConfiguration())
        return ["ok": true]
    }
}
#endif
