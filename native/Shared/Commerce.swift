// Commerce : Studio parle à Shopify (API Admin GraphQL) et à Meta (Graph API) pour le compte de la page.
//
// Pont `type: "commerce"`, appelé par `native.call('commerce', action, extra, timeoutMs)` (src/core/native.ts).
// La page n'a pas le droit de joindre ces hôtes (CORS + CSP) : tout passe ici, en https, vers deux hôtes fixes.
// App Mac seulement ; l'action ne figure PAS dans `REMOTE_ALLOWED` (src/integrations/link.ts) : un appareil lié
// ne s'en sert jamais, car elle emploie les secrets du Mac. Sur iPhone, Shell.swift répond « Disponible dans l'app Mac. ».
//
// CONTRAT (toutes les réponses sont du JSON pur ; Shell.swift y ajoute `id`) :
//
//  action "shopify"
//    demande : { shop: "nom.myshopify.com", token?: String, clientId?: String, clientSecret?: String,
//                query: String, variables?: Object }
//    envoie  : POST https://<shop>/admin/api/2026-04/graphql.json, en-tête X-Shopify-Access-Token, corps { query, variables }
//    réponse : { ok, status, data?, errors?, throttle?, message? }
//      ok       = HTTP 2xx ET pas d'`errors` de premier niveau ; status = code HTTP (0 si le réseau a échoué)
//      data     = le champ `data` de GraphQL ; errors = le champ `errors` ; throttle = extensions.cost.throttleStatus
//      message  = en français pour les cas connus (401/403, 402/404/423, 429, shop_not_permitted, réseau),
//                 sinon le premier errors[0].message
//    Authentification : `token` (jeton fixe shpat_…) sinon `clientId` + `clientSecret` (app du Dev Dashboard) :
//    « client credentials grant », POST https://<shop>/admin/oauth/access_token en x-www-form-urlencoded
//    (grant_type=client_credentials, client_id, client_secret ; pas de `scope`) → { access_token, scope, expires_in (86399 s) }.
//    Le jeton obtenu reste en mémoire (clé : boutique + clientId, vérifié contre le secret) jusqu'à expires_in moins 5 minutes ;
//    sur HTTP 401 il est jeté et la requête rejouée une fois. Il n'est jamais renvoyé à la page ni écrit sur disque.
//
//  action "meta"
//    demande : { token: String, method: "GET" | "POST" | "DELETE", path: "/act_123/campaigns",
//                params?: { clé: String | Number | Bool | Object | Array } }
//    envoie  : https://graph.facebook.com/v25.0<path> ; le jeton va dans `Authorization: Bearer`, jamais dans l'URL.
//              GET/DELETE : params en query string ; POST : x-www-form-urlencoded. Objets et tableaux sont encodés en JSON,
//              booléens en true/false. path : ^/[A-Za-z0-9_./-]{1,200}$ sans « .. ».
//    réponse : { ok, status, data (corps JSON entier), message? (error.error_user_msg sinon error.message), code? (error.code) }
//
//  action "status" : { ok: true, shopifyVersion: "2026-04", metaVersion: "v25.0" }
//  autre action    : { ok: false, message: "Action inconnue." }
//
// Limites : délai 30 s, réponse 8 Mo au plus, requête 1 Mo au plus. Une redirection n'est suivie que vers le même hôte
// en https. Aucun secret (jeton, identifiant client, secret) dans un message d'erreur ni dans un journal : ce fichier
// n'écrit rien dans la console.
import Foundation
#if os(macOS)

final class Commerce {
    static let shared = Commerce()

    static let shopifyVersion = "2026-04"
    static let metaVersion = "v25.0"
    private static let maxResponse = 8 * 1024 * 1024, maxRequest = 1024 * 1024
    private static let timeout: TimeInterval = 30
    /// Marge avant l'expiration d'un jeton Shopify gardé en mémoire.
    private static let margin: TimeInterval = 300

