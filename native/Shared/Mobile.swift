// Développement mobile d'un projet, depuis le Mac (onglet Mobile).
//
// Studio cherche une app mobile dans le dossier du projet, à des emplacements connus (racine, mobile/, app/,
// apps/mobile/…) : Expo, React Native, Flutter, Capacitor, un projet Xcode ou un projet Android (Gradle). Il liste
// les simulateurs iOS (simctl) et les émulateurs Android (adb, emulator), les démarre, lance l'app dessus, montre
// leur écran et règle ce qu'on teste sans cesse : apparence claire ou sombre, taille du texte, barre d'état de
// démonstration, lien profond, capture.
//
// Garde-fous : la page ne fournit jamais de chemin ni de commande. Elle désigne un emplacement relatif et un
// appareil, que Studio doit retrouver lui-même dans ce qu'il vient de détecter ; chaque commande est construite
// ici, argument par argument, sans passer par un shell (sauf le script fixe du build Xcode, qui reçoit ses valeurs
// en paramètres positionnels). Lancer une app exécute le code du projet : seul le Mac peut le demander
// (« project.mobile » n'est pas dans REMOTE_ALLOWED, link.ts). Tout s'arrête avec l'app.
import Foundation
#if os(macOS)
import AppKit

final class Mobile {
    static let shared = Mobile()
    private let lock = NSLock()
    private var runs: [String: Run] = [:]

    /// Une app mobile trouvée dans le dossier du projet.
    struct App {
        let rel: String
        let dir: String
        /// « expo », « rn », « flutter », « capacitor », « xcode » ou « gradle ».
        let kind: String
        let label: String
        let platforms: [String]
        /// Gestionnaire de paquets (apps JavaScript), sinon vide.
        let tool: String
    }

    /// Un simulateur iOS, un émulateur Android (démarré ou non) ou un appareil Android branché.
    struct Device {
        /// UDID du simulateur, numéro de série adb, ou « avd:<nom> » pour un émulateur éteint.
        let id: String
        let name: String
        let os: String
        let runtime: String
        let booted: Bool
        let tablet: Bool
    }

    /// Une app en cours de lancement ou d'exécution, ou terminée et pas encore refermée.
    final class Run {
        let rel: String
        let kind: String
        let label: String
        let platform: String
        let device: String
        let deviceName: String
        let command: String
        let name: String
        /// La commande rend la main une fois l'app installée (build natif) ; sinon c'est un serveur qui reste ouvert.
        let ends: Bool
        let started = Date()
        var ended: Date?
        /// « running », « done », « error » ou « stopped ».
        var status = "running"
        var code: Int32 = 0
        var log = ""
        var process: Process?
        /// Entrée de « flutter run » : « r » recharge à chaud, « R » redémarre l'app.
        var input: FileHandle?
        init(rel: String, kind: String, label: String, platform: String, device: String, deviceName: String, command: String, name: String, ends: Bool) {
            self.rel = rel; self.kind = kind; self.label = label; self.platform = platform; self.device = device
            self.deviceName = deviceName; self.command = command; self.name = name; self.ends = ends
        }
    }

    // MARK: Détection des apps

    private static let places = ["", "mobile", "app", "native", "client", "frontend", "ios", "android",
                                 "apps/mobile", "apps/app", "apps/native", "apps/expo", "apps/ios", "apps/android",
                                 "packages/mobile", "packages/app"]

    private static func tool(_ dir: String, _ root: String) -> String {
        let fm = FileManager.default
        for d in [dir, root] {
            if fm.fileExists(atPath: d + "/pnpm-lock.yaml") { return "pnpm" }
            if fm.fileExists(atPath: d + "/yarn.lock") { return "yarn" }
            if fm.fileExists(atPath: d + "/bun.lockb") || fm.fileExists(atPath: d + "/bun.lock") { return "bun" }
            if fm.fileExists(atPath: d + "/package-lock.json") { return "npm" }
        }
        return "npm"
    }

