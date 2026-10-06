import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  boardOf,
  boardText,
  parseJob,
  parseSessions,
  parseWorktrees,
  pulse,
  pulseSvg,
  pulseText,
  readTranscript,
  ringSvg,
  summaryLine,
  transcriptDir,
  wholeLines,
} from './hooks/board.mts'

const MIN = 60_000
const EM = '\u2003\u2003'
const NOW = Date.UTC(2026, 0, 10, 12)

const PORCELAIN = `worktree /work/repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /work/repo/.worktrees/search
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/search
locked

worktree /work/repo/.worktrees/probe
HEAD 3333333333333333333333333333333333333333
detached

`.replaceAll('\n', '\0')

test('parses worktrees', () => {
  assert.deepEqual(parseWorktrees(PORCELAIN), [
    { path: '/work/repo', branch: 'main', isMain: true },
    { path: '/work/repo/.worktrees/search', branch: 'feat/search', isMain: false },
    { path: '/work/repo/.worktrees/probe', branch: '(detached 3333333)', isMain: false },
  ])
  assert.deepEqual(parseWorktrees('worktree /work/gone\0HEAD 5555555\0detached\0prunable gitdir file points to non-existent location\0\0'), [])
  assert.deepEqual(parseWorktrees('worktree /work/bare.git\0bare\0\0worktree /work/one\nline\0HEAD 4444444\0branch refs/heads/one\0'), [
    { path: '/work/one\nline', branch: 'one', isMain: false },
  ])
})

test('parses the session listing, background sessions by their job', () => {
  assert.deepEqual(
    parseSessions(JSON.stringify([
      { pid: 1, sessionId: 'a', name: 'alpha', cwd: '/work/repo', kind: 'interactive', status: 'busy' },
      { id: 'c0ffee', sessionId: 'b', name: 'beta', cwd: '/work/repo', kind: 'background', state: 'blocked' },
      { sessionId: 7, cwd: '/work/repo' },
    ])),
    [
      { id: 'a', name: 'alpha', status: 'busy', cwd: '/work/repo' },
      { id: 'b', name: 'beta', status: 'blocked', cwd: '/work/repo', jobId: 'c0ffee' },
    ],
  )
  assert.equal(parseSessions('not json'), undefined)
  assert.equal(parseSessions('{"sessionId":"a"}'), undefined)
  assert.equal(parseSessions('[{"id":"a","dir":"/work/repo"}]'), undefined)
  assert.deepEqual(parseSessions('[]'), [])
  assert.equal(parseJob('{"state":"blocked","needs":"Ship it?\\nThe diff is below.\\u001b[2J"}'), 'Ship it?')
  assert.equal(parseJob('{"state":"working"}'), undefined)
  assert.equal(parseJob('nope'), undefined)
})

test('names the transcript folder the way Claude Code does', () => {
  assert.equal(transcriptDir('/Users/me/Work/my.repo/apps/web'), '-Users-me-Work-my-repo-apps-web')
})

test('reads whole lines only, counting bytes', () => {
  assert.deepEqual(wholeLines('{"a":1}\n{"b":2}\n{"c"', false), { text: '{"a":1}\n{"b":2}\n', bytes: 16 })
  assert.deepEqual(wholeLines('rtial"}\n{"é":1}\n', true), { text: '{"é":1}\n', bytes: 17 })
  assert.deepEqual(wholeLines('no newline yet', true), { text: '', bytes: 0 })
  assert.deepEqual(wholeLines('\uFFFD\uFFFDé"}\n{"a":1}\n', true), { text: '{"a":1}\n', bytes: 15 })
})

