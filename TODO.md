# LaunchPad — Iteration 1 TODO (reconciled)

> **Mostly shipped.** This is the historical iteration-1 backlog from 2026-04-20.
> The Settings page, dual theme, favicon, keyboard shortcuts, and the Commit/Push
> + Pull git actions have all since shipped (authoritative shipped-feature history
> lives in **[CHANGELOG.md](CHANGELOG.md)**, v1.0.0 → v1.1.1). Only items still
> marked `[ ]` remain open.

## Still open

- [ ] **UX: "Bulk Import" tab discoverability** — the Import modal now has Browse /
  Import-by-URL / Bulk-Import modes; confirm the Bulk-Import option reads as clearly
  clickable (the original complaint was a near-invisible `#888` transparent button).
- [ ] **Optional: commit → Build Log** — auto-add a Build Log update entry per commit
  so the detail page gains a real history view. Not wired.

## Shipped (kept for the record)

**Settings page** — ✅ Settings tab in nav · ✅ persist GitHub PAT (SQLite `settings`)
· ✅ auto-load PAT on boot (`initOctokit()`) · ✅ clone-path config (Settings → Clone
base directory; default `~/github`, `CLONE_BASE_DIR` override) · ✅ Test-Connection
button (`POST /api/settings/test-github` pings `/user`).

**Bug fixes** — ✅ clone-path canonical layout (base default now `~/github`,
per-project subdir) · ✅ Edit-Project dead-end (snapshot/restore detail markup) ·
✅ Import-by-URL uses stored auth.

**Git actions** — ✅ Commit & Push (💾 button + modal; `POST /api/projects/:id/commit`)
· ✅ Pull ff-only (⬇️ button + incoming-commits preview; `POST /api/projects/:id/pull`).

**Nice-to-have** — ✅ dark/light theme toggle (v1.1.0, auto/light/dark) · ✅ favicon
· ✅ keyboard shortcuts (number keys 1–6 switch tabs).

---

**Context:** LaunchPad = vanilla JS + Express + SQLite — the minimum viable stack for
"track my repos + sync status at a glance."
