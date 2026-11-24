import Foundation
import Capacitor
import AuthenticationServices
import CryptoKit

// Signing in on the iPhone with Apple or with Google. Neither can be done inside the app's
// own web view (Google refuses an embedded browser; Apple's sheet is a system one), so the
// phone does it and hands the page the signed note ("ID token") that RunTheTown's server
// checks. Nothing is kept here: no token is stored on the phone by this plugin.
//
//   apple()            the system's Sign in with Apple sheet -> { identityToken, name }
//                      (Apple gives the name only the first time a person signs in)
//   google({clientId}) Google's page in the system's sign-in browser, with the app's
//                      iOS client id -> { idToken }
//
// Both reject with the code "cancelled" when the runner closes the sheet.
@objc(SignInPlugin)
public class SignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SignInPlugin"
    public let jsName = "SignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "apple", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "google", returnType: CAPPluginReturnPromise),
    ]
    private var appleCall: CAPPluginCall?
    private var webSession: ASWebAuthenticationSession?

    private var window: ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { return window }
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { return window }

    // ---- Apple ----

    @objc func apple(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.appleCall = call
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = appleCall else { return }
        appleCall = nil
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken,
              let token = String(data: data, encoding: .utf8) else {
            call.reject("Apple did not finish the sign-in")
            return
        }
        let name = [credential.fullName?.givenName, credential.fullName?.familyName].compactMap { $0 }.joined(separator: " ")
        call.resolve(["identityToken": token, "name": name])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = appleCall else { return }
        appleCall = nil
        if (error as? ASAuthorizationError)?.code == .canceled {
            call.reject("cancelled", "cancelled")
        } else {
            call.reject("Apple did not finish the sign-in", "failed", error)
        }
    }

    // ---- Google ----

    // The way Google asks of an installed app: its page in the system's sign-in browser,
    // the answer back through the app's own address (the client id written backwards), and
    // a one-time secret made here (PKCE) that only this phone can redeem for the note.
    @objc func google(_ call: CAPPluginCall) {
        let suffix = ".apps.googleusercontent.com"
        guard let clientId = call.getString("clientId"), clientId.hasSuffix(suffix) else {
            call.reject("no Google client id")
            return
        }
        let scheme = clientId.split(separator: ".").reversed().joined(separator: ".")
        let redirect = "\(scheme):/oauth2redirect"
        let verifier = SignInPlugin.randomText(32)
        let challenge = SignInPlugin.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = SignInPlugin.randomText(16)
        var page = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        page.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        guard let url = page.url else {
            call.reject("no Google client id")
            return
        }
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { back, error in
                self.webSession = nil
                if let error = error {
                    if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        call.reject("cancelled", "cancelled")
                    } else {
                        call.reject("Google did not finish the sign-in", "failed", error)
                    }
                    return
                }
                let items = back.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
                let value = { (name: String) in items.first(where: { $0.name == name })?.value }
                guard value("state") == state, let code = value("code") else {
                    call.reject("Google did not finish the sign-in")
                    return
                }
                self.redeem(code: code, clientId: clientId, redirect: redirect, verifier: verifier, call: call)
            }
            session.presentationContextProvider = self
            self.webSession = session
            if !session.start() {
                self.webSession = nil
                call.reject("Google did not finish the sign-in")
            }
        }
    }

    // The code Google sent back, exchanged (with the secret) for the signed note.
    private func redeem(code: String, clientId: String, redirect: String, verifier: String, call: CAPPluginCall) {
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "code_verifier", value: verifier),
        ]
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let idToken = json["id_token"] as? String else {
                call.reject("Google did not finish the sign-in")
                return
            }
            call.resolve(["idToken": idToken])
        }.resume()
    }

    static func base64url(_ data: Data) -> String {
        return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func randomText(_ bytes: Int) -> String {
        var raw = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &raw)
        return base64url(Data(raw))
    }
}
