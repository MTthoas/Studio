// Bulle macOS des agents Claude Code lancés sur ce Mac (réglage « Terminal isolé », Réglages → Autorisations).
// L'agent part par `sandbox-exec -p <profil> claude …` : le profil Seatbelt vaut pour Claude Code et pour tout ce qu'il
// lance (Bash, git, npm, serveur MCP du navigateur), sans qu'aucun ne puisse en sortir.
// - Lecture : tout, sauf les données de Studio (notes, coffre, réglages : ~/Library/*/app.carnet.notes*), les dossiers
//   des autres projets de Studio, les journaux des autres sessions de Claude Code, l'agent SSH de Studio et quelques
//   dossiers de secrets. Le projet lui-même (dépôt, copies, .git) reste lisible même s'il est rangé sous un autre.
// - Écriture dans le dossier personnel : la copie de l'agent (et ses copies sœurs), le .git de leurs dépôts (sauf
//   hooks/), ~/.claude (sauf réglages, hooks, commandes…), les caches des outils et le trousseau. Hors du dossier
//   personnel (/tmp, dossiers temporaires) : permis.
// - Réseau : ouvert (git push, npm install, gh). Ce qu'il peut envoyer se limite à ce qu'il peut lire.
// Le profil est vérifié par macOS avant chaque lancement ; refusé, l'agent part sans bulle et sans terminal.
import Foundation
#if os(macOS)

enum AgentSandbox {
    static let exec = "/usr/bin/sandbox-exec"
    static var available: Bool { FileManager.default.isExecutableFile(atPath: exec) }

    private static let lock = NSLock()
    private static var checked: [String: Bool] = [:]

    /// Profil de la bulle pour un agent, ou nil (pas de sandbox-exec, ou profil refusé par macOS).
    /// `workDirs` : là où il écrit (sa copie, ses copies sœurs) ; `readDirs` : le reste du projet qu'il doit pouvoir lire.
    static func profile(project pid: String, workDirs: [String], readDirs: [String]) -> String? {
        guard available else { return nil }
        // La règle sur la socket SSH de Studio est la seule dont la syntaxe dépend de la version de macOS : sans elle si besoin.
        for strict in [true, false] {
            if let p = build(project: pid, workDirs: workDirs, readDirs: readDirs, strict: strict), valid(p) { return p }
        }
        return nil
    }

    private static func build(project pid: String, workDirs: [String], readDirs: [String], strict: Bool) -> String? {
        let home = real(NSHomeDirectory())
        let work = unique(workDirs.map(real))
        let commons = unique(work.compactMap(gitCommon))
        let mine = unique(work + commons + readDirs.map(real))
        let logs = home + "/.claude/projects"
        let ownLogs = unique(workDirs.flatMap { [encode($0), encode(real($0))] }).map { logs + "/" + $0 }
        let others = unique(ProjectFolders.shared.otherProjectDirs(except: pid).map(real))
        let sshAgent = real(NSTemporaryDirectory()) + "/studio-ssh-\(getuid())"
        let studio = Bundle.main.bundleIdentifier ?? "app.carnet.notes"
        let secrets = [".aws", ".gnupg", ".kube", ".docker", ".azure", ".password-store", ".config/gcloud",
                       "Library/Mail", "Library/Messages", "Library/Safari", "Library/Cookies"].map { home + "/" + $0 }
        let caches = [".npm", ".cache", ".bun", ".yarn", ".pnpm-store", "Library/pnpm", ".local/share/pnpm", ".cargo/registry", ".cargo/git",
                      ".rustup", ".gradle", ".m2", "go/pkg", ".node-gyp", ".swiftpm", "Library/org.swift.swiftpm",
                      "Library/Developer/Xcode/DerivedData", "Library/Caches", "Library/Keychains", ".config/gh", ".claude", ".local/share/claude", ".local/state/claude"].map { home + "/" + $0 }

        guard let homeRx = rx(home), let studioRx = rx(studio) else { return nil }
        let studioData = "(regex #\"^\(homeRx)/Library/[^/]+/\(studioRx)\")"
        let claudeConfig = "(regex #\"^\(homeRx)/\\.claude/(settings[^/]*\\.json|CLAUDE\\.md|commands|agents|hooks|plugins|skills|output-styles)(/|$)\")"
        let claudeState = "(regex #\"^\(homeRx)/\\.claude\\.json\")"

        func paths(_ list: [String]) -> String? {
            let parts = list.map(subpath)
            return parts.contains(nil) ? nil : parts.compactMap { $0 }.joined(separator: " ")
        }
        guard let pOthers = paths(others + secrets + [sshAgent, logs]), let pMine = paths(mine + ownLogs), let pHome = paths([home]),
              let pWrite = paths(work + commons + caches), let pHooks = paths(commons.map { $0 + "/hooks" } + [logs]),
              let pOwnLogs = paths(ownLogs), let pSsh = paths([sshAgent]) else { return nil }

        var rules = ["(version 1)", "(allow default)",
                     // Lecture : données de Studio, autres projets, autres sessions, secrets ; puis le projet, rouvert.
                     "(deny file-read* \(studioData) \(pOthers))",
                     "(allow file-read* \(pMine))",
                     // Écriture : rien dans le dossier personnel, sauf la copie, le .git, les caches et l'état de Claude Code.
                     "(deny file-write* \(pHome))",
                     "(allow file-write* \(pWrite) \(claudeState))",
                     "(deny file-write* \(studioData) \(claudeConfig) \(pHooks) \(pSsh))",
                     "(allow file-write* \(pOwnLogs))"]
        if pOwnLogs.isEmpty { rules.removeLast() }
        if strict { rules.append("(deny network-outbound \(pSsh))") }
        return rules.joined(separator: "\n")
    }

