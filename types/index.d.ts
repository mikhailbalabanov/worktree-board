export type State = 'needs you' | 'working' | 'waiting' | 'idle'
export type Window = { id: string; name: string; state: State; doing?: string; activeAt?: number; pulse: number[] }
export type Card = { path: string; name: string; branch: string; isMain: boolean; createdAt?: number; uncommitted?: number; windows: Window[] }
export type Board = { repo: string; takenAt: number; worktrees: number; cards: Card[]; main?: Card; empty: Card[]; note?: string }
export type Folds = { idle: boolean; empty: boolean }

declare module 'claude-code' {
  interface PluginState {
    'worktree-board': { board: Board; folds: Folds }
  }
}
