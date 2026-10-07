import type { Board, Card, State, Window } from '../types'

export type Worktree = { path: string; branch: string; isMain: boolean; createdAt?: number; uncommitted?: number }
export type Listed = { id: string; name: string; status: string; cwd: string; pid?: number; jobId?: string }
export type Reading = { cwd?: string; title?: string; doing?: string; toolTimes: number[] }
export type Seen = {
  id: string
  name: string
  status: string
  title?: string
  doing?: string
  needs?: string
  activeAt?: number
  toolTimes: number[]
  place: string
  launch: string
  isMe: boolean
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const RANK: Record<State, number> = { 'needs you': 0, working: 1, waiting: 2, idle: 3 }
export const GLYPH: Record<State, string> = { 'needs you': '▲', working: '●', waiting: '●', idle: '○' }
const COLOR: Record<State, string> = { 'needs you': '#e5534b', working: '#2ea043', waiting: '#d29922', idle: '#8b949e' }
const LEVELS = ' ▁▂▃▄▅▆▇'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// `git worktree list --porcelain -z`: git writes a path raw, newlines and all,
// so only NUL frames a field. The main worktree comes first; a bare repository's
// own entry takes that place instead and, having no checkout, is no place to work,
// nor is a worktree whose folder is gone (`prunable`).
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain.split('\0\0').flatMap((block, index) => {
    const lines = block.split('\0')
    const field = (name: string) => lines.find(line => line === name || line.startsWith(`${name} `))?.slice(name.length + 1)
    const path = field('worktree')
    if (path === undefined || lines.includes('bare') || field('prunable') !== undefined) return []
    const branch = field('branch')?.replace(/^refs\/heads\//, '') ?? `(detached ${(field('HEAD') ?? '').slice(0, 7)})`
    return [{ path, branch, isMain: index === 0 }]
  })
}

// `claude agents --json`: undefined when the output is not the listing. A
// background session carries its job id, the folder its own state lives in.
export function parseSessions(json: string): Listed[] | undefined {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  const listed = rows.flatMap(row => {
    if (!isRecord(row) || typeof row.sessionId !== 'string' || typeof row.cwd !== 'string') return []
    const status = typeof row.status === 'string' ? row.status : typeof row.state === 'string' ? row.state : ''
    const name = typeof row.name === 'string' ? row.name : row.sessionId
    const listed: Listed = { id: row.sessionId, name, status, cwd: row.cwd, ...(typeof row.pid === 'number' && { pid: row.pid }) }
    return [row.kind === 'background' && typeof row.id === 'string' ? { ...listed, jobId: row.id } : listed]
  })
  return rows.length > 0 && listed.length === 0 ? undefined : listed
}

// A background job's `state.json`: the question it stopped on.
export function parseJob(json: string): string | undefined {
  try {
    const job: unknown = JSON.parse(json)
    return isRecord(job) && typeof job.needs === 'string' ? oneLine(job.needs) : undefined
  } catch {
    return undefined
  }
}

export const transcriptDir = (launchCwd: string) => launchCwd.replace(/[^A-Za-z0-9]/g, '-')

function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

// The whole lines of a read and the bytes they span; a read that starts inside
// a line drops that line's tail, and the unfinished last line waits for the next read.
// A read that starts inside a character decodes each stray byte as one U+FFFD.
export function wholeLines(chunk: string, startsMidLine: boolean): { text: string; bytes: number } {
  const end = chunk.lastIndexOf('\n') + 1
  const start = startsMidLine ? chunk.indexOf('\n') + 1 : 0
  const stray = startsMidLine ? (/^\uFFFD*/.exec(chunk)?.[0].length ?? 0) : 0
  return { text: chunk.slice(start, end), bytes: end === 0 ? 0 : stray + utf8Length(chunk.slice(stray, end)) }
}

// Model-written text drawn on one row: its first line, no control characters, capped.
export function oneLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

// An MCP tool's `description` is often its payload, so such a call is named by its server.
function describe(tool: string, input: unknown): string {
  if (tool.startsWith('mcp__')) return tool.split('__')[1] ?? tool
  return isRecord(input) && typeof input.description === 'string' && input.description !== '' ? oneLine(input.description) : tool
}

// Claude Code stamps every transcript entry with the shell's directory at that
// moment, so the newest `cwd` is where the session works now, `cd`s included.
export function readTranscript(text: string, prior: Reading, now: number): Reading {
  let { cwd, title, doing } = prior
  const toolTimes = prior.toolTimes.filter(at => now - at < HOUR)
  for (const line of text.split('\n')) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry)) continue
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') title = oneLine(entry.customTitle)
    if (typeof entry.cwd === 'string') cwd = entry.cwd
    const content = isRecord(entry.message) ? entry.message.content : undefined
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue
      doing = describe(block.name, block.input)
      if (now - at < HOUR) toolTimes.push(at)
    }
  }
  return { cwd, title, doing, toolTimes }
}

