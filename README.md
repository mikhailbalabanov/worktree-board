# worktree-board

A Claude Code mod that shows where each Claude Code window of the repository you are in is working: a card for each git worktree a window works in, what each window is doing and an hour of its activity, and the worktrees no window uses folded into one.

## Install

```
/plugin marketplace add mikhailbalabanov/worktree-board
/plugin install worktree-board@worktree-board
```

Mods are early access in Claude Code. If `/worktrees` is not offered after installing, start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in its environment.

Runs on macOS and Linux, with `git`, `tail` and the `claude` command on your `PATH`.

## Use

`/worktrees` opens the board in a pane that refreshes every 15 seconds while it stays open. Where no pane can be drawn - the VS Code extension today, or `claude -p /worktrees` from a script - it prints the board as one Markdown table instead: each worktree a bold row, its windows indented under it.

Live sessions come from `claude agents --json`; only those started in this repository are read. Each one is placed by the newest working directory its transcript records, so a window that `cd`s into a worktree is shown there from its next tool call, with nothing installed in that window; a window that never changes directory stays in the worktree it started in. The editor, desktop and mobile surfaces draw the activity bars and window counts as pictures, a terminal as characters. The main worktree is not given an age, since git touches its `.git` directory on every command.

## Tests

`node --test` runs the parsing and layout tests; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` runs the mod against the Claude Code engine.

## Licence

MIT
