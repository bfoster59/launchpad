# Changelog

All notable changes to LaunchPad. Format loosely based on [Keep a Changelog](https://keepachangelog.com/). This project is local-only (not published to npm).

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
