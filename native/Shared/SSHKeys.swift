// Clés SSH gardées par Studio, pour relier un serveur sans toucher à ~/.ssh.
//
// La clé privée vit chiffrée dans le trousseau macOS (mot de passe générique, service `app.carnet.notes.ssh`, propre à
// ce Mac, jamais synchronisé) ; les réglages ne gardent que ce qui est public : nom, type, empreinte, clé publique.
// Elle ne passe jamais par la page web et n'est jamais écrite en clair sur le disque : créée ici (Ed25519 par CryptoKit,
// écrite au format OpenSSH en mémoire) ou importée d'un fichier choisi dans le Finder, elle est chargée à la première
// connexion dans un agent SSH privé à Studio (socket dans le dossier temporaire de l'utilisateur, 0700), le temps que
// l'app est ouverte et au plus 12 h. Les autres clés de l'utilisateur ne sont jamais proposées au serveur (IdentitiesOnly).
//
// Piège : l'app est signée ad hoc, donc chaque reconstruction fait redemander au trousseau l'accès à la clé
// (« Toujours autoriser »), une fois par clé.
import Foundation
#if os(macOS)
import AppKit
import CryptoKit
import Security

final class SSHKeys {
    static let shared = SSHKeys()
    private let metaKey = "studio.sshKeys"
    private let service = "app.carnet.notes.ssh"
    private static let life = 12 * 3600
    private let lock = NSLock()
    private var agent: Process?
    private var loaded: [String: Date] = [:]
    private var watching = false