const line = entry => `${JSON.stringify(entry)}\n`
const toolUse = (at, name, input, cwd = '/work/repo/.worktrees/search') => line({ type: 'assistant', cwd, timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', name, input }] } })

test('reads a transcript: newest cwd and title, what it does, its calls in the last hour', () => {
  const first = readTranscript(
    line({ type: 'custom-title', customTitle: 'search-1' }) +
      toolUse(NOW - 90 * MIN, 'Bash', { command: 'ls', description: 'List files' }, '/work/repo') +
      line({ type: 'user', cwd: '/work/repo/.worktrees/search', timestamp: new Date(NOW - 5 * MIN).toISOString() }) +
      toolUse(NOW - 4 * MIN, 'mcp__browser__click', {}) +
      'not json\n',
    { toolTimes: [] },
    NOW,
  )
  assert.deepEqual(first, { cwd: '/work/repo/.worktrees/search', title: 'search-1', doing: 'browser', toolTimes: [NOW - 4 * MIN] })
  assert.equal(readTranscript(toolUse(NOW, 'mcp__tracker__save', { description: 'A long\nissue body' }), { toolTimes: [] }, NOW).doing, 'tracker')
  assert.equal(readTranscript(toolUse(NOW, 'Bash', { description: `Step one\n${'x'.repeat(200)}` }), { toolTimes: [] }, NOW).doing, 'Step one')
  assert.equal(readTranscript(toolUse(NOW, 'Bash', { description: 'y'.repeat(200) }), { toolTimes: [] }, NOW).doing, `${'y'.repeat(119)}…`)
  const next = readTranscript(toolUse(NOW + 30 * MIN, 'Agent', { description: 'Review the diff' }), first, NOW + 61 * MIN)
  assert.deepEqual(next, { cwd: '/work/repo/.worktrees/search', title: 'search-1', doing: 'Review the diff', toolTimes: [NOW + 30 * MIN] })
})

test('counts calls into thirty two-minute bars and draws them', () => {
  const bars = pulse([NOW - 1 * MIN, NOW - 1.5 * MIN, NOW - 59 * MIN, NOW - 61 * MIN, NOW + MIN], NOW)
  assert.equal(bars.length, 30)
  assert.equal(bars[29], 3)
  assert.equal(bars[0], 1)
  assert.equal(bars.reduce((a, b) => a + b), 4)
  assert.equal(pulseText(bars), '▃·············▇')
  assert.equal(pulseText(Array(30).fill(0)).length, 15)
  assert.match(pulseSvg(bars, 'working'), /^<svg [^>]*width="96"[^>]*>(<rect [^>]*\/>){30}<\/svg>$/)
  assert.match(ringSvg(23, 'working'), /<circle [^>]*stroke="#2ea043"[^>]*\/><text [^>]*>23<\/text>/)
})

const worktrees = [
  { path: '/work/repo', branch: 'main', isMain: true, uncommitted: 0 },
  { path: '/work/repo/.worktrees/search', branch: 'feat/search', isMain: false, createdAt: NOW - 3 * 3600_000, uncommitted: 2 },
  { path: '/work/repo/.worktrees/old', branch: 'old', isMain: false, createdAt: NOW - 5 * 86400_000, uncommitted: 1 },
  { path: '/work/repo/.worktrees/new', branch: '(detached 3333333)', isMain: false, createdAt: NOW - 90_000, uncommitted: 0 },
]
const seen = (id, status, place, extra = {}) => ({ id, name: id, status, place, launch: '/work/repo', toolTimes: [], isMe: false, activeAt: NOW - 2 * MIN, ...extra })

test('puts each window in the worktree its shell is in, and folds the rest', () => {
  const board = boardOf(worktrees, [
    seen('alpha', 'busy', '/work/repo/.worktrees/search/lib', { title: 'search-1', doing: 'Run tests', toolTimes: [NOW - MIN] }),
    seen('beta', 'idle', '/work/repo/.worktrees/search'),
    seen('gamma', 'blocked', '/work/repo/.worktrees/gone', { needs: 'Ship it?' }),
    seen('delta', 'idle', '/tmp/scratch', { activeAt: NOW - 3 * 86400_000 }),
    seen('me', 'idle', '/work/repo', { isMe: true }),
    seen('other', 'busy', '/elsewhere', { launch: '/elsewhere' }),
  ], NOW)
  assert.equal(board.repo, 'repo')
  assert.equal(board.worktrees, 4)
  assert.deepEqual(board.cards.map(c => [c.name, c.windows.map(w => `${w.name}:${w.state}`)]), [
    ['search', ['search-1:working', 'beta:waiting']],
  ])
  assert.equal(board.cards[0]?.windows[0]?.pulse[29], 1)
  assert.deepEqual(board.main?.windows.map(w => [w.name, w.state, w.doing]), [
    ['gamma', 'needs you', 'asks: Ship it?'],
    ['me', 'waiting', 'this window'],
    ['delta', 'idle', undefined],
  ])
  assert.deepEqual(board.empty.map(c => c.name), ['old', 'new'])
})

test('writes the board as one Markdown table', () => {
  const board = boardOf(worktrees, [
    seen('alpha', 'busy', '/work/repo/.worktrees/search', { doing: 'Run tests' }),
    seen('beta', 'idle', '/work/repo', { activeAt: NOW - 2 * 86400_000 }),
  ], NOW)
  assert.equal(summaryLine(board), 'repo · 4 worktrees · 1 working · 2 without a window')
  assert.equal(summaryLine({ ...board, worktrees: 1, empty: [] }), 'repo · 1 worktree · 1 working')
  assert.equal(
    boardText(board),
    [
      'repo · 4 worktrees',
      '',
      '🟢 1 working · ⚪ 2 without a window',
      '',
      '| **WORKTREES** | a separate folder and branch for each task |',
      '| :-- | :-- |',
      '| **search** | **2 uncommitted · added 3h ago** |',
      `| ${EM}🟢 **alpha** · working · 2m | Run tests |`,
      '| **Without a window** | **2 worktrees** |',
      `| ${EM}⚪ old | 1 uncommitted · 5d |`,
      `| ${EM}⚪ new | 1m |`,
      '| **MAIN CHECKOUT** | windows working in the repository folder itself |',
      '| **repo** | **1 window · branch main** |',
      `| ${EM}⚪ 1 idle window, oldest 2d |  |`,
    ].join('\n'),
  )
  assert.equal(boardText({ ...board, note: 'session listing unavailable' }).split('\n').at(-1), 'session listing unavailable')
  const unknown = boardOf([worktrees[0], { ...worktrees[2], uncommitted: undefined }], [seen('beta', 'idle', '/work/repo', { activeAt: undefined })], NOW)
  assert.match(boardText(unknown), /\| \u2003\u2003⚪ old \| status unknown · 5d \|\n.*MAIN CHECKOUT.*\n.*\n\| \u2003\u2003⚪ 1 idle window \| {2}\|$/)
  const piped = boardOf(worktrees, [seen('a|b', 'busy', '/work/repo', { doing: 'grep a|b' })], NOW)
  assert.match(boardText(piped), /\| \u2003\u2003🟢 \*\*a\\\|b\*\* · working · 2m \| grep a\\\|b \|/)
  const broken = boardOf([worktrees[0], { ...worktrees[1], path: '/work/repo/.worktrees/one\nline' }], [seen('a', 'busy', '/work/repo/.worktrees/one\nline')], NOW)
  assert.match(boardText(broken), /\n\| \*\*one line\*\* \| \*\*feat\/search · 2 uncommitted · added 3h ago\*\* \|\n/)
  const branched = boardOf([{ ...worktrees[0], branch: 'x|y' }, { ...worktrees[1], branch: 'feat/x|y' }], [seen('a', 'busy', '/work/repo'), seen('b', 'busy', '/work/repo/.worktrees/search')], NOW)
  assert.match(boardText(branched), /\| \*\*feat\/x\\\|y · 2 uncommitted · added 3h ago\*\* \|\n[^]*\| \*\*1 window · branch x\\\|y\*\* \|/)
})
