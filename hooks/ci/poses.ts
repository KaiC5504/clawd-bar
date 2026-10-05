import type { CiPose } from '../../types'

export function poseForStep(name: string): CiPose {
  const n = name.toLowerCase()
  if (/prepar|clean/.test(n)) return 'prep'
  if (/sign|certificate|provision/.test(n)) return 'sign'
  if (/fetch|clone|checkout|package|dependenc|pub get|install|sdk/.test(n)) return 'fetch'
  if (/publish|upload|testflight|deploy|release/.test(n)) return 'publish'
  if (/build|compile|ipa|apk|archive/.test(n)) return 'build'
  return 'prep'
}
