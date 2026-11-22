// Cockpit d'un projet, côté Mac : analyse en lecture seule des dépôts du projet (paquets et scripts, routes d'API,
// modèles et migrations de la base, variables d'environnement, déploiement, tests) et lancement des scripts qu'ils
// déclarent (onglets Architecture, API, Données, Tests, Environnements).
//
// Garde-fous : l'analyse ne fait que lire des fichiers (un « git ls-files » ciblé en plus), dans une arborescence bornée
// (profondeur, nombre d'entrées, taille des fichiers ; ni liens symboliques, ni node_modules, .git, dist, build…).
// Les fichiers .env ne livrent JAMAIS une valeur, même partielle : seulement le nom de la variable, si elle est renseignée,
// et (pour les fichiers d'exemple) le commentaire de la ligne du dessus. La page ne fournit ni chemin ni commande : elle
// désigne un dépôt par son nom, un paquet par son emplacement relatif et un script par son nom, que le Mac doit retrouver
// lui-même dans l'analyse puis dans le package.json ; la commande est toujours « <npm|pnpm|yarn|bun> run <script> ».
// Lancer un script exécute le code du projet : seul le Mac le demande (« project.stack » n'est pas dans REMOTE_ALLOWED,
// link.ts). Tout s'arrête avec l'app (stopAll). Les réponses sont des types JSON purs (voir « Réponse du Mac non JSON »).
import Foundation
#if os(macOS)

final class Stack {
    static let shared = Stack()
    private let lock = NSLock()
    /// Lancements par projet, puis par clé « dépôt|paquet|script ».
    private var jobs: [String: [String: Job]] = [:]
    /// Analyse gardée quelques secondes par projet (l'onglet se redessine souvent ; « fresh » force la relecture).
    private var cache: [String: (at: Date, repos: [[String: Any]])] = [:]
    private static let cacheSeconds: TimeInterval = 6

    // Limites : l'analyse reste rapide et bornée sur n'importe quel dépôt.
    private static let maxEntries = 15_000, maxDepth = 8, maxFiles = 400, maxFileBytes = 262_144, maxTotalBytes = 8_000_000
    private static let maxRoutes = 300, maxPackages = 40, maxRepos = 12
    private static let skipDirs: Set<String> = ["node_modules", ".git", "dist", "build", ".next", "Pods", "vendor", "target", "__pycache__", "venv",
                                                "coverage", "out", "bower_components", "DerivedData", "storybook-static", "site-packages", "tmp"]

    /// Un lancement de script (en cours, ou terminé et gardé pour qu'on en relise le résultat).
    final class Job {
        let repo: String
        let rel: String
        let script: String
        let tool: String
        let family: String
        let name: String
        let started = Date()
        var ended: Date?
        /// « running », « done », « failed » ou « stopped ».
        var status = "running"
        var code: Int32 = 0
        var log = ""
        var process: Process?
        init(repo: String, rel: String, script: String, tool: String, family: String, name: String) {
            self.repo = repo; self.rel = rel; self.script = script; self.tool = tool; self.family = family; self.name = name
        }
        var key: String { "\(repo)|\(rel)|\(script)" }
    }

    // MARK: Entrée du pont

    /// Action `project` / `stack` : `op` absent = état ; `run` `{ repo, rel, script, name }` ; `stop` `{ repo, rel, script }` ;
    /// `clear` `{ repo, rel, script }` oublie un lancement fini. `fresh: true` relit les dépôts sans attendre la fin du cache.
    func handle(pid: String, body: [String: Any]) -> [String: Any] {
        let repo = body["repo"] as? String ?? "", rel = body["rel"] as? String ?? "", script = body["script"] as? String ?? ""
        switch body["op"] as? String ?? "" {
        case "run":
            let r = run(pid, repo: repo, rel: rel, script: script, name: body["name"] as? String ?? "")
            return r["ok"] as? Bool == false ? r : state(pid, fresh: false)
        case "stop":
            stop(pid, repo: repo, rel: rel, script: script)
            return state(pid, fresh: false)
        case "clear":
            lock.lock()
            if let j = jobs[pid]?["\(repo)|\(rel)|\(script)"], j.status != "running" { jobs[pid]?["\(repo)|\(rel)|\(script)"] = nil }
            lock.unlock()
            return state(pid, fresh: false)
        default:
            return state(pid, fresh: body["fresh"] as? Bool == true)
        }
    }

    /// Forme de la réponse d'état :
    /// `{ ok, folder, at, repos: [dépôt], runs: { "dépôt|paquet|script": lancement }, alerts: [alerte] }`.
    func state(_ pid: String, fresh: Bool) -> [String: Any] {
        guard ProjectFolders.shared.path(pid) != nil else { return ["ok": true, "folder": false, "repos": [[String: Any]](), "runs": [String: Any](), "alerts": [[String: Any]]()] }
        let repos = analysis(pid, fresh: fresh)
        var alerts: [[String: Any]] = []
        for r in repos {
            let name = r["name"] as? String ?? ""
            for a in (r["env"] as? [String: Any])?["alerts"] as? [[String: Any]] ?? [] {
                var x = a; x["repo"] = name; alerts.append(x)
            }
        }
        var out: [String: Any] = ["ok": true, "folder": true, "at": Int(Date().timeIntervalSince1970 * 1000), "repos": repos, "alerts": alerts]
        var runs: [String: Any] = [:]
        lock.lock()
        for (k, j) in jobs[pid] ?? [:] { runs[k] = info(j) }
        lock.unlock()
        out["runs"] = runs
        return out
    }

    // MARK: Dépôts du projet

    private struct RepoRef { let name: String; let role: String; let dir: String; let main: Bool }

    /// Le dépôt principal puis les autres dépôts retrouvés sur ce Mac (aides de ProjectFolders, jamais recopiées).
    private func repoRefs(_ pid: String) -> [RepoRef] {
        let folders = ProjectFolders.shared
        guard let main = folders.path(pid) else { return [] }
        let declared = folders.repos(pid)
        let remote = folders.remote(main)
        let mainName = remote ?? declared.first?.name ?? (main as NSString).lastPathComponent
        let mainRole = declared.first(where: { $0.name.lowercased() == mainName.lowercased() })?.role ?? ""
        var out = [RepoRef(name: mainName, role: mainRole, dir: main, main: true)]
        for f in folders.otherRepos(pid).found where out.count < Self.maxRepos { out.append(RepoRef(name: f.repo.name, role: f.repo.role, dir: f.dir, main: false)) }
        return out
    }

    private func analysis(_ pid: String, fresh: Bool) -> [[String: Any]] {
        lock.lock()
        if !fresh, let c = cache[pid], Date().timeIntervalSince(c.at) < Self.cacheSeconds { lock.unlock(); return c.repos }
        lock.unlock()
        let tilde = { (p: String) in p.replacingOccurrences(of: NSHomeDirectory(), with: "~") }
        var out: [[String: Any]] = []
        for r in repoRefs(pid) {
            var d = Self.analyze(r.dir)
            d["name"] = r.name; d["role"] = r.role; d["path"] = tilde(r.dir); d["main"] = r.main
            out.append(d)
        }
        lock.lock(); cache[pid] = (Date(), out); lock.unlock()
        return out
    }

    // MARK: Arborescence

    private struct Entry { let rel: String; let name: String; let dir: Bool; let size: Int; let mtime: Double }
    private struct Tree {
        var entries: [Entry] = []
        var kids: [String: [Entry]] = [:]
        var paths: Set<String> = []
        var sizes: [String: Int] = [:]
        var truncated = false
        func has(_ rel: String) -> Bool { paths.contains(rel) }
        func children(_ rel: String) -> [Entry] { kids[rel] ?? [] }
    }

