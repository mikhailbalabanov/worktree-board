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

`/worktrees` opens the board in a pane. From its first draw until it is closed the pane follows the windows' transcripts and session records with `tail -F` and refreshes when one changes, at most every 15 seconds; with every window quiet it stays as it is. Where no pane is drawn - the VS Code extension today, or `claude -p /worktrees` from a script - and whenever `/worktrees` is asked through Remote Control from the Claude mobile app or the web, which show a session's transcript and never its panes, it prints the board as a Markdown list instead, a line per window, the most urgent first. A printed board is a snapshot: run `/worktrees` again for a fresh one.

Live sessions come from `claude agents --json`; only those started in this repository are read. Each one is placed by the newest working directory its transcript records, so a window that `cd`s into a worktree is shown there from its next tool call, with nothing installed in that window; a window that never changes directory stays in the worktree it started in. A window is named as its VS Code tab is: the title it was given, else the one Claude Code wrote, else its last prompt. A background job is marked as one, opened with `claude agents`; one whose question has waited a day is folded with the idle windows. Claude Code Desktop draws the activity bars and window counts as pictures, a terminal and the printed board as characters. The main worktree is not given an age, since git touches its `.git` directory on every command.

## Tests

`node --test` runs the parsing and layout tests; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` runs the mod against the Claude Code engine.

## Licence

MIT
