// devtower-notifier: native macOS notifications for devtower, no third-party packages.
// Built into build/devtower-notifier.app by scripts/build-notifier.mjs (swiftc from the Command Line Tools).
//
//   devtower-notifier notify --title T --message M [--url U] [--group G] [--sound]
//       exit 0 posted · 3 not allowed in System Settings > Notifications · 1 error
//   devtower-notifier status      prints authorized | denied | notDetermined
//
// Clicking a notification relaunches the app with no arguments; it opens the notice's URL and exits.
import AppKit
import UserNotifications

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let center = UNUserNotificationCenter.current()

  // the delegate must be set before launch finishes to receive the click that launched us
  func applicationWillFinishLaunching(_ notification: Notification) { center.delegate = self }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first {
    case "notify": post(Array(args.dropFirst()))
    case "status": status()
    default: DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) } // launched by a click
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    if let link = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: link) {
      NSWorkspace.shared.open(url)
    }
    done()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }

  private func option(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }

  private func status() {
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .denied: print("denied")
      case .notDetermined: print("notDetermined")
      default: print("authorized")
      }
      exit(0)
    }
  }

  private func post(_ args: [String]) {
    let content = UNMutableNotificationContent()
    content.title = option(args, "--title") ?? "devtower"
    content.body = option(args, "--message") ?? ""
    if let url = option(args, "--url") { content.userInfo = ["url": url] }
    if args.contains("--sound") { content.sound = .default }
    // a distinct group per notice keeps them stacked instead of replacing each other
    let id = option(args, "--group") ?? UUID().uuidString
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      guard granted else { FileHandle.standardError.write("not allowed\n".data(using: .utf8)!); exit(3) }
      self.center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
        if let error { FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!); exit(1) }
        exit(0)
      }
    }
  }
}

let app = NSApplication.shared
let notifier = Notifier()
app.delegate = notifier
app.setActivationPolicy(.accessory)
app.run()
