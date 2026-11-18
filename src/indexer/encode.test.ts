import { test, assert } from 'orca/testing'
import { dirMatchesRoot, encodeProjectDir, isInsideAnyRoot, isInsideRoot, normalizePath } from './encode.ts'

test('encodeProjectDir replaces every non-alphanumeric char', () => {
  assert.equal(encodeProjectDir('C:\\Users\\dev\\Development\\hangar'), 'C--Users-dev-Development-hangar')
  assert.equal(encodeProjectDir('C:\\Users\\dev\\my.repo'), 'C--Users-dev-my-repo')
  assert.equal(encodeProjectDir('C:\\a\\b\\'), 'C--a-b')
})

test('dirMatchesRoot: exact, prefix on dash, case-insensitive, no partial words', () => {
  const root = 'C:\\Users\\dev\\Development\\roleplay-journal'
  assert.ok(dirMatchesRoot('C--Users-dev-Development-roleplay-journal', root))
  assert.ok(dirMatchesRoot('c--users-dev-development-ROLEPLAY-JOURNAL', root))
  assert.ok(dirMatchesRoot('C--Users-dev-Development-roleplay-journal-web', root))
  assert.ok(dirMatchesRoot('C--Users-dev-Development-roleplay-journal--claude-worktrees-x', root))
  assert.ok(!dirMatchesRoot('C--Users-dev-Development-roleplay-journalist', root))
  assert.ok(!dirMatchesRoot('C--Users-dev-Development-roleplay', root))
})

test('dirMatchesRoot handles dots in paths', () => {
  const root = 'C:\\Users\\dev\\my.repo'
  assert.ok(dirMatchesRoot('C--Users-dev-my-repo', root))
  assert.ok(!dirMatchesRoot('C--Users-dev-myXrepo2', root))
})

test('isInsideRoot normalizes slashes/case and respects segment boundaries', () => {
  const root = 'C:\\Users\\dev\\Development\\roleplay-journal'
  assert.equal(normalizePath('C:\\A\\B\\'), 'c:/a/b')
  assert.ok(isInsideRoot('c:/users/dev/development/roleplay-journal', root))
  assert.ok(isInsideRoot('C:\\Users\\dev\\Development\\roleplay-journal\\src', root))
  assert.ok(!isInsideRoot('C:\\Users\\dev\\Development\\roleplay-journal-web', root))
  assert.ok(!isInsideRoot('C:\\Users\\dev\\Development', root))
  assert.ok(isInsideAnyRoot('D:\\x\\y', ['C:\\a', 'D:\\x']))
  assert.ok(!isInsideAnyRoot('', ['C:\\a']))
})
