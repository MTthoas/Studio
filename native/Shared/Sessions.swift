// Sessions Claude Code d'un projet (Mac uniquement), lues en local depuis ~/.claude/projects/.
// Lecture seule et incrémentale : seules les lignes ajoutées depuis la dernière lecture sont analysées.
// N'est accessible que pour le dossier choisi pour un projet (jamais un chemin fourni par la page).
import Foundation
#if os(macOS)

final class ClaudeSessions {
    static let shared = ClaudeSessions()

    /// `add`/`del` : lignes ajoutées et retirées par une modification de fichier (Edit, Write, MultiEdit), pour le suivi en direct.
    struct Action {
        let at: String; let kind: String; let text: String; var add = 0; var del = 0
        /// Outils d'écriture : fichier touché et extraits avant/après. Délégation (Agent, Task) : destinataire et consigne donnée.
        /// Tous facultatifs et absents du JSON quand ils sont vides, pour ne pas casser les anciens clients.
        var file = ""; var old = ""; var new = ""; var to = ""; var body = ""
        /// Prompt : chemins des images jointes (AgentImages), que la page relit par `agent` / `image`.
        var images: [String] = []
        var json: [String: Any] {
            var d: [String: Any] = ["at": at, "kind": kind, "text": text]
            if add > 0 { d["add"] = add }; if del > 0 { d["del"] = del }
            if !file.isEmpty { d["file"] = file }; if !old.isEmpty { d["old"] = old }; if !new.isEmpty { d["new"] = new }
            if !to.isEmpty { d["to"] = to }; if !body.isEmpty { d["body"] = body }
            if !images.isEmpty { d["images"] = images }
            return d
        }
    }
    /// Lignes ajoutées et retirées par un appel d'outil d'écriture (estimation : lignes de l'ancien et du nouveau texte).
    static func lineDelta(_ name: String, _ input: [String: Any]) -> (add: Int, del: Int) {
        let n = { (s: Any?) -> Int in (s as? String).map { $0.isEmpty ? 0 : $0.split(separator: "\n", omittingEmptySubsequences: false).count } ?? 0 }
        switch name {
        case "Write": return (n(input["content"]), 0)
        case "Edit": return (n(input["new_string"]), n(input["old_string"]))
        case "MultiEdit":
            let edits = input["edits"] as? [[String: Any]] ?? []
            return edits.reduce((0, 0)) { ($0.0 + n($1["new_string"]), $0.1 + n($1["old_string"])) }
        default: return (0, 0)
        }
    }
    final class State {
        var offset: UInt64 = 0
        var title = ""; var branch = ""; var started = ""; var updated = ""; var lastPrompt = ""; var firstPrompt = ""
        /// Heure du dernier vrai échange (demande ou réponse) : sert à ranger les conversations. La date du fichier
        /// et `updated` bougent aussi pour des lignes techniques (titre, résumé…) ajoutées à de vieilles conversations.
        var active = ""
        var models = Set<String>(); var seen = Set<String>()
        var tokIn = 0, tokOut = 0, tokCacheRead = 0, tokCacheWrite = 0, prompts = 0
        var tools: [String: Int] = [:]; var files: [String] = []
        /// Lignes ajoutées et retirées sur toute la session (voir `lineDelta`).
        var added = 0, removed = 0
        /// Lignes ajoutées et retirées par fichier (même estimation), pour le résumé d'un sous-agent.
        var fileLines: [String: (add: Int, del: Int)] = [:]
        /// Consigne complète (la première demande) et dernier texte écrit : consigne et compte rendu d'un sous-agent.
        var firstFull = ""; var lastText = ""
        var actions: [Action] = []
        var quota: [String: Any]?
        var cwd = ""
        /// Tokens écrits par jour (AAAA-MM-JJ), pour les graphiques du projet.
        var daily: [String: Int] = [:]
        /// Journal : toutes les demandes de la personne (pas celles des sous-agents), sans la limite du fil affiché.
        var log: [Action] = []
        /// Journal : par jour local (AAAA-MM-JJ), tokens écrits et fichiers modifiés.
        var dayTokens: [String: Int] = [:]
        var dayFiles: [String: [String]] = [:]
    }
    private var states: [String: State] = [:]
    private let queue = DispatchQueue(label: "studio.sessions")

