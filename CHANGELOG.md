# Changelog

All notable changes to LaunchPad. Format loosely based on [Keep a Changelog](https://keepachangelog.com/). This project is local-only (not published to npm).

## [Unreleased]

### Added
- **🧠 AI Review button** on the project detail page. Sends a bounded snapshot of the
  local clone (README/CLAUDE/TODO/CHANGELOG, manifests, file names, last 20 commits)
  to Claude Opus 5 and shows a structured review (verdict + score, current state,
  strengths, risks, next 3 actions). Each review is saved to the Build Log.
  Uses server-side refusal fallback. New `anthropic_api_key` setting (masked in the
  settings API like the GitHub token), with `ANTHROPIC_API_KEY` as fallback.

## [1.1.1] — 2026-07-07 — Security stabilization

A follow-up deep review of v1.1.0 found that the shell-executing endpoints had no
cross-origin protection and the injection hardening had no tests. This release
closes those gaps. No feature changes.

### Security
- **Origin/CSRF + DNS-rebinding guard** on every state-changing endpoint
  (including the two mutating GET routes). Cross-origin or cross-site requests to
  the local server — e.g. from a web page you visit, or a DNS-rebinding attack —
  are now rejected, so they can't drive git/npm actions against your instance.
- **Open Terminal** no longer builds a shell string: it spawns the terminal
  executable directly with an argument array (no `shell:true`). The project path
  is passed as the spawn working directory (and, where a launcher needs it, as a
  validated literal argument) rather than composed into a shell command string.
- **GitHub token** is no longer previewed in the settings API response (it had
  returned the first 7 characters); it now reports only whether a token is set.
- **Dev-server URL chip** is HTML-escaped (`safeUrl`/`escapeHtml`), consistent
  with the rest of the app's XSS discipline.
- **Trust model documented** — Launch / Install / Open Terminal run the target
  repo's own scripts, so only use them on repos you trust (see README).

### Added
- **Security regression tests** locking the command-injection hardening
  (`resolveSafeDir`, argument-array git, the terminal-run whitelist), the origin
  guard, the `:id` validation, and the token-preview removal — the suite grew
  from 13 to 29 tests.
- Test suite runs against an in-memory DB via `LAUNCHPAD_DB` (never touches the
  on-disk `launchpad.db`).

## [1.1.0] — 2026-06-14 — Stabilize + Polish

### Added
- **Dual light/dark theme** with auto-follow-OS + a persistent header toggle, built on a CSS design-token system.
- **Toasts** — typed (info/success/error), dismissible notifications replacing blocking `alert()`s for save/import/sync feedback.
- **Favicon**, **keyboard shortcuts** (number keys `1`–`6` switch tabs), and visible **focus rings** for accessibility.
- **Docs:** usage guide / SWI (`docs/USAGE.md`), expanded README with light/dark screenshots, and this changelog.
- **LICENSE** (MIT).
- `node:test` smoke suite (DB layer + server-loads, runs on an in-memory DB).

### Changed
- **Premium-depth visual finish:** card elevation + hover, gradient primary buttons, tinted status pills, gradient active-tab underline.
- **Light mode correct everywhere** — tokenized the inline-style and component colors a CSS-only pass couldn't reach.
- **Desktop responsiveness** — header, nav, and card grids reflow on narrow windows instead of overflowing.
- Clone base directory now defaults to a portable `~/github` (override via setting or `CLONE_BASE_DIR`).

### Fixed
- **"+ New Project" from the Dashboard** now opens the form (it had injected into a hidden view and appeared to do nothing).
- Stabilization (Gate 3): integer `:id` guards, idempotent sync writes, `UNIQUE(repo_url)` + race-safe import, GitHub rate-limit retry with bounded concurrency, WAL checkpoint + clean DB close on shutdown, package metadata + engine pin, hygiene cleanup.

### Security
- Binds **loopback-only** (`127.0.0.1`); no auth, so not network-exposed.
- Command-injection hardening: `execFile` arg-arrays (no shell) + path allowlist for git/launch operations.
- XSS escaping across GitHub/user-rendered content; central Express error handler.
- Live DB, `.env`, and backups are gitignored; SQL is fully parameterized (no SQL injection).

## [1.0.0]
- Initial LaunchPad — project tracker, GitHub import/sync, Explore, and the Learn bootcamp.
