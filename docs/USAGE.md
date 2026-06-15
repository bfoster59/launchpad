# LaunchPad — Usage Guide (Standard Work Instruction)

How to operate LaunchPad, task by task. For install/config see the [README](../README.md).

---

## 0. First run

1. `npm install` then `npm start`.
2. Open **http://localhost:3020**.
3. **Set up GitHub access** (needed for import / discover / sync — skip if you only track projects manually):
   - **Settings → GitHub Personal Access Token** → paste a token (`repo` scope) → **Save Token** → **Test Connection** should show `✅ Connected as @you`.
   - One-time, in a terminal: `gh auth setup-git` (lets clone/pull/push work without prompts).
4. Optionally set **Settings → Clone base directory** (where imported repos clone to; default `~/github`).

---

## 1. Add a project

1. Go to **My Projects** (or Dashboard) and click **+ New Project**.
2. In the **Build Room** form, fill **Project Name** (required) and a one-line description.
3. Set **Status** (the new-project form offers **Idea / Planning / Building / Launched / Infrastructure**) and **Category**. Additional statuses such as **Paused** become available when you **edit** an existing project.
4. Optional: capture the **Prompt / vision**, **PRD**, stack, and entry-points so the context is ready when you open a terminal.
5. **Save**. The project appears in My Projects and on the Dashboard.

> Tip: number keys **1–6** jump between tabs. The toggle top-right switches **theme** (🖥️ auto / ☀️ light / 🌙 dark).

---

## 2. Import repositories from GitHub

Open **GitHub → Import from GitHub**. Three modes (tabs in the dialog):

- **Browse GitHub** — lists your account's repos; click one to import it.
- **Import by URL** — paste a `github.com/owner/repo` URL (private repos resolve when a PAT is set).
- **Bulk Import** — import many of your repos at once.

Imported repos show up as projects and gain **sync status** tracking.

---

## 3. Read & refresh sync status

Each cloned project shows a sync badge:

| Badge | Meaning |
|---|---|
| **synced** | local matches the remote |
| **ahead** | you have unpushed local commits |
| **behind** | the remote has commits you haven't pulled |
| **dirty** | uncommitted local changes |

- **Refresh All** (My Projects) re-checks every cloned project.
- **Check All** (GitHub view) re-checks sync status for the repo list.

---

## 4. Work with a project

Click a project card to open its **detail** view, where you can:

- **Edit** its fields (status, description, stack, URLs, etc.).
- **Open Terminal** / **Open Folder** in the project's local path.
- **Launch** its dev server (if configured) and see the live URL.
- View **build logs / updates**.

---

## 5. Icon & badge legend

- 🐙 — a GitHub-sourced repo/project.
- 📁 — a project with a detected **local clone** on disk.
- **Status pill** (top-right of a card) — the project's status (see §1).
- **Sync badge** — git sync state (see §3).
- Nav emojis (🚀📁🐙🔍🎓⚙️) label the six tabs.

---

## 6. Settings reference

| Setting | Purpose |
|---|---|
| **GitHub Personal Access Token** | GitHub API access (import / discover / sync). `Test Connection` verifies it. |
| **Clone base directory** | Where new clones land (default `~/github`). |
| **Default terminal** | Which terminal "Open Terminal" launches. |

All settings persist locally in SQLite and apply immediately.

---

## Troubleshooting

See the [README troubleshooting section](../README.md#troubleshooting).