    private static func walk(_ root: String) -> Tree {
        let fm = FileManager.default
        var t = Tree()
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
        func visit(_ rel: String, _ depth: Int) {
            let dir = rel.isEmpty ? root : root + "/" + rel
            guard let items = try? fm.contentsOfDirectory(at: URL(fileURLWithPath: dir, isDirectory: true), includingPropertiesForKeys: keys, options: []) else { return }
            for u in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                if t.entries.count >= maxEntries { t.truncated = true; return }
                let name = u.lastPathComponent
                let v = try? u.resourceValues(forKeys: Set(keys))
                if v?.isSymbolicLink == true { continue }
                let isDir = v?.isDirectory == true
                let r = rel.isEmpty ? name : rel + "/" + name
                if isDir && (skipDirs.contains(name) || (name.hasPrefix(".") && name != ".github")) { continue }
                let e = Entry(rel: r, name: name, dir: isDir, size: v?.fileSize ?? 0, mtime: v?.contentModificationDate?.timeIntervalSince1970 ?? 0)
                t.entries.append(e); t.kids[rel, default: []].append(e); t.paths.insert(r); t.sizes[r] = e.size
                if isDir && depth < maxDepth { visit(r, depth + 1) }
            }
        }
        visit("", 1)
        return t
    }

    private static func read(_ root: String, _ tree: Tree, _ rel: String, max: Int = maxFileBytes) -> String? {
        guard let size = tree.sizes[rel], size <= max, let d = FileManager.default.contents(atPath: rel.isEmpty ? root : root + "/" + rel) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }
    private static func json(_ root: String, _ tree: Tree, _ rel: String, max: Int = 2_000_000) -> [String: Any]? {
        guard let size = tree.sizes[rel], size <= max, let d = FileManager.default.contents(atPath: root + "/" + rel) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }
    private static func parent(_ rel: String) -> String { (rel as NSString).deletingLastPathComponent }
    private static func join(_ dir: String, _ name: String) -> String { dir.isEmpty ? name : dir + "/" + name }
    private static func ms(_ t: Double) -> Int { Int(t * 1000) }

    // MARK: Expressions régulières

    private static func rx(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: o) }
    /// Chaque correspondance sous forme de groupes (le 0 est le texte entier ; « » pour un groupe absent).
    private static func all(_ re: NSRegularExpression, _ s: String, limit: Int = 400) -> [[String]] {
        let ns = s as NSString
        var out: [[String]] = []
        re.enumerateMatches(in: s, range: NSRange(location: 0, length: ns.length)) { m, _, stop in
            guard let m = m else { return }
            var g: [String] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                g.append(r.location == NSNotFound ? "" : ns.substring(with: r))
            }
            out.append(g)
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }
    private static func first(_ re: NSRegularExpression, _ s: String) -> [String]? { all(re, s, limit: 1).first }
    private static func lines(_ s: String) -> [String] {
        s.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\r")) }
    }
    private static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }
    private static func indent(_ l: String) -> Int { l.prefix(while: { $0 == " " || $0 == "\t" }).count }

    // MARK: Paquets

    private struct Pkg {
        var rel: String
        var kind: String
        var name: String
        var deps: Set<String>
        var role: String
        var info: [String: Any]
    }

    private static let nodeTech: [(String, String)] = [
        ("next", "Next.js"), ("expo", "Expo"), ("react-native", "React Native"), ("nuxt", "Nuxt"), ("astro", "Astro"), ("@sveltejs/kit", "SvelteKit"),
        ("@remix-run/react", "Remix"), ("gatsby", "Gatsby"), ("@nestjs/core", "NestJS"), ("express", "Express"), ("fastify", "Fastify"), ("hono", "Hono"),
        ("koa", "Koa"), ("@trpc/server", "tRPC"), ("@apollo/server", "Apollo"), ("graphql-yoga", "GraphQL Yoga"), ("@angular/core", "Angular"),
        ("vite", "Vite"), ("react", "React"), ("vue", "Vue"), ("svelte", "Svelte"), ("electron", "Electron"), ("react-scripts", "Create React App"),
        ("prisma", "Prisma"), ("@prisma/client", "Prisma"), ("drizzle-orm", "Drizzle"), ("typeorm", "TypeORM"), ("mongoose", "Mongoose"),
        ("sequelize", "Sequelize"), ("knex", "Knex"), ("@supabase/supabase-js", "Supabase"), ("firebase", "Firebase"), ("pg", "Postgres"),
        ("mysql2", "MySQL"), ("redis", "Redis"), ("ioredis", "Redis"),
    ]
    private static let webTech: Set<String> = ["Next.js", "Nuxt", "Astro", "SvelteKit", "Remix", "Gatsby", "Angular", "Create React App"]
    private static let apiTech: Set<String> = ["NestJS", "Express", "Fastify", "Hono", "Koa", "tRPC", "Apollo", "GraphQL Yoga", "FastAPI", "Django", "Flask", "Gin", "Echo", "Chi", "Fiber", "Axum", "Actix", "Rails", "Sinatra", "Laravel", "Symfony", "Vapor"]
    private static let dbTech: Set<String> = ["Prisma", "Drizzle", "TypeORM", "Mongoose", "Sequelize", "Knex", "Supabase", "Firebase", "Postgres", "MySQL", "Redis", "SQLAlchemy", "Alembic"]
    private static let ports: [String: Int] = ["Next.js": 3000, "Nuxt": 3000, "Astro": 4321, "SvelteKit": 5173, "Remix": 5173, "Vite": 5173, "NestJS": 3000, "Express": 3000,
                                               "Fastify": 3000, "Hono": 3000, "Koa": 3000, "Expo": 8081, "Create React App": 3000, "Angular": 4200, "Gatsby": 8000,
                                               "FastAPI": 8000, "Django": 8000, "Flask": 5000, "Rails": 3000, "Laravel": 8000]
    private static let portInScript = rx(#"(?:--port|-p)[ =](\d{2,5})|\bPORT=(\d{2,5})"#)

    /// Famille d'un script : dev, build, test, quality, data ou other.
    static func family(_ n: String) -> String {
        let s = n.lowercased()
        let head = s.split(whereSeparator: { ":._-".contains($0) }).first.map(String.init) ?? s
        if ["migrate", "migration", "migrations", "seed", "db", "database", "prisma", "drizzle", "knex", "typeorm", "sequelize", "schema", "supabase"].contains(head) { return "data" }
        if ["test", "tests", "e2e", "vitest", "jest", "playwright", "cypress", "spec", "coverage", "mocha"].contains(head) || s.contains("e2e") { return "test" }
        if ["lint", "typecheck", "tsc", "types", "format", "prettier", "check", "validate", "eslint", "biome", "stylelint", "verify"].contains(head) || s == "type-check" { return "quality" }
        if head == "build" || ["compile", "bundle", "package", "export"].contains(head) { return "build" }
        if ["dev", "start", "serve", "watch", "preview", "storybook", "develop", "run"].contains(head) { return "dev" }
        return "other"
    }
    /// Scripts qui détruisent ou publient : la page demande une confirmation avant de les lancer.
    static func risky(_ name: String, _ command: String) -> Bool {
        let s = (name + " " + command).lowercased()
        return s.range(of: #"\b(reset|drop|wipe|truncate|destroy|prod|production|deploy|publish|release|force)\b|migrate[ :._-]*deploy|--force|rm -rf"#, options: .regularExpression) != nil
    }

    private static func toolFor(_ rel: String, _ tree: Tree, _ declared: String) -> String {
        var cur = rel
        while true {
            for (f, t) in [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun"), ("package-lock.json", "npm")] where tree.has(join(cur, f)) { return t }
            if cur.isEmpty { break }
            cur = parent(cur)
        }
        let d = declared.split(separator: "@").first.map(String.init) ?? ""
        return ["pnpm", "yarn", "bun", "npm"].contains(d) ? d : "npm"
    }

    private func discover(_ root: String, _ tree: Tree) -> [Pkg] {
        var out: [Pkg] = []
        var dirs: [String: [String]] = [:]
        let manifests: Set<String> = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pubspec.yaml", "Package.swift"]
        for e in tree.entries where !e.dir && manifests.contains(e.name) {
            let d = Self.parent(e.rel)
            if d.split(separator: "/").count > 4 { continue }
            dirs[d, default: []].append(e.name)
        }
        for d in dirs.keys.sorted() {
            let names = dirs[d] ?? []
            if out.count >= Self.maxPackages { break }
            if names.contains("package.json"), let p = Self.nodePackage(root, tree, d) { out.append(p) }
            if let p = Self.otherPackage(root, tree, d, names) { out.append(p) }
        }
        // Liens entre paquets du dépôt : un paquet qui dépend d'un autre (workspace).
        let byName = Dictionary(out.filter { !$0.name.isEmpty }.map { ($0.name, $0.rel) }, uniquingKeysWith: { a, _ in a })
        for i in out.indices {
            let uses = out[i].deps.compactMap { byName[$0] }.filter { $0 != out[i].rel }.sorted()
            out[i].info["uses"] = Array(uses.prefix(12))
        }
        return out
    }

    private static func nodePackage(_ root: String, _ tree: Tree, _ rel: String) -> Pkg? {
        guard let pkg = json(root, tree, join(rel, "package.json")) else { return nil }
        let name = pkg["name"] as? String ?? ""
        var deps = Set<String>()
        for k in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] { if let d = pkg[k] as? [String: Any] { deps.formUnion(d.keys) } }
        var tech: [String] = []
        for (dep, label) in nodeTech where deps.contains(dep) && !tech.contains(label) { tech.append(label) }
        let scriptMap = pkg["scripts"] as? [String: Any] ?? [:]
        var families: [String: [[String: Any]]] = ["dev": [], "build": [], "test": [], "quality": [], "data": [], "other": []]
        let tool = toolFor(rel, tree, pkg["packageManager"] as? String ?? "")
        for n in scriptMap.keys.sorted() {
            guard let cmd = scriptMap[n] as? String, n.count <= 80 else { continue }
            let fam = family(n)
            if (families[fam]?.count ?? 0) >= 30 { continue }
            families[fam, default: []].append(["name": n, "command": clip(cmd, 200), "run": "\(tool) run \(n)", "risky": risky(n, cmd)])
        }
        // « build » et « dev » d'abord dans leur famille.
        for f in ["dev", "build"] {
            families[f]?.sort { a, b in
                let x = a["name"] as? String ?? "", y = b["name"] as? String ?? ""
                return x == f ? true : y == f ? false : x < y
            }
        }
        var port = 0
        for s in families["dev"] ?? [] {
            if let g = first(portInScript, s["command"] as? String ?? ""), let n = Int(g[1].isEmpty ? g[2] : g[1]) { port = n; break }
        }
        if port == 0 { port = tech.compactMap { ports[$0] }.first ?? 0 }
        var node = ""
        for f in [join(rel, ".nvmrc"), ".nvmrc", join(rel, ".node-version"), ".node-version"] where tree.has(f) {
            node = clip((read(root, tree, f, max: 200) ?? "").trimmingCharacters(in: .whitespacesAndNewlines), 20); break
        }
        if node.isEmpty, let eng = pkg["engines"] as? [String: Any], let n = eng["node"] as? String { node = clip(n, 24) }
        // Rôle probable : mobile, puis cadre web, puis serveur, puis bibliothèque d'après le nom du dossier.
        var role = "lib"
        let path = rel.lowercased()
        if tech.contains("Expo") || tech.contains("React Native") { role = "mobile" }
        else if tech.contains(where: { webTech.contains($0) }) { role = "site" }
        else if tech.contains(where: { apiTech.contains($0) }) { role = "api" }
        else if tech.contains("Vite") || tech.contains("React") || tech.contains("Vue") || tech.contains("Svelte") { role = "site" }
        else if path.contains("api") || path.contains("server") || path.contains("backend") { role = "api" }
        else if !(families["dev"] ?? []).isEmpty { role = "app" }
        var info: [String: Any] = [
            "rel": rel, "name": name, "kind": "node", "tool": tool, "frameworks": tech.filter { !dbTech.contains($0) }, "data": tech.filter { dbTech.contains($0) },
            "role": role, "node": node, "port": port, "scripts": families, "runnable": true,
        ]
        if let ws = pkg["workspaces"] { info["workspace"] = ws is [Any] || ws is [String: Any] }
        return Pkg(rel: rel, kind: "node", name: name, deps: deps, role: role, info: info)
    }

    private static func otherPackage(_ root: String, _ tree: Tree, _ rel: String, _ names: [String]) -> Pkg? {
        func has(_ n: String) -> Bool { names.contains(n) }
        var kind = "", tool = "", tech: [String] = [], text = "", mod = ""
        if has("pyproject.toml") || has("requirements.txt") {
            kind = "python"
            text = (read(root, tree, join(rel, "pyproject.toml")) ?? "") + "\n" + (read(root, tree, join(rel, "requirements.txt")) ?? "")
            tool = tree.has(join(rel, "poetry.lock")) ? "poetry" : tree.has(join(rel, "uv.lock")) ? "uv" : tree.has(join(rel, "Pipfile")) ? "pipenv" : "pip"
            let lower = text.lowercased()
            for (k, v) in [("fastapi", "FastAPI"), ("django", "Django"), ("flask", "Flask"), ("sqlalchemy", "SQLAlchemy"), ("alembic", "Alembic"), ("celery", "Celery"), ("pytest", "pytest")]
            where lower.range(of: #"(^|[\s"'\[,=<>~^-])"# + k + #"([\s"'\],=<>~^\[-]|$)"#, options: .regularExpression) != nil { tech.append(v) }
        } else if has("go.mod") {
            kind = "go"; tool = "go"
            text = read(root, tree, join(rel, "go.mod")) ?? ""
            mod = first(rx(#"(?m)^module\s+(\S+)"#), text)?[1] ?? ""
            for (k, v) in [("gin-gonic/gin", "Gin"), ("labstack/echo", "Echo"), ("go-chi/chi", "Chi"), ("gofiber/fiber", "Fiber"), ("gorilla/mux", "Gorilla")] where text.contains(k) { tech.append(v) }
        } else if has("Cargo.toml") {
            kind = "rust"; tool = "cargo"
            text = read(root, tree, join(rel, "Cargo.toml")) ?? ""
            for (k, v) in [("axum", "Axum"), ("actix-web", "Actix"), ("rocket", "Rocket"), ("tokio", "Tokio"), ("sqlx", "SQLx"), ("diesel", "Diesel")] where text.contains(k) { tech.append(v) }
        } else if has("Gemfile") {
            kind = "ruby"; tool = "bundler"
            text = read(root, tree, join(rel, "Gemfile")) ?? ""
            for (k, v) in [("rails", "Rails"), ("sinatra", "Sinatra"), ("rspec", "RSpec")] where text.range(of: #"gem ['"]"# + k + #"['"]"#, options: .regularExpression) != nil { tech.append(v) }
        } else if has("composer.json") {
            kind = "php"; tool = "composer"
            text = read(root, tree, join(rel, "composer.json")) ?? ""
            for (k, v) in [("laravel/framework", "Laravel"), ("symfony/", "Symfony"), ("phpunit", "PHPUnit")] where text.contains(k) { tech.append(v) }
        } else if has("pubspec.yaml") {
            kind = "dart"; tool = "pub"
            text = read(root, tree, join(rel, "pubspec.yaml")) ?? ""
            if text.contains("flutter:") { tech.append("Flutter") }
        } else if has("Package.swift") {
            kind = "swift"; tool = "swiftpm"
            text = read(root, tree, join(rel, "Package.swift")) ?? ""
            if text.contains("vapor") { tech.append("Vapor") }
        }
        guard !kind.isEmpty else { return nil }
        var role = "lib"
        if tech.contains("Flutter") { role = "mobile" } else if tech.contains(where: { apiTech.contains($0) }) { role = "api" } else if rel.lowercased().contains("api") { role = "api" }
        let port = tech.compactMap { ports[$0] }.first ?? 0
        let info: [String: Any] = ["rel": rel, "name": mod, "kind": kind, "tool": tool, "frameworks": tech.filter { !dbTech.contains($0) }, "data": tech.filter { dbTech.contains($0) },
                                   "role": role, "node": "", "port": port, "scripts": [String: Any](), "runnable": false, "uses": [String]()]
        return Pkg(rel: rel, kind: kind, name: mod, deps: [], role: role, info: info)
    }

    // MARK: Analyse d'un dépôt

    static func analyze(_ root: String) -> [String: Any] {
        let tree = walk(root)
        let me = Stack.shared
        let pkgs = me.discover(root, tree)
        let sources = scanSources(root, tree, pkgs)
        var out: [String: Any] = ["packages": pkgs.map { $0.info }, "truncated": tree.truncated]
        out["git"] = FileManager.default.fileExists(atPath: root + "/.git")
        let deploy = deployFiles(root, tree)
        out["deploy"] = deploy.files
        out["hosts"] = deploy.hosts
        out["workflows"] = workflows(root, tree)
        out["api"] = api(root, tree, sources.routes)
        out["data"] = data(root, tree, pkgs)
        out["env"] = env(root, tree, used: sources.envUsed)
        out["tests"] = tests(root, tree, pkgs)
        out["compose"] = deploy.compose
        return out
    }

    // MARK: Sources : routes et variables lues

    private static let srcExt: Set<String> = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "py", "go", "rb", "php", "java", "kt"]
    private static let testDir: Set<String> = ["test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "fixtures", "mocks", "__mocks__", "docs", "examples", "example", "stories"]
    private static let jsRoute = rx(#"\b(app|router|route|routes|server|fastify|hono|r|v\d+|\w+Router|\w+Routes?|\w+App)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])(/[^'"`\s]*|\*)\3"#)
    private static let jsChain = rx(#"\.route\(\s*(['"`])(/[^'"`\s]*)\1\s*\)\s*\.(get|post|put|patch|delete|all)\b"#)
    private static let nestRoute = rx(#"@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)"#)
    private static let nestCtrl = rx(#"@Controller\(\s*(?:['"`]([^'"`]*)['"`])?"#)
    private static let pyRoute = rx(#"@\w+\.(get|post|put|patch|delete|head|options)\(\s*(?:path\s*=\s*)?['"]([^'"]*)['"]"#)
    private static let flaskRoute = rx(#"@\w+\.route\(\s*['"]([^'"]+)['"]([^)]*)\)"#)
    private static let pyPrefix = rx(#"APIRouter\([^)]*prefix\s*=\s*['"]([^'"]*)['"]"#)
    private static let djangoPath = rx(#"\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]"#)
    private static let ginRoute = rx(#"\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\(\s*"(/[^"]*)""#)
    private static let chiRoute = rx(#"\b\w+\.(Get|Post|Put|Patch|Delete|Head|Options)\(\s*"(/[^"]*)""#)
    private static let goHandle = rx(#"\bHandle(?:Func)?\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(/[^"]*)""#)
    private static let railsRoute = rx(#"(?m)^\s*(get|post|put|patch|delete)\s+['"]/?([^'"]+)['"]"#)
    private static let railsRes = rx(#"(?m)^\s*resources?\s+:(\w+)"#)
    private static let laravelRoute = rx(#"Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]"#)
    private static let springRoute = rx(#"@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?\{?\s*["']([^"']*)["']"#)
    private static let springBase = rx(#"@RequestMapping\(\s*(?:value\s*=\s*)?\{?\s*["']([^"']*)["']"#)
    private static let exportedVerb = rx(#"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b"#)
    private static let envUse = [
        rx(#"process\.env\.([A-Z][A-Z0-9_]{2,})"#), rx(#"process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]"#), rx(#"import\.meta\.env\.([A-Z][A-Z0-9_]{2,})"#),
        rx(#"os\.environ(?:\.get)?[\[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]"#), rx(#"os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]"#), rx(#"os\.Getenv\(\s*"([A-Z][A-Z0-9_]{2,})""#),
        rx(#"ENV(?:\.fetch)?[\[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]"#), rx(#"\benv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]"#),
    ]
    private static let envIgnore: Set<String> = ["NODE_ENV", "CI", "PATH", "HOME", "PWD", "USER", "SHELL", "TERM", "DEBUG", "LANG", "TZ", "PORT", "HOST", "HOSTNAME", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "NEXT_RUNTIME", "NEXT_PHASE", "MODE", "DEV", "PROD", "BASE_URL", "SSR"]

    private static func isTestFile(_ rel: String, _ name: String) -> Bool {
        let n = name.lowercased()
        if n.range(of: #"\.(test|spec|cy|e2e)\.[a-z]+$"#, options: .regularExpression) != nil { return true }
        if n.hasSuffix("_test.go") || n.hasSuffix("_spec.rb") || n.hasSuffix("_test.rb") || n.hasSuffix("_test.dart") || n.hasSuffix("_test.py") { return true }
        if n.hasPrefix("test_") && n.hasSuffix(".py") { return true }
        if n.hasSuffix("tests.swift") || n.hasSuffix("test.swift") || n.hasSuffix("test.php") || n.hasSuffix("test.java") || n.hasSuffix("test.kt") { return true }
        let comps = rel.lowercased().split(separator: "/").dropLast()
        if comps.contains("__tests__") { return srcExt.contains((name as NSString).pathExtension.lowercased()) }
        return false
    }

    private static func joinPath(_ a: String, _ b: String) -> String {
        var p = ("/" + a + "/" + b).replacingOccurrences(of: #"/{2,}"#, with: "/", options: .regularExpression)
        if p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }
    private static func route(_ method: String, _ path: String, _ source: String, _ summary: String = "") -> [String: Any]? {
        guard !path.contains("${"), path.count <= 200 else { return nil }
        let p = path.hasPrefix("/") || path == "*" ? path : "/" + path
        var r: [String: Any] = ["method": method.uppercased() == "ALL" || method.uppercased() == "ANY" ? "*" : method.uppercased(), "path": p, "source": source,
                                "params": p.range(of: #"[:{<\[*]"#, options: .regularExpression) != nil]
        if !summary.isEmpty { r["summary"] = clip(summary, 120) }
        return r
    }
    /// Segment de dossier Next/SvelteKit/Nuxt → segment d'URL : « [id] » devient « :id », « (groupe) » disparaît.
    private static func segments(_ parts: [String]) -> String {
        var out: [String] = []
        for s in parts {
            if s.hasPrefix("(") && s.hasSuffix(")") { continue }
            if s.hasPrefix("@") { continue }
            if s.hasPrefix("[[...") || s.hasPrefix("[...") { out.append(":" + s.trimmingCharacters(in: CharacterSet(charactersIn: "[].")) + "*"); continue }
            if s.hasPrefix("[") && s.hasSuffix("]") { out.append(":" + s.dropFirst().dropLast()); continue }
            out.append(s)
        }
        return "/" + out.joined(separator: "/")
    }

    private struct Sources { var routes: [[String: Any]]; var envUsed: Set<String> }

    private static func scanSources(_ root: String, _ tree: Tree, _ pkgs: [Pkg]) -> Sources {
        var routes: [[String: Any]] = []
        var seen = Set<String>()
        var used = Set<String>()
        func add(_ r: [String: Any]?) {
            guard let r = r, routes.count < maxRoutes else { return }
            let k = "\(r["method"] as? String ?? "")|\(r["path"] as? String ?? "")|\(r["source"] as? String ?? "")"
            if seen.insert(k).inserted { routes.append(r) }
        }
        // Routes portées par l'arborescence : Next (app/**/route.ts, pages/api/**), SvelteKit (+server.ts), Nuxt (server/api).
        var candidates: [(score: Int, e: Entry)] = []
        for e in tree.entries where !e.dir {
            let ext = (e.name as NSString).pathExtension.lowercased()
            guard srcExt.contains(ext) else { continue }
            let comps = e.rel.split(separator: "/").map(String.init)
            let dirs = Array(comps.dropLast())
            if e.name.hasSuffix(".d.ts") || e.name.contains(".min.") || isTestFile(e.rel, e.name) || dirs.contains(where: { testDir.contains($0.lowercased()) }) { continue }
            let base = (e.name as NSString).deletingPathExtension
            if let i = dirs.lastIndex(of: "app"), base == "route", ["ts", "js", "tsx", "jsx", "mjs"].contains(ext) {
                let verbs = (read(root, tree, e.rel).map { all(exportedVerb, $0, limit: 8).map { $0[1] } }) ?? []
                for m in verbs.isEmpty ? ["*"] : Array(Set(verbs)).sorted() { add(route(m, segments(Array(dirs[(i + 1)...])), e.rel)) }
            } else if let i = dirs.lastIndex(of: "pages"), i + 1 < dirs.count, dirs[i + 1] == "api" {
                let tail = Array(dirs[(i + 1)...]) + (base == "index" ? [] : [base])
                add(route("*", segments(tail), e.rel))
            } else if e.name.hasPrefix("+server."), let i = dirs.lastIndex(of: "routes") {
                let verbs = (read(root, tree, e.rel).map { all(exportedVerb, $0, limit: 8).map { $0[1] } }) ?? []
                for m in verbs.isEmpty ? ["*"] : Array(Set(verbs)).sorted() { add(route(m, segments(Array(dirs[(i + 1)...])), e.rel)) }
            } else if let i = dirs.lastIndex(of: "server"), i + 1 < dirs.count, dirs[i + 1] == "api" || dirs[i + 1] == "routes" {
                var stem = base, method = "*"
                for m in ["get", "post", "put", "patch", "delete"] where stem.hasSuffix("." + m) { method = m; stem = String(stem.dropLast(m.count + 1)) }
                let tail = Array(dirs[(i + 1)...]) + (stem == "index" ? [] : [stem])
                add(route(method, segments(tail), e.rel))
            }
            // Fichiers lus pour y repérer des routes (déclarées dans le code) et les variables d'environnement.
            let low = e.rel.lowercased()
            var score = 0
            for k in ["route", "api", "controller", "router", "handler", "endpoint", "urls", "views", "server", "main", "app", "index", "config", "env", "settings", "web"] where low.contains(k) { score += 1 }
            if e.size > maxFileBytes { continue }
            candidates.append((score, e))
        }
        candidates.sort { $0.score != $1.score ? $0.score > $1.score : $0.e.size < $1.e.size }
        var total = 0
        for c in candidates.prefix(maxFiles) {
            guard total < maxTotalBytes, let text = read(root, tree, c.e.rel) else { continue }
            total += text.utf8.count
            let ext = (c.e.name as NSString).pathExtension.lowercased(), src = c.e.rel
            for re in envUse { for g in all(re, text, limit: 40) where !envIgnore.contains(g[1]) { used.insert(g[1]) } }
            if routes.count >= maxRoutes { continue }
            switch ext {
            case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts":
                for g in all(jsRoute, text, limit: 60) { add(route(g[2], g[4], src)) }
                for g in all(jsChain, text, limit: 30) { add(route(g[3], g[2], src)) }
                if text.contains("@Controller") {
                    let prefix = first(nestCtrl, text)?[1] ?? ""
                    for g in all(nestRoute, text, limit: 60) { add(route(g[1], joinPath(prefix, g[2]), src)) }
                }
            case "py":
                let prefix = first(pyPrefix, text)?[1] ?? ""
                for g in all(pyRoute, text, limit: 60) { add(route(g[1], joinPath(prefix, g[2]), src)) }
                for g in all(flaskRoute, text, limit: 40) {
                    let ms = all(rx(#"['"](GET|POST|PUT|PATCH|DELETE)['"]"#, [.caseInsensitive]), g[2], limit: 5).map { $0[1] }
                    for m in ms.isEmpty ? ["GET"] : ms { add(route(m, g[1], src)) }
                }
                if c.e.name == "urls.py" { for g in all(djangoPath, text, limit: 60) { add(route("*", joinPath("", g[1]), src)) } }
            case "go":
                for g in all(ginRoute, text, limit: 60) { add(route(g[1], g[2], src)) }
                for g in all(chiRoute, text, limit: 60) { add(route(g[1], g[2], src)) }
                for g in all(goHandle, text, limit: 40) { add(route(g[1].isEmpty ? "*" : g[1], g[2], src)) }
            case "rb":
                if c.e.name == "routes.rb" {
                    for g in all(railsRoute, text, limit: 60) { add(route(g[1], g[2], src)) }
                    for g in all(railsRes, text, limit: 40) { add(route("*", "/" + g[1], src, "resources")) }
                }
            case "php":
                if text.contains("Route::") { for g in all(laravelRoute, text, limit: 60) { add(route(g[1], g[2], src)) } }
            case "java", "kt":
                if text.contains("Mapping(") {
                    let base = first(springBase, text)?[1] ?? ""
                    for g in all(springRoute, text, limit: 60) { add(route(g[1], joinPath(base, g[2]), src)) }
                }
            default: break
            }
        }
        return Sources(routes: routes, envUsed: used)
    }

    // MARK: API

    private static let verbs: Set<String> = ["get", "post", "put", "patch", "delete", "head", "options"]

    /// Routes d'un fichier OpenAPI en YAML : lecture par indentation, sans analyseur complet.
    private static func yamlPaths(_ text: String) -> [(String, String, String)] {
        var out: [(String, String, String)] = []
        var inPaths = false, pathIndent = -1, cur = "", method = "", methodIndent = -1, summarySet = false
        for raw in lines(text) {
            let l = raw
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("#") { continue }
            let ind = indent(l)
            if ind == 0 { inPaths = t == "paths:"; cur = ""; method = ""; continue }
            guard inPaths else { continue }
            if pathIndent < 0 { pathIndent = ind }
            if ind == pathIndent, t.hasSuffix(":"), t.hasPrefix("/") || t.hasPrefix("\"/") || t.hasPrefix("'/") {
                cur = t.dropLast().trimmingCharacters(in: CharacterSet(charactersIn: "\"'")); method = ""; continue
            }
            guard !cur.isEmpty, ind > pathIndent else { continue }
            let key = t.split(separator: ":", maxSplits: 1).first.map { String($0).lowercased() } ?? ""
            if verbs.contains(key), t.hasSuffix(":"), methodIndent < 0 || ind <= methodIndent || method.isEmpty {
                methodIndent = ind; method = key; summarySet = false
                out.append((key, cur, "")); continue
            }
            if !method.isEmpty, !summarySet, ind > methodIndent, key == "summary" {
                let v = t.dropFirst(8).trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                if let i = out.indices.last, !v.isEmpty { out[i].2 = v; summarySet = true }
            }
        }
        return out
    }

    private static func urlPath(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespaces)
        s = s.replacingOccurrences(of: #"^https?://[^/\s]+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^\{\{[^}]*\}\}"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^:[A-Za-z_]+"#, with: "", options: .regularExpression)
        if let q = s.firstIndex(of: "?") { s = String(s[..<q]) }
        return s.hasPrefix("/") ? s : "/" + s
    }

    private static func api(_ root: String, _ tree: Tree, _ code: [[String: Any]]) -> [String: Any] {
        var specs: [[String: Any]] = []
        var files: [[String: Any]] = []
        var routes: [[String: Any]] = []
        var keys = Set<String>()
        // Routes lues dans les fichiers .http, collections Postman et Bruno (ajoutées après celles du code et d'OpenAPI).
        var code_http: [[String: Any]] = []
        func norm(_ p: String) -> String { p.replacingOccurrences(of: #"\{(\w+)\}"#, with: ":$1", options: .regularExpression) }
        func put(_ r: [String: Any]) {
            guard routes.count < maxRoutes else { return }
            if keys.insert("\(r["method"] as? String ?? "")|\(norm(r["path"] as? String ?? ""))").inserted { routes.append(r) }
        }
        for e in tree.entries where !e.dir {
            let n = e.name.lowercased()
            let depth = e.rel.split(separator: "/").count
            if depth <= 4, n.range(of: #"^(openapi|swagger)[a-z0-9._-]*\.(json|ya?ml)$"#, options: .regularExpression) != nil, specs.count < 6 {
                var found: [(String, String, String)] = []
                var title = "", version = "", servers: [String] = []
                if n.hasSuffix(".json"), let j = json(root, tree, e.rel, max: 1_500_000) {
                    let info = j["info"] as? [String: Any] ?? [:]
                    title = info["title"] as? String ?? ""; version = info["version"] as? String ?? ""
                    servers = (j["servers"] as? [[String: Any]] ?? []).compactMap { $0["url"] as? String }
                    for (p, v) in (j["paths"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) {
                        for (m, o) in (v as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) where verbs.contains(m.lowercased()) {
                            found.append((m.lowercased(), p, (o as? [String: Any])?["summary"] as? String ?? ""))
                        }
                    }
                } else if let t = read(root, tree, e.rel, max: 1_500_000) {
                    found = yamlPaths(t)
                    title = first(rx(#"(?m)^\s+title:\s*['"]?(.+?)['"]?\s*$"#), t)?[1] ?? ""
                    version = first(rx(#"(?m)^\s+version:\s*['"]?(.+?)['"]?\s*$"#), t)?[1] ?? ""
                    servers = all(rx(#"(?m)^\s*-?\s*url:\s*['"]?(\S+?)['"]?\s*$"#), t, limit: 3).map { $0[1] }
                }
                specs.append(["rel": e.rel, "title": clip(title, 80), "version": clip(version, 24), "servers": Array(servers.prefix(3).map { clip($0, 120) }), "count": found.count])
                for f in found { if let r = route(f.0, f.1, e.rel, f.2) { put(r) } }
            } else if depth <= 5, n.hasSuffix(".http") || n.hasSuffix(".rest"), files.count < 12, let t = read(root, tree, e.rel, max: 200_000) {
                var name = "", count = 0
                for l in lines(t) {
                    let s = l.trimmingCharacters(in: .whitespaces)
                    if s.hasPrefix("###") { name = String(s.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces); continue }
                    if let g = first(rx(#"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)"#), s) {
                        count += 1
                        if count <= 40, let r = route(g[1], urlPath(g[2]), e.rel, name) { code_http.append(r) }
                        name = ""
                    }
                }
                files.append(["rel": e.rel, "kind": "http", "count": count])
            } else if depth <= 5, n.contains("postman_collection") && n.hasSuffix(".json"), files.count < 12, let j = json(root, tree, e.rel, max: 3_000_000) {
                var count = 0
                func walkItems(_ items: [[String: Any]], _ budget: inout Int) {
                    for it in items {
                        if budget <= 0 { return }
                        if let sub = it["item"] as? [[String: Any]] { walkItems(sub, &budget); continue }
                        guard let req = it["request"] as? [String: Any], let m = req["method"] as? String else { continue }
                        budget -= 1; count += 1
                        let u = (req["url"] as? String) ?? ((req["url"] as? [String: Any])?["raw"] as? String) ?? ""
                        if !u.isEmpty, count <= 60, let r = route(m, urlPath(u), e.rel, it["name"] as? String ?? "") { code_http.append(r) }
                    }
                }
                var budget = 300
                walkItems(j["item"] as? [[String: Any]] ?? [], &budget)
                files.append(["rel": e.rel, "kind": "postman", "count": count])
            }
        }
        // Dossier Bruno : un fichier .bru par requête.
        let bru = tree.entries.filter { !$0.dir && $0.name.hasSuffix(".bru") }
        if !bru.isEmpty {
            let dir = parent(bru[0].rel)
            files.append(["rel": dir.isEmpty ? "." : dir, "kind": "bruno", "count": bru.count])
            for e in bru.prefix(40) {
                if let t = read(root, tree, e.rel, max: 50_000), let g = first(rx(#"(?m)^(get|post|put|patch|delete|head|options)\s*\{\s*\n\s*url:\s*(\S+)"#), t),
                   let r = route(g[1], urlPath(g[2]), e.rel) { code_http.append(r) }
            }
        }
        for r in code { put(r) }
        for r in code_http { put(r) }
        routes.sort { a, b in
            let pa = a["path"] as? String ?? "", pb = b["path"] as? String ?? ""
            return pa != pb ? pa < pb : (a["method"] as? String ?? "") < (b["method"] as? String ?? "")
        }
        return ["routes": routes, "specs": specs, "files": files, "truncated": routes.count >= maxRoutes]
    }

    // MARK: Données

    private static func fieldList(_ models: [[String: Any]]) -> [[String: Any]] { models }

    private static func prisma(_ text: String) -> (provider: String, models: [[String: Any]], enums: [[String: Any]]) {
        var provider = ""
        var models: [[String: Any]] = [], enums: [[String: Any]] = []
        var block = "", name = ""
        var fields: [[String: Any]] = [], values: [String] = []
        for raw in lines(text) {
            let l = raw.trimmingCharacters(in: .whitespaces)
            if l.isEmpty || l.hasPrefix("//") { continue }
            if block.isEmpty {
                let parts = l.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
                if parts.count >= 2, ["model", "enum", "datasource", "view", "type"].contains(parts[0]), l.hasSuffix("{") || l.contains("{") {
                    block = parts[0]; name = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "{")); fields = []; values = []
                }
                continue
            }
            if l.hasPrefix("}") {
                if block == "model" || block == "view" || block == "type", models.count < 80 { models.append(["name": name, "fields": fields]) }
                if block == "enum", enums.count < 40 { enums.append(["name": name, "values": values]) }
                block = ""; continue
            }
            if block == "datasource" {
                if let g = first(rx(#"provider\s*=\s*"([^"]+)""#), l) { provider = g[1] }
            } else if block == "enum" {
                if !l.hasPrefix("@"), values.count < 60 { values.append(String(l.split(separator: " ").first ?? "")) }
            } else if !l.hasPrefix("@@"), fields.count < 60 {
                let parts = l.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
                guard parts.count >= 2 else { continue }
                var type = parts[1]
                let optional = type.hasSuffix("?"), list = type.hasSuffix("[]")
                type = type.replacingOccurrences(of: "?", with: "").replacingOccurrences(of: "[]", with: "")
                let attrs = parts.dropFirst(2).joined(separator: " ")
                fields.append(["name": parts[0], "type": type, "optional": optional, "list": list, "key": attrs.contains("@id"), "unique": attrs.contains("@unique"),
                               "owns": attrs.contains("@relation(") && attrs.contains("fields:")])
            }
        }
        // Un champ dont le type est un autre modèle est une relation.
        let names = Set(models.compactMap { $0["name"] as? String })
        for i in models.indices {
            var fs = models[i]["fields"] as? [[String: Any]] ?? []
            for j in fs.indices { if let t = fs[j]["type"] as? String, names.contains(t) { fs[j]["ref"] = t } }
            models[i]["fields"] = fs
        }
        return (provider, models, enums)
    }

    private static func sqlTables(_ text: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let ls = lines(text)
        var i = 0
        let create = rx(#"(?i)^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["`\[]?([\w.]+)["`\]]?\s*\("#)
        while i < ls.count, out.count < 80 {
            guard let g = first(create, ls[i]) else { i += 1; continue }
            var fields: [[String: Any]] = []
            var j = i + 1
            while j < ls.count, !ls[j].trimmingCharacters(in: .whitespaces).hasPrefix(")"), fields.count < 60 {
                let l = ls[j].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ","))
                let parts = l.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
                let head = (parts.first ?? "").lowercased()
                if parts.count >= 2, !["primary", "foreign", "unique", "key", "index", "check", "constraint", "--", "create", "exclude"].contains(head), !l.hasPrefix("--") {
                    let low = l.lowercased()
                    var f: [String: Any] = ["name": parts[0].trimmingCharacters(in: CharacterSet(charactersIn: "\"`[]")), "type": parts[1].trimmingCharacters(in: CharacterSet(charactersIn: ",")),
                                            "optional": !low.contains("not null") && !low.contains("primary key"), "list": false, "key": low.contains("primary key"), "unique": low.contains("unique"), "owns": false]
                    if let r = first(rx(#"(?i)references\s+["`]?([\w.]+)["`]?"#), l) { f["ref"] = r[1]; f["owns"] = true }
                    fields.append(f)
                }
                j += 1
            }
            out.append(["name": g[1], "fields": fields])
            i = j + 1
        }
        return out
    }

    private static func drizzleTables(_ text: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let head = rx(#"(?:pgTable|mysqlTable|sqliteTable)\(\s*['"]([\w.]+)['"]\s*,\s*\{"#)
        let ns = text as NSString
        for m in head.matches(in: text, range: NSRange(location: 0, length: ns.length)).prefix(80) {
            let name = ns.substring(with: m.range(at: 1))
            let rest = ns.substring(from: m.range.location + m.range.length)
            var depth = 1, end = rest.startIndex
            for idx in rest.indices {
                if rest[idx] == "{" { depth += 1 } else if rest[idx] == "}" { depth -= 1; if depth == 0 { end = idx; break } }
                end = idx
            }
            var fields: [[String: Any]] = []
            for g in all(rx(#"(?m)^\s*(\w+):\s*(\w+)\(([^)]*)\)([^\n]*)"#), String(rest[..<end]), limit: 60) {
                var f: [String: Any] = ["name": g[1], "type": g[2], "optional": !g[4].contains("notNull") && !g[4].contains("primaryKey"), "list": false,
                                        "key": g[4].contains("primaryKey"), "unique": g[4].contains("unique"), "owns": g[4].contains("references")]
                if let r = first(rx(#"references\(\(\)\s*=>\s*(\w+)\."#), g[4]) { f["ref"] = r[1] }
                fields.append(f)
            }
            out.append(["name": name, "fields": fields])
        }
        return out
    }

    private static func migrations(_ root: String, _ tree: Tree) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let migExt: Set<String> = ["sql", "ts", "js", "py", "rb", "php", "go", "cs", "kt", "java", "swift", "mjs", "cjs"]
        for d in tree.entries where d.dir {
            let comps = d.rel.split(separator: "/").map(String.init)
            let low = d.name.lowercased()
            let isMig = low == "migrations" || (low == "migrate" && comps.count >= 2 && comps[comps.count - 2] == "db")
                || (low == "versions" && comps.count >= 2 && comps[comps.count - 2].lowercased() == "alembic")
                || (low == "drizzle" && tree.children(d.rel).contains { $0.name.hasSuffix(".sql") })
            guard isMig, out.count < 6 else { continue }
            let items = tree.children(d.rel).filter { e in
                !e.name.hasPrefix(".") && !e.name.hasPrefix("_") && e.name != "migration_lock.toml" && e.name != "meta"
                    && (e.dir || migExt.contains((e.name as NSString).pathExtension.lowercased()))
            }.sorted { $0.name < $1.name }
            guard !items.isEmpty else { continue }
            let p = d.rel.lowercased()
            let tool = p.contains("prisma") ? "Prisma" : p.contains("supabase") ? "Supabase" : p.contains("alembic") ? "Alembic" : low == "drizzle" || p.contains("drizzle") ? "Drizzle"
                : p.hasSuffix("db/migrate") ? "Rails" : p.contains("knex") ? "Knex" : "SQL"
            let recent: [[String: Any]] = items.suffix(12).reversed().map { ["name": $0.name, "at": ms($0.mtime)] }
            out.append(["rel": d.rel, "tool": tool, "count": items.count, "items": recent, "last": recent.first ?? [String: Any]()])
        }
        return out
    }

    private static func data(_ root: String, _ tree: Tree, _ pkgs: [Pkg]) -> [String: Any] {
        var schemas: [[String: Any]] = []
        var orm: [String] = []
        for e in tree.entries where !e.dir && schemas.count < 6 {
            let n = e.name.lowercased(), depth = e.rel.split(separator: "/").count
            guard depth <= 6 else { continue }
            if n == "schema.prisma", let t = read(root, tree, e.rel) {
                let p = prisma(t)
                schemas.append(["kind": "prisma", "rel": e.rel, "provider": p.provider, "models": p.models, "enums": p.enums]); if !orm.contains("Prisma") { orm.append("Prisma") }
            } else if n.hasPrefix("drizzle.config.") {
                if !orm.contains("Drizzle") { orm.append("Drizzle") }
                // Le schéma Drizzle : fichiers .ts qui déclarent des tables, près de la configuration.
                for s in tree.entries where !s.dir && s.name.hasSuffix(".ts") && (s.name.lowercased().contains("schema") || s.rel.contains("/db/") || s.rel.hasPrefix("db/")) && schemas.count < 6 {
                    if let t = read(root, tree, s.rel), t.contains("Table(") {
                        let tables = drizzleTables(t)
                        if !tables.isEmpty { schemas.append(["kind": "drizzle", "rel": s.rel, "provider": "", "models": tables, "enums": [[String: Any]]()]) }
                    }
                }
            } else if n.hasSuffix(".sql"), n == "schema.sql" || n == "structure.sql" || n == "init.sql" || n == "tables.sql" || (n.contains("schema") && !e.rel.contains("migrations")),
                      !e.rel.lowercased().contains("migrations"), let t = read(root, tree, e.rel, max: 400_000) {
                let tables = sqlTables(t)
                if !tables.isEmpty { schemas.append(["kind": "sql", "rel": e.rel, "provider": "", "models": tables, "enums": [[String: Any]]()]) }
            }
        }
        for p in pkgs { for d in p.info["data"] as? [String] ?? [] where !orm.contains(d) { orm.append(d) } }
        var out: [String: Any] = ["schemas": schemas, "migrations": migrations(root, tree), "tools": orm]
        out["supabase"] = tree.has("supabase/config.toml")
        // Scripts de base des paquets : migrate, seed, studio… (famille « data »).
        var scripts: [[String: Any]] = []
        for p in pkgs {
            for s in (p.info["scripts"] as? [String: Any])?["data"] as? [[String: Any]] ?? [] {
                var x = s; x["rel"] = p.rel; scripts.append(x)
            }
        }
        out["scripts"] = Array(scripts.prefix(40))
        return out
    }

    // MARK: Environnements

    private static let exampleWords = ["example", "sample", "template", "dist"]
    private static let envKey = rx(#"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$"#)

    private static func isEnvFile(_ name: String) -> Bool {
        if name == ".env" { return true }
        guard name.hasPrefix(".env.") else { return false }
        let tail = name.dropFirst(5).split(separator: ".").map(String.init)
        guard !tail.isEmpty, tail.count <= 3 else { return false }
        return !tail.contains(where: { ["ts", "js", "md", "json", "d", "yml", "yaml", "txt", "sh", "py"].contains($0.lowercased()) })
    }
    private static func stage(_ name: String) -> String {
        let n = name.lowercased()
        if exampleWords.contains(where: { n.contains($0) }) { return "example" }
        if n.contains("prod") { return "prod" }
        if n.contains("stag") || n.contains("preprod") || n.contains("preview") { return "staging" }
        if n.contains("test") || n.hasSuffix(".ci") { return "other" }
        return "dev"
    }

    /// Variables d'un fichier .env : le nom, si une valeur est renseignée (jamais la valeur elle-même), et le commentaire
    /// de la ligne du dessus pour les fichiers d'exemple.
    private static func envVars(_ text: String, notes: Bool) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var comment = ""
        for l in lines(text) {
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#") {
                let body = t.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                // Une variable mise en commentaire (« # KEY=… ») n'est pas une note.
                comment = first(envKey, body) == nil ? body : ""
                continue
            }
            guard let g = first(envKey, l), out.count < 300 else { comment = ""; continue }
            var v = g[2].trimmingCharacters(in: .whitespaces)
            if let hash = v.range(of: " #"), !(v.hasPrefix("\"") || v.hasPrefix("'")) { v = String(v[..<hash.lowerBound]).trimmingCharacters(in: .whitespaces) }
            v = v.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            var item: [String: Any] = ["key": g[1], "set": !v.isEmpty]
            if notes, !comment.isEmpty { item["note"] = clip(comment, 140) }
            out.append(item)
            comment = ""
        }
        return out
    }

    /// Un .gitignore couvre-t-il ce fichier ? Lecture des .gitignore du dépôt (de la racine au dossier du fichier), le dernier motif qui correspond gagne.
    private static func ignored(_ rel: String, _ gitignores: [String: [String]]) -> Bool {
        var result = false
        var dirs: [String] = [""]
        var acc = ""
        for c in rel.split(separator: "/").dropLast() { acc = join(acc, String(c)); dirs.append(acc) }
        for d in dirs {
            guard let ls = gitignores[d] else { continue }
            let sub = d.isEmpty ? rel : String(rel.dropFirst(d.count + 1))
            let base = (rel as NSString).lastPathComponent
            for raw in ls {
                var p = raw.trimmingCharacters(in: .whitespaces)
                if p.isEmpty || p.hasPrefix("#") { continue }
                var neg = false
                if p.hasPrefix("!") { neg = true; p.removeFirst() }
                // « dist/ » : le motif ne vaut que pour un dossier, et couvre tout ce qu'il contient.
                let dirOnly = p.hasSuffix("/")
                if dirOnly { p.removeLast() }
                if p.isEmpty { continue }
                let anchored = p.contains("/")
                if p.hasPrefix("/") { p.removeFirst() }
                var re = "^"
                var i = p.startIndex
                while i < p.endIndex {
                    let ch = p[i]
                    if ch == "*" {
                        let next = p.index(after: i)
                        if next < p.endIndex, p[next] == "*" {
                            let after = p.index(after: next)
                            if after < p.endIndex, p[after] == "/" { re += "(?:.*/)?"; i = p.index(after: after); continue }
                            re += ".*"; i = after; continue
                        }
                        re += "[^/]*"
                    } else if ch == "?" { re += "[^/]" }
                    else { re += NSRegularExpression.escapedPattern(for: String(ch)) }
                    i = p.index(after: i)
                }
                re += "$"
                guard let r = try? NSRegularExpression(pattern: re) else { continue }
                // Un motif couvre le fichier lui-même, ou n'importe lequel de ses dossiers parents (sous le .gitignore lu).
                let parts = sub.split(separator: "/").map(String.init)
                var targets: [String] = dirOnly ? [] : [anchored ? sub : base]
                for n in stride(from: 1, to: parts.count, by: 1) { targets.append(anchored ? parts.prefix(n).joined(separator: "/") : parts[n - 1]) }
                if targets.contains(where: { r.firstMatch(in: $0, range: NSRange(location: 0, length: ($0 as NSString).length)) != nil }) { result = !neg }
            }
        }
        return result
    }

    private static func env(_ root: String, _ tree: Tree, used: Set<String>) -> [String: Any] {
        let files = tree.entries.filter { !$0.dir && isEnvFile($0.name) && $0.size <= 131_072 }.prefix(24)
        var gitignores: [String: [String]] = [:]
        for e in tree.entries where !e.dir && e.name == ".gitignore" && e.size <= 65_536 {
            if let t = read(root, tree, e.rel) { gitignores[parent(e.rel)] = lines(t) }
        }
        // Fichiers suivis par Git : un seul « git ls-files » ciblé sur les noms d'environnement.
        var tracked = Set<String>()
        if !files.isEmpty, FileManager.default.fileExists(atPath: root + "/.git"),
           let out = ProjectFolders.shared.git(["ls-files", "--", ".env", ".env.*", "*/.env", "*/.env.*"], in: root, timeout: 4, maxBytes: 100_000) {
            tracked = Set(out.split(separator: "\n").map(String.init))
        }
        struct Parsed { let rel: String; let stage: String; let vars: [[String: Any]] }
        var parsed: [Parsed] = []
        for e in files {
            let st = stage(e.name)
            parsed.append(Parsed(rel: e.rel, stage: st, vars: envVars(read(root, tree, e.rel, max: 131_072) ?? "", notes: st == "example")))
        }
        let keysOf = { (p: Parsed) -> [String] in p.vars.compactMap { $0["key"] as? String } }
        var outFiles: [[String: Any]] = []
        var alerts: [[String: Any]] = []
        var allKeys = Set<String>()
        for p in parsed { allKeys.formUnion(keysOf(p)) }
        for p in parsed {
            let dir = parent(p.rel)
            let prefs = [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.local.example"]
            let example = p.stage == "example" ? nil : prefs.compactMap { n in parsed.first(where: { $0.rel == join(dir, n) }) }.first
                ?? parsed.first(where: { $0.stage == "example" && parent($0.rel) == dir })
            var f: [String: Any] = ["rel": p.rel, "stage": p.stage, "vars": p.vars, "count": p.vars.count,
                                    "set": p.vars.filter { $0["set"] as? Bool == true }.count]
            let isTracked = tracked.contains(p.rel)
            f["tracked"] = isTracked
            f["ignored"] = ignored(p.rel, gitignores)
            if let ex = example {
                let have = Set(keysOf(p)), want = keysOf(ex)
                f["vs"] = ex.rel
                f["missing"] = Array(want.filter { !have.contains($0) }.prefix(100))
                f["extra"] = Array(keysOf(p).filter { !want.contains($0) }.prefix(100))
            }
            outFiles.append(f)
            guard p.stage != "example", (f["set"] as? Int ?? 0) > 0 else { continue }
            if isTracked {
                alerts.append(["level": "danger", "code": "tracked", "rel": p.rel, "text": "\(p.rel) est suivi par Git : ses secrets sont dans l’historique du dépôt.",
                               "fix": "git rm --cached \(p.rel)  puis ajoute-le au .gitignore, et change les secrets déjà publiés."])
            } else if f["ignored"] as? Bool == false {
                alerts.append(["level": "danger", "code": "not-ignored", "rel": p.rel, "text": "\(p.rel) n’est pas couvert par un .gitignore : un git add . l’enverrait avec ses secrets.",
                               "fix": "Ajoute « \(((p.rel) as NSString).lastPathComponent) » au .gitignore du dépôt."])
            }
            if example == nil && !parsed.contains(where: { $0.stage == "example" }) && !alerts.contains(where: { $0["code"] as? String == "no-example" }) {
                alerts.append(["level": "warn", "code": "no-example", "rel": p.rel, "text": "Aucun .env.example : une nouvelle personne ne sait pas quelles variables renseigner.",
                               "fix": "Copie \(p.rel) en .env.example en vidant les valeurs, et versionne-le."])
            }
            if let miss = f["missing"] as? [String], !miss.isEmpty {
                alerts.append(["level": "warn", "code": "missing", "rel": p.rel, "text": "\(p.rel) : \(miss.count) variable\(miss.count > 1 ? "s" : "") de l’exemple absente\(miss.count > 1 ? "s" : "").",
                               "fix": "Ajoute \(miss.prefix(3).joined(separator: ", "))\(miss.count > 3 ? "…" : "") à \(p.rel)."])
            }
        }
        // Variables lues dans le code mais décrites nulle part (échantillon des fichiers lus).
        let undocumented = used.subtracting(allKeys).sorted()
        var out: [String: Any] = ["files": outFiles, "alerts": alerts]
        if !parsed.isEmpty || !used.isEmpty { out["undocumented"] = Array(undocumented.prefix(60)); out["used"] = used.count }
        return out
    }

    // MARK: Déploiement, compose, workflows

    private static let dataStores: [(String, String)] = [
        ("postgres", "Postgres"), ("mysql", "MySQL"), ("mariadb", "MariaDB"), ("mongo", "MongoDB"), ("redis", "Redis"), ("valkey", "Valkey"), ("memcached", "Memcached"),
        ("clickhouse", "ClickHouse"), ("cockroach", "CockroachDB"), ("elasticsearch", "Elasticsearch"), ("opensearch", "OpenSearch"), ("neo4j", "Neo4j"), ("influx", "InfluxDB"),
        ("supabase", "Supabase"), ("sqlite", "SQLite"),
    ]
    private static let otherServices: [(String, String)] = [("rabbitmq", "RabbitMQ"), ("kafka", "Kafka"), ("nats", "NATS"), ("minio", "MinIO"), ("mailhog", "MailHog"), ("mailpit", "Mailpit"), ("nginx", "Nginx"), ("traefik", "Traefik"), ("caddy", "Caddy")]

    private static func composeServices(_ text: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let ls = lines(text)
        guard let start = ls.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "services:" && indent($0) == 0 }) else { return [] }
        var svcIndent = -1
        var cur: [String: Any]?
        var ports: [String] = []
        var inPorts = false
        func flush() {
            guard var c = cur else { return }
            c["ports"] = Array(ports.prefix(8))
            let hay = ((c["image"] as? String ?? "") + " " + (c["name"] as? String ?? "")).lowercased()
            if let s = dataStores.first(where: { hay.contains($0.0) }) { c["kind"] = s.1; c["db"] = true }
            else if let s = otherServices.first(where: { hay.contains($0.0) }) { c["kind"] = s.1; c["db"] = false }
            else { c["db"] = false }
            if out.count < 30 { out.append(c) }
            cur = nil; ports = []; inPorts = false
        }
        for l in ls[(start + 1)...] {
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("#") { continue }
            let ind = indent(l)
            if ind == 0 { break }
            if svcIndent < 0 { svcIndent = ind }
            if ind == svcIndent, t.hasSuffix(":") {
                flush()
                cur = ["name": String(t.dropLast()), "image": "", "build": false]
                continue
            }
            guard cur != nil, ind > svcIndent else { continue }
            if t.hasPrefix("image:") { cur?["image"] = clip(t.dropFirst(6).trimmingCharacters(in: CharacterSet(charactersIn: " \"'")), 80); inPorts = false }
            else if t.hasPrefix("build:") { cur?["build"] = true; inPorts = false }
            else if t.hasPrefix("ports:") {
                inPorts = true
                for g in all(rx(#"(\d{2,5}(?::\d{2,5})?)"#), String(t.dropFirst(6)), limit: 8) { ports.append(g[1]) }
            } else if inPorts, t.hasPrefix("-") {
                if let g = first(rx(#"(\d{2,5}(?::\d{2,5})?)"#), t) { ports.append(g[1]) }
            } else if !t.hasPrefix("-") { inPorts = false }
        }
        flush()
        return out
    }

    private static func deployFiles(_ root: String, _ tree: Tree) -> (files: [[String: Any]], hosts: [String], compose: [[String: Any]]) {
        var files: [[String: Any]] = []
        var hosts: [String] = []
        var compose: [[String: Any]] = []
        func note(_ rel: String, _ kind: String, _ host: String) {
            guard files.count < 40 else { return }
            files.append(["rel": rel, "kind": kind, "host": host])
            if !host.isEmpty && !hosts.contains(host) { hosts.append(host) }
        }
        var tfDirs = Set<String>()
        for e in tree.entries {
            let n = e.name.lowercased(), depth = e.rel.split(separator: "/").count
            if e.dir {
                if depth <= 2, ["k8s", "kubernetes", "helm", "charts", ".github"].contains(n) == false, n != "terraform" { continue }
                if ["k8s", "kubernetes"].contains(n) { note(e.rel, "kubernetes", "Kubernetes") }
                if n == "helm" || n == "charts" { note(e.rel, "helm", "Kubernetes") }
                if n == "terraform" { note(e.rel, "terraform", "Terraform") }
                continue
            }
            guard depth <= 4 else { continue }
            if n == "dockerfile" || n.hasPrefix("dockerfile.") || n.hasSuffix(".dockerfile") { note(e.rel, "docker", "Docker") }
            else if n.range(of: #"^(docker-)?compose[a-z0-9._-]*\.ya?ml$"#, options: .regularExpression) != nil {
                if compose.count < 6, let t = read(root, tree, e.rel, max: 200_000) {
                    let svc = composeServices(t)
                    compose.append(["rel": e.rel, "services": svc])
                    if !hosts.contains("Docker") { hosts.append("Docker") }
                }
            }
            else if n == "vercel.json" { note(e.rel, "vercel", "Vercel") }
            else if n == "netlify.toml" { note(e.rel, "netlify", "Netlify") }
            else if n == "fly.toml" { note(e.rel, "fly", "Fly.io") }
            else if n == "render.yaml" || n == "render.yml" { note(e.rel, "render", "Render") }
            else if n.hasPrefix("railway.") { note(e.rel, "railway", "Railway") }
            else if n == "procfile" { note(e.rel, "procfile", "Heroku") }
            else if n.hasPrefix("wrangler.") { note(e.rel, "wrangler", "Cloudflare") }
            else if n == "eas.json" { note(e.rel, "eas", "Expo EAS") }
            else if n == "app.json", let j = json(root, tree, e.rel, max: 200_000), j["expo"] != nil { note(e.rel, "expo", "Expo") }
            else if n == "firebase.json" { note(e.rel, "firebase", "Firebase") }
            else if n == "serverless.yml" || n == "serverless.yaml" { note(e.rel, "serverless", "AWS") }
            else if n == "amplify.yml" { note(e.rel, "amplify", "AWS") }
            else if n == "app.yaml" { note(e.rel, "gcp", "Google Cloud") }
            else if n == "chart.yaml" { note(parent(e.rel).isEmpty ? e.rel : parent(e.rel), "helm", "Kubernetes") }
            else if n.hasSuffix(".tf") { tfDirs.insert(parent(e.rel)) }
        }
        for d in tfDirs.sorted().prefix(4) where !files.contains(where: { $0["kind"] as? String == "terraform" && $0["rel"] as? String == d }) { note(d.isEmpty ? "." : d, "terraform", "Terraform") }
        return (files, hosts, compose)
    }

    private static func workflows(_ root: String, _ tree: Tree) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for e in tree.children(".github/workflows") where !e.dir && (e.name.hasSuffix(".yml") || e.name.hasSuffix(".yaml")) && out.count < 20 {
            guard let t = read(root, tree, e.rel, max: 200_000) else { continue }
            let ls = lines(t)
            let name = ls.first(where: { $0.hasPrefix("name:") }).map { $0.dropFirst(5).trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) } ?? ""
            var triggers: [String] = []
            let known = ["push", "pull_request", "pull_request_target", "schedule", "workflow_dispatch", "release", "workflow_call", "workflow_run", "tag", "repository_dispatch"]
            if let i = ls.firstIndex(where: { $0.hasPrefix("on:") || $0.hasPrefix("\"on\":") || $0.hasPrefix("'on':") }) {
                let head = ls[i]
                for k in known where head.range(of: #"\b"# + k + #"\b"#, options: .regularExpression) != nil { triggers.append(k) }
                var j = i + 1
                while j < ls.count, ls[j].isEmpty || indent(ls[j]) > 0 {
                    let tt = ls[j].trimmingCharacters(in: .whitespaces)
                    if indent(ls[j]) == 2 || (indent(ls[j]) == 4 && tt.hasPrefix("- ")) {
                        let key = tt.replacingOccurrences(of: "- ", with: "").split(separator: ":").first.map(String.init) ?? ""
                        if known.contains(key), !triggers.contains(key) { triggers.append(key) }
                    }
                    j += 1
                }
            }
            let low = (e.name + " " + name).lowercased()
            let deploy = low.range(of: #"deploy|release|publish|prod"#, options: .regularExpression) != nil || t.contains("environment:")
            out.append(["rel": e.rel, "name": clip(name.isEmpty ? e.name : name, 80), "triggers": triggers, "deploy": deploy])
        }
        return out
    }

    // MARK: Tests

    private static func tests(_ root: String, _ tree: Tree, _ pkgs: [Pkg]) -> [String: Any] {
        var fw: [[String: Any]] = []
        var byPkg: [String: Int] = [:]
        func addFW(_ name: String, _ command: String, _ rel: String) {
            if !fw.contains(where: { $0["name"] as? String == name && $0["rel"] as? String == rel }) { fw.append(["name": name, "command": command, "rel": rel]) }
        }
        let pkgDirs = pkgs.map { $0.rel }.sorted { $0.count > $1.count }
        var rootFiles = 0
        for e in tree.entries where !e.dir && isTestFile(e.rel, e.name) {
            if let d = pkgDirs.first(where: { $0.isEmpty || e.rel.hasPrefix($0 + "/") }) { byPkg[d, default: 0] += 1 } else { rootFiles += 1 }
        }
        for p in pkgs {
            let rel = p.rel
            let names = Set(tree.children(rel).map { $0.name })
            let tool = p.info["tool"] as? String ?? ""
            func conf(_ prefix: String) -> Bool { names.contains(where: { $0.hasPrefix(prefix) }) }
            if p.kind == "node" {
                let run = "\(tool) run test"
                if p.deps.contains("vitest") || conf("vitest.config") { addFW("Vitest", run, rel) }
                if p.deps.contains("jest") || conf("jest.config") { addFW("Jest", run, rel) }
                if p.deps.contains("@playwright/test") || conf("playwright.config") { addFW("Playwright", "\(tool) run test:e2e", rel) }
                if p.deps.contains("cypress") || conf("cypress.config") { addFW("Cypress", "\(tool) run cypress:run", rel) }
                if p.deps.contains("mocha") || conf(".mocharc") { addFW("Mocha", run, rel) }
                if p.deps.contains("ava") { addFW("AVA", run, rel) }
                if p.deps.contains("@testing-library/react") || p.deps.contains("@testing-library/react-native") { addFW("Testing Library", run, rel) }
            } else if p.kind == "python" {
                if names.contains("pytest.ini") || names.contains("conftest.py") || (p.info["frameworks"] as? [String] ?? []).contains("pytest") { addFW("pytest", "pytest", rel) }
            } else if p.kind == "go" { addFW("go test", "go test ./...", rel) }
            else if p.kind == "rust" { addFW("cargo test", "cargo test", rel) }
            else if p.kind == "dart", tree.has(join(rel, "test")) { addFW("flutter test", "flutter test", rel) }
            else if p.kind == "swift", (read(root, tree, join(rel, "Package.swift")) ?? "").contains("testTarget") { addFW("XCTest", "swift test", rel) }
            else if p.kind == "ruby", names.contains(".rspec") || tree.has(join(rel, "spec")) { addFW("RSpec", "bundle exec rspec", rel) }
            else if p.kind == "php", names.contains("phpunit.xml") || names.contains("phpunit.xml.dist") { addFW("PHPUnit", "vendor/bin/phpunit", rel) }
        }
        // Coverage : rapport de résumé Istanbul/Vitest ou lcov, à la racine ou dans un paquet.
        var coverage: [[String: Any]] = []
        for d in Set(pkgs.map { $0.rel } + [""]).sorted() {
            let base = join(d, "coverage")
            let sum = base + "/coverage-summary.json", lcov = base + "/lcov.info"
            let fm = FileManager.default
            let at = { (p: String) -> Int in ms(((try? fm.attributesOfItem(atPath: root + "/" + p))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) }
            if let d0 = fm.contents(atPath: root + "/" + sum), d0.count < 1_000_000,
               let j = (try? JSONSerialization.jsonObject(with: d0)) as? [String: Any], let tot = j["total"] as? [String: Any] {
                var c: [String: Any] = ["rel": d, "source": sum, "at": at(sum)]
                for k in ["lines", "statements", "functions", "branches"] {
                    if let m = tot[k] as? [String: Any], let pct = (m["pct"] as? NSNumber)?.doubleValue { c[k] = (pct * 10).rounded() / 10 }
                }
                coverage.append(c)
            } else if let d0 = fm.contents(atPath: root + "/" + lcov), d0.count < 4_000_000 {
                var lf = 0, lh = 0
                for l in String(decoding: d0, as: UTF8.self).split(separator: "\n") {
                    if l.hasPrefix("LF:") { lf += Int(l.dropFirst(3)) ?? 0 } else if l.hasPrefix("LH:") { lh += Int(l.dropFirst(3)) ?? 0 }
                }
                if lf > 0 { coverage.append(["rel": d, "source": lcov, "at": at(lcov), "lines": (Double(lh) / Double(lf) * 1000).rounded() / 10]) }
            }
            if coverage.count >= 8 { break }
        }
        return ["frameworks": fw, "files": byPkg.values.reduce(rootFiles, +), "byPackage": byPkg, "coverage": coverage]
    }

    // MARK: Lancement des scripts

    private static let scriptName = rx(#"^[A-Za-z0-9:._@/-]{1,80}$"#)

    private func run(_ pid: String, repo: String, rel: String, script: String, name: String) -> [String: Any] {
        guard let main = ProjectFolders.shared.path(pid), !main.isEmpty else { return ["ok": false, "message": "Choisis d’abord le dossier du projet."] }
        guard Self.scriptName.firstMatch(in: script, range: NSRange(location: 0, length: (script as NSString).length)) != nil else {
            return ["ok": false, "message": "Nom de script invalide."]
        }
        // Le dépôt et le paquet doivent figurer dans l'analyse que le Mac vient de faire.
        let repos = analysis(pid, fresh: false)
        let refs = repoRefs(pid)
        guard let ref = refs.first(where: { $0.name == repo }) ?? (repo.isEmpty ? refs.first : nil),
              let rd = repos.first(where: { $0["name"] as? String == ref.name }),
              let pk = (rd["packages"] as? [[String: Any]])?.first(where: { $0["rel"] as? String == rel && $0["runnable"] as? Bool == true }) else {
            return ["ok": false, "message": "Ce paquet n’existe pas (ou plus) dans le dépôt."]
        }
        let dir = rel.isEmpty ? ref.dir : ref.dir + "/" + rel
        let real = URL(fileURLWithPath: dir).resolvingSymlinksInPath().path, base = URL(fileURLWithPath: ref.dir).resolvingSymlinksInPath().path
        guard real == base || real.hasPrefix(base + "/") else { return ["ok": false, "message": "Dossier hors du dépôt."] }
        // Le script doit être déclaré dans le package.json lu à l'instant.
        guard let data = FileManager.default.contents(atPath: dir + "/package.json"), data.count < 2_000_000,
              let pkg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let scripts = pkg["scripts"] as? [String: Any], scripts[script] is String else {
            return ["ok": false, "message": "Ce script n’existe pas (ou plus) dans le package.json."]
        }
        let tool = pk["tool"] as? String ?? "npm"
        guard let exe = Sites.find(tool) else {
            return ["ok": false, "message": "« \(tool) » est introuvable sur ce Mac. Ajoute son dossier dans Réglages → Autorisations des agents → Dossiers des outils."]
        }
        let key = "\(ref.name)|\(rel)|\(script)"
        lock.lock()
        let fam = Self.family(script)
        let job = Job(repo: ref.name, rel: rel, script: script, tool: tool, family: fam, name: String(name.prefix(80)))
        lock.lock()
        if jobs[pid]?[key]?.status == "running" { lock.unlock(); return ["ok": false, "message": "Ce script tourne déjà."] }
        // Inscrit avant le lancement, sous le même verrou que le test : deux demandes rapprochées ne lancent pas deux fois le script.
        let before = jobs[pid]?[key]
        jobs[pid, default: [:]][key] = job
        lock.unlock()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = ["run", script]
        p.currentDirectoryURL = URL(fileURLWithPath: dir, isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Sites.searchPath().joined(separator: ":")
        env["NO_COLOR"] = "1"; env["FORCE_COLOR"] = "0"
        // Un lanceur de tests en mode « watch » ne se termine jamais : CI=true l'en empêche.
        if fam == "test" { env["CI"] = "true" }
        p.environment = env
        let out = Pipe()
        p.standardOutput = out; p.standardError = out; p.standardInput = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self, weak job] handle in
            let d = handle.availableData
            guard !d.isEmpty, let self = self, let job = job else { handle.readabilityHandler = nil; return }
            let text = Sites.clean(String(decoding: d, as: UTF8.self))
            self.lock.lock(); job.log = String((job.log + text).suffix(24_000)); self.lock.unlock()
        }
        p.terminationHandler = { [weak self, weak job] proc in
            guard let self = self, let job = job else { return }
            self.lock.lock()
            let wasRunning = job.status == "running"
            if wasRunning { job.status = proc.terminationStatus == 0 ? "done" : "failed" }
            job.code = proc.terminationStatus; job.ended = Date(); job.process = nil
            let status = job.status, code = job.code, secs = Int(Date().timeIntervalSince(job.started).rounded())
            let summary = job.family == "test" ? Self.testSummary(job.log) : nil
            self.lock.unlock()
            // Arrêté à la main : pas de notification, la personne est déjà devant.
            guard wasRunning else { return }
            let who = job.name.isEmpty ? "" : " · \(job.name)"
            let took = secs < 60 ? "\(secs) s" : "\(secs / 60) min \(String(format: "%02d", secs % 60))"
            let isTest = job.family == "test"
            let title = status == "done" ? (isTest ? "Tests réussis\(who)" : "Script terminé\(who)") : (isTest ? "Tests en échec\(who)" : "Script en échec\(who)")
            var body = status == "done" ? "\(job.tool) run \(job.script) a réussi en \(took)." : "\(job.tool) run \(job.script) s’est arrêté sur une erreur (code \(code)) après \(took)."
            if let s = summary, let f = s["failed"] as? Int, let ok = s["passed"] as? Int { body += " \(ok) réussi\(ok > 1 ? "s" : ""), \(f) échoué\(f > 1 ? "s" : "")." }
            Notifier.shared.post(title: title, body: body, url: nil, thread: "stack")
        }
        do { try p.run() } catch {
            lock.lock(); if jobs[pid]?[key] === job { jobs[pid]?[key] = before }; lock.unlock()
            return ["ok": false, "message": "Impossible de lancer « \(tool) run \(script) »."]
        }
        lock.lock()
        job.process = p
        // Les derniers lancements finis sont gardés, pas tous : trente par projet au plus.
        let done = (jobs[pid] ?? [:]).filter { $0.value.status != "running" }.sorted { ($0.value.ended ?? $0.value.started) < ($1.value.ended ?? $1.value.started) }
        if done.count > 30 { for d in done.prefix(done.count - 30) { jobs[pid]?[d.key] = nil } }
        lock.unlock()
        return ["ok": true]
    }

    @discardableResult
    private func stop(_ pid: String, repo: String, rel: String, script: String) -> Bool {
        lock.lock()
        let job = (jobs[pid] ?? [:]).values.first { ($0.repo == repo || repo.isEmpty) && $0.rel == rel && $0.script == script }
        if job?.status == "running" { job?.status = "stopped" }
        let process = job?.process
        lock.unlock()
        if let p = process, p.isRunning {
            for child in Sites.descendants(of: p.processIdentifier) { kill(child, SIGTERM) }
            p.terminate()
        }
        return job != nil
    }

    /// À la fermeture de l'app : aucun script lancé d'ici ne doit lui survivre.
    func stopAll() {
        lock.lock()
        let running = jobs.flatMap { pid, m in m.values.filter { $0.status == "running" }.map { (pid, $0) } }
        lock.unlock()
        for (pid, j) in running { stop(pid, repo: j.repo, rel: j.rel, script: j.script) }
    }

    /// Un lancement tel que la page le lit (à appeler verrou pris).
    private func info(_ j: Job) -> [String: Any] {
        let end = j.ended ?? Date()
        var r: [String: Any] = [
            "repo": j.repo, "rel": j.rel, "script": j.script, "command": "\(j.tool) run \(j.script)", "family": j.family, "status": j.status, "code": Int(j.code),
            "since": Int(j.started.timeIntervalSince1970 * 1000), "took": Int(end.timeIntervalSince(j.started).rounded()), "log": String(j.log.suffix(16_000)),
        ]
        if let e = j.ended { r["ended"] = Int(e.timeIntervalSince1970 * 1000) }
        if j.family == "test", let s = Self.testSummary(j.log) { r["summary"] = s }
        return r
    }

    // MARK: Résumé d'un lancement de tests

    private static let counts = rx(#"(\d+)\s+(failed|passed|skipped|todo|pending|passing|failing|flaky|errors?)\b"#, [.caseInsensitive])
    private static let pytestEnd = rx(#"(?m)^(?:=+\s*)?((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+)\s+in\s+[\d.]+s"#)

    /// `{ passed, failed, skipped }` si le format est reconnu (Vitest, Jest, Playwright, pytest, Mocha, node:test), sinon rien.
    static func testSummary(_ log: String) -> [String: Any]? {
        var passed = 0, failed = 0, skipped = 0
        var found = false
        func take(_ line: String) {
            for g in all(counts, line, limit: 12) {
                let n = Int(g[1]) ?? 0
                switch g[2].lowercased() {
                case "passed", "passing": passed += n
                case "failed", "failing", "error", "errors": failed += n
                case "skipped", "todo", "pending": skipped += n
                default: break
                }
                found = true
            }
        }
        let tail = String(log.suffix(12_000))
        // Vitest et Jest : une ligne « Tests: … » (la dernière, qui est le total).
        if let line = lines(tail).last(where: { $0.range(of: #"^\s*Tests:?\s+\d"#, options: .regularExpression) != nil }) { take(line); if found { return ["passed": passed, "failed": failed, "skipped": skipped] } }
        // pytest.
        if let m = all(pytestEnd, tail, limit: 20).last { take(m[1]); if found { return ["passed": passed, "failed": failed, "skipped": skipped] } }
        // Playwright : « 2 failed », « 5 passed (3s) » sur des lignes à part, après « Running N tests ».
        if tail.range(of: #"Running \d+ tests?"#, options: .regularExpression) != nil {
            for l in lines(tail) where l.range(of: #"^\s+\d+ (passed|failed|skipped|flaky)\b"#, options: .regularExpression) != nil { take(l) }
            if found { return ["passed": passed, "failed": failed, "skipped": skipped] }
        }
        // Mocha : « 5 passing », « 1 failing », « 2 pending ».
        for l in lines(tail) where l.range(of: #"^\s+\d+ (passing|failing|pending)\b"#, options: .regularExpression) != nil { take(l) }
        if found { return ["passed": passed, "failed": failed, "skipped": skipped] }
        // node:test : « # pass 5 », « # fail 1 », « # skipped 0 ».
        for g in all(rx(#"(?m)^# (pass|fail|skipped)\s+(\d+)"#), tail, limit: 6) {
            let n = Int(g[2]) ?? 0
            if g[1] == "pass" { passed = n } else if g[1] == "fail" { failed = n } else { skipped = n }
            found = true
        }
        return found ? ["passed": passed, "failed": failed, "skipped": skipped] : nil
    }
}
#endif
