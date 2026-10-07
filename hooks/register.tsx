import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderChildren, Timer } from 'claude-code'

import type { Board, Card, Folds, State, Window } from '../types'
import { GLYPH, age, boardOf, boardText, counts, facts, home, idleNote, parseJob, parseSessions, parseWorktrees, plural } from './board.mjs'
import { pulseSvg, pulseText, readTranscript, ringSvg, summaryLine, transcriptDir, wholeLines } from './board.mjs'
import type { Listed, Reading, Seen, Worktree } from './board.mjs'

const PANE = 'worktrees'
// The first read of a transcript starts this far from its end; later reads take only what it gained.
const FIRST_READ = 1_048_576
// A change refreshes at once after a quiet spell; while windows keep changing, at most this often.
const SPACING = 15_000
const EMPTY: Board = { repo: '', takenAt: 0, worktrees: 0, cards: [], empty: [] }
const board = atom({ plugin: 'worktree-board', key: 'board' } as const, EMPTY)
const folds = atom({ plugin: 'worktree-board', key: 'folds' } as const, { idle: false, empty: false })
const TONE: Record<State, string | undefined> = { 'needs you': 'error', working: 'success', waiting: 'warning', idle: undefined }

const tails = new Map<string, { offset: number; reading: Reading }>()
let inflight: Promise<Board> | undefined
// The files that change when one of the board's windows does: transcripts, session and job records.
let watched: string[] = []
let watching: { files: string; tail: HookStream<ProcessSpawnChunk, ProcessSpawnResult> } | undefined
let due: Timer | undefined
let lastAt = 0
let isInteractive = false

