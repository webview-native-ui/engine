import Foundation
import WebKit

enum ProjectionOrigins {
    static let defaults: Set<String> = ["capacitor://localhost", "app://localhost", "https://localhost", "http://localhost"]

    static func configured(in bundle: Bundle = .main) throws -> Set<String> {
        guard let url = bundle.url(forResource: "capacitor.config", withExtension: "json") else { return defaults }
        guard let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw URLError(.badURL) }
        return try configured(configuration)
    }

    static func configured(_ configuration: [String: Any]) throws -> Set<String> {
        guard let server = configuration["server"] as? [String: Any] else { return defaults }
        var scheme = server["iosScheme"] as? String ?? "capacitor"
        if WKWebView.handlesURLScheme(scheme) || scheme.range(of: "^[a-z][a-z0-9.+-]*$", options: [.caseInsensitive, .regularExpression]) == nil {
            scheme = "capacitor"
        }
        let host = server["hostname"] as? String ?? "localhost"
        guard let url = URLComponents(string: server["url"] as? String ?? "\(scheme)://\(host)"),
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
              !host.isEmpty, !host.contains("*") else { throw URLError(.badURL) }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = url.port
        if (scheme == "https" && url.port == 443) || (scheme == "http" && url.port == 80) { origin.port = nil }
        guard let value = origin.string else { throw URLError(.badURL) }
        return [value]
    }
}
