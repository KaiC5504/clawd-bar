import { test, expect } from 'claude-code/testing'
import { classify, parseCodemagicStarted, watchedRun } from '../../hooks/ci/detect'

test('build starts are recognised in chained commands', () => {
  expect(classify('cd C:/src/rocket && python scripts/codemagic.py start main')).toEqual({ kind: 'codemagic-start' })
  expect(classify('gh workflow run pr.yaml -R acme/rocket --ref dev')).toEqual({ kind: 'actions-start', workflow: 'pr.yaml', ref: 'dev', repo: 'acme/rocket' })
  expect(classify('gh workflow run "pr.yaml" --repo=o/r')).toEqual({ kind: 'actions-start', workflow: 'pr.yaml', ref: undefined, repo: 'o/r' })
})

test('foreground watches are recognised', () => {
  expect(classify('gh run watch 123 -R o/r --exit-status')).toEqual({ kind: 'foreground-watch', provider: 'actions' })
  expect(classify('python scripts/codemagic.py watch')).toEqual({ kind: 'foreground-watch', provider: 'codemagic' })
})

test('everything else is none, including status and list', () => {
  expect(classify('python scripts/codemagic.py status')).toEqual({ kind: 'none' })
  expect(classify('gh run list -R o/r --limit 1')).toEqual({ kind: 'none' })
})

test('a quoted mention is a known false positive the lookup window absorbs', () => {
  expect(classify('echo "gh workflow run is cool"')).toEqual({ kind: 'actions-start', workflow: 'is', ref: undefined, repo: undefined })
})

test('the build id is read from the start script output', () => {
  expect(parseCodemagicStarted('started 66f1c2abc on main\n')).toBe('66f1c2abc')
  expect(parseCodemagicStarted('No token.')).toBeUndefined()
})

test('a start in the same command wins over a watch', () => {
  expect(classify('gh workflow run pr.yaml -R o/r && gh run watch 5 -R o/r').kind).toBe('actions-start')
  expect(classify('python scripts/codemagic.py start main && python scripts/codemagic.py watch').kind).toBe('codemagic-start')
})

test('the run a watch names is read with its repo', () => {
  expect(watchedRun('gh run watch 77 -R o/r --exit-status')).toEqual({ id: '77', repo: 'o/r' })
  expect(watchedRun('gh run watch')).toBeUndefined()
})