    /// Conteneur Xcode d'un dossier : l'espace de travail s'il existe (CocoaPods), sinon le projet.
    private static func xcodeContainer(_ dir: String) -> (flag: String, name: String)? {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).sorted()
        if let w = names.first(where: { $0.hasSuffix(".xcworkspace") }) { return ("-workspace", w) }
        if let p = names.first(where: { $0.hasSuffix(".xcodeproj") }) { return ("-project", p) }
        return nil
    }

    func apps(_ root: String) -> [App] {
        let fm = FileManager.default
        var out: [App] = []
        // Emplacements d'une app multiplateforme : ses dossiers ios/ et android/ en font partie, on ne les relance pas à part.
        var cross = Set<String>()
        for rel in Self.places {
            let dir = rel.isEmpty ? root : root + "/" + rel
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { continue }
            let parent = rel.contains("/") ? String(rel[..<rel.lastIndex(of: "/")!]) : ""
            if !rel.isEmpty, cross.contains(parent) { continue }
            let hasIOS = fm.fileExists(atPath: dir + "/ios"), hasAndroid = fm.fileExists(atPath: dir + "/android")
            if let data = fm.contents(atPath: dir + "/package.json"), data.count < 2_000_000,
               let pkg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                var deps = Set<String>()
                for k in ["dependencies", "devDependencies"] {
                    if let d = pkg[k] as? [String: Any] { deps.formUnion(d.keys) }
                }
                let t = Self.tool(dir, root)
                if deps.contains("expo") {
                    out.append(App(rel: rel, dir: dir, kind: "expo", label: "Expo", platforms: ["ios", "android"], tool: t)); cross.insert(rel); continue
                }
                if deps.contains("react-native") {
                    out.append(App(rel: rel, dir: dir, kind: "rn", label: "React Native", platforms: ["ios", "android"], tool: t)); cross.insert(rel); continue
                }
                if deps.contains("@capacitor/core") {
                    // Capacitor ne lance que les plateformes déjà ajoutées au projet (npx cap add ios).
                    let p = (hasIOS ? ["ios"] : []) + (hasAndroid ? ["android"] : [])
                    out.append(App(rel: rel, dir: dir, kind: "capacitor", label: "Capacitor", platforms: p.isEmpty ? ["ios", "android"] : p, tool: t)); cross.insert(rel); continue
                }
            }
            if let data = fm.contents(atPath: dir + "/pubspec.yaml"), data.count < 1_000_000,
               String(decoding: data, as: UTF8.self).range(of: #"(?m)^\s*sdk:\s*flutter\s*$"#, options: .regularExpression) != nil {
                let p = (hasIOS ? ["ios"] : []) + (hasAndroid ? ["android"] : [])
                out.append(App(rel: rel, dir: dir, kind: "flutter", label: "Flutter", platforms: p.isEmpty ? ["ios", "android"] : p, tool: "")); cross.insert(rel); continue
            }
            if Self.xcodeContainer(dir) != nil {
                out.append(App(rel: rel, dir: dir, kind: "xcode", label: "App iOS (Xcode)", platforms: ["ios"], tool: ""))
            }
            if fm.fileExists(atPath: dir + "/gradlew"), fm.fileExists(atPath: dir + "/settings.gradle") || fm.fileExists(atPath: dir + "/settings.gradle.kts") {
                out.append(App(rel: rel, dir: dir, kind: "gradle", label: "App Android (Gradle)", platforms: ["android"], tool: ""))
            }
        }
        return out
    }

    /// Préfixe qui lance un outil du projet selon son gestionnaire de paquets.
    private static func runner(_ tool: String) -> [String] {
        switch tool {
        case "pnpm": return ["pnpm", "exec"]
        case "yarn": return ["yarn"]
        case "bun": return ["bunx"]
        default: return ["npx"]
        }
    }

    /// Commande d'une app pour une plateforme et un appareil ; `ends` : elle rend la main une fois l'app installée.
    private static func command(_ a: App, platform: String, device: String) -> (args: [String], ends: Bool)? {
        let ios = platform == "ios"
        switch a.kind {
        case "expo": return (runner(a.tool) + ["expo", "start", ios ? "--ios" : "--android"], false)
        case "rn": return (runner(a.tool) + ["react-native", ios ? "run-ios" : "run-android"] + (ios && !device.isEmpty ? ["--udid", device] : []), true)
        case "capacitor": return (runner(a.tool) + ["cap", "run", ios ? "ios" : "android"] + (device.isEmpty ? [] : ["--target", device]), true)
        case "flutter": return (["flutter", "run"] + (device.isEmpty ? [] : ["-d", device]), false)
        case "gradle": return (["./gradlew", "installDebug"], true)
        case "xcode": return (["xcodebuild", "build"], true)
        default: return nil
        }
    }
    private static func shown(_ a: App, platform: String) -> String {
        if a.kind == "xcode" { return "xcodebuild, puis simctl install et launch" }
        return command(a, platform: platform, device: "")?.args.joined(separator: " ") ?? ""
    }

    // MARK: Outils et appareils

    private static var sdk: String? {
        let env = ProcessInfo.processInfo.environment
        for c in [env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"], NSHomeDirectory() + "/Library/Android/sdk"] {
            if let c = c, !c.isEmpty, FileManager.default.fileExists(atPath: c + "/platform-tools") { return c }
        }
        return nil
    }
    private static var adb: String? {
        if let s = sdk, FileManager.default.isExecutableFile(atPath: s + "/platform-tools/adb") { return s + "/platform-tools/adb" }
        return Sites.find("adb")
    }
    private static var emulator: String? {
        if let s = sdk, FileManager.default.isExecutableFile(atPath: s + "/emulator/emulator") { return s + "/emulator/emulator" }
        return Sites.find("emulator")
    }
    private static let xcrun = "/usr/bin/xcrun"

    private static func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        var path = Sites.searchPath()
        if let s = sdk { path += [s + "/platform-tools", s + "/emulator"]; env["ANDROID_HOME"] = s }
        env["PATH"] = path.joined(separator: ":")
        env["NO_COLOR"] = "1"; env["FORCE_COLOR"] = "0"
        return env
    }

    /// Lance un outil et attend sa fin (délai en secondes) : code de sortie, sortie standard, erreur en texte.
    private static func exec(_ exe: String, _ args: [String], timeout: TimeInterval = 20, cwd: String? = nil) -> (code: Int32, out: Data, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = environment()
        if let d = cwd { p.currentDirectoryURL = URL(fileURLWithPath: d, isDirectory: true) }
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, Data(), "Impossible de lancer \((exe as NSString).lastPathComponent).") }
        var errData = Data()
        let done = DispatchGroup()
        done.enter()
        DispatchQueue.global(qos: .utility).async { errData = err.fileHandleForReading.readDataToEndOfFile(); done.leave() }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        done.wait()
        return (p.terminationStatus, data, String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static let udid = try! NSRegularExpression(pattern: "^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")
    private static func isUDID(_ s: String) -> Bool { udid.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

    /// Simulateurs iOS disponibles (iPhone et iPad), démarrés d'abord, puis du système le plus récent au plus ancien.
    private func simulators() -> (ok: Bool, list: [Device]) {
        guard FileManager.default.isExecutableFile(atPath: Self.xcrun) else { return (false, []) }
        let r = Self.exec(Self.xcrun, ["simctl", "list", "devices", "available", "--json"], timeout: 15)
        guard r.code == 0, let json = (try? JSONSerialization.jsonObject(with: r.out)) as? [String: Any],
              let groups = json["devices"] as? [String: [[String: Any]]] else { return (false, []) }
        var rows: [(Device, [Int])] = []
        for (key, list) in groups {
            // « com.apple.CoreSimulator.SimRuntime.iOS-26-5 » → « iOS 26.5 » ; les montres et téléviseurs ne sont pas listés.
            let tail = key.components(separatedBy: ".").last ?? ""
            guard tail.hasPrefix("iOS-") else { continue }
            let nums = tail.dropFirst(4).split(separator: "-").compactMap { Int($0) }
            let runtime = "iOS " + nums.map(String.init).joined(separator: ".")
            for d in list {
                guard let id = d["udid"] as? String, Self.isUDID(id), let name = d["name"] as? String else { continue }
                rows.append((Device(id: id, name: String(name.prefix(60)), os: "ios", runtime: runtime, booted: d["state"] as? String == "Booted", tablet: name.hasPrefix("iPad")), nums))
            }
        }
        rows.sort { a, b in
            if a.0.booted != b.0.booted { return a.0.booted }
            if a.1 != b.1 { return b.1.lexicographicallyPrecedes(a.1) }
            if a.0.tablet != b.0.tablet { return !a.0.tablet }
            return a.0.name.localizedStandardCompare(b.0.name) == .orderedAscending
        }
        return (true, rows.prefix(80).map { $0.0 })
    }

    private static let avdName = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]{1,80}$")
    private static let serial = try! NSRegularExpression(pattern: "^[A-Za-z0-9._:-]{1,80}$")
    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool { re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

    /// Appareils Android : ceux qu'adb voit (émulateurs démarrés, téléphones branchés), puis les émulateurs éteints.
    private func androids() -> (ok: Bool, list: [Device]) {
        var out: [Device] = [], running = Set<String>()
        let adb = Self.adb, emulator = Self.emulator
        if let adb = adb {
            let r = Self.exec(adb, ["devices", "-l"], timeout: 8)
            for line in String(decoding: r.out, as: UTF8.self).split(separator: "\n").dropFirst() {
                let f = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
                guard f.count >= 2, f[1] == "device", Self.matches(Self.serial, f[0]) else { continue }
                var name = f.first(where: { $0.hasPrefix("model:") }).map { String($0.dropFirst(6)).replacingOccurrences(of: "_", with: " ") } ?? f[0]
                if f[0].hasPrefix("emulator-") {
                    let n = String(decoding: Self.exec(adb, ["-s", f[0], "emu", "avd", "name"], timeout: 4).out, as: UTF8.self)
                        .split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
                    if Self.matches(Self.avdName, n) { running.insert(n); name = n.replacingOccurrences(of: "_", with: " ") }
                }
                out.append(Device(id: f[0], name: String(name.prefix(60)), os: "android", runtime: f[0].hasPrefix("emulator-") ? "Émulateur" : "Appareil branché", booted: true, tablet: false))
            }
        }
        if let emulator = emulator {
            let r = Self.exec(emulator, ["-list-avds"], timeout: 8)
            for line in String(decoding: r.out, as: UTF8.self).split(whereSeparator: \.isNewline) {
                let n = line.trimmingCharacters(in: .whitespaces)
                guard Self.matches(Self.avdName, n), !running.contains(n) else { continue }
                out.append(Device(id: "avd:" + n, name: n.replacingOccurrences(of: "_", with: " "), os: "android", runtime: "Émulateur", booted: false, tablet: false))
            }
        }
        return (adb != nil, out)
    }

    private func device(_ id: String) -> Device? {
        if Self.isUDID(id) { return simulators().list.first(where: { $0.id == id }) }
        return androids().list.first(where: { $0.id == id })
    }

    // MARK: État

    /// Y a-t-il une app mobile dans le dossier ? Lecture de fichiers seulement : sert à montrer ou non l'onglet.
    func probe(_ pid: String) -> [String: Any] {
        guard let root = ProjectFolders.shared.path(pid) else { return ["ok": true, "folder": false, "count": 0] }
        return ["ok": true, "folder": true, "count": apps(root).count]
    }

    /// Ce que l'onglet Mobile affiche : les apps trouvées, les appareils, les outils présents, et l'app lancée.
    func state(_ pid: String) -> [String: Any] {
        var r: [String: Any] = ["ok": true]
        if let root = ProjectFolders.shared.path(pid) {
            r["folder"] = true
            r["apps"] = apps(root).map { a -> [String: Any] in
                var cmds: [String: String] = [:]
                for p in a.platforms { cmds[p] = Self.shown(a, platform: p) }
                return ["rel": a.rel, "kind": a.kind, "label": a.label, "platforms": a.platforms, "commands": cmds]
            }
        } else {
            r["folder"] = false; r["apps"] = [[String: Any]]()
        }
        let sims = simulators(), droids = androids()
        r["tools"] = ["xcode": sims.ok, "android": droids.ok]
        r["devices"] = (sims.list + droids.list).map { d -> [String: Any] in
            ["id": d.id, "name": d.name, "os": d.os, "runtime": d.runtime, "booted": d.booted, "tablet": d.tablet]
        }
        lock.lock(); defer { lock.unlock() }
        if let x = runs[pid] {
            var info: [String: Any] = [
                "rel": x.rel, "kind": x.kind, "label": x.label, "platform": x.platform, "device": x.device, "deviceName": x.deviceName,
                "command": x.command, "status": x.status, "code": Int(x.code), "ends": x.ends, "reload": x.input != nil && x.status == "running",
                "since": Int(x.started.timeIntervalSince1970 * 1000), "log": String(x.log.suffix(4000)),
            ]
            if let e = x.ended { info["ended"] = Int(e.timeIntervalSince1970 * 1000) }
            r["run"] = info
        }
        return r
    }

    // MARK: Appareils : démarrer, éteindre, régler

    private static func fail(_ r: (code: Int32, out: Data, err: String), _ fallback: String) -> [String: Any] {
        let detail = r.err.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
        return ["ok": false, "message": detail.isEmpty ? fallback : String(detail.prefix(240))]
    }

    /// Démarre un simulateur ou un émulateur (ou le ramène devant s'il tourne déjà).
    func boot(_ id: String) -> [String: Any] {
        guard let d = device(id) else { return ["ok": false, "message": "Appareil introuvable."] }
        if d.os == "ios" {
            if !d.booted {
                let r = Self.exec(Self.xcrun, ["simctl", "boot", d.id], timeout: 60)
                if r.code != 0, !r.err.contains("current state: Booted") { return Self.fail(r, "Impossible de démarrer ce simulateur.") }
            }
            // La fenêtre du simulateur : sans elle, l'appareil tourne mais on ne peut pas y toucher.
            _ = Self.exec("/usr/bin/open", ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", d.id], timeout: 10)
            return ["ok": true]
        }
        guard d.id.hasPrefix("avd:") else { return ["ok": true] }
        guard let emulator = Self.emulator else { return ["ok": false, "message": "L'émulateur Android est introuvable (Android Studio → SDK Manager → Android Emulator)."] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: emulator)
        p.arguments = ["-avd", String(d.id.dropFirst(4))]
        p.environment = Self.environment()
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return ["ok": false, "message": "Impossible de démarrer cet émulateur."] }
        return ["ok": true]
    }

    func shutdown(_ id: String) -> [String: Any] {
        guard let d = device(id), d.booted else { return ["ok": true] }
        if d.os == "ios" {
            let r = Self.exec(Self.xcrun, ["simctl", "shutdown", d.id], timeout: 30)
            return r.code == 0 ? ["ok": true] : Self.fail(r, "Impossible d'éteindre ce simulateur.")
        }
        guard d.id.hasPrefix("emulator-"), let adb = Self.adb else { return ["ok": false, "message": "Seul un émulateur s'éteint d'ici."] }
        let r = Self.exec(adb, ["-s", d.id, "emu", "kill"], timeout: 10)
        return r.code == 0 ? ["ok": true] : Self.fail(r, "Impossible d'éteindre cet émulateur.")
    }

    /// Réduit une capture (PNG ou JPEG) à `maxHeight` pixels de haut et la rend en JPEG : l'écran en direct passe par
    /// le pont toutes les deux secondes, inutile d'y envoyer trois mégaoctets.
    private static func shrink(_ data: Data, maxHeight: CGFloat = 1300) -> (data: Data, w: Int, h: Int)? {
        guard let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { return nil }
        let w = CGFloat(cg.width), h = CGFloat(cg.height)
        let k = min(1, maxHeight / max(h, 1))
        let tw = max(1, Int((w * k).rounded())), th = max(1, Int((h * k).rounded()))
        guard let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: tw, height: th))
        guard let small = ctx.makeImage(),
              let jpeg = NSBitmapImageRep(cgImage: small).representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { return nil }
        return (jpeg, tw, th)
    }

    /// Capture brute de l'écran d'un appareil démarré, en PNG.
    private func capture(_ d: Device) -> (data: Data?, failure: [String: Any]) {
        if d.os == "ios" {
            let file = NSTemporaryDirectory() + "studio-mobile-\(d.id).png"
            defer { try? FileManager.default.removeItem(atPath: file) }
            let r = Self.exec(Self.xcrun, ["simctl", "io", d.id, "screenshot", "--type=png", file], timeout: 15)
            guard r.code == 0, let data = FileManager.default.contents(atPath: file) else { return (nil, Self.fail(r, "Capture impossible.")) }
            return (data, [:])
        }
        guard let adb = Self.adb else { return (nil, ["ok": false, "message": "adb est introuvable."]) }
        let r = Self.exec(adb, ["-s", d.id, "exec-out", "screencap", "-p"], timeout: 15)
        guard r.code == 0, !r.out.isEmpty else { return (nil, Self.fail(r, "Capture impossible.")) }
        return (r.out, [:])
    }

    /// Écran d'un appareil démarré, pour l'aperçu en direct.
    func screen(_ id: String) -> [String: Any] {
        guard let d = device(id), d.booted else { return ["ok": false, "message": "Cet appareil n'est pas démarré."] }
        let c = capture(d)
        guard let data = c.data else { return c.failure }
        guard let s = Self.shrink(data) else { return ["ok": false, "message": "Capture illisible."] }
        return ["ok": true, "image": s.data.base64EncodedString(), "w": s.w, "h": s.h]
    }

    /// Enregistre une capture en pleine définition sur le Bureau.
    func snap(_ id: String) -> [String: Any] {
        guard let d = device(id), d.booted else { return ["ok": false, "message": "Cet appareil n'est pas démarré."] }
        let c = capture(d)
        guard let data = c.data else { return c.failure }
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "yyyy-MM-dd 'à' HH.mm.ss"
        let safe = d.name.replacingOccurrences(of: "[^A-Za-z0-9 ._()-]", with: "", options: .regularExpression)
        let name = "Studio – \(safe) – \(f.string(from: Date())).png"
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop").appendingPathComponent(name)
        do { try data.write(to: url, options: .atomic) } catch { return ["ok": false, "message": "Impossible d'écrire sur le Bureau."] }
        return ["ok": true, "name": name]
    }

    /// Réglages d'un appareil démarré : `look` (light, dark), `text` (small, normal, large, huge), `bar` (demo, real).
    func tune(_ id: String, what: String, value: String) -> [String: Any] {
        guard let d = device(id), d.booted else { return ["ok": false, "message": "Cet appareil n'est pas démarré."] }
        var steps: [[String]] = []
        let ios = d.os == "ios"
        switch what {
        case "look":
            guard value == "light" || value == "dark" else { return ["ok": false, "message": "Apparence inconnue."] }
            steps = ios ? [["simctl", "ui", d.id, "appearance", value]] : [["shell", "cmd", "uimode", "night", value == "dark" ? "yes" : "no"]]
        case "text":
            let sizes: [String: (String, String)] = ["small": ("small", "0.85"), "normal": ("large", "1.0"), "large": ("extra-extra-large", "1.3"), "huge": ("accessibility-extra-large", "1.8")]
            guard let s = sizes[value] else { return ["ok": false, "message": "Taille inconnue."] }
            steps = ios ? [["simctl", "ui", d.id, "content_size", s.0]] : [["shell", "settings", "put", "system", "font_scale", s.1]]
        case "bar":
            // Barre d'état de démonstration : 9:41, réseau et batterie pleins, pour des captures propres.
            let demo = value == "demo"
            if ios {
                steps = demo ? [["simctl", "status_bar", d.id, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
                                 "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"]]
                    : [["simctl", "status_bar", d.id, "clear"]]
            } else {
                let say = ["shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command"]
                steps = demo ? [["shell", "settings", "put", "global", "sysui_demo_allowed", "1"], say + ["enter"], say + ["clock", "-e", "hhmm", "0941"],
                                say + ["battery", "-e", "level", "100", "-e", "plugged", "false"], say + ["network", "-e", "wifi", "show", "-e", "level", "4"],
                                say + ["notifications", "-e", "visible", "false"]]
                    : [say + ["exit"]]
            }
        default: return ["ok": false, "message": "Réglage inconnu."]
        }
        for s in steps {
            let r: (code: Int32, out: Data, err: String)
            if ios { r = Self.exec(Self.xcrun, s, timeout: 15) } else {
                guard let adb = Self.adb else { return ["ok": false, "message": "adb est introuvable."] }
                r = Self.exec(adb, ["-s", d.id] + s, timeout: 15)
            }
            if r.code != 0 { return Self.fail(r, "Le réglage n'a pas été appliqué.") }
        }
        return ["ok": true]
    }

    private static let link = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9+.-]{1,40}:[^\\s'\"\\\\`$<>]{1,2000}$")
    /// Ouvre une adresse sur l'appareil : lien profond de l'app (monapp://ecran) ou page web.
    func open(_ id: String, url: String) -> [String: Any] {
        guard let d = device(id), d.booted else { return ["ok": false, "message": "Cet appareil n'est pas démarré."] }
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.matches(Self.link, u) else { return ["ok": false, "message": "Adresse refusée : attendu un lien du type monapp://ecran ou https://…"] }
        if d.os == "ios" {
            let r = Self.exec(Self.xcrun, ["simctl", "openurl", d.id, u], timeout: 15)
            return r.code == 0 ? ["ok": true] : Self.fail(r, "Aucune app n'ouvre ce lien sur le simulateur.")
        }
        guard let adb = Self.adb else { return ["ok": false, "message": "adb est introuvable."] }
        // « adb shell » recolle ses arguments en une ligne de commande sur l'appareil : l'adresse y va entre apostrophes
        // (le filtre ci-dessus refuse apostrophes, guillemets, « $ » et accents graves).
        let r = Self.exec(adb, ["-s", d.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "'\(u)'"], timeout: 15)
        return r.code == 0 ? ["ok": true] : Self.fail(r, "Aucune app n'ouvre ce lien sur l'appareil.")
    }

    // MARK: Lancer l'app

    /// Premier schéma du projet Xcode (ceux de CocoaPods écartés).
    private static func scheme(_ dir: String, _ c: (flag: String, name: String)) -> String? {
        guard let xcodebuild = Sites.find("xcodebuild") else { return nil }
        let r = exec(xcodebuild, ["-list", "-json", c.flag, c.name], timeout: 90, cwd: dir)
        guard let json = (try? JSONSerialization.jsonObject(with: r.out)) as? [String: Any] else { return nil }
        let box = (json["workspace"] ?? json["project"]) as? [String: Any]
        let all = (box?["schemes"] as? [String] ?? []).filter { !$0.hasPrefix("Pods-") }
        // Le schéma qui porte le nom du projet est presque toujours celui de l'app.
        let base = (c.name as NSString).deletingPathExtension
        return all.first(where: { $0 == base }) ?? all.first
    }

    /// Build Xcode pour simulateur, puis installation et lancement. Les valeurs arrivent en paramètres positionnels.
    private static let xcodeScript = """
        set -e
        xcodebuild "$1" "$2" -scheme "$3" -configuration Debug -destination "platform=iOS Simulator,id=$4" -derivedDataPath "$5" build
        app=$(/usr/bin/find "$5/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name "*.app" | /usr/bin/head -n 1)
        [ -n "$app" ] || { echo "Le build n'a produit aucune app pour simulateur."; exit 1; }
        bundle=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Info.plist")
        /usr/bin/xcrun simctl install "$4" "$app"
        /usr/bin/xcrun simctl launch "$4" "$bundle"
        echo "App lancée sur le simulateur."
        """

    /// Lance l'app détectée à `rel` sur un appareil. `name` (nom du projet) ne sert qu'au texte de la notification.
    func run(_ pid: String, rel: String, kind: String, platform: String, device id: String, name: String) -> [String: Any] {
        guard let root = ProjectFolders.shared.path(pid) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        guard let a = apps(root).first(where: { $0.rel == rel && $0.kind == kind }), a.platforms.contains(platform) else {
            return ["ok": false, "message": "Aucune app mobile trouvée à cet emplacement."]
        }
        guard let d = device(id), d.os == platform else { return ["ok": false, "message": platform == "ios" ? "Choisis un simulateur iOS." : "Choisis un appareil Android."] }
        if d.os == "android", !d.booted { return ["ok": false, "message": "Démarre d'abord cet émulateur, puis relance."] }
        guard var cmd = Self.command(a, platform: platform, device: d.id) else { return ["ok": false, "message": "Type d'app inconnu."] }
        var exe = "", shown = cmd.args.joined(separator: " ")
        if a.kind == "xcode" {
            guard let c = Self.xcodeContainer(a.dir) else { return ["ok": false, "message": "Projet Xcode introuvable."] }
            guard let s = Self.scheme(a.dir, c) else { return ["ok": false, "message": "Aucun schéma partagé dans ce projet Xcode (Xcode → Product → Scheme → Manage Schemes → Shared)."] }
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path ?? NSTemporaryDirectory()
            let derived = caches + "/studio-mobile/" + pid.filter { $0.isLetter || $0.isNumber || $0 == "-" }
            exe = "/bin/sh"
            cmd.args = ["-c", Self.xcodeScript, "studio-mobile", c.flag, c.name, s, d.id, derived]
            shown = "xcodebuild -scheme \(s) build, puis simctl install et launch"
        } else if a.kind == "gradle" {
            exe = "/bin/sh"; cmd.args = [a.dir + "/gradlew", "installDebug"]
        } else {
            let tool = cmd.args.removeFirst()
            guard let found = Sites.find(tool) else {
                return ["ok": false, "message": "« \(tool) » est introuvable sur ce Mac. Ajoute son dossier dans Réglages → Autorisations des agents → Dossiers des outils."]
            }
            exe = found
        }
        // Le simulateur démarre avant l'app : Expo et React Native visent celui qui tourne.
        if d.os == "ios" { let b = boot(d.id); if b["ok"] as? Bool != true { return b } }
        stop(pid)
        let x = Run(rel: a.rel, kind: a.kind, label: a.label, platform: platform, device: d.id, deviceName: d.name, command: shown, name: String(name.prefix(80)), ends: cmd.ends)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = cmd.args
        p.currentDirectoryURL = URL(fileURLWithPath: a.dir, isDirectory: true)
        var env = Self.environment()
        if d.os == "android" { env["ANDROID_SERIAL"] = d.id }
        p.environment = env
        let out = Pipe()
        p.standardOutput = out; p.standardError = out
        if a.kind == "flutter" {
            let input = Pipe()
            p.standardInput = input; x.input = input.fileHandleForWriting
        } else {
            p.standardInput = FileHandle.nullDevice
        }
        out.fileHandleForReading.readabilityHandler = { [weak self, weak x] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self = self, let x = x else { handle.readabilityHandler = nil; return }
            let text = Sites.clean(String(decoding: data, as: UTF8.self))
            self.lock.lock(); x.log = String((x.log + text).suffix(12000)); self.lock.unlock()
        }
        p.terminationHandler = { [weak self, weak x] proc in
            guard let self = self, let x = x else { return }
            self.lock.lock()
            let wasRunning = x.status == "running"
            if wasRunning { x.status = proc.terminationStatus == 0 && x.ends ? "done" : "error" }
            x.code = proc.terminationStatus; x.ended = Date(); x.process = nil; x.input = nil
            let status = x.status
            self.lock.unlock()
            // Un build natif dure : sa fin est annoncée. Arrêté à la main, ou simple serveur : pas de notification.
            guard wasRunning, x.ends else { return }
            let who = x.name.isEmpty ? "" : " · \(x.name)"
            Notifier.shared.post(title: status == "done" ? "App lancée\(who)" : "Lancement en échec\(who)",
                                 body: status == "done" ? "\(x.label) est installée sur \(x.deviceName)." : "\(x.label) n'a pas pu être lancée sur \(x.deviceName) (code \(proc.terminationStatus)).",
                                 url: nil, thread: "build")
        }
        do { try p.run() } catch { return ["ok": false, "message": "Impossible de lancer « \(shown) »."] }
        x.process = p
        lock.lock(); runs[pid] = x; lock.unlock()
        return state(pid)
    }

    /// Recharge à chaud (« r ») ou redémarre (« R ») l'app Flutter en cours.
    func reload(_ pid: String, full: Bool) -> [String: Any] {
        lock.lock(); let input = runs[pid]?.status == "running" ? runs[pid]?.input : nil; lock.unlock()
        guard let h = input else { return ["ok": false, "message": "Aucune app à recharger."] }
        do { try h.write(contentsOf: Data((full ? "R" : "r").utf8)) } catch { return ["ok": false, "message": "L'app ne répond plus."] }
        return ["ok": true]
    }

    /// Arrête l'app lancée et oublie son journal (bouton Arrêter ou Fermer).
    @discardableResult
    func stop(_ pid: String) -> [String: Any] {
        lock.lock()
        let x = runs.removeValue(forKey: pid)
        if x?.status == "running" { x?.status = "stopped" }
        let process = x?.process
        lock.unlock()
        if let p = process, p.isRunning {
            for child in Sites.descendants(of: p.processIdentifier) { kill(child, SIGTERM) }
            p.terminate()
        }
        return ["ok": true]
    }

    /// À la fermeture de Studio : aucun serveur de développement ne doit lui survivre (les simulateurs, eux, restent).
    func stopAll() {
        lock.lock(); let ids = Array(runs.keys); lock.unlock()
        for id in ids { stop(id) }
    }

    // MARK: Agents

    /// Ce qu'un agent Claude Code doit savoir quand son dossier contient une app mobile : comment voir son travail
    /// à l'écran sans se lancer dans un build natif de dix minutes.
    func agentNote(dir: String, shell: Bool) -> String {
        let found = apps(dir)
        guard !found.isEmpty else { return "" }
        let what = found.prefix(3).map { "\($0.label) (\($0.rel.isEmpty ? "racine" : $0.rel + "/"))" }.joined(separator: ", ")
        var s = "Ce dépôt contient une app mobile : \(what). Pense mobile dans ce que tu écris : zones sûres (encoche, barre d'accueil), "
            + "clavier qui recouvre les champs, cibles tactiles d'au moins 44 points, mode sombre, grandes tailles de texte, et les deux plateformes quand le code est partagé."
        if shell {
            s += " Pour voir ton travail à l'écran : « xcrun simctl list devices booted » dit si un simulateur tourne ; si oui, "
                + "« xcrun simctl io booted screenshot /tmp/ecran.png » puis Read sur l'image (« adb exec-out screencap -p > /tmp/ecran.png » pour Android). "
                + "L'utilisateur lance l'app depuis l'onglet Mobile de Studio : ne démarre pas de simulateur et ne lance pas de build natif "
                + "(xcodebuild, gradlew, expo run, flutter build) sans qu'on te le demande ; préfère la vérification des types, le lint et les tests."
        }
        return s
    }
}
#endif
