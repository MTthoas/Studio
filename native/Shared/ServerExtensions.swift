// Extensions du serveur d'un projet, à activer une par une (Servers.extensions) : Docker et Kubernetes.
// Elles passent par la connexion SSH du serveur (Servers.run) et n'envoient que des modèles de commande fixes :
// lecture de l'état, journaux, et quelques actions nommées (démarrer, arrêter, redémarrer). Les noms de conteneur,
// de déploiement, de pod et d'espace de noms sont validés (caractères permis de Docker et de Kubernetes) puis protégés.
// Kubernetes : kubectl, sinon `k3s kubectl`, sinon `microk8s kubectl`, avec la configuration de l'utilisateur distant.
import Foundation
#if os(macOS)

final class ServerExtensions {
    static let shared = ServerExtensions()

    private static func validDocker(_ s: String) -> Bool {
        guard let f = s.first, f.isASCII, f.isLetter || f.isNumber, s.count <= 128 else { return false }
        return s.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "_.-".contains($0) }
    }
    private static func validKube(_ s: String) -> Bool {
        guard let f = s.first, let l = s.last, s.count <= 253, (f.isLowercase || f.isNumber), (l.isLowercase || l.isNumber) else { return false }
        return s.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || "-.".contains($0) }
    }

    private static let path = "export PATH=\"$PATH:/usr/local/bin:/snap/bin\"; "
    private static let kube = path + "if command -v kubectl >/dev/null 2>&1; then K=kubectl; elif command -v k3s >/dev/null 2>&1; then K='k3s kubectl'; "
        + "elif command -v microk8s >/dev/null 2>&1; then K='microk8s kubectl'; else echo @MISSING; exit 0; fi; "

    private func enabled(_ pid: String, _ ext: String) -> Result<Servers.Server, SSHKeys.Failure> {
        guard let c = Servers.shared.config(pid) else { return .failure(.init("Aucun serveur configuré.")) }
        guard c.ext.contains(ext) else { return .failure(.init("Extension non activée sur ce serveur (Modifier).")) }
        return .success(c)
    }
    private static func lastLine(_ s: String) -> String { String(s.split(separator: "\n").last ?? "").trimmingCharacters(in: .whitespaces).prefix(240).description }
    private static func sections(_ out: String) -> [String] { out.components(separatedBy: "@@").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } }

    /// État d'une extension (lecture seule).
    func read(_ pid: String, ext: String) -> [String: Any] {
        switch enabled(pid, ext) {
        case .failure(let f): return ["ok": false, "message": f.message]
        case .success(let c): return ext == "docker" ? docker(c) : kubernetes(c)
        }
    }

    // MARK: Docker

    private func docker(_ c: Servers.Server) -> [String: Any] {
        let json = Servers.q("{{json .}}")
        let cmd = Self.path + "command -v docker >/dev/null 2>&1 || { echo @MISSING; exit 0; }; "
            + "docker version --format \(Servers.q("{{.Server.Version}}")) 2>&1 | head -n 3; echo @@; "
            + "docker ps -a --format \(json) 2>/dev/null | head -n 300; echo @@; "
            + "docker stats --no-stream --format \(json) 2>/dev/null | head -n 300; echo @@; "
            + "docker compose ls -a --format json 2>/dev/null | head -c 200000"
        let r = Servers.shared.run(c, cmd, timeout: 40)
        if r.keyError || (r.status != 0 && !r.out.contains("@")) { return ["ok": false, "message": r.out.isEmpty ? "Connexion SSH impossible." : Self.lastLine(r.out)] }
        if r.out.contains("@MISSING") { return ["ok": true, "installed": false] }
        let s = Self.sections(r.out)
        func at(_ i: Int) -> String { i < s.count ? s[i] : "" }
        let version = at(0)
        if version.lowercased().contains("permission denied") {
            return ["ok": true, "installed": true, "error": "L’utilisateur SSH n’a pas accès à Docker.", "hint": "sudo usermod -aG docker $USER, puis reconnecte-toi"]
        }
        if version.contains("Cannot connect") || version.contains("Is the docker daemon running") {
            return ["ok": true, "installed": true, "error": "Le service Docker ne tourne pas sur le serveur.", "hint": "sudo systemctl start docker"]
        }
        func lines(_ t: String) -> [[String: Any]] {
            t.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        }
        var stats: [String: [String: Any]] = [:]
        for st in lines(at(2)) { if let n = st["Name"] as? String { stats[n] = st } }
        let containers: [[String: Any]] = lines(at(1)).map { d -> [String: Any] in
            let name = (d["Names"] as? String ?? "").split(separator: ",").first.map(String.init) ?? ""
            let labels = (d["Labels"] as? String ?? "").split(separator: ",")
            let project = labels.first { $0.hasPrefix("com.docker.compose.project=") }.map { String($0.dropFirst("com.docker.compose.project=".count)) } ?? ""
            var o: [String: Any] = ["id": String((d["ID"] as? String ?? "").prefix(12)), "name": name, "image": d["Image"] as? String ?? "",
                                    "state": d["State"] as? String ?? "", "status": d["Status"] as? String ?? "", "ports": d["Ports"] as? String ?? "",
                                    "since": d["RunningFor"] as? String ?? "", "compose": project]
            if let st = stats[name] { o["cpu"] = st["CPUPerc"] as? String ?? ""; o["mem"] = st["MemUsage"] as? String ?? ""; o["memPct"] = st["MemPerc"] as? String ?? "" }
            return o
        }
        let compose = ((try? JSONSerialization.jsonObject(with: Data(at(3).utf8))) as? [[String: Any]] ?? []).map {
            ["name": $0["Name"] as? String ?? "", "status": $0["Status"] as? String ?? ""]
        }
        return ["ok": true, "installed": true, "version": version.split(separator: "\n").first.map(String.init) ?? "", "containers": containers, "compose": compose]
    }

    // MARK: Kubernetes

    private func kubernetes(_ c: Servers.Server) -> [String: Any] {
        let t = "{\"\\t\"}", n = "{\"\\n\"}"
        let nodes = "{range .items[*]}{.metadata.name}\(t){.status.conditions[?(@.type==\"Ready\")].status}\(t){.status.nodeInfo.kubeletVersion}\(n){end}"
        let deploys = "{range .items[*]}{.metadata.namespace}\(t){.metadata.name}\(t){.spec.replicas}\(t){.status.readyReplicas}\(t){.status.updatedReplicas}\(n){end}"
        let pods = "{range .items[*]}{.metadata.namespace}\(t){.metadata.name}\(t){.status.phase}\(t){.status.containerStatuses[*].ready}\(t){.status.containerStatuses[*].restartCount}\(t){.status.containerStatuses[*].state.waiting.reason}\(t){.metadata.creationTimestamp}\(n){end}"
        let cmd = Self.kube + "$K config current-context 2>&1 | head -n 2; echo @@; "
            + "$K get nodes -o jsonpath=\(Servers.q(nodes)) 2>&1 | head -n 100; echo @@; "
            + "$K get deployments -A -o jsonpath=\(Servers.q(deploys)) 2>&1 | head -n 300; echo @@; "
            + "$K get pods -A -o jsonpath=\(Servers.q(pods)) 2>&1 | head -n 500"
        let r = Servers.shared.run(c, cmd, timeout: 40)
        if r.keyError || (r.status != 0 && !r.out.contains("@")) { return ["ok": false, "message": r.out.isEmpty ? "Connexion SSH impossible." : Self.lastLine(r.out)] }
        if r.out.contains("@MISSING") { return ["ok": true, "installed": false] }
        let s = Self.sections(r.out)
        func at(_ i: Int) -> String { i < s.count ? s[i] : "" }
        func rows(_ t: String, _ min: Int) -> [[String]] { t.split(separator: "\n").map { $0.components(separatedBy: "\t") }.filter { $0.count >= min } }
        // kubectl répond par une erreur (pas de configuration, accès refusé) au lieu des lignes attendues.
        let err = [at(1), at(3)].first { $0.hasPrefix("error") || $0.contains("refused") || $0.contains("Forbidden") || $0.contains("permission denied") }
        if let err, rows(at(3), 7).isEmpty {
            let perm = err.contains("permission denied")
            return ["ok": true, "installed": true, "error": String(err.split(separator: "\n").first ?? "").prefix(240).description,
                    "hint": perm ? "k3s : sudo chmod 644 /etc/rancher/k3s/k3s.yaml, ou KUBECONFIG dans le profil de l’utilisateur SSH" : "Vérifie que kubectl get pods fonctionne pour l’utilisateur SSH"]
        }
        let ints: (String) -> Int = { Int($0) ?? 0 }
        return ["ok": true, "installed": true, "context": at(0).split(separator: "\n").first.map(String.init) ?? "",
                "nodes": rows(at(1), 3).map { n -> [String: Any] in ["name": n[0], "ready": n[1] == "True", "version": n[2]] },
                "deployments": rows(at(2), 5).map { d -> [String: Any] in ["ns": d[0], "name": d[1], "want": ints(d[2]), "ready": ints(d[3]), "updated": ints(d[4])] },
                "pods": rows(at(3), 7).map { p -> [String: Any] in
                    let ready = p[3].split(separator: " ")
                    return ["ns": p[0], "name": p[1], "phase": p[2], "ready": ready.filter { $0 == "true" }.count, "containers": ready.count,
                            "restarts": p[4].split(separator: " ").reduce(0) { $0 + (Int($1) ?? 0) }, "reason": p[5].split(separator: " ").first.map(String.init) ?? "", "created": p[6]]
                }]
    }

    // MARK: Journaux et actions

    /// Dernières lignes du journal d'un conteneur ou d'un pod.
    func logs(_ pid: String, ext: String, name: String, ns: String) -> [String: Any] {
        let c: Servers.Server
        switch enabled(pid, ext) { case .failure(let f): return ["ok": false, "message": f.message]; case .success(let s): c = s }
        let cmd: String
        if ext == "docker" {
            guard Self.validDocker(name) else { return ["ok": false, "message": "Nom de conteneur invalide."] }
            cmd = Self.path + "docker logs --tail 400 --timestamps \(Servers.q(name)) 2>&1 | tail -c 200000"
        } else {
            guard Self.validKube(name), Self.validKube(ns) else { return ["ok": false, "message": "Nom de pod invalide."] }
            cmd = Self.kube + "$K logs \(Servers.q(name)) -n \(Servers.q(ns)) --all-containers --tail=400 --timestamps 2>&1 | tail -c 200000"
        }
        let r = Servers.shared.run(c, cmd, timeout: 40)
        if r.keyError { return ["ok": false, "message": r.out] }
        return ["ok": true, "log": r.out]
    }

    /// Action nommée : Docker start, stop, restart d'un conteneur ; Kubernetes redémarrage d'un déploiement, suppression d'un pod.
    func act(_ pid: String, ext: String, action: String, name: String, ns: String) -> [String: Any] {
        let c: Servers.Server
        switch enabled(pid, ext) { case .failure(let f): return ["ok": false, "message": f.message]; case .success(let s): c = s }
        let cmd: String
        if ext == "docker" {
            guard ["start", "stop", "restart"].contains(action) else { return ["ok": false, "message": "Action inconnue."] }
            guard Self.validDocker(name) else { return ["ok": false, "message": "Nom de conteneur invalide."] }
            cmd = Self.path + "docker \(action) \(Servers.q(name)) 2>&1"
        } else {
            guard Self.validKube(name), Self.validKube(ns) else { return ["ok": false, "message": "Nom invalide."] }
            switch action {
            case "rollout": cmd = Self.kube + "$K rollout restart \(Servers.q("deployment/" + name)) -n \(Servers.q(ns)) 2>&1"
            case "delete-pod": cmd = Self.kube + "$K delete pod \(Servers.q(name)) -n \(Servers.q(ns)) --wait=false 2>&1"
            default: return ["ok": false, "message": "Action inconnue."]
            }
        }
        let r = Servers.shared.run(c, cmd, timeout: 60)
        return r.status == 0 ? ["ok": true] : ["ok": false, "message": r.out.isEmpty ? "L’action a échoué." : Self.lastLine(r.out)]
    }
}
#endif
