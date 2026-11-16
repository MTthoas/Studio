// Commerce : relais HTTP vers l'API Admin de Shopify, pour l'onglet Boutique d'un projet.
//
// L'API Admin refuse les appels faits depuis une page web (pas de CORS) : la page passe donc par l'app, qui envoie la
// requête à sa place. Ce relais ne sait faire que deux choses, vers un seul type d'hôte (`<boutique>.myshopify.com`,
// en https, sans suivre de redirection) :
//   - `graphql` : POST /admin/api/<version>/graphql.json, avec le jeton d'accès donné par la page ;
//   - `token`   : POST /admin/oauth/access_token (échange « client credentials » : identifiants d'une app du
//                 Dev Dashboard contre un jeton valable 24 h).
// Les secrets viennent du coffre de la page à chaque appel : rien n'est gardé ici, ni écrit sur le disque.
// Même code sur Mac et iPhone (Foundation seulement). Jamais ouvert aux appareils liés (hors REMOTE_ALLOWED, link.ts).
import Foundation

enum Commerce {
    /// Version de l'API Admin : la dernière stable, à relever une fois par an au plus (Shopify garde chaque version 12 mois).
    static let version = "2026-10"
    private static let maxBody = 4_000_000

    /// `ma-boutique.myshopify.com` : le nom permanent de la boutique, jamais un domaine personnalisé.
    static func validShop(_ s: String) -> Bool {
        guard s.hasSuffix(".myshopify.com"), s.count <= 80 else { return false }
        let name = s.dropLast(".myshopify.com".count)
        return !name.isEmpty && name.first != "-" && name.last != "-" && name.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" }
    }
    /// Jeton, identifiant ou secret d'app : une ligne d'ASCII imprimable, sans espace.
    private static func validSecret(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 400 && s.unicodeScalars.allSatisfy { $0.value > 32 && $0.value < 127 }
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private final class Box { var data: Data?; var code = 0; var retry = "" }

    /// Envoie la requête et attend la réponse (appelé hors du fil principal).
    private static func send(_ req: URLRequest) -> Box {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        let box = Box(), sem = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { d, r, _ in
            let http = r as? HTTPURLResponse
            box.data = d; box.code = http?.statusCode ?? 0; box.retry = http?.value(forHTTPHeaderField: "Retry-After") ?? ""
            sem.signal()
        }.resume()
        sem.wait()
        session.finishTasksAndInvalidate()
        return box
    }

    private static func request(_ shop: String, _ path: String, type: String, body: Data) -> URLRequest? {
        guard validShop(shop), let url = URL(string: "https://" + shop + path) else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
        req.httpMethod = "POST"
        req.setValue(type, forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = body
        return req
    }

    /// Réponse rendue à la page : le code HTTP et le JSON reçu tels quels (`body`), que la page interprète.
    private static func reply(_ box: Box) -> [String: Any] {
        guard box.code != 0 else { return ["ok": false, "message": "Shopify est injoignable (connexion ou nom de boutique)."] }
        var out: [String: Any] = ["ok": true, "status": box.code]
        if let s = Double(box.retry) { out["retryAfter"] = s }
        if let d = box.data, d.count <= maxBody, let j = try? JSONSerialization.jsonObject(with: d), JSONSerialization.isValidJSONObject(j) { out["body"] = j }
        return out
    }

    static func graphql(shop: String, token: String, query: String, variables: [String: Any]) -> [String: Any] {
        guard validShop(shop) else { return ["ok": false, "message": "Boutique invalide : attendu « nom.myshopify.com »."] }
        guard validSecret(token) else { return ["ok": false, "message": "Jeton d’accès invalide."] }
        guard !query.isEmpty, query.utf8.count <= 20_000, JSONSerialization.isValidJSONObject(variables),
              let body = try? JSONSerialization.data(withJSONObject: ["query": query, "variables": variables]),
              var req = request(shop, "/admin/api/\(version)/graphql.json", type: "application/json", body: body) else {
            return ["ok": false, "message": "Requête invalide."]
        }
        req.setValue(token, forHTTPHeaderField: "X-Shopify-Access-Token")
        return reply(send(req))
    }

    static func token(shop: String, clientId: String, secret: String) -> [String: Any] {
        guard validShop(shop) else { return ["ok": false, "message": "Boutique invalide : attendu « nom.myshopify.com »."] }
        guard validSecret(clientId), validSecret(secret) else { return ["ok": false, "message": "Identifiants d’app invalides."] }
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "grant_type", value: "client_credentials"), URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "client_secret", value: secret)]
        // `percentEncodedQuery` laisse « + » tel quel, qu'un formulaire lirait comme un espace.
        guard let body = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8),
              let req = request(shop, "/admin/oauth/access_token", type: "application/x-www-form-urlencoded", body: body) else {
            return ["ok": false, "message": "Requête invalide."]
        }
        return reply(send(req))
    }
}