export function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// Thirty two-minute bars over the last hour, the newest last.
export function pulse(toolTimes: number[], now: number): number[] {
  const bars: number[] = Array.from({ length: 30 }, () => 0)
  for (const at of toolTimes) {
    const index = 29 - Math.floor(Math.max(0, now - at) / (2 * MINUTE))
    if (index >= 0) bars[index] = (bars[index] ?? 0) + 1
  }
  return bars
}

export function pulseText(bars: number[]): string {
  const pairs = Array.from({ length: bars.length / 2 }, (_, i) => (bars[2 * i] ?? 0) + (bars[2 * i + 1] ?? 0))
  const top = Math.max(3, ...pairs)
  return pairs.map(v => (v === 0 ? '·' : (LEVELS[Math.ceil((v / top) * 7)] ?? '▇'))).join('')
}

export function pulseSvg(bars: number[], state: State): string {
  const top = Math.max(3, ...bars)
  const rects = bars.map((v, i) => {
    const height = v === 0 ? 1 : Math.max(2, (v / top) * 16)
    const fill = v === 0 ? COLOR.idle : COLOR[state]
    return `<rect x="${(i * 3.2).toFixed(1)}" y="${(16 - height).toFixed(1)}" width="2.2" height="${height.toFixed(1)}" fill="${fill}"${v === 0 ? ' fill-opacity="0.45"' : ''}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="16" viewBox="0 0 96 16">${rects.join('')}</svg>`
}

export function ringSvg(count: number, state: State): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">` +
    `<circle cx="13" cy="13" r="11" fill="none" stroke="${COLOR[state]}" stroke-width="2"/>` +
    `<text x="13" y="17.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${COLOR[state]}">${count}</text></svg>`
  )
}

function stateOf(seen: Seen, now: number): State {
  if (seen.status === 'busy' || seen.status === 'working') return 'working'
  if (seen.status === 'blocked') return 'needs you'
  return seen.activeAt !== undefined && now - seen.activeAt < HOUR ? 'waiting' : 'idle'
}

function windowOf(seen: Seen, now: number): Window {
  const state = stateOf(seen, now)
  const doing = seen.isMe ? 'this window' : state === 'needs you' ? `asks: ${seen.needs ?? 'a reply'}` : state === 'working' ? seen.doing : undefined
  return { id: seen.id, name: seen.title ?? seen.name, state, doing, activeAt: seen.activeAt, pulse: pulse(seen.toolTimes, now) }
}

