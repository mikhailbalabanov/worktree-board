import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 0, 10, 12)
const MIN = 60_000
const MIB = 1_048_576
const EM = '\u2003\u2003'
const PORCELAIN = 'worktree /work/repo\0HEAD 1111111\0branch refs/heads/main\0\0worktree /work/repo/.worktrees/search\0HEAD 2222222\0branch refs/heads/feat/search\0\0'
const DIR = '/cfg/projects/-work-repo'
const PANE = {
  plugin: 'worktree-board',
  component: 'Pane',
  requestId: 'worktrees',
  props: { title: 'Worktrees', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const RUN = { command: 'worktrees', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

const entry = (cwd: string, at: number, tool?: string) =>
  `${JSON.stringify({
    type: tool ? 'assistant' : 'user',
    cwd,
    timestamp: new Date(at).toISOString(),
    message: { content: tool ? [{ type: 'tool_use', name: 'Bash', input: { description: tool } }] : [] },
  })}\n`
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function machine(on: On) {
  const transcripts: Record<string, string> = {
    [`${DIR}/alpha.jsonl`]: `${JSON.stringify({ type: 'custom-title', customTitle: 'search-1' })}\n${entry('/work/repo/.worktrees/search/lib', NOW - MIN, 'Run tests')}`,
    [`${DIR}/beta.jsonl`]: entry('/work/repo/.worktrees/search', NOW - 3 * MIN, 'Read the plan'),
    [`${DIR}/gamma.jsonl`]: entry('/work/repo', NOW - 20 * MIN, 'Ask'),
    [`${DIR}/delta.jsonl`]: `${'x'.repeat(MIB + 100)}\n${entry('/work/repo', NOW - 3 * 1440 * MIN)}`,
  }
  const active: Record<string, number> = { alpha: NOW - MIN, beta: NOW - 2 * MIN, gamma: NOW - 20 * MIN, delta: NOW - 3 * 1440 * MIN }
  const tails: string[][] = []
  const opened: unknown[] = []
  const pane = { isPlaced: true }
  const listing = { porcelain: PORCELAIN }
  const agents = JSON.stringify([
    ...['alpha', 'beta', 'delta'].map(id => ({ sessionId: id, name: id, cwd: '/work/repo', kind: 'interactive', status: id === 'alpha' ? 'busy' : 'idle' })),
    { id: 'job1', sessionId: 'gamma', name: 'gamma', cwd: '/work/repo', kind: 'background', state: 'blocked' },
    { sessionId: 'elsewhere', name: 'other', cwd: '/other/repo', kind: 'interactive', status: 'busy' },
  ])
  on('process.run', ($, e) => {
    if (e.argv[0] === 'claude') return ok(agents)
    if (e.argv[1] === 'worktree') return ok(listing.porcelain)
    if (e.argv.includes('status')) return ok(e.init?.cwd === '/work/repo/.worktrees/search' ? ' M a.ts\n?? b.ts\n' : '')
    tails.push([...e.argv])
    return ok((transcripts[e.argv[3] ?? ''] ?? '').slice(Number(e.argv[2]?.slice(1)) - 1))
  })
  on('fs.stat', ($, e) => {
    const text = transcripts[e.path]
    if (e.path.endsWith('.jsonl') && text === undefined) throw new Error('ENOENT')
    const mtimeMs = active[e.path.slice(DIR.length + 1, -'.jsonl'.length)] ?? NOW - 3 * 60 * MIN
    return { value: { kind: text !== undefined || e.path.endsWith('search/.git') ? 'file' : 'dir', size: text?.length ?? 0, mtimeMs, isLink: false, realPath: e.path } }
  })
  on('fs.exists', ($, e) => ({ value: e.path.startsWith('/work/repo') }))
  on('fs.read', ($, e) => ({ value: e.path === '/cfg/jobs/job1/state.json' ? '{"state":"blocked","needs":"Ship it?\\nand more"}' : '' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.id', () => ({ value: 'me' }))
  on('ui.open', ($, e) => {
    opened.push(e)
    return { value: pane.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no surface places panes' } }
  })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  return { transcripts, tails, opened, pane, listing, clock: mock.clock(on, { now: NOW }) }
}

test('a window is drawn in the worktree its transcript places it in, and the rest fold', async ($, on) => {
  const { transcripts, tails, opened, clock } = machine(on)
  const argvOf = (id: string) => tails.filter(argv => argv[3] === `${DIR}/${id}.jsonl`).map(argv => argv[2])

  const ran = await $.command.run(RUN)
  expect(ran.text).toBe(
    [
      'repo · 2 worktrees',
      '',
      '🔴 1 needs you · 🟢 2 working · 🟡 1 waiting',
      '',
      '| **WORKTREES** | a separate folder and branch for each task |',
      '| :-- | :-- |',
      '| **search** | **2 uncommitted · added 3h ago** |',
      `| ${EM}🟢 **search-1** · working · 1m | Run tests |`,
      `| ${EM}🟡 **beta** · waiting · 2m |  |`,
      '| **MAIN CHECKOUT** | windows working in the repository folder itself |',
      '| **repo** | **3 windows · branch main** |',
      `| ${EM}🔴 **gamma** · needs you · 20m | asks: Ship it? |`,
      `| ${EM}🟢 **this session** · working | this window |`,
      `| ${EM}⚪ 1 idle window, oldest 3d |  |`,
    ].join('\n'),
  )
  expect(opened).toHaveLength(1)
  expect(tails.some(argv => argv[3]?.includes('elsewhere'))).toBe(false)
  const delta = transcripts[`${DIR}/delta.jsonl`]?.length ?? 0
  expect(argvOf('delta')).toEqual([`+${delta - MIB + 1}`])

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(6)
  expect(await desktop.find({ type: 'Text', text: 'search-1' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '3 windows' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: 'delta' })).toBeUndefined()
  await desktop.press({ key: 'idle' })
  expect(await desktop.find({ type: 'Text', text: 'delta' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await terminal.find({ type: 'Text', text: /^[·▁▂▃▄▅▆▇]{15}$/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '2 windows' })).toBeDefined()
  await terminal.unmount()

  const read = `${DIR}/alpha.jsonl`
  const size = transcripts[read]?.length ?? 0
  transcripts[read] += entry('/work/repo', NOW + MIN, 'Merge')
  await clock.advance(15_000)
  const after = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await after.find({ type: 'Text', text: 'Merge' })).toBeDefined()
  await after.unmount()

  // A backlog longer than a first read is skipped to its last MiB; one with no line end there starts again from the end.
  const grown = (transcripts[read] += 'y'.repeat(MIB + 10)).length
  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(argvOf('alpha')).toEqual(['+1', `+${size + 1}`, `+${grown - MIB + 1}`, `+${grown - MIB + 1}`])
  expect((await $.command.run(RUN)).text).toMatch(/\| \*\*4 windows · branch main\*\* \|\n\| \u2003\u2003🔴 \*\*gamma\*\*[^\n]*\n\| \u2003\u2003🟢 \*\*search-1\*\* · working/)
})

test('outside git, a failed listing, and the default config folder', async ($, on) => {
  let gitExit = 128
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: gitExit, stdout: e.argv[1] === 'worktree' ? PORCELAIN : ' M a.ts\n', stderr: '', isStdoutTruncated: e.argv.includes('status'), isStderrTruncated: false } }
    if (e.argv[0] === 'tail') return ok(JSON.stringify({ type: 'custom-title', customTitle: 'mine' }) + '\n')
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) => {
    if (e.path.endsWith('.jsonl') && e.path !== '/home/me/.claude/projects/-work-repo/me.jsonl') throw new Error('ENOENT')
    return { value: { kind: e.path.endsWith('.jsonl') ? 'file' : 'dir', size: 40, mtimeMs: NOW - MIN, isLink: false, realPath: e.path } }
  })
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.id', () => ({ value: 'me' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.env(on, { HOME: '/home/me' })
  mock.clock(on, { now: NOW })

  expect((await $.command.run(RUN)).text).toBe('/work/repo is not inside a git repository')
  gitExit = 0
  expect((await $.command.run(RUN)).text).toBe(
    [
      'repo · 2 worktrees',
      '',
      '🟢 1 working · ⚪ 1 without a window',
      '',
      '| **WORKTREES** | a separate folder and branch for each task |',
      '| :-- | :-- |',
      '| **Without a window** | **1 worktree** |',
      `| ${EM}⚪ search | status unknown |`,
      '| **MAIN CHECKOUT** | windows working in the repository folder itself |',
      '| **repo** | **1 window · branch main** |',
      `| ${EM}🟢 **mine** · working · 1m | this window |`,
      '',
      'session listing unavailable: `claude agents --json` failed',
    ].join('\n'),
  )
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'uncommitted changes' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '1 with status unknown' })).toBeDefined()
  await pane.unmount()
})

test('an interactive session gets one summary line beside a placed pane, the board where none is placed', async ($, on) => {
  const { pane } = machine(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(RUN)).text).toBe('repo · 2 worktrees · 1 needs you · 2 working · 1 waiting')
  pane.isPlaced = false
  expect((await $.command.run(RUN)).text).toContain('| **search** | **2 uncommitted · added 3h ago** |')
})

test('three windowless worktrees ask the pane for no more rows than one, as it folds them into one card', async ($, on) => {
  const { opened, listing } = machine(on)
  const linked = (name: string) => `worktree /work/repo/.worktrees/${name}\0HEAD 3333333\0branch refs/heads/${name}\0\0`
  listing.porcelain = PORCELAIN + linked('a')
  await $.command.run(RUN)
  listing.porcelain += linked('b') + linked('c')
  expect((await $.command.run(RUN)).text).toContain(`| ${EM}⚪ c |  |`)
  expect(opened[1]).toEqual(opened[0])
})
