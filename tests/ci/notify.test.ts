import { test, expect } from 'claude-code/testing'
import { utf16Base64, toastArgv, macArgv, linuxArgv, desktopToast, ntfy } from '../../hooks/ci/notify'
import { fakeHost } from './fake-host'

test('utf16 base64 matches what PowerShell expects', () => {
  expect(utf16Base64('hi')).toBe('aABpAA==')
  expect(utf16Base64('abc')).toBe('YQBiAGMA')
})

test('PowerShell gets an encoded command, so quotes in titles cannot break it', () => {
  const argv = toastArgv("rocket's build", 'a <b> & "c"')
  expect(argv.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(argv.length).toBe(5)
})

test('osascript gets the title and body as escaped AppleScript strings', () => {
  const argv = macArgv('rocket "main"', 'C:\\build \\ ok')
  expect(argv.slice(0, 2)).toEqual(['osascript', '-e'])
  expect(argv[2]).toBe('display notification "C:\\\\build \\\\ ok" with title "rocket \\"main\\""')
})

test('notify-send gets the title and body as their own arguments, after --', () => {
  expect(linuxArgv('-v', 'a; rm -rf ~')).toEqual(['notify-send', '--app-name=clawd-bar', '--', '-v', 'a; rm -rf ~'])
})

const system = (name: string | null) => (argv: string[]) =>
  argv[0] === 'uname' ? (name ? { exitCode: 0, stdout: `${name}\n`, stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' }) : { exitCode: 0, stdout: '', stderr: '' }

test('the desktop toast picks the command for the platform', async () => {
  const win = fakeHost({ env: { OS: 'Windows_NT' }, run: system(null) })
  await desktopToast(win, 'T', 'B')
  expect(win.runs.map(a => a[0])).toEqual(['powershell.exe'])

  const mac = fakeHost({ env: {}, run: system('Darwin') })
  await desktopToast(mac, 'T', 'B')
  expect(mac.runs.map(a => a[0])).toEqual(['uname', 'osascript'])

  const linux = fakeHost({ env: {}, run: system('Linux') })
  await desktopToast(linux, 'T', 'B')
  expect(linux.runs.map(a => a[0])).toEqual(['uname', 'notify-send'])
})

test('an unknown platform or a failed uname shows no desktop toast', async () => {
  const bsd = fakeHost({ env: {}, run: system('FreeBSD') })
  await desktopToast(bsd, 'T', 'B')
  expect(bsd.runs.map(a => a[0])).toEqual(['uname'])

  const none = fakeHost({ env: {}, run: system(null) })
  await desktopToast(none, 'T', 'B')
  expect(none.runs.map(a => a[0])).toEqual(['uname'])
})

test('ntfy gets a JSON publish with the topic in the body', async () => {
  const h = fakeHost({ fetch: () => ({ status: 200, ok: true, text: '{}' }) })
  await ntfy(h, 'my-topic', 'T', 'B', 'https://x')
  expect(h.fetches[0]!.url).toBe('https://ntfy.sh/')
  expect(h.fetches[0]!.init?.method).toBe('POST')
  expect(JSON.parse(h.fetches[0]!.init!.body!)).toEqual({ topic: 'my-topic', title: 'T', message: 'B', click: 'https://x' })
})