    private struct Cached { let token: String, secret: String, expires: Date }
    private let lock = NSLock()
    private var tokens: [String: Cached] = [:]

    // MARK: - Entrée

    /// Appelé hors du fil principal : bloque jusqu'à la réponse.
    func handle(_ action: String, body: [String: Any]) -> [String: Any] {
        let r: [String: Any]
        switch action {
        case "shopify": r = shopify(body)
        case "meta": r = meta(body)
        case "status": r = ["ok": true, "shopifyVersion": Self.shopifyVersion, "metaVersion": Self.metaVersion]
        default: r = ["ok": false, "message": "Action inconnue."]
        }
        // Garde-fou : jamais d'objet non JSON vers `JSONSerialization.data` (exception Objective-C non rattrapable).
        return JSONSerialization.isValidJSONObject(r) ? r : ["ok": false, "message": "Réponse illisible."]
    }

    // MARK: - Validation

    /// ^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$ (écrit à la main : `$` accepterait un retour à la ligne final).
    static func validShop(_ s: String) -> Bool {
        let suffix = ".myshopify.com"
        guard s.hasSuffix(suffix), s.utf8.count <= 61 + suffix.utf8.count else { return false }
        let name = Array(s.utf8.dropLast(suffix.utf8.count))
        guard (1...61).contains(name.count) else { return false }
        func low(_ c: UInt8) -> Bool { (c >= 97 && c <= 122) || (c >= 48 && c <= 57) }
        return low(name[0]) && name.allSatisfy { low($0) || $0 == 45 }
    }