// Linked worktrees usually sit inside the main one, so the deepest match wins.
export function home(worktrees: Worktree[], dir: string): Worktree | undefined {
  return worktrees
    .filter(worktree => dir === worktree.path || dir.startsWith(`${worktree.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

const byUrgency = (a?: Window, b?: Window) => RANK[a?.state ?? 'idle'] - RANK[b?.state ?? 'idle'] || (b?.activeAt ?? 0) - (a?.activeAt ?? 0)

// A window is drawn where its shell is; one whose shell left the repository, in
// the worktree it started in.
export function boardOf(worktrees: Worktree[], sessions: Seen[], now: number): Board {
  const cards: Card[] = worktrees.map(worktree => ({
    ...worktree,
    name: worktree.path.slice(worktree.path.lastIndexOf('/') + 1),
    windows: [],
  }))
  for (const seen of sessions) {
    const target = home(worktrees, seen.place) ?? home(worktrees, seen.launch)
    cards.find(card => card.path === target?.path)?.windows.push(windowOf(seen, now))
  }
  for (const card of cards) card.windows.sort(byUrgency)
  const linked = cards.filter(card => !card.isMain)
  const main = cards.find(card => card.isMain)
  return {
    repo: main?.name ?? '',
    takenAt: now,
    worktrees: worktrees.length,
    cards: linked.filter(card => card.windows.length > 0).sort((a, b) => byUrgency(a.windows[0], b.windows[0])),
    main: main && main.windows.length > 0 ? main : undefined,
    empty: linked.filter(card => card.windows.length === 0).sort((a, b) => (a.createdAt ?? now) - (b.createdAt ?? now)),
  }
}

export function counts(board: Board): Record<State, number> {
  const tally: Record<State, number> = { 'needs you': 0, working: 0, waiting: 0, idle: 0 }
  for (const card of [...board.cards, ...(board.main ? [board.main] : [])]) for (const w of card.windows) tally[w.state] += 1
  return tally
}

export function summaryLine(board: Board): string {
  const n = counts(board)
  const parts = [board.repo, plural(board.worktrees, 'worktree')].filter(Boolean)
  for (const state of ['needs you', 'working', 'waiting'] as const) if (n[state] > 0) parts.push(`${n[state]} ${state}`)
  if (board.empty.length > 0) parts.push(`${board.empty.length} without a window`)
  return parts.join(' · ')
}

// The facts a card heads with: the branch where the folder name does not already say it,
// and uncommitted work, never read as none when `git status` could not tell.
export function facts(card: Card, now: number): { branch?: string; changes?: string; added?: string } {
  const shown = card.isMain || card.branch === card.name || card.branch.endsWith(`/${card.name}`) ? undefined : card.branch.startsWith('(detached') ? 'detached' : card.branch
  const since = card.createdAt === undefined ? undefined : age(now - card.createdAt)
  const changes = card.uncommitted === undefined ? 'status unknown' : card.uncommitted > 0 ? `${card.uncommitted} uncommitted` : undefined
  return { branch: shown, changes, added: since === undefined ? undefined : since === 'now' ? 'added just now' : `added ${since} ago` }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function idleNote(card: Card, now: number): string | undefined {
  const idle = card.windows.filter(w => w.state === 'idle')
  const known = idle.flatMap(w => (w.activeAt === undefined ? [] : [w.activeAt]))
  return idle.length === 0 ? undefined : `${plural(idle.length, 'idle window')}${known.length > 0 ? `, oldest ${age(now - Math.min(...known))}` : ''}`
}

const MARK: Record<State, string> = { 'needs you': '🔴', working: '🟢', waiting: '🟡', idle: '⚪' }
// One line each, and a lone backtick cannot pair with a sparkline's code span.
const line = (text: string) => text.replace(/[\r\n]+/g, ' ').replaceAll('`', '\\`')

// Printed where no pane is drawn, the editor and the phone alike: a line per window, so a
// narrow screen wraps lines rather than squeezing a table's columns.
export function boardText(board: Board): string {
  if (board.worktrees === 0) return board.note ?? ''
  const now = board.takenAt
  const placed = [...board.cards, ...(board.main ? [board.main] : [])].flatMap(card => card.windows.map(w => ({ w, folder: `📁 ${card.isMain ? 'main checkout' : card.name}` })))
  const rows = placed
    .filter(({ w }) => w.state !== 'idle')
    .sort((a, b) => byUrgency(a.w, b.w))
    .map(({ w, folder }) => {
      const since = w.activeAt === undefined ? undefined : age(now - w.activeAt)
      const bars = w.state === 'working' && w.pulse.some(v => v > 0) ? ` \`${pulseText(w.pulse)}\`` : ''
      const about = w.state === 'needs you' ? [w.doing, folder, since] : w.state === 'working' ? [folder] : [since, folder]
      return `- ${MARK[w.state]} **${line(w.name)}**${bars} · ${about.flatMap(text => (text ? [line(text)] : [])).join(' · ')}`
    })
  const idle = placed.length - rows.length
  const folded = [idle > 0 && plural(idle, 'idle window'), board.empty.length > 0 && `${plural(board.empty.length, 'worktree')} without a window`].filter(Boolean)
  if (folded.length > 0) rows.push(`- ⚪ ${folded.join(' · ')}`)
  const out = [[board.repo, plural(board.worktrees, 'worktree')].filter(Boolean).join(' · ')]
  if (rows.length > 0) out.push('', ...rows)
  if (board.note) out.push('', board.note)
  return out.join('\n')
}
