// Dépendances JavaScript des copies isolées. Une copie neuve n'a pas de node_modules : chaque agent les réinstallait
// (minutes, demande de confirmation du garde, et des milliers de lignes de sortie dans son contexte). Studio les
// prépare une fois par version du verrou, dans `<.git commun>/studio-deps/<empreinte de package-lock.json>/node_modules`,
// et relie `node_modules` de chaque copie à ce stock (lien symbolique). Le .git commun est lisible et inscriptible
// depuis la bulle de l'agent. Le stock se remplit par clonage APFS du node_modules du dépôt principal quand son verrou
// est le même, sinon par `npm ci --ignore-scripts` lancé par Studio (hors bulle, d'où l'absence de scripts).
#if os(macOS)
import Foundation
import CryptoKit

extension ProjectFolders {
    /// Relie `node_modules` de la copie `wt` (du dépôt `dir`) au stock partagé, en le préparant s'il manque.
    /// Sans effet sans package-lock.json, ou si la copie a déjà ses node_modules. Ne fait jamais échouer la copie.
    func linkDependencies(_ wt: String, repo dir: String) {
        let fm = FileManager.default
        let lock = wt + "/package-lock.json", link = wt + "/node_modules"
        guard let data = fm.contents(atPath: lock), (try? fm.destinationOfSymbolicLink(atPath: link)) == nil,
              !fm.fileExists(atPath: link),
              let common = git(["rev-parse", "--git-common-dir"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines), !common.isEmpty
        else { return }
        let gitDir = common.hasPrefix("/") ? common : dir + "/" + common
        let root = gitDir + "/studio-deps"
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
        let store = root + "/" + key, modules = store + "/node_modules"
        depsLock.lock(); defer { depsLock.unlock() }
        if !fm.fileExists(atPath: modules) && !fillStore(store, lock: data, wt: wt, repo: dir) { return }
        guard (try? fm.createSymbolicLink(atPath: link, withDestinationPath: modules)) != nil else { return }
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: store)
        // Le lien ne doit jamais paraître dans les changements de la copie (« node_modules/ » ne couvre pas un lien).
        if !gitRun(["check-ignore", "-q", "node_modules"], in: wt).ok { exclude(dir, line: "/node_modules") }
        pruneStores(root, keep: 4)
    }

    /// Prépare `store/node_modules` : clone du node_modules du dépôt principal s'il a le même verrou, sinon `npm ci`.
    private func fillStore(_ store: String, lock: Data, wt: String, repo dir: String) -> Bool {
        let fm = FileManager.default
        let tmp = store + ".tmp-" + UUID().uuidString.prefix(8)
        defer { try? fm.removeItem(atPath: tmp) }
        guard (try? fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)) != nil else { return false }
        var ok = false
        if fm.contents(atPath: dir + "/package-lock.json") == lock, fm.fileExists(atPath: dir + "/node_modules/.package-lock.json") {
            // cp -c : clone APFS, instantané et sans place en plus.
            ok = run("/bin/cp", ["-cR", dir + "/node_modules", tmp + "/node_modules"], in: tmp, timeout: 120)
        }
        if !ok, let npm = AgentPermissions.npxDir.map({ $0 + "/npm" }), fm.isExecutableFile(atPath: npm) {
            for f in ["package.json", "package-lock.json", ".npmrc"] where fm.fileExists(atPath: wt + "/" + f) {
                try? fm.copyItem(atPath: wt + "/" + f, toPath: tmp + "/" + f)
            }
            ok = run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], in: tmp, timeout: 300)
        }
        guard ok, fm.fileExists(atPath: tmp + "/node_modules") else { return false }
        try? fm.removeItem(atPath: store)
        return (try? fm.moveItem(atPath: tmp, toPath: store)) != nil
    }

    /// Garde les `keep` stocks servis le plus récemment (chaque changement de verrou en crée un).
    private func pruneStores(_ root: String, keep: Int) {
        let fm = FileManager.default
        let all = ((try? fm.contentsOfDirectory(atPath: root)) ?? []).map { root + "/" + $0 }
        let dated = all.map { ($0, ((try? fm.attributesOfItem(atPath: $0))?[.modificationDate] as? Date) ?? .distantPast) }
        for (p, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(keep) { try? fm.removeItem(atPath: p) }
    }

    /// Lance un programme sans shell, sortie ignorée ; vrai s'il réussit avant le délai.
    private func run(_ exe: String, _ args: [String], in dir: String, timeout: TimeInterval) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = [(exe as NSString).deletingLastPathComponent, "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = env
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return false }
        let end = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning { p.terminate(); return false }
        return p.terminationStatus == 0
    }
}
#endif