    /// ^/[A-Za-z0-9_./-]{1,200}$ sans « .. ».
    static func validPath(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard b.count >= 2, b.count <= 201, b[0] == 47, !s.contains("..") else { return false }
        return b.dropFirst().allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 65 && $0 <= 90) || ($0 >= 48 && $0 <= 57) || $0 == 95 || $0 == 46 || $0 == 47 || $0 == 45 }
    }

    // MARK: - HTTP

    /// Résultat d'une requête : `fail` est rempli si elle n'a pas abouti (message français, sans secret).
    private struct Reply {
        var status = 0, data = Data(), fail: String?
        var json: Any? {
            guard !data.isEmpty else { return nil }
            return try? JSONSerialization.jsonObject(with: data)
        }
    }

    /// Une session éphémère par requête (ni cookies, ni cache, ni disque), qui borne la taille de la réponse
    /// et refuse toute redirection hors du même hôte.
    private final class Fetcher: NSObject, URLSessionDataDelegate {
        let host: String
        var data = Data(), status = 0, tooBig = false
        let done = DispatchSemaphore(value: 0)
        var error: Error?
        init(host: String) { self.host = host }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if response.expectedContentLength > Int64(Commerce.maxResponse) { tooBig = true; completionHandler(.cancel) } else { completionHandler(.allow) }
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
            data.append(d)
            if data.count > Commerce.maxResponse { tooBig = true; data = Data(); dataTask.cancel() }
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if let u = request.url, u.scheme == "https", u.host?.lowercased() == host { completionHandler(request) } else { completionHandler(nil) }
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            self.error = error; done.signal()
        }
    }

    private func send(_ url: URL, method: String, headers: [String: String], body: Data?) -> Reply {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return Reply(fail: "Adresse non permise.") }
        if let body = body, body.count > Self.maxRequest { return Reply(fail: "Requête trop volumineuse (1 Mo au plus).") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Self.timeout)
        req.httpMethod = method
        req.httpBody = body
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Studio", forHTTPHeaderField: "User-Agent")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = Self.timeout
        cfg.timeoutIntervalForResource = Self.timeout
        let fetcher = Fetcher(host: host)
        let session = URLSession(configuration: cfg, delegate: fetcher, delegateQueue: nil)
        let task = session.dataTask(with: req)
        task.resume()
        if fetcher.done.wait(timeout: .now() + Self.timeout + 5) == .timedOut {
            task.cancel(); session.invalidateAndCancel()
            return Reply(fail: "Délai dépassé : le service ne répond pas.")
        }
        session.finishTasksAndInvalidate()
        if fetcher.tooBig { return Reply(status: fetcher.status, fail: "Réponse trop volumineuse (8 Mo au plus).") }
        if let e = fetcher.error as? URLError {
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                return Reply(fail: "Pas de connexion à Internet.")
            case .timedOut: return Reply(fail: "Délai dépassé : le service ne répond pas.")
            case .cannotFindHost, .dnsLookupFailed: return Reply(fail: "Hôte introuvable : vérifie le nom de la boutique et ta connexion.")
            case .cancelled where fetcher.status != 0: break   // redirection refusée : on rend la réponse de redirection telle quelle
            default: return Reply(fail: "Connexion impossible (\(e.code.rawValue)).")
            }
        } else if fetcher.error != nil {
            return Reply(fail: "Connexion impossible.")
        }
        return Reply(status: fetcher.status, data: fetcher.data)
    }

    // MARK: - Shopify

    private func shopify(_ body: [String: Any]) -> [String: Any] {
        guard let shop = body["shop"] as? String, Self.validShop(shop) else {
            return ["ok": false, "status": 0, "message": "Nom de boutique invalide : il doit ressembler à nom.myshopify.com."]
        }
        guard let query = body["query"] as? String, !query.isEmpty else { return ["ok": false, "status": 0, "message": "Requête vide."] }
        var payload: [String: Any] = ["query": query]
        if let v = body["variables"] as? [String: Any] {
            guard JSONSerialization.isValidJSONObject(v) else { return ["ok": false, "status": 0, "message": "Variables illisibles."] }
            payload["variables"] = v
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return ["ok": false, "status": 0, "message": "Requête illisible."] }
        guard let url = URL(string: "https://\(shop)/admin/api/\(Self.shopifyVersion)/graphql.json") else { return ["ok": false, "status": 0, "message": "Adresse invalide."] }

        let fixed = (body["token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let clientId = body["clientId"] as? String ?? "", clientSecret = body["clientSecret"] as? String ?? ""
        if fixed == nil && (clientId.isEmpty || clientSecret.isEmpty) {
            return ["ok": false, "status": 0, "message": "Il manque le jeton d’accès, ou l’identifiant et la clé secrète de l’app."]
        }

        var retried = false
        while true {
            let token: String
            if let f = fixed { token = f } else {
                switch accessToken(shop: shop, clientId: clientId, secret: clientSecret) {
                case .success(let t): token = t
                case .failure(let e): return ["ok": false, "status": e.status, "message": e.message]
                }
            }
            let r = send(url, method: "POST", headers: ["Content-Type": "application/json", "X-Shopify-Access-Token": token], body: data)
            if r.status == 401, fixed == nil, !retried {
                forget(shop: shop, clientId: clientId); retried = true; continue
            }
            if r.status == 401, fixed == nil { forget(shop: shop, clientId: clientId) }
            return shopifyAnswer(r)
        }
    }

    private struct Failure: Error { let status: Int, message: String }

    private func cacheKey(_ shop: String, _ clientId: String) -> String { shop + "\n" + clientId }
    private func forget(shop: String, clientId: String) {
        lock.lock(); tokens[cacheKey(shop, clientId)] = nil; lock.unlock()
    }

    /// Jeton de l'app du Dev Dashboard : celui gardé en mémoire s'il est encore valable, sinon un nouveau.
    private func accessToken(shop: String, clientId: String, secret: String) -> Result<String, Failure> {
        let key = cacheKey(shop, clientId)
        lock.lock()
        let hit = tokens[key]
        lock.unlock()
        if let h = hit, h.secret == secret, h.expires > Date() { return .success(h.token) }

        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? "" }
        let form = "grant_type=client_credentials&client_id=\(enc(clientId))&client_secret=\(enc(secret))"
        guard let url = URL(string: "https://\(shop)/admin/oauth/access_token") else { return .failure(Failure(status: 0, message: "Adresse invalide.")) }
        let r = send(url, method: "POST", headers: ["Content-Type": "application/x-www-form-urlencoded"], body: Data(form.utf8))
        if let f = r.fail { return .failure(Failure(status: r.status, message: f)) }
        let j = r.json as? [String: Any]
        if (200..<300).contains(r.status), let t = j?["access_token"] as? String, !t.isEmpty {
            let secs = (j?["expires_in"] as? NSNumber)?.doubleValue ?? 3600
            let life = max(0, secs - Self.margin)
            lock.lock()
            tokens[key] = Cached(token: t, secret: secret, expires: Date().addingTimeInterval(life))
            lock.unlock()
            return .success(t)
        }
        let code = j?["error"] as? String ?? ""
        if code == "shop_not_permitted" {
            return .failure(Failure(status: r.status, message: "L’app du Dev Dashboard et la boutique ne sont pas dans la même organisation : crée ou transfère la boutique dans l’organisation de l’app."))
        }
        switch r.status {
        case 400, 401, 403: return .failure(Failure(status: r.status, message: "Identifiants refusés : vérifie l’identifiant client et la clé secrète de l’app, et qu’elle est installée sur cette boutique."))
        case 402, 404, 423: return .failure(Failure(status: r.status, message: "Boutique introuvable ou fermée : vérifie son adresse et que son abonnement est actif."))
        case 429: return .failure(Failure(status: r.status, message: "Trop de requêtes : attends un instant avant de réessayer."))
        default: return .failure(Failure(status: r.status, message: "Shopify a refusé de donner un accès (code \(r.status))."))
        }
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Droit manquant nommé dans une erreur GraphQL (`extensions.requiredAccess` ou « read_orders » dans le texte).
    private func missingScope(_ errors: [Any]) -> String? {
        for case let e as [String: Any] in errors {
            if let a = (e["extensions"] as? [String: Any])?["requiredAccess"] as? String, !a.isEmpty { return a }
            if let m = e["message"] as? String, let r = m.range(of: "\\b(read|write)_[a-z_]+", options: .regularExpression) { return String(m[r]) }
        }
        return nil
    }

    private func shopifyAnswer(_ r: Reply) -> [String: Any] {
        var out: [String: Any] = ["status": r.status]
        if let f = r.fail { out["ok"] = false; out["message"] = f; return out }
        let j = r.json as? [String: Any]
        if let d = j?["data"] as? [String: Any] { out["data"] = d }
        let errors = (j?["errors"] as? [Any]) ?? (j?["errors"] is String ? [["message": j?["errors"] as? String ?? ""]] : nil)
        if let e = errors, !e.isEmpty { out["errors"] = e }
        if let t = ((j?["extensions"] as? [String: Any])?["cost"] as? [String: Any])?["throttleStatus"] as? [String: Any] { out["throttle"] = t }
        let ok = (200..<300).contains(r.status) && out["errors"] == nil
        out["ok"] = ok
        if ok { return out }

        let list = (out["errors"] as? [Any]) ?? []
        let codes = list.compactMap { (($0 as? [String: Any])?["extensions"] as? [String: Any])?["code"] as? String }
        let first = ((list.first as? [String: Any])?["message"] as? String) ?? ""
        switch r.status {
        case 401: out["message"] = "Identifiants refusés par Shopify : le jeton est invalide ou a été révoqué."
        case 403: out["message"] = missingScope(list).map { "Droit manquant sur la boutique : « \($0) ». Ajoute-le à l’app, puis réinstalle-la." } ?? "Accès refusé : l’app n’a pas les droits nécessaires sur cette boutique."
        case 402, 404, 423: out["message"] = "Boutique introuvable ou fermée : vérifie son adresse et que son abonnement est actif."
        case 429: out["message"] = "Trop de requêtes envoyées à Shopify : attends un instant avant de réessayer."
        default:
            if codes.contains("ACCESS_DENIED") {
                out["message"] = missingScope(list).map { "Droit manquant sur la boutique : « \($0) ». Ajoute-le à l’app, puis réinstalle-la." } ?? "Accès refusé : l’app n’a pas les droits nécessaires sur cette boutique."
            } else if codes.contains("THROTTLED") {
                out["message"] = "Trop de requêtes envoyées à Shopify : attends un instant avant de réessayer."
            } else if !first.isEmpty { out["message"] = first }
            else if !(200..<300).contains(r.status) { out["message"] = "Shopify a répondu avec une erreur (code \(r.status))." }
        }
        return out
    }

    // MARK: - Meta

    private func meta(_ body: [String: Any]) -> [String: Any] {
        guard let token = body["token"] as? String, !token.isEmpty else { return ["ok": false, "status": 0, "message": "Il manque le jeton d’accès Meta."] }
        let method = body["method"] as? String ?? ""
        guard ["GET", "POST", "DELETE"].contains(method) else { return ["ok": false, "status": 0, "message": "Méthode non permise."] }
        guard let path = body["path"] as? String, Self.validPath(path) else { return ["ok": false, "status": 0, "message": "Chemin non permis."] }
        let params = body["params"] as? [String: Any] ?? [:]
        var pairs: [String] = []
        for key in params.keys.sorted() {
            guard let v = Self.formValue(params[key]) else { continue }
            guard let k = key.addingPercentEncoding(withAllowedCharacters: Self.unreserved), let e = v.addingPercentEncoding(withAllowedCharacters: Self.unreserved) else { continue }
            pairs.append("\(k)=\(e)")
        }
        let form = pairs.joined(separator: "&")
        var address = "https://graph.facebook.com/\(Self.metaVersion)\(path)"
        var payload: Data?
        var headers = ["Authorization": "Bearer " + token]
        if method == "POST" {
            payload = Data(form.utf8)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        } else if !form.isEmpty { address += "?" + form }
        guard let url = URL(string: address) else { return ["ok": false, "status": 0, "message": "Adresse invalide."] }
        let r = send(url, method: method, headers: headers, body: payload)
        if let f = r.fail { return ["ok": false, "status": r.status, "message": f] }

        var out: [String: Any] = ["status": r.status]
        let j = r.json
        if let d = j as? [String: Any] { out["data"] = d } else if let a = j as? [Any] { out["data"] = ["data": a] } else { out["data"] = [String: Any]() }
        let err = (j as? [String: Any])?["error"] as? [String: Any]
        out["ok"] = (200..<300).contains(r.status) && err == nil
        if let err = err {
            let user = err["error_user_msg"] as? String ?? "", plain = err["message"] as? String ?? ""
            let msg = !user.isEmpty ? user : plain
            if !msg.isEmpty { out["message"] = msg }
            if let c = err["code"] as? NSNumber { out["code"] = c }
        } else if !(200..<300).contains(r.status) {
            out["message"] = "Meta a répondu avec une erreur (code \(r.status))."
        }
        return out
    }

    /// Valeur d'un paramètre de formulaire : texte tel quel, nombre, true/false, objet ou tableau en JSON ; nil si à ignorer.
    private static func formValue(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            return n.stringValue
        case let d as [String: Any]:
            guard JSONSerialization.isValidJSONObject(d), let data = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys]) else { return nil }
            return String(data: data, encoding: .utf8)
        case let a as [Any]:
            guard JSONSerialization.isValidJSONObject(a), let data = try? JSONSerialization.data(withJSONObject: a) else { return nil }
            return String(data: data, encoding: .utf8)
        default: return nil
        }
    }
}
#endif
