import { test, expect } from 'claude-code/testing'
import { normalizeRemote, repoSlug } from '../../hooks/ci/repo'

test('remotes normalize across https, .git, ssh and case', () => {
  const want = 'https://github.com/acme/rocket'
  expect(normalizeRemote('https://github.com/Acme/Rocket.git')).toBe(want)
  expect(normalizeRemote('https://github.com/Acme/Rocket/')).toBe(want)
  expect(normalizeRemote('git@github.com:Acme/Rocket.git')).toBe(want)
  expect(repoSlug('git@github.com:Acme/Rocket.git')).toBe('Acme/Rocket')
  expect(repoSlug('https://github.com/Acme/Rocket.git')).toBe('Acme/Rocket')
})