    /// macOS accepte-t-il le profil ? (`sandbox-exec -p … /usr/bin/true`, résultat gardé par profil)
    private static func valid(_ profile: String) -> Bool {
        lock.lock(); let known = checked[profile]; lock.unlock()
        if let known { return known }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exec)
        p.arguments = ["-p", profile, "/usr/bin/true"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        var ok = false
        if (try? p.run()) != nil { p.waitUntilExit(); ok = p.terminationStatus == 0 }
        lock.lock(); if checked.count > 200 { checked = [:] }; checked[profile] = ok; lock.unlock()
        if !ok { NSLog("Studio : profil de bulle refusé par macOS, agent lancé sans bulle.") }
        return ok
    }

    /// Dossier .git commun d'un dépôt ou d'une copie (`gitdir: /dépôt/.git/worktrees/nom` → `/dépôt/.git`).
    private static func gitCommon(_ dir: String) -> String? {
        let dotGit = dir + "/.git"
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dotGit, isDirectory: &isDir) else { return nil }
        if isDir.boolValue { return dotGit }
        guard let text = try? String(contentsOfFile: dotGit, encoding: .utf8),
              let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }) else { return nil }
        var target = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
        if !target.hasPrefix("/") { target = (dir as NSString).appendingPathComponent(target) }
        guard let r = target.range(of: "/.git/worktrees/", options: .backwards) else { return nil }
        return real(String(target[..<r.lowerBound]) + "/.git")
    }

    /// Nom du dossier des journaux de Claude Code pour un dossier (même règle que `ClaudeSessions.dirs`).
    private static func encode(_ path: String) -> String {
        String(decoding: path.utf16.map { c -> UInt16 in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ? c : 0x2D
        }, as: UTF16.self)
    }

    private static func real(_ p: String) -> String { ((p as NSString).standardizingPath as NSString).resolvingSymlinksInPath }
    private static func unique(_ list: [String]) -> [String] { var seen = Set<String>(); return list.filter { seen.insert($0).inserted } }

    /// `(subpath "…")`, ou nil pour un chemin qu'on ne sait pas écrire sans risque dans le profil.
    private static func subpath(_ p: String) -> String? {
        guard p.hasPrefix("/"), p != "/", p.rangeOfCharacter(from: CharacterSet(charactersIn: "\"\\").union(.controlCharacters)) == nil else { return nil }
        return "(subpath \"\(p)\")"
    }
    /// Texte littéral pour une expression rationnelle du profil (chaîne brute `#"…"`, donc sans guillemet).
    private static func rx(_ s: String) -> String? {
        guard !s.contains("\""), s.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return NSRegularExpression.escapedPattern(for: s)
    }
}
#endif