async function physical($: EngineInterface, path: string) {
  return (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? path
}

async function inspect($: EngineInterface, worktree: Worktree): Promise<Worktree> {
  // A linked worktree's `.git` is a file written when it was added; the main
  // worktree's is a directory every git call touches, so it carries no age.
  const dotGit = await $.fs.stat(`${worktree.path}/.git`).catch(() => undefined)
  // Polled: an optional index refresh would take `index.lock` from under a window's own commit.
  const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain'], { cwd: worktree.path }).catch(() => undefined)
  return {
    ...worktree,
    path: await physical($, worktree.path),
    createdAt: dotGit?.kind === 'file' ? dotGit.mtimeMs : undefined,
    uncommitted: status?.exitCode === 0 && !status.isStdoutTruncated ? status.stdout.split('\n').filter(Boolean).length : undefined,
  }
}

async function follow($: EngineInterface, path: string, size: number, now: number): Promise<Reading> {
  const known = tails.get(path)
  const resumes = known !== undefined && known.offset >= 0 && known.offset <= size
  // A backlog longer than a first read is skipped to its last part, as a first read is.
  const from = Math.max(resumes ? known.offset : 0, size - FIRST_READ)
  const startsMidLine = from > 0 && from !== known?.offset
  const ran = from < size ? await $.process.run(['tail', '-c', `+${from + 1}`, path]).catch(() => undefined) : undefined
  const { text, bytes } = wholeLines(ran?.exitCode === 0 ? ran.stdout : '', startsMidLine)
  const reading = readTranscript(text, resumes ? known.reading : { ...known?.reading, toolTimes: [] }, now)
  // A read that began inside a line and reached no line end starts from the end again next time.
  tails.set(path, { offset: bytes === 0 && startsMidLine ? -1 : from + bytes, reading })
  return reading
}

const transcriptOf = (config: string, listed: Listed) => `${config}/projects/${transcriptDir(listed.cwd)}/${listed.id}.jsonl`

async function observe($: EngineInterface, listed: Listed, launch: string, config: string, me: { id: string; cwd: string }, now: number) {
  const stat = await $.fs.stat(transcriptOf(config, listed)).catch(() => undefined)
  const reading = stat === undefined ? { toolTimes: [] } : await follow($, transcriptOf(config, listed), stat.size, now)
  const job = listed.jobId !== undefined && listed.status === 'blocked' ? await $.fs.read(`${config}/jobs/${listed.jobId}/state.json`).catch(() => undefined) : undefined
  const isMe = listed.id === me.id
  // A shell whose folder is gone is placed where the window started.
  const place = isMe ? me.cwd : reading.cwd !== undefined && (await $.fs.exists(reading.cwd)) ? await physical($, reading.cwd) : launch
  const seen: Seen = { ...listed, ...reading, needs: typeof job === 'string' ? parseJob(job) : undefined, activeAt: stat?.mtimeMs, place, launch, isMe }
  const jobFile = listed.jobId === undefined ? undefined : `${config}/jobs/${listed.jobId}/state.json`
  const files = [
    stat && transcriptOf(config, listed),
    listed.pid !== undefined && `${config}/sessions/${listed.pid}.json`,
    jobFile !== undefined && (await $.fs.exists(jobFile)) && jobFile,
  ].filter(file => typeof file === 'string')
  return { seen, found: stat !== undefined, files }
}

async function worktreeList($: EngineInterface, cwd: string) {
  const git = await $.process.run(['git', 'worktree', 'list', '--porcelain', '-z'], { cwd }).catch(() => undefined)
  return git?.exitCode === 0 ? git.stdout : undefined
}

async function gather($: EngineInterface): Promise<Board> {
  const cwd = await physical($, await $.session.cwd())
  const root = await physical($, await $.session.root())
  const now = await $.clock.now()
  lastAt = now
  // A shell may have stepped out of the repository; the session's own root has not.
  const porcelain = (await worktreeList($, cwd)) ?? (await worktreeList($, root))
  if (porcelain === undefined) return { ...EMPTY, takenAt: now, note: `${root} is not inside a git repository` }
  const worktrees = await Promise.all(parseWorktrees(porcelain).map(worktree => inspect($, worktree)))
  const listing = await $.process.run(['claude', 'agents', '--json']).catch(() => undefined)
  const listed = listing === undefined ? undefined : parseSessions(listing.stdout)
  const me = { id: await $.session.id(), cwd }
  const sessions = [...(listed ?? [])]
  if (!sessions.some(s => s.id === me.id)) sessions.push({ id: me.id, name: 'this session', status: 'busy', cwd: root })
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  // Only windows started in this repository are read: other projects' transcripts stay unopened.
  const ours = (await Promise.all(sessions.map(async s => ({ s, launch: await physical($, s.cwd) })))).filter(({ launch }) => home(worktrees, launch))
  const observed = await Promise.all(ours.map(({ s, launch }) => observe($, s, launch, config, me, now)))
  const kept = new Set(ours.map(({ s }) => transcriptOf(config, s)))
  for (const path of tails.keys()) if (!kept.has(path)) tails.delete(path)
  // A failed listing keeps following every window, so their next write retries it.
  if (listed !== undefined) watched = observed.flatMap(o => o.files)
  const drawn = boardOf(worktrees, observed.map(o => o.seen), now)
  if (listed === undefined) return { ...drawn, note: 'session listing unavailable: `claude agents --json` failed' }
  return observed.length === 0 || observed.some(o => o.found) ? drawn : { ...drawn, note: `no transcripts under ${config}/projects: windows are shown where they started` }
}

// One gather at a time: a slow one is joined, never raced, so an older board never lands last.
function refreshBoard($: EngineInterface): Promise<Board> {
  inflight ??= gather($)
    .then(async next => {
      await update($, board, () => next)
      return next
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

// Only a drawn pane follows its windows: the editor and the phone show a printed board no refresh reaches.
function watch($: EngineInterface) {
  const files = watched.join('\0')
  if (watched.length === 0 || watching?.files === files) return
  void watching?.tail.return({ code: null, signal: null })
  const tail = $.process.spawn({ argv: ['tail', '-q', '-F', '-n', '0', ...watched] })
  watching = { files, tail }
  // `-n 0` starts past what changed between the gather's reads and now: one refresh catches up.
  void changed($)
  void (async () => {
    for await (const _ of tail) await changed($)
  })()
    .catch(() => undefined)
    .finally(() => {
      // A tail that ended or never started is started again by the draw its refresh brings.
      if (watching?.tail !== tail) return
      watching = undefined
      void changed($)
    })
}

async function changed($: EngineInterface) {
  if (due !== undefined) return
  const wait = Math.max(0, lastAt + SPACING - (await $.clock.now()))
  due ??= $.clock.after(wait, () => {
    due = undefined
    // A gather under way may have read a file before the write that armed this one.
    void Promise.resolve(inflight)
      .catch(() => undefined)
      .then(() => refreshBoard($))
      .catch(() => undefined)
  })
}

function unwatch() {
  void watching?.tail.return({ code: null, signal: null })
  watching = undefined
  due?.cancel()
  due = undefined
}

function flip($: EngineInterface, fold: keyof Folds) {
  return update($, folds, open => ({ ...open, [fold]: !open[fold] }))
}

// A terminal answers `Svg` with an empty fragment, so the surface decides, not the table.
function windowView(el: ElementTable, graphic: boolean, w: Window, now: number) {
  const { Box, Text } = el
  const tone = TONE[w.state]
  const bars =
    graphic && 'Svg' in el ? <el.Svg source={pulseSvg(w.pulse, w.state)} alt="tool calls in the last hour" width={96} height={16} /> : <Text color={tone} dimColor={!tone} wrap="truncate-end">{pulseText(w.pulse)}</Text>
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={tone} dimColor={!tone}>{GLYPH[w.state]}</Text>
        <Box width={16}><Text bold wrap="truncate-end">{w.name}</Text></Box>
        <Box width={9}><Text color={tone} dimColor={!tone}>{w.state}</Text></Box>
        <Box flexGrow={1} justifyContent="flex-end">{bars}</Box>
        <Box width={4} justifyContent="flex-end"><Text dimColor>{w.activeAt === undefined ? '' : age(now - w.activeAt)}</Text></Box>
      </Box>
      {w.doing !== undefined && <Box paddingLeft={2}><Text dimColor wrap="truncate-end">{w.doing}</Text></Box>}
    </Box>
  )
}

function frame(el: ElementTable, title: string, meta: string, sub: RenderChildren, body: RenderChildren[], lead?: RenderChildren) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        {lead}
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}><Text bold wrap="truncate-end">{title}</Text><Text dimColor>{meta}</Text></Box>
          {sub}
        </Box>
      </Box>
      {body}
    </Box>
  )
}

