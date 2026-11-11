/**
 * Desktop notifications for reminders, using each system's own tool:
 * notify-send on Linux, osascript on macOS, and a PowerShell toast on Windows.
 * If none works, the reminder is still printed in the terminal (with a bell).
 *
 * Text is passed to the tools as arguments or through environment variables,
 * never pasted into a script, so a medication name can't inject commands.
 */

import { spawnSync } from "node:child_process";

export type Notifier = (title: string, body: string) => boolean;

export function systemNotifier(platform = process.platform): Notifier {
  return (title, body) => {
    try {
      if (platform === "linux") {
        return spawnSync("notify-send", ["--app-name=dosely", "--urgency=critical", title, body], { timeout: 5000 }).status === 0;
      }
      if (platform === "darwin") {
        const script = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"\nend run";
        return spawnSync("osascript", ["-e", script, title, body], { timeout: 5000 }).status === 0;
      }
      if (platform === "win32") {
        const script = [
          "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
          "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
          "$t = $xml.GetElementsByTagName('text')",
          "$t.Item(0).AppendChild($xml.CreateTextNode($env:DOSELY_TITLE)) > $null",
          "$t.Item(1).AppendChild($xml.CreateTextNode($env:DOSELY_BODY)) > $null",
          "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('dosely').Show($toast)",
        ].join("; ");
        return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
          { timeout: 10000, env: { ...process.env, DOSELY_TITLE: title, DOSELY_BODY: body } }).status === 0;
      }
    } catch {
      return false;
    }
    return false;
  };
}