    /// Dossiers des sessions de Claude Code pour un dossier de projet : le dossier lui-même
    /// et ses copies isolées (worktrees créés par Claude Code dans .claude/worktrees/).
    private func dirs(for project: String) -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects", isDirectory: true)
        // Même règle que Claude Code (`/[^a-zA-Z0-9]/g` → « - », unité UTF-16 par unité) : un dossier au nom accentué
        // (« Projets », « Écriture »…) gardait sinon ses lettres ici, et aucune session de ce projet n'était retrouvée.
        let encoded = String(decoding: project.utf16.map { c -> UInt16 in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ? c : 0x2D
        }, as: UTF16.self)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: home.path)) ?? []
        return names.filter { $0 == encoded || $0.hasPrefix(encoded + "--claude-worktrees-") }
            .map { home.appendingPathComponent($0, isDirectory: true) }
    }
    private func files(for project: String, maxAge: TimeInterval? = nil) -> [URL] {
        let limit = maxAge.map { Date().addingTimeInterval(-$0) } ?? .distantPast
        return dirs(for: project).flatMap { (try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] }
            .filter { $0.pathExtension == "jsonl" && self.mtime($0) > limit }
            .sorted { self.mtime($0) > self.mtime($1) }
    }
    private func mtime(_ u: URL) -> Date { (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
    private func file(_ project: String, _ session: String) -> URL? {
        guard !session.isEmpty, session.count <= 64, session.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return dirs(for: project).map { $0.appendingPathComponent(session + ".jsonl") }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

    private func ingest(_ e: [String: Any], into st: State) {
        let ts = e["timestamp"] as? String ?? ""
        if !ts.isEmpty { if st.started.isEmpty { st.started = ts }; st.updated = ts }
        if let b = e["gitBranch"] as? String, !b.isEmpty { st.branch = b }
        if let q = e["quotaLimits"] as? [String: Any] { st.quota = q }
        if st.cwd.isEmpty, let c = e["cwd"] as? String { st.cwd = c }
        switch e["type"] as? String ?? "" {
        case "ai-title": if let t = e["aiTitle"] as? String { st.title = t }
        case "user":
            guard (e["isMeta"] as? Bool) != true, let m = e["message"] as? [String: Any] else { return }
            // La consigne d'un sous-agent peut être écrite en blocs de texte plutôt qu'en une seule chaîne.
            var content = m["content"] as? String
            if content == nil, (e["isSidechain"] as? Bool) == true, let blocks = m["content"] as? [[String: Any]],
               !blocks.isEmpty, blocks.allSatisfy({ $0["type"] as? String == "text" }) {
                content = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
            }
            guard let c = content else { return }
            // Notes liées scellées : Claude Code garde dans son journal la consigne complète, clair des notes compris
            // (voir Sealed, dans Agents.swift). Rien de ce bloc n'est lu ni renvoyé à la page.
            var shown = c
            if let r = shown.range(of: "\n\n<notes-liees>\n") { shown = String(shown[..<r.lowerBound]) }
            // Images jointes : le bloc qui liste leurs chemins n'est pas affiché ; les chemins vont à la page, qui montre des vignettes.
            let pics = AgentImages.split(shown); shown = pics.text
            let text = shown.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, !text.hasPrefix("<") else { return }
            st.prompts += 1; st.lastPrompt = clip(text, 300)
            if !ts.isEmpty { st.active = ts }
            if st.firstPrompt.isEmpty { st.firstPrompt = st.lastPrompt; st.firstFull = clip(text, 2000) }
            push(st, Action(at: ts, kind: "prompt", text: clip(text, 4000), images: pics.paths))
            if (e["isSidechain"] as? Bool) != true, !ts.isEmpty, !text.hasPrefix("[Request interrupted") {
                st.log.append(Action(at: ts, kind: "prompt", text: clip(text, 6000)))
                if st.log.count > 4000 { st.log.removeFirst(st.log.count - 4000) }
            }
        case "assistant":
            guard let m = e["message"] as? [String: Any] else { return }
            if !ts.isEmpty { st.active = ts }
            let id = m["id"] as? String ?? UUID().uuidString
            if let model = m["model"] as? String, !model.hasPrefix("<") { st.models.insert(model) }
            if !st.seen.contains(id), let u = m["usage"] as? [String: Any] {
                st.seen.insert(id)
                st.tokIn += u["input_tokens"] as? Int ?? 0; st.tokOut += u["output_tokens"] as? Int ?? 0
                st.tokCacheRead += u["cache_read_input_tokens"] as? Int ?? 0; st.tokCacheWrite += u["cache_creation_input_tokens"] as? Int ?? 0
                if ts.count >= 10 { st.daily[String(ts.prefix(10)), default: 0] += u["output_tokens"] as? Int ?? 0 }
                if let d = Self.localDay(ts) { st.dayTokens[d, default: 0] += u["output_tokens"] as? Int ?? 0 }
            }
            for b in m["content"] as? [[String: Any]] ?? [] {
                if b["type"] as? String == "text", let t = b["text"] as? String, !t.isEmpty { st.lastText = clip(t, 4000); push(st, Action(at: ts, kind: "text", text: clip(t, 16000))) }
                if b["type"] as? String == "tool_use", let name = b["name"] as? String {
                    st.tools[name, default: 0] += 1
                    let input = b["input"] as? [String: Any] ?? [:]
                    let path = input["file_path"] as? String ?? input["path"] as? String ?? ""
                    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(name), !path.isEmpty {
                        st.files.removeAll { $0 == path }; st.files.insert(path, at: 0); if st.files.count > 40 { st.files.removeLast() }
                        if let d = Self.localDay(ts) {
                            var list = st.dayFiles[d] ?? []
                            if !list.contains(path) && list.count < 80 { list.append(path); st.dayFiles[d] = list }
                        }
                    }
                    let detail = path.isEmpty ? (input["description"] as? String ?? input["command"] as? String ?? input["pattern"] as? String ?? "") : path
                    let delta = Self.lineDelta(name, input)
                    st.added += delta.add; st.removed += delta.del
                    var a = Action(at: ts, kind: "tool:" + name, text: clip(detail, 240), add: delta.add, del: delta.del)
                    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(name), !path.isEmpty {
                        a.file = path
                        switch name {
                        case "Write": a.new = clip(input["content"] as? String ?? "", 1500)
                        case "Edit": a.old = clip(input["old_string"] as? String ?? "", 1500); a.new = clip(input["new_string"] as? String ?? "", 1500)
                        case "MultiEdit":
                            let edits = (input["edits"] as? [[String: Any]] ?? []).prefix(4)
                            a.old = clip(edits.compactMap { $0["old_string"] as? String }.joined(separator: "\n⋯\n"), 1500)
                            a.new = clip(edits.compactMap { $0["new_string"] as? String }.joined(separator: "\n⋯\n"), 1500)
                        default: a.new = clip(input["new_source"] as? String ?? "", 1500)
                        }
                        let f = st.fileLines[path] ?? (0, 0)
                        st.fileLines[path] = (f.add + delta.add, f.del + delta.del)
                    }
                    if name == "Agent" || name == "Task" {
                        a.to = clip(input["subagent_type"] as? String ?? "", 80); a.body = clip(input["prompt"] as? String ?? "", 4000)
                    }
                    push(st, a)
                }
            }
        default: break
        }
    }
    private func push(_ st: State, _ a: Action) { st.actions.append(a); if st.actions.count > 120 { st.actions.removeFirst(st.actions.count - 120) } }

    /// Met à jour l'état d'une session en lisant seulement la fin ajoutée du fichier.
    private func refresh(_ url: URL) -> State? {
        touched[url.path] = Date()
        // Rien de nouveau dans le fichier (cas le plus fréquent, à chaque rafraîchissement) : on ne l'ouvre même pas.
        if let known = states[url.path],
           let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value,
           size == known.offset { return known }
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let st = states[url.path] ?? State()
        let size = (try? h.seekToEnd()) ?? 0
        if size < st.offset { states[url.path] = State(); return refresh(url) } // fichier réécrit : on repart de zéro
        if size == st.offset { states[url.path] = st; return st }
        try? h.seek(toOffset: st.offset)
        let data = h.readDataToEndOfFile()
        guard let lastNL = data.lastIndex(of: 0x0A) else { states[url.path] = st; return st } // ligne incomplète : on attend
        let chunk = data[data.startIndex...lastNL]
        for line in chunk.split(separator: 0x0A) {
            if let e = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] { ingest(e, into: st) }
        }
        st.offset += UInt64(chunk.count)
        states[url.path] = st
        return st
    }

    /// Dernière lecture de chaque état, et dernier passage du ménage.
    private var touched: [String: Date] = [:]
    private var pruned = Date()

    /// Libère la mémoire des fils qu'on ne regarde plus (au plus une fois par minute) : ceux des sous-agents
    /// restés dix minutes sans lecture, et ceux dont le journal a disparu. Un fil rouvert est simplement relu.
    private func prune() {
        let now = Date()
        guard now.timeIntervalSince(pruned) > 60 else { return }
        pruned = now
        for path in Array(states.keys) {
            let idle = path.contains("/subagents/") && now.timeIntervalSince(touched[path] ?? .distantPast) > 600
            if idle || !FileManager.default.fileExists(atPath: path) { forget(path) }
        }
    }
    private func forget(_ path: String) { states[path] = nil; touched[path] = nil; metas[path] = nil }

    private func summary(_ url: URL, _ st: State) -> [String: Any] {
        let mtime = self.mtime(url)
        let worktree = st.cwd.range(of: "/.claude/worktrees/").map { String(st.cwd[$0.upperBound...]) } ?? ""
        return ["id": url.deletingPathExtension().lastPathComponent, "worktree": worktree, "title": st.title.isEmpty ? (st.lastPrompt.isEmpty ? "Session" : clip(st.lastPrompt, 80)) : st.title,
                "branch": st.branch, "started": st.started, "updated": st.updated, "active": st.active.isEmpty ? st.updated : st.active, "live": Date().timeIntervalSince(mtime) < 45,
                // Titre écrit par Claude Code lui-même (sessions du terminal), et première demande : Studio en tire le nom affiché.
                "aiTitle": st.title, "firstPrompt": st.firstPrompt,
                "models": Array(st.models).sorted(), "prompts": st.prompts, "lastPrompt": st.lastPrompt,
                "tokens": ["input": st.tokIn, "output": st.tokOut, "cacheRead": st.tokCacheRead, "cacheWrite": st.tokCacheWrite],
                "tools": st.tools, "files": Array(st.files.prefix(15)), "lines": ["add": st.added, "del": st.removed]]
    }

    /// Sessions du dossier, les plus récentes d'abord, et l'état de la limite d'utilisation de Claude Code.
    func list(project folder: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            self.prune()
            let files = self.files(for: folder).prefix(25)
            if files.isEmpty { return done(["ok": true, "sessions": [], "found": false]) }
            var out: [[String: Any]] = [], quota: [String: Any]? = nil
            // L'état de la limite n'est écrit que lorsqu'elle est atteinte : on ignore celui dont l'heure de réinitialisation est passée.
            let now = Date().timeIntervalSince1970
            for f in files {
                guard let st = self.refresh(f) else { continue }
                out.append(self.summary(f, st))
                if quota == nil, let q = st.quota, ((q["resetsAt"] as? Double) ?? (q["resetsAt"] as? Int).map(Double.init) ?? 0) > now { quota = q }
            }
            // Dernier échange d'abord (horodatages ISO : l'ordre des chaînes est celui des dates).
            out.sort { ($0["active"] as? String ?? "") > ($1["active"] as? String ?? "") }
            done(["ok": true, "found": true, "sessions": out, "quota": quota ?? NSNull()])
        }
    }

    /// Fil d'une session : ses dernières actions (prompts, réponses, outils).
    func detail(project folder: String, session: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let f = self.file(folder, session), let st = self.refresh(f) else { return done(["ok": false, "message": "Session introuvable."]) }
            var r = self.summary(f, st)
            r["ok"] = true
            r["actions"] = st.actions.suffix(80).map { $0.json }
            r["subagents"] = self.subagents(folder, session)
            done(r)
        }
    }

    // MARK: Sous-agents

    // Claude Code écrit la conversation de chaque sous-agent d'une session dans
    // <session>/subagents/agent-<id>.jsonl, à côté du journal de la session, avec parfois une fiche
    // agent-<id>.meta.json (type d'agent, description de la tâche). Lecture seule, comme le reste.
    private var metas: [String: (type: String, title: String)] = [:]

    private func subagentFiles(_ project: String, _ session: String) -> [URL] {
        guard let f = file(project, session) else { return [] }
        let dir = f.deletingPathExtension().appendingPathComponent("subagents", isDirectory: true)
        return ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter {
                let n = $0.lastPathComponent
                // Les conversations internes de Claude Code (compactage, suggestions) ne sont pas des sous-agents.
                return $0.pathExtension == "jsonl" && n.hasPrefix("agent-") && !n.hasPrefix("agent-acompact") && !n.hasPrefix("agent-aprompt_suggestion")
            }
            .sorted { self.mtime($0) > self.mtime($1) }
    }
    private func agentID(_ url: URL) -> String { String(url.deletingPathExtension().lastPathComponent.dropFirst(6)) }

    private func subSummary(_ url: URL, _ st: State) -> [String: Any] {
        let id = agentID(url)
        var meta = metas[url.path]
        if meta == nil {
            let m = url.deletingLastPathComponent().appendingPathComponent("agent-\(id).meta.json")
            if let d = try? Data(contentsOf: m), d.count < 100_000, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                meta = (type: clip(j["agentType"] as? String ?? "", 40), title: clip((j["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines), 80))
                metas[url.path] = meta
            }
        }
        let title = meta?.title.isEmpty == false ? meta!.title : st.firstPrompt.isEmpty ? "Sous-agent" : clip(st.firstPrompt, 80)
        let live = Date().timeIntervalSince(mtime(url)) < 45
        var r: [String: Any] = ["id": id, "title": title, "type": meta?.type ?? "", "started": st.started, "updated": st.updated,
                "live": live, "tokens": st.tokOut,
                // Détail des tokens du sous-agent (son propre journal : ceux de la session ne les comptent pas).
                "tok": ["input": st.tokIn, "output": st.tokOut, "cacheRead": st.tokCacheRead, "cacheWrite": st.tokCacheWrite],
                "steps": st.tools.values.reduce(0, +),
                "prompt": st.firstFull, "lines": ["add": st.added, "del": st.removed],
                "files": st.files.prefix(15).map { p -> [String: Any] in let l = st.fileLines[p] ?? (0, 0); return ["path": p, "add": l.add, "del": l.del] }]
        // Dernière action, et compte rendu (dernier texte) une fois le sous-agent arrêté.
        if let a = st.actions.last { r["last"] = ["at": a.at, "kind": a.kind, "text": clip(a.text, 240)] }
        if !live, !st.lastText.isEmpty { r["report"] = st.lastText }
        return r
    }

    /// Sous-agents d'une session, dans l'ordre où ils ont été lancés (les 60 plus récents).
    private func subagents(_ project: String, _ session: String) -> [[String: Any]] {
        subagentFiles(project, session).prefix(60)
            .compactMap { f in self.refresh(f).map { self.subSummary(f, $0) } }
            .sorted { ($0["started"] as? String ?? "") < ($1["started"] as? String ?? "") }
    }

    /// Fil d'un sous-agent : sa consigne, ses réponses et ses outils, et la liste de ses voisins dans la session.
    func subagent(project folder: String, session: String, agent: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard !agent.isEmpty, agent.count <= 80, agent.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
                  let f = self.subagentFiles(folder, session).first(where: { self.agentID($0) == agent }),
                  let st = self.refresh(f) else { return done(["ok": false, "message": "Sous-agent introuvable."]) }
            var r = self.summary(f, st)
            r["ok"] = true
            r["agent"] = self.subSummary(f, st)
            r["actions"] = st.actions.suffix(80).map { $0.json }
            r["subagents"] = self.subagents(folder, session)
            done(r)
        }
    }

    /// Supprime une session : son journal part à la corbeille du Mac (récupérable), jamais ailleurs que dans le dossier du projet.
    func delete(project folder: String, session: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let f = self.file(folder, session) else { return done(["ok": false, "message": "Session introuvable."]) }
            do {
                try FileManager.default.trashItem(at: f, resultingItemURL: nil)
                self.forget(f.path)
                // Les fils de ses sous-agents (dossier du même nom, à côté du journal) partent avec elle,
                // et leurs états en mémoire sont libérés tout de suite.
                let side = f.deletingPathExtension()
                for k in Array(self.states.keys) + Array(self.metas.keys) where k.hasPrefix(side.path + "/") { self.forget(k) }
                if FileManager.default.fileExists(atPath: side.path) { try? FileManager.default.trashItem(at: side, resultingItemURL: nil) }
                done(["ok": true])
            } catch { done(["ok": false, "message": "Suppression impossible : \(error.localizedDescription)"]) }
        }
    }

    /// Tokens écrits par jour sur les `days` derniers jours, toutes sessions du projet confondues.
    func daily(project folder: String, days: Int, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            var sum: [String: Int] = [:], sessions: [String: Int] = [:]
            for f in self.files(for: folder, maxAge: TimeInterval(days + 1) * 86400) {
                guard let st = self.refresh(f) else { continue }
                for (d, n) in st.daily { sum[d, default: 0] += n }
                if let d = st.started.split(separator: "T").first { sessions[String(d), default: 0] += 1 }
            }
            done(["ok": true, "tokens": sum, "sessions": sessions])
        }
    }

    // MARK: Journal

    // Jour local (AAAA-MM-JJ) d'un horodatage ISO 8601 de Claude Code (écrit en UTC) : une demande faite à 0 h 30
    // appartient bien à la journée qui commence, pas à la veille.
    private static let isoFrac: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let iso = ISO8601DateFormatter()
    private static let dayFormat: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f }()
    static func localDay(_ ts: String) -> String? {
        guard let d = isoFrac.date(from: ts) ?? iso.date(from: ts) else { return nil }
        return dayFormat.string(from: d)
    }

    /// Chemin d'un fichier modifié, relatif au projet (et à sa copie isolée s'il en vient).
    private func relative(_ path: String, _ dir: String) -> String {
        guard path.hasPrefix(dir + "/") else { return (path as NSString).lastPathComponent }
        var p = String(path.dropFirst(dir.count + 1))
        if p.hasPrefix(".claude/worktrees/"), let slash = p.dropFirst(18).firstIndex(of: "/") { p = String(p[p.index(after: slash)...]) }
        return p
    }

    /// Journal : toutes les demandes faites à Claude Code dans ces projets depuis `since` (jour local inclus),
    /// et l'activité de chaque projet par jour (sessions, tokens écrits, fichiers modifiés).
    func journal(projects: [(id: String, dir: String)], since: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            let start = Self.dayFormat.date(from: since) ?? Date().addingTimeInterval(-30 * 86400)
            let age = min(400 * 86400, max(86400, Date().timeIntervalSince(start) + 2 * 86400))
            var prompts: [[String: Any]] = [], stats: [[String: Any]] = []
            for (pid, dir) in projects {
                var tokens: [String: Int] = [:], files: [String: [String]] = [:], sessions: [String: Set<String>] = [:]
                for f in self.files(for: dir, maxAge: age) {
                    guard let st = self.refresh(f) else { continue }
                    let sid = f.deletingPathExtension().lastPathComponent
                    let worktree = st.cwd.range(of: "/.claude/worktrees/").map { String(st.cwd[$0.upperBound...]) } ?? ""
                    let title = st.title.isEmpty ? self.clip(st.firstPrompt, 80) : st.title
                    for a in st.log {
                        guard let d = Self.localDay(a.at), d >= since else { continue }
                        prompts.append(["at": a.at, "day": d, "text": a.text, "project": pid, "session": sid, "title": title, "worktree": worktree, "branch": st.branch])
                        sessions[d, default: []].insert(sid)
                    }
                    for (d, n) in st.dayTokens where d >= since { tokens[d, default: 0] += n }
                    for (d, list) in st.dayFiles where d >= since {
                        var cur = files[d] ?? []
                        for p in list.map({ self.relative($0, dir) }) where !cur.contains(p) && cur.count < 120 { cur.append(p) }
                        files[d] = cur
                    }
                }
                for d in Set(tokens.keys).union(files.keys).union(sessions.keys) {
                    stats.append(["project": pid, "day": d, "tokens": tokens[d] ?? 0, "files": files[d] ?? [], "sessions": sessions[d]?.count ?? 0])
                }
            }
            done(["ok": true, "prompts": prompts, "stats": stats])
        }
    }

    /// Dernière session ouverte dans une copie isolée (pour y relancer l'agent qui l'a écrite).
    func latest(project folder: String, worktree name: String) -> String? {
        queue.sync {
            let suffix = "/.claude/worktrees/" + name
            for f in self.files(for: folder) {
                guard let st = self.refresh(f), st.cwd.hasSuffix(suffix) else { continue }
                return f.deletingPathExtension().lastPathComponent
            }
            return nil
        }
    }

    /// Dossier de travail d'une session (pour la reprendre au même endroit), s'il appartient bien au projet.
    func cwd(project folder: String, session: String) -> String? {
        queue.sync {
            guard let f = self.file(folder, session), let st = self.refresh(f), !st.cwd.isEmpty else { return nil }
            let real = URL(fileURLWithPath: st.cwd).standardizedFileURL.path
            return real == folder || real.hasPrefix(folder + "/.claude/worktrees/") ? real : nil
        }
    }

    /// Dernière branche Git vue dans une session (pour recréer sa copie isolée si elle a été supprimée).
    func branch(project folder: String, session: String) -> String? {
        queue.sync {
            guard let f = self.file(folder, session), let st = self.refresh(f), !st.branch.isEmpty else { return nil }
            return st.branch
        }
    }
}
#endif