function foldRow(el: ElementTable, note: string, toggle: RenderChildren) {
  const { Box, Text } = el
  return <Box flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}><Text dimColor wrap="truncate-end">{note}</Text>{toggle}</Box>
}

function cardView(el: ElementTable, graphic: boolean, card: Card, now: number, windows: Window[], tail?: RenderChildren) {
  const { Text } = el
  const f = facts(card, now)
  const many = card.windows.length > 1
  const ring = graphic && many && 'Svg' in el ? <el.Svg source={ringSvg(card.windows.length, card.windows[0]?.state ?? 'idle')} alt={plural(card.windows.length, 'window')} width={26} height={26} /> : undefined
  const meta = [(card.isMain || many) && !ring ? plural(card.windows.length, 'window') : undefined, f.added].filter(Boolean).join(' · ')
  const branch = card.isMain ? `branch ${card.branch}` : f.branch
  const sub = branch || f.changes ? <Text>{branch && <Text dimColor>{branch}{f.changes ? ' · ' : ''}</Text>}{f.changes && <Text color="warning">{f.changes}</Text>}</Text> : undefined
  return frame(el, card.name, meta, sub, [...windows.map(w => windowView(el, graphic, w, now)), tail], ring)
}

function emptyView(el: ElementTable, empty: Card[], now: number, isOpen: boolean, toggle: RenderChildren) {
  const { Text } = el
  const dirty = empty.filter(c => (c.uncommitted ?? 0) > 0).length
  const unknown = empty.filter(c => c.uncommitted === undefined).length
  const added = empty.flatMap(c => (c.createdAt === undefined ? [] : [c.createdAt]))
  const notes = [dirty > 0 && <Text color="warning">{dirty} with uncommitted changes</Text>, unknown > 0 && <Text color="warning">{unknown} with status unknown</Text>, added.length > 0 && <Text dimColor>oldest {age(now - Math.min(...added))}</Text>].filter(Boolean)
  const sub = notes.length > 0 ? <Text>{notes.flatMap((note, i) => (i === 0 ? [note] : [<Text dimColor> · </Text>, note]))}</Text> : undefined
  const rows = isOpen ? empty.map(c => <Text dimColor wrap="truncate-end">{['○ ' + c.name, facts(c, now).changes, c.createdAt !== undefined && age(now - c.createdAt)].filter(Boolean).join(' · ')}</Text>) : []
  return frame(el, 'Without a window', plural(empty.length, 'worktree'), sub, [...rows, foldRow(el, isOpen ? '' : empty.map(c => c.name).join(', '), toggle)])
}