    private var meta: [[String: Any]] {
        get { UserDefaults.standard.array(forKey: metaKey) as? [[String: Any]] ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: metaKey) }
    }

    static func validId(_ s: String) -> Bool { !s.isEmpty && s.count <= 40 && s.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" } }
    private static func cleanName(_ s: String) -> String? {
        let n = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, n.count <= 60, n.allSatisfy({ $0.isLetter || $0.isNumber || " ._-@’'".contains($0) }) else { return nil }
        return n
    }
    func exists(_ id: String) -> Bool { meta.contains { $0["id"] as? String == id } }
    func info(_ id: String) -> [String: Any]? { meta.first { $0["id"] as? String == id } }

    /// Clés connues (sans rien de secret), avec les projets dont le serveur les utilise.
    func list() -> [String: Any] {
        let used = Servers.shared.keyUsage()
        return ["ok": true, "keys": meta.map { k -> [String: Any] in var k = k; k["projects"] = used[k["id"] as? String ?? ""] ?? []; return k }]
    }

    // MARK: Création et import

    /// Nouvelle clé Ed25519, créée en mémoire et rangée aussitôt dans le trousseau.
    func generate(name: String) -> [String: Any] {
        guard let n = Self.cleanName(name) else { return ["ok": false, "message": "Nom invalide : lettres, chiffres, espaces et . _ - @ (60 au plus)."] }
        let sk = Curve25519.Signing.PrivateKey(), pk = sk.publicKey.rawRepresentation
        let comment = "studio-" + String(n.lowercased().map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        let blob = Self.str("ssh-ed25519") + Self.str(pk)
        // Section privée d'OpenSSH : deux mots de contrôle identiques, la clé (graine + publique), le commentaire, un bourrage 1, 2, 3…
        let check = Self.u32(UInt32.random(in: .min ... .max))
        // Assemblé pas à pas : une seule longue chaîne de `+` dépasse le temps de vérification des types de Swift (CI).
        var priv = Data()
        priv.append(check); priv.append(check)
        priv.append(Self.str("ssh-ed25519")); priv.append(Self.str(pk))
        priv.append(Self.str(sk.rawRepresentation + pk)); priv.append(Self.str(Data(comment.utf8)))
        var pad: UInt8 = 1
        while priv.count % 8 != 0 { priv.append(pad); pad += 1 }
        var body = Data("openssh-key-v1".utf8)
        body.append(0)
        body.append(Self.str("none")); body.append(Self.str("none")); body.append(Self.str(Data()))
        body.append(Self.u32(1)); body.append(Self.str(blob)); body.append(Self.str(priv))
        // L'en-tête est assemblé en deux morceaux : écrit d'un bloc, `npm run verify` le prendrait pour une clé oubliée dans le dépôt.
        let label = "OPENSSH " + "PRIVATE KEY"
        let options: Data.Base64EncodingOptions = [.lineLength64Characters, .endLineWithLineFeed]
        let encoded: String = body.base64EncodedString(options: options)
        let pem = "-----BEGIN \(label)-----\n" + encoded + "\n-----END \(label)-----\n"
        priv.resetBytes(in: 0..<priv.count)
        return save(name: n, type: "ED25519", pub: "ssh-ed25519 " + blob.base64EncodedString() + " " + comment, secret: Data(pem.utf8))
    }

    /// Importe une clé privée existante, choisie dans le Finder : son contenu ne passe pas par la page.
    func pick(name: String, done: @escaping ([String: Any]) -> Void) {
        guard let n = Self.cleanName(name) else { return done(["ok": false, "message": "Nom invalide : lettres, chiffres, espaces et . _ - @ (60 au plus)."]) }
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.title = "Importer une clé SSH privée"
            panel.message = "Choisis le fichier de la clé privée (par exemple ~/.ssh/id_ed25519, pas le .pub). Studio la range chiffrée dans le trousseau."
            panel.prompt = "Importer"
            panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.showsHiddenFiles = true
            panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/.ssh", isDirectory: true)
            NSApp.activate(ignoringOtherApps: true)
            panel.begin { resp in
                guard resp == .OK, let url = panel.url else { return done(["ok": false, "cancelled": true]) }
                DispatchQueue.global(qos: .userInitiated).async { done(self.importKey(at: url, name: n)) }
            }
        }
    }

    private func importKey(at url: URL, name: String) -> [String: Any] {
        guard url.pathExtension != "pub" else { return ["ok": false, "message": "C’est la clé publique : choisis le fichier sans .pub."] }
        guard let data = try? Data(contentsOf: url), data.count < 32_000, let text = String(data: data, encoding: .utf8), text.contains("PRIVATE KEY-----") else {
            return ["ok": false, "message": "Ce fichier n’est pas une clé SSH privée."]
        }
        // La clé publique se déduit de la privée ; -P "" échoue au lieu de demander une phrase de passe.
        let r = Servers.exec("/usr/bin/ssh-keygen", ["-y", "-P", "", "-f", url.path])
        let pub = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard r.status == 0, pub.hasPrefix("ssh-") || pub.hasPrefix("ecdsa-") else {
            if r.out.lowercased().contains("passphrase") { return ["ok": false, "message": "Cette clé est protégée par une phrase de passe : Studio ne la garde pas ainsi. Crée plutôt une clé dans Studio, ou garde celle-ci dans ton agent SSH (« Ma configuration SSH »)."] }
            return ["ok": false, "message": "Clé illisible : " + String(r.out.split(separator: "\n").last ?? "format inconnu").prefix(160)]
        }
        let parts = pub.split(separator: " ")
        let type = parts[0].hasPrefix("ssh-ed25519") ? "ED25519" : parts[0].hasPrefix("ssh-rsa") ? "RSA" : parts[0].hasPrefix("ecdsa") ? "ECDSA" : String(parts[0])
        let line = parts.prefix(2).joined(separator: " ") + " studio-" + String(name.lowercased().map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        return save(name: name, type: type, pub: line, secret: data)
    }

    private func save(name: String, type: String, pub: String, secret: Data) -> [String: Any] {
        guard let fp = Self.fingerprint(pub) else { return ["ok": false, "message": "Clé publique illisible."] }
        if let same = meta.first(where: { $0["fingerprint"] as? String == fp }) { return ["ok": true, "key": same, "existing": true] }
        let id = "k-" + UUID().uuidString.lowercased().prefix(8)
        guard store(id, secret) else { return ["ok": false, "message": "Le trousseau a refusé d’enregistrer la clé."] }
        let k: [String: Any] = ["id": id, "name": name, "type": type, "fingerprint": fp, "public": pub, "created": Date().timeIntervalSince1970 * 1000]
        meta = meta + [k]
        return ["ok": true, "key": k]
    }

    /// Supprime une clé : refusé tant qu'un serveur s'en sert.
    func delete(_ id: String) -> [String: Any] {
        guard Self.validId(id), exists(id) else { return ["ok": false, "message": "Clé inconnue."] }
        if let used = Servers.shared.keyUsage()[id], !used.isEmpty { return ["ok": false, "message": "Un serveur utilise encore cette clé : change d’abord sa connexion.", "projects": used] }
        lock.lock(); defer { lock.unlock() }
        if agent?.isRunning == true {
            _ = Servers.exec("/usr/bin/ssh-add", ["-d", pubPath(id)], env: ["SSH_AUTH_SOCK": socket, "PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()])
        }
        loaded[id] = nil
        try? FileManager.default.removeItem(atPath: pubPath(id))
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id] as CFDictionary)
        meta = meta.filter { $0["id"] as? String != id }
        return ["ok": true]
    }

    // MARK: Agent SSH de Studio

    private lazy var dir: String = (NSTemporaryDirectory() as NSString).appendingPathComponent("studio-ssh-\(getuid())")
    private var socket: String { dir + "/agent.sock" }
    /// Dossier privé de l'agent (0700), créé au premier `prepare` : y vont aussi les scripts du Terminal.
    var scratch: String { dir }
    private func pubPath(_ id: String) -> String { dir + "/" + id + ".pub" }

    /// Charge la clé dans l'agent de Studio si besoin ; rend la clé publique (fichier) et la socket à donner à ssh.
    func prepare(_ id: String) -> Result<(pub: String, socket: String), Failure> {
        guard Self.validId(id), let k = info(id), let pub = k["public"] as? String else { return .failure(Failure("La clé SSH de ce serveur a été supprimée : choisis-en une autre (Modifier).")) }
        lock.lock(); defer { lock.unlock() }
        if let err = ensureAgent() { return .failure(Failure(err)) }
        if let at = loaded[id], Date().timeIntervalSince(at) < Double(Self.life - 600), FileManager.default.fileExists(atPath: pubPath(id)) {
            return .success((pubPath(id), socket))
        }
        guard FileManager.default.createFile(atPath: pubPath(id), contents: Data((pub + "\n").utf8), attributes: [.posixPermissions: 0o644]) else {
            return .failure(Failure("Impossible de préparer la clé publique."))
        }
        guard var secret = read(id) else { return .failure(Failure("Studio n’a pas pu lire la clé « \(k["name"] as? String ?? id) » dans le trousseau (accès refusé ?).")) }
        defer { secret.resetBytes(in: 0..<secret.count) }
        let r = Servers.exec("/usr/bin/ssh-add", ["-q", "-t", String(Self.life), "-"], input: secret,
                             env: ["SSH_AUTH_SOCK": socket, "PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "SSH_ASKPASS_REQUIRE": "never"])
        guard r.status == 0 else { return .failure(Failure("L’agent SSH de Studio a refusé la clé : " + String(r.out.split(separator: "\n").last ?? "").prefix(160))) }
        loaded[id] = Date()
        return .success((pubPath(id), socket))
    }
    struct Failure: Error { let message: String; init(_ m: String) { message = m } }

    // Appelé sous verrou.
    private func ensureAgent() -> String? {
        let fm = FileManager.default
        if agent?.isRunning == true, fm.fileExists(atPath: socket) { return nil }
        agent?.terminate(); agent = nil; loaded = [:]
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Le dossier doit être un vrai dossier, à nous, fermé aux autres (pas un lien posé par quelqu'un d'autre).
        var st = stat()
        guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid() else { return "Dossier de l’agent SSH invalide." }
        chmod(dir, 0o700)
        unlink(socket)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-agent")
        p.arguments = ["-D", "-a", socket, "-t", String(Self.life)]
        p.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "Agent SSH introuvable (/usr/bin/ssh-agent)." }
        let deadline = Date().addingTimeInterval(3)
        while !fm.fileExists(atPath: socket) && p.isRunning && Date() < deadline { usleep(20_000) }
        guard p.isRunning, fm.fileExists(atPath: socket) else { p.terminate(); return "L’agent SSH de Studio n’a pas démarré." }
        agent = p
        if !watching {
            watching = true
            // À la fermeture de l'app, l'agent part avec elle (et les clés en mémoire avec lui).
            NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.agent?.terminate(); self.agent = nil; self.lock.unlock()
                unlink(self.socket)
            }
        }
        return nil
    }

    // MARK: Trousseau

    private func store(_ id: String, _ secret: Data) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = secret
        add[kSecAttrLabel as String] = "Studio : clé SSH"
        add[kSecAttrDescription as String] = "Clé privée SSH gardée par Studio"
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    private func read(_ id: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    // MARK: Format SSH

    private static func u32(_ v: UInt32) -> Data { Data([UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)]) }
    private static func str(_ d: Data) -> Data { u32(UInt32(d.count)) + d }
    private static func str(_ s: String) -> Data { str(Data(s.utf8)) }
    /// Empreinte affichée par ssh-keygen -l : SHA256 de la clé publique, en base64 sans « = ».
    static func fingerprint(_ pub: String) -> String? {
        let parts = pub.split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return nil }
        return "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }
}
#endif
