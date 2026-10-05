import type { Host } from './host'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// PowerShell's -EncodedCommand takes base64 of UTF-16LE. The mod's environment has no
// Node Buffer, so this encodes by hand.
export function utf16Base64(s: string) {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function toastArgv(title: string, body: string) {
  const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>`
  // Windows PowerShell 5.1, not pwsh: only 5.1 projects the WinRT toast types.
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${toast.replace(/'/g, "''")}')`,
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('\n')
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', utf16Base64(script)]
}

// AppleScript string literals take backslash escapes, nothing else.
const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function macArgv(title: string, body: string) {
  return ['osascript', '-e', `display notification ${appleString(body)} with title ${appleString(title)}`]
}

export function linuxArgv(title: string, body: string) {
  return ['notify-send', '--app-name=clawd-bar', '--', title, body]
}

export async function desktopToast(h: Host, title: string, body: string) {
  if ((await h.env('OS')) === 'Windows_NT') {
    await h.run(toastArgv(title, body), 20_000)
    return
  }
  const uname = await h.run(['uname', '-s'], 5_000).catch(() => null)
  const system = uname?.exitCode === 0 ? uname.stdout.trim() : ''
  // A machine without notify-send (a server, WSL) just gets the in-app toast.
  if (system === 'Darwin') await h.run(macArgv(title, body), 10_000)
  else if (system === 'Linux') await h.run(linuxArgv(title, body), 10_000)
}

export async function ntfy(h: Host, topic: string, title: string, body: string, url: string) {
  // The JSON form, because ntfy's Title header can't carry ✓ or ✗.
  await h.fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message: body, click: url }),
  })
}