function summaryView(el: ElementTable, shown: Board) {
  const { Box, Text } = el
  const n = counts(shown)
  const parts = (['needs you', 'working', 'waiting'] as const).filter(state => n[state] > 0).map(state => <Text color={TONE[state]}>{n[state]} {state}</Text>)
  if (shown.empty.length > 0) parts.push(<Text dimColor>{shown.empty.length} without a window</Text>)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{shown.repo !== '' && <Text bold>{shown.repo} · </Text>}<Text dimColor>{plural(shown.worktrees, 'worktree')}</Text></Text>
      {parts.length > 0 && <Text>{parts.flatMap((part, i) => (i === 0 ? [part] : [<Text dimColor> · </Text>, part]))}</Text>}
    </Box>
  )
}

// Two rows a line the pane draws: summary and section heads, each card's head and windows, the
// main checkout's idle windows folded to one, the windowless worktrees as one folded card.
function paneRows(board: Board) {
  if (board.worktrees === 0) return 2
  const { main } = board
  const idle = main?.windows.some(w => w.state === 'idle') ? 1 : 0
  const cards = board.cards.reduce((n, card) => n + 1 + card.windows.length, 0)
  return 2 * (6 + cards + (board.empty.length > 0 ? 2 : 0) + (main ? 2 + main.windows.filter(w => w.state !== 'idle').length + idle : 0) + (board.note ? 1 : 0))
}

function sectionView(el: ElementTable, title: string, note: string) {
  const { Box, Text } = el
  return <Box flexDirection="row" justifyContent="space-between" gap={2} marginBottom={1}><Text bold>{title}</Text><Text dimColor wrap="truncate-end">{note}</Text></Box>
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({ name: 'worktrees', description: 'Show where each Claude Code window of this repository works, worktree by worktree' })
    // A reload drops the watch but keeps the pane open; its next draw watches again.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) void refreshBoard($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    const drawn = await refreshBoard($)
    // Asked inline, the pane opens about as tall as its cards; docked, about as wide.
    const opened = await $.ui.open({ id: PANE, title: 'Worktrees', rows: paneRows(drawn), columns: 64 })
    // Asked from the phone or the web, the answer is all that reaches the asker: the pane stays on this machine.
    const beside = isInteractive && opened.isPlaced && drawn.note === undefined && e.origin.kind !== 'bridge'
    return { text: beside ? summaryLine(drawn) : boardText(drawn) }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    unwatch()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Before any await, so a close landing during this draw is never followed by a new watch.
    watch($)
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    const graphic = e.surface !== 'terminal'
    const shown = await read($, board)
    const open = await read($, folds)
    const { main, takenAt: now } = shown
    const idle = main && idleNote(main, now)
    const toggle = (fold: keyof Folds) => <Button key={fold} label={open[fold] ? 'Hide' : 'Show'} onPress={() => void flip($, fold)} />
    return (
      <Box flexDirection="column">
        {shown.worktrees > 0 && summaryView(el, shown)}
        {shown.cards.length + shown.empty.length > 0 && sectionView(el, 'WORKTREES', 'a separate folder and branch for each task')}
        {shown.cards.map(card => cardView(el, graphic, card, now, card.windows))}
        {shown.empty.length > 0 && emptyView(el, shown.empty, now, open.empty, toggle('empty'))}
        {main && sectionView(el, 'MAIN CHECKOUT', 'windows working in the repository folder itself')}
        {main && cardView(el, graphic, main, now, open.idle ? main.windows : main.windows.filter(w => w.state !== 'idle'), idle && foldRow(el, open.idle ? '' : `○ ${idle}`, toggle('idle')))}
        {shown.note !== undefined && <Text color="warning">{shown.note}</Text>}
      </Box>
    )
  })
}
