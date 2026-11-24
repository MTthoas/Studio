// Bulle macOS des agents Claude Code lancés sur ce Mac (réglage « Terminal isolé », Réglages → Autorisations).
// L'agent part par `sandbox-exec -p <profil> claude …` : le profil Seatbelt vaut pour Claude Code et pour tout ce qu'il
// lance (Bash, git, npm, serveur MCP du navigateur), sans qu'aucun ne puisse en sortir.
// - Lecture : le système (/System, /usr, /opt, /Library, /tmp…) reste lisible ; tout ce qui est sous /Users (le
//   dossier personnel et ceux des autres utilisateurs, /Users/Shared) et /Volumes (disques externes) est fermé. Dans le
//   dossier personnel ne se rouvrent que le projet (dépôt, copies, leur .git commun, les journaux de la session) et une
//   liste blanche de quoi faire tourner les outils (git, gh, node/npm, claude… : leurs réglages, caches et binaires, les
//   dossiers ajoutés au PATH). Les réglages du shell (.zshrc, .bashrc, .profile…) restent illisibles exprès : ils
//   contiennent souvent des jetons. Par-dessus la liste blanche, restent fermés : les données de Studio (notes, coffre,
//   réglages : ~/Library/*/app.carnet.notes*), les dossiers des autres projets de Studio, les journaux des autres
//   sessions de Claude Code, l'agent SSH de Studio et quelques dossiers de secrets. Le projet reste lisible même s'il
//   est rangé sous un autre ; des dossiers au-dessus, seuls les attributs (stat) se lisent.
// - Écriture dans le dossier personnel : la copie de l'agent (et ses copies sœurs), le .git de leurs dépôts (sauf
//   hooks/), ~/.claude (sauf réglages, hooks, commandes…), les caches des outils et le trousseau. Hors du dossier
//   personnel : les dossiers temporaires (/tmp, /var/folders) et /dev seulement ; /Applications, /opt/homebrew,
//   /usr/local, /Library… sont fermés (pas d'installation globale depuis la bulle).
// - Supprimer ou installer : confirmé par Touch ID ou mot de passe avant chaque commande (AgentGuard.swift).
// - Réseau : ouvert (git push, npm install, gh). Ce qu'il peut envoyer se limite à ce qu'il peut lire.
// - Vie privée (`privacy`) : ni Apple Events, ni caméra, micro, localisation, presse-papiers, ni préférences et caches
//   des apps qui gardent ton activité (lus par cfprefsd, hors des règles de fichiers). Chaque règle est vérifiée seule.
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
        // Règles de vie privée : chacune vérifiée seule par macOS (une règle refusée est laissée de côté, pas la bulle).
        let kept = privacy().filter { valid("(version 1)\n(allow default)\n" + $0) }
        for strict in [true, false] {
            guard let base = build(project: pid, workDirs: workDirs, readDirs: readDirs, strict: strict) else { continue }
            for p in kept.isEmpty ? [base] : [([base] + kept).joined(separator: "\n"), base] where valid(p) { return p }
        }
        return nil
    }

    /// Ce qui ferait de l'agent un mouchard de ce que tu fais sur le Mac, hors de tes fichiers : fermé dans la bulle.
    /// - Apple Events (osascript) : pas de pilotage des autres apps (onglets de Safari, Mail, Messages, frappes).
    /// - Caméra, micro, localisation, presse-papiers (pbpaste : un mot de passe copié y traîne souvent). Les droits
    ///   accordés à Studio (micro pour la dictée…) passeraient sinon à l'agent, dont macOS le tient pour responsable.
    /// - Préférences des apps qui gardent ton activité (dossiers récents du Finder, Dock, Safari, Mail, Messages…) et
    ///   celles de Studio, lues par cfprefsd (`defaults read`) sans passer par les règles de fichiers ; leurs .plist
    ///   aussi, ~/Library/Preferences restant lisible pour les outils.
    /// - Caches des navigateurs et des apps personnelles dans ~/Library/Caches (pages visitées), lui aussi ouvert aux outils.
    static func privacy() -> [String] {
        let home = real(NSHomeDirectory())
        let studio = Bundle.main.bundleIdentifier ?? "app.carnet.notes"
        let domains = [studio, "com.apple.finder", "com.apple.dock", "com.apple.recentitems", "com.apple.sidebarlists",
                       "com.apple.Safari", "com.apple.mail", "com.apple.MobileSMS", "com.apple.iChat", "com.apple.Spotlight",
                       "com.apple.spotlight", "com.apple.Photos", "com.apple.Notes", "com.apple.iCal", "com.apple.AddressBook",
                       "com.apple.Terminal", "com.apple.Preview", "com.apple.TextEdit", "com.apple.QuickTimePlayerX",
                       "com.apple.Music", "com.apple.podcasts", "com.apple.TV", "com.apple.loginwindow", "com.apple.Siri",
                       "com.apple.assistant.support", "com.apple.FaceTime", "com.apple.Maps"]
        var rules = ["(deny appleevent-send)", "(deny device-camera)", "(deny device-microphone)",
                     "(deny mach-lookup (global-name \"com.apple.pasteboard.1\"))",
                     "(deny mach-lookup (global-name \"com.apple.locationd.registration\") (global-name \"com.apple.locationd.synchronous\")"
                        + " (global-name \"com.apple.locationd.desktop.registration\") (global-name \"com.apple.locationd.desktop.synchronous\"))",
                     "(deny user-preference-read " + domains.map { "(preference-domain \"\($0)\")" }.joined(separator: " ") + ")"]
        let caches = ["com.apple.Safari", "com.apple.mail", "com.apple.Messages", "com.apple.Notes", "com.apple.Photos", "com.apple.Maps",
                      "Google", "BraveSoftware", "Firefox", "Mozilla", "com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac",
                      "company.thebrowser.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi"]
        if let h = rx(home) {
            let d = domains.compactMap(rx).joined(separator: "|"), c = caches.compactMap(rx).joined(separator: "|")
            rules.append("(deny file-read* (regex #\"^\(h)/Library/Preferences/(ByHost/)?(\(d))\\.\")"
                + " (regex #\"^\(h)/Library/Caches/(\(c))(/|$)\"))")
        }
        return rules
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

        // Liste blanche de lecture dans le dossier personnel : ce qu'il faut pour faire tourner les outils, rien de plus.
        // Pas de .zshrc, .bashrc, .profile… : ils contiennent souvent des jetons, et l'agent ne lance pas de shell de connexion.
        let tools = [".config/git", ".config/gh", ".nvm", ".volta", ".fnm", ".asdf", ".local/bin", ".bun", ".deno",
                     ".cargo/bin", ".rustup", ".pyenv", "go/bin", ".npm-global", ".claude", ".local/share/claude",
                     ".local/state/claude", "Library/Keychains", "Library/Caches", "Library/pnpm", "Library/Preferences"].map { home + "/" + $0 }
        // Fichiers seuls (sans ce qui serait rangé à côté) : jamais les clés SSH, seulement les hôtes connus et la config.
        let toolFiles = [".gitconfig", ".gitignore_global", ".npmrc", ".yarnrc", ".yarnrc.yml", ".ssh/known_hosts", ".ssh/config",
                         ".CFUserTextEncoding"].map { home + "/" + $0 }
        // Dossiers ajoutés au PATH (Réglages → Autorisations) et dossier du programme claude réellement lancé.
        // Jamais le dossier personnel lui-même ni un de ses parents : ce serait tout rouvrir.
        var extra = AgentPermissions.path.map(real)
        if let bin = ClaudeCode.shared.binary() {
            extra += [(bin as NSString).deletingLastPathComponent, (real(bin) as NSString).deletingLastPathComponent]
        }
        let opened = unique(extra.filter { $0 != home && $0 != "/" && !home.hasPrefix($0 + "/") })
        let readable = unique(caches + tools + opened)

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
              let pOwnLogs = paths(ownLogs), let pSsh = paths([sshAgent]), let pTools = paths(readable),
              let pHomeRead = paths([home, "/Volumes", "/Users/Shared"]) else { return nil }
        // Seuls endroits inscriptibles hors du dossier personnel (par leurs deux chemins : /tmp est un lien vers /private/tmp).
        guard let pTemp = paths(["/private/tmp", "/tmp", "/private/var/folders", "/var/folders", "/private/var/tmp", "/var/tmp", "/dev"]) else { return nil }
        let pToolFiles = toolFiles.compactMap(literal).joined(separator: " ")
        // Attributs des dossiers au-dessus du projet et de la liste blanche (~/.local, ~/.config, ~/Library…).
        let up = unique((mine + readable + toolFiles).flatMap(ancestors)).compactMap(literal)
        let pUp = up.isEmpty ? "(literal \"/\")" : up.joined(separator: " ")

        var rules = ["(version 1)", "(allow default)",
                     // Lecture : fermé sous /Users (dossier personnel, autres utilisateurs, /Users/Shared) et /Volumes…
                     // Même dossiers par leur autre chemin (`/System/Volumes/Data/…`, le volume des données de macOS).
                     "(deny file-read* \(pHomeRead) (regex #\"^/Users/\") (regex #\"^/System/Volumes/Data/(Users|Volumes)/\"))",
                     // … rouvert pour les outils (réglages, caches, binaires) …
                     "(allow file-read* \(pTools) \(pToolFiles) \(claudeState))",
                     // … sauf données de Studio, autres projets, autres sessions, secrets ; puis le projet (et les
                     // journaux de sa session), rouvert même s'il est rangé sous l'un d'eux.
                     "(deny file-read* \(studioData) \(pOthers))",
                     "(allow file-read* \(pMine))",
                     // Les dossiers au-dessus du projet : seulement leurs attributs (stat, realpath), jamais leur contenu.
                     // Sans ça, git et node échouent sur « Operation not permitted » quand le projet est rangé dans
                     // le dossier d'un autre projet (ils remontent l'arborescence en résolvant les chemins).
                     "(allow file-read-metadata \(pUp))",
                     // Écriture : fermée partout (dossier personnel, /Applications, /opt/homebrew, /usr/local, /Library…),
                     // sauf les dossiers temporaires et /dev (terminaux, /dev/null), puis la copie, le .git, les caches
                     // et l'état de Claude Code. Avant, seul le dossier personnel était fermé : un agent pouvait écrire
                     // dans /Applications ou remplacer un programme de Homebrew, que tu lances ensuite hors de la bulle.
                     "(deny file-write* (regex #\"^/\"))",
                     "(allow file-write* \(pTemp))",
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
    /// `(literal "…")` : ce chemin seul, sans ce qu'il contient.
    private static func literal(_ p: String) -> String? {
        guard p.hasPrefix("/"), p.rangeOfCharacter(from: CharacterSet(charactersIn: "\"\\").union(.controlCharacters)) == nil else { return nil }
        return "(literal \"\(p)\")"
    }
    /// Dossiers parents d'un chemin, jusqu'à « / » compris (`/a/b/c` → `/a/b`, `/a`, `/`).
    private static func ancestors(_ p: String) -> [String] {
        var out: [String] = [], cur = p
        while cur != "/" && !cur.isEmpty { cur = (cur as NSString).deletingLastPathComponent; out.append(cur) }
        return out
    }
    /// Texte littéral pour une expression rationnelle du profil (chaîne brute `#"…"`, donc sans guillemet).
    private static func rx(_ s: String) -> String? {
        guard !s.contains("\""), s.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return NSRegularExpression.escapedPattern(for: s)
    }
}
#endif
