# LaunchPad — Iteration 1 TODO

Resumed 2026-04-20 after a 2.5-month gap. App works; these are the gaps observed during first real use.

## UX

- [ ] **"Bulk Import" styled as a tab but invisible** — currently a transparent button with `#888` text, users mistake the active view for the only option. Promote to a real button or segmented toggle so both import modes are obviously clickable.

## Settings page (doesn't exist yet)

- [ ] Add a Settings tab/page in the main nav
- [ ] **Persist GitHub PAT** — currently memory-only, lost on every server restart. Store in `.env` (simple) or a SQLite `settings` table (cleaner, supports encryption later)
- [ ] **Auto-load PAT on boot** from env/DB so users don't re-paste
- [ ] **Repos clone path** config (currently hardcoded or derived from cwd — check). Align with the ghq layout: `C:\Work\github.com\<user>\<repo>\`
- [ ] "Test connection" button that pings `/user` with the saved PAT to verify scope

## Bug fixes

- [x] **Clone path updated** — `server.js:350` now uses `/home/bfoster/<project>` (drops the `projects/` middle layer), resolving to `C:\home\bfoster\<project>` on Windows, `/home/bfoster/<project>` on Linux. Canonical layout locked in 2026-04-20.
- [x] **Edit Project dead-end fixed** — added `_editBackupHTML` module state + `_restoreDetailFromBackup()` helper + new `cancelEdit()` function in `app.js`. `editProject` now snapshots the detail container's markup before swapping in the edit form; Cancel and successful Save both restore the snapshot before `showProject()` is called, so `detailTitle`/`detailDescription`/etc. exist when showProject hydrates them. Verified in Chrome DevTools: Cancel returns to detail view, no `TypeError` in console.
- [ ] **Import by URL doesn't use auth** — `server.js:481` creates `new Octokit()` with no token, so private repos 404. Use authenticated Octokit when a PAT is set. 2-line fix.

## Git actions (iteration 1)

- [ ] **Commit & Push button** — next to Sync Status, enabled when status is `dirty` or `unpushed`. Click opens a small modal with a commit-message field. Submit runs `git add . && git commit -m "$MSG" && git push`. Handle auth failures (bad PAT) and merge conflicts (surface as toast/alert). Keeps the loop inside launchpad so you don't have to jump to terminal for every commit.
- [ ] **Pull button** — when status is `behind`. Runs `git pull --ff-only`, refuses non-fast-forward (surface conflict → terminal for manual resolution).
- [ ] **Optional:** wire commit messages into the Build Log (auto-add an update entry per commit). Gives the detail page a real history view.

## Nice-to-have (not blockers)

- [ ] Dark/light theme toggle (currently dark-only)
- [ ] Favicon
- [ ] Keyboard shortcuts for tab switching

---

**Context:** LaunchPad was evaluated against apptrack (Python CLI, no git history) and ProLaunch (Electron+React, MC-trap shape). LaunchPad won because vanilla JS + Express + SQLite is the minimum viable stack for "track my 38 repos + sync status at a glance." See `C:\MATRIX\active-projects.md` (TBD) for where it fits in the workflow.
