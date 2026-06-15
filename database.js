const Database = require('better-sqlite3');
const path = require('path');

class LaunchpadDB {
    // dbPath defaults to the on-disk app DB; pass an explicit path or ':memory:'
    // (used by the test suite) to run against an isolated database.
    constructor(dbPath) {
        this.db = new Database(dbPath || path.join(__dirname, 'launchpad.db'));
        this.db.pragma('journal_mode = WAL');
        // Passively fold the WAL back into the main DB every ~1000 pages so it
        // doesn't grow unbounded while the server runs (it had ballooned to ~3MB
        // against a ~52KB DB). A TRUNCATE checkpoint in close() resets it to 0.
        this.db.pragma('wal_autocheckpoint = 1000');
        this.init();
    }

    init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                status TEXT DEFAULT 'idea',
                category TEXT DEFAULT 'app',
                tech_stack TEXT,
                target_market TEXT,
                monetization TEXT,
                pricing TEXT,
                repo_url TEXT,
                live_url TEXT,
                local_path TEXT,
                source TEXT DEFAULT 'manual',
                readme TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch()),
                launched_at INTEGER,
                UNIQUE(id)
            );
            
            CREATE TABLE IF NOT EXISTS updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                type TEXT DEFAULT 'progress',
                title TEXT NOT NULL,
                content TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                metric_name TEXT NOT NULL,
                value REAL NOT NULL,
                recorded_at INTEGER DEFAULT (unixepoch()),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_updates_project ON updates(project_id);
            CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id);
            CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER DEFAULT (unixepoch())
            );

            -- Learn Page — lightweight learner profiles. No password, just
            -- a username so progress can be tracked across sessions. Multiple
            -- learners can share one launchpad install (e.g., family members).
            CREATE TABLE IF NOT EXISTS learners (
                username TEXT PRIMARY KEY,
                display_name TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                last_active_at INTEGER DEFAULT (unixepoch()),
                total_xp INTEGER DEFAULT 0,
                level TEXT DEFAULT 'basic'
            );

            -- One row per (learner, lesson). status is not_started until the
            -- learner opens a lesson, then in_progress, then completed once
            -- the quiz + challenge are passed. score = quiz percentage 0-100.
            CREATE TABLE IF NOT EXISTS lesson_progress (
                username TEXT NOT NULL,
                lesson_id TEXT NOT NULL,
                status TEXT DEFAULT 'in_progress',
                score INTEGER DEFAULT 0,
                attempts INTEGER DEFAULT 0,
                completed_at INTEGER,
                PRIMARY KEY (username, lesson_id),
                FOREIGN KEY (username) REFERENCES learners(username) ON DELETE CASCADE
            );

            -- Earned badges. badge_id is a slug from the curriculum
            -- (e.g., 'first-commit', 'branch-boss'). Each can only be
            -- earned once per learner.
            CREATE TABLE IF NOT EXISTS learner_badges (
                username TEXT NOT NULL,
                badge_id TEXT NOT NULL,
                earned_at INTEGER DEFAULT (unixepoch()),
                PRIMARY KEY (username, badge_id),
                FOREIGN KEY (username) REFERENCES learners(username) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress(username);
            CREATE INDEX IF NOT EXISTS idx_learner_badges_user ON learner_badges(username);

            -- Star-velocity snapshots for the Explore page. The GitHub Search
            -- API doesn't expose "stars in last 7 days" — we have to derive it
            -- by remembering yesterday's count and diffing. Snapshots are
            -- written opportunistically every time Explore fetches a repo, and
            -- throttled so we don't bloat the table with one row per second.
            CREATE TABLE IF NOT EXISTS repo_star_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_full_name TEXT NOT NULL,
                stargazers_count INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_repo_time
                ON repo_star_snapshots (repo_full_name, fetched_at);
        `);

        // App-building fields added 2026-04-20 — additive, non-breaking.
        // Wrapped in try/catch because SQLite lacks ALTER TABLE IF NOT EXISTS.
        const tryAlter = (sql) => {
            try { this.db.prepare(sql).run(); } catch (e) {
                if (!/duplicate column/i.test(e.message)) throw e;
            }
        };
        tryAlter('ALTER TABLE projects ADD COLUMN prompt TEXT');
        tryAlter('ALTER TABLE projects ADD COLUMN prd TEXT');
        tryAlter('ALTER TABLE projects ADD COLUMN stack TEXT');
        tryAlter('ALTER TABLE projects ADD COLUMN references_json TEXT');
        tryAlter('ALTER TABLE projects ADD COLUMN last_commit_at INTEGER');
        // Marker for "last commit the user has been shown / acknowledged".
        // Updated when the user opens the project detail view. If
        // last_commit_at > last_seen_commit_at the card shows an
        // "External activity" badge so they notice github-side commits.
        tryAlter('ALTER TABLE projects ADD COLUMN last_seen_commit_at INTEGER');
        // GitHub repo visibility. NULL = unknown (not yet backfilled), 0 = public,
        // 1 = private. Captured on import and refreshed by the boot-time
        // visibility backfill in server.js.
        tryAlter('ALTER TABLE projects ADD COLUMN is_private INTEGER');

        // Enforce at most one project per repo_url (NULLs allowed — manual
        // projects have no repo). Partial unique index. Guarded: if the table
        // already holds legacy duplicate repo_urls the creation throws, so log
        // and continue rather than crash boot.
        try {
            this.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repo_url ON projects(repo_url) WHERE repo_url IS NOT NULL').run();
        } catch (e) {
            console.warn('[db] skipped unique repo_url index — legacy duplicates present:', e.message);
        }
    }

    // ========== SETTINGS ==========

    getSetting(key) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    setSetting(key, value) {
        this.db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
        `).run(key, value);
        return { key, value };
    }

    getAllSettings() {
        return this.db.prepare('SELECT key, value, updated_at FROM settings').all();
    }

    deleteSetting(key) {
        const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        return result.changes > 0;
    }

    // ========== PROJECTS ==========
    
    addProject(project) {
        const stmt = this.db.prepare(`
            INSERT INTO projects (name, description, status, category, tech_stack, target_market, monetization, pricing, repo_url, live_url, local_path, source, readme, prompt, prd, stack, references_json, is_private)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Accept GitHub's `private` boolean or an explicit `is_private`; store
        // as 0/1, or null when caller didn't supply visibility.
        const visibility = project.is_private ?? project.private;
        const isPrivate = visibility === undefined || visibility === null
            ? null : (visibility ? 1 : 0);

        let result;
        try {
            result = stmt.run(
                project.name,
                project.description || null,
                project.status || 'idea',
                project.category || 'app',
                project.tech_stack || null,
                project.target_market || null,
                project.monetization || null,
                project.pricing || null,
                project.repo_url || null,
                project.live_url || null,
                project.local_path || null,
                project.source || 'manual',
                project.readme || null,
                project.prompt || null,
                project.prd || null,
                project.stack || null,
                project.references_json || null,
                isPrivate
            );
        } catch (e) {
            // Race with a concurrent import of the same repo_url — the unique
            // index rejects the duplicate. Return the project that already owns
            // it instead of throwing (idempotent "ON CONFLICT" behavior).
            if (/UNIQUE constraint failed/i.test(e.message) && project.repo_url) {
                const existing = this.db.prepare('SELECT * FROM projects WHERE repo_url = ?').get(project.repo_url);
                if (existing) return existing;
            }
            throw e;
        }

        return this.getProject(result.lastInsertRowid);
    }

    getProject(id) {
        const stmt = this.db.prepare('SELECT * FROM projects WHERE id = ?');
        return stmt.get(id);
    }

    getAllProjects(filters = {}) {
        let query = 'SELECT * FROM projects WHERE 1=1';
        const params = [];
        
        if (filters.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        
        if (filters.category) {
            query += ' AND category = ?';
            params.push(filters.category);
        }
        
        query += ' ORDER BY updated_at DESC';
        
        const stmt = this.db.prepare(query);
        return stmt.all(...params);
    }

    updateProject(id, updates) {
        const fields = [];
        const params = [];
        
        const allowed = ['name', 'description', 'status', 'category', 'tech_stack',
                         'target_market', 'monetization', 'pricing', 'repo_url', 'live_url',
                         'local_path', 'source', 'readme',
                         'prompt', 'prd', 'stack', 'references_json',
                         'last_commit_at', 'last_seen_commit_at', 'is_private'];
        
        allowed.forEach(field => {
            if (updates[field] !== undefined) {
                fields.push(`${field} = ?`);
                params.push(updates[field]);
            }
        });
        
        if (updates.status === 'launched' && !this.getProject(id).launched_at) {
            fields.push('launched_at = unixepoch()');
        }
        
        fields.push('updated_at = unixepoch()');
        
        if (fields.length === 0) return null;
        
        params.push(id);
        const query = `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`;
        
        const stmt = this.db.prepare(query);
        stmt.run(...params);
        
        return this.getProject(id);
    }

    deleteProject(id) {
        const stmt = this.db.prepare('DELETE FROM projects WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    // ========== UPDATES ==========
    
    addUpdate(update) {
        const stmt = this.db.prepare(`
            INSERT INTO updates (project_id, type, title, content)
            VALUES (?, ?, ?, ?)
        `);
        
        const result = stmt.run(
            update.project_id,
            update.type || 'progress',
            update.title,
            update.content || null
        );
        
        // Update project's updated_at
        this.db.prepare('UPDATE projects SET updated_at = unixepoch() WHERE id = ?')
            .run(update.project_id);
        
        return this.getUpdate(result.lastInsertRowid);
    }

    getUpdate(id) {
        const stmt = this.db.prepare('SELECT * FROM updates WHERE id = ?');
        return stmt.get(id);
    }

    getProjectUpdates(projectId, limit = 50) {
        const stmt = this.db.prepare(`
            SELECT * FROM updates 
            WHERE project_id = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(projectId, limit);
    }

    deleteUpdate(id) {
        const stmt = this.db.prepare('DELETE FROM updates WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    // ========== METRICS ==========
    
    addMetric(metric) {
        const stmt = this.db.prepare(`
            INSERT INTO metrics (project_id, metric_name, value, recorded_at)
            VALUES (?, ?, ?, ?)
        `);
        
        const result = stmt.run(
            metric.project_id,
            metric.metric_name,
            metric.value,
            metric.recorded_at || Math.floor(Date.now() / 1000)
        );
        
        return { id: result.lastInsertRowid, ...metric };
    }

    getProjectMetrics(projectId, metricName = null) {
        let query = 'SELECT * FROM metrics WHERE project_id = ?';
        const params = [projectId];
        
        if (metricName) {
            query += ' AND metric_name = ?';
            params.push(metricName);
        }
        
        query += ' ORDER BY recorded_at DESC';
        
        const stmt = this.db.prepare(query);
        return stmt.all(...params);
    }

    // ========== STATS ==========
    
    getStats() {
        const stmt = this.db.prepare(`
            SELECT 
                status,
                COUNT(*) as count
            FROM projects
            GROUP BY status
        `);
        
        const stats = stmt.all();
        const result = {
            idea: 0,
            planning: 0,
            building: 0,
            launched: 0,
            growing: 0,
            paused: 0
        };
        
        stats.forEach(s => {
            result[s.status] = s.count;
        });
        
        return result;
    }

    // ========== LEARN ==========

    getLearner(username) {
        return this.db.prepare('SELECT * FROM learners WHERE username = ?').get(username);
    }

    // Idempotent — first call creates the row, subsequent calls only refresh
    // display_name (when provided) and last_active_at. We intentionally don't
    // reset total_xp/level on re-login.
    upsertLearner({ username, display_name }) {
        this.db.prepare(`
            INSERT INTO learners (username, display_name, last_active_at)
            VALUES (?, ?, unixepoch())
            ON CONFLICT(username) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, learners.display_name),
                last_active_at = unixepoch()
        `).run(username, display_name || null);
        return this.getLearner(username);
    }

    bumpLearnerActivity(username) {
        this.db.prepare('UPDATE learners SET last_active_at = unixepoch() WHERE username = ?').run(username);
    }

    getLearnerProgress(username) {
        return this.db.prepare(
            'SELECT * FROM lesson_progress WHERE username = ? ORDER BY lesson_id'
        ).all(username);
    }

    // Upserts the (username, lesson_id) row. completed_at is stamped only on
    // the transition to status='completed' so we don't churn the timestamp on
    // repeat saves.
    upsertLessonProgress({ username, lesson_id, status, score, attempts }) {
        this.db.prepare(`
            INSERT INTO lesson_progress (username, lesson_id, status, score, attempts, completed_at)
            VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN unixepoch() ELSE NULL END)
            ON CONFLICT(username, lesson_id) DO UPDATE SET
                status = excluded.status,
                score = excluded.score,
                attempts = excluded.attempts,
                completed_at = CASE
                    WHEN excluded.status = 'completed' AND lesson_progress.completed_at IS NULL
                        THEN unixepoch()
                    ELSE lesson_progress.completed_at
                END
        `).run(username, lesson_id, status || 'in_progress', score || 0, attempts || 0, status || 'in_progress');
        return this.db.prepare(
            'SELECT * FROM lesson_progress WHERE username = ? AND lesson_id = ?'
        ).get(username, lesson_id);
    }

    getLearnerBadges(username) {
        return this.db.prepare(
            'SELECT * FROM learner_badges WHERE username = ? ORDER BY earned_at'
        ).all(username);
    }

    // INSERT OR IGNORE — re-awarding a badge is a no-op. Returns true if a new
    // badge row was created so the caller can include it in newBadges.
    addBadge(username, badge_id) {
        const result = this.db.prepare(
            'INSERT OR IGNORE INTO learner_badges (username, badge_id) VALUES (?, ?)'
        ).run(username, badge_id);
        return result.changes > 0;
    }

    addXp(username, xp) {
        this.db.prepare('UPDATE learners SET total_xp = total_xp + ? WHERE username = ?').run(xp, username);
    }

    setLearnerLevel(username, level) {
        this.db.prepare('UPDATE learners SET level = ? WHERE username = ?').run(level, username);
    }

    // Wipe one learner's progress. Wrapped in a transaction so a partial reset
    // can't leave xp/level out of sync with the empty progress/badges tables.
    resetLearner(username) {
        const tx = this.db.transaction((u) => {
            this.db.prepare('DELETE FROM lesson_progress WHERE username = ?').run(u);
            this.db.prepare('DELETE FROM learner_badges WHERE username = ?').run(u);
            this.db.prepare("UPDATE learners SET total_xp = 0, level = 'basic' WHERE username = ?").run(u);
        });
        tx(username);
    }

    // ========== STAR-VELOCITY SNAPSHOTS ==========

    // Throttled insert. If we already have a snapshot for this repo within the
    // last `minIntervalSec` (default 6 hours), skip — otherwise insert. Returns
    // true when a new row was written so callers can log if useful.
    recordStarSnapshot(repoFullName, stars, minIntervalSec = 6 * 60 * 60) {
        if (!repoFullName) return false;
        const now = Math.floor(Date.now() / 1000);
        const recent = this.db.prepare(`
            SELECT fetched_at FROM repo_star_snapshots
            WHERE repo_full_name = ? AND fetched_at > ?
            ORDER BY fetched_at DESC LIMIT 1
        `).get(repoFullName, now - minIntervalSec);
        if (recent) return false;
        this.db.prepare(`
            INSERT INTO repo_star_snapshots (repo_full_name, stargazers_count, fetched_at)
            VALUES (?, ?, ?)
        `).run(repoFullName, stars, now);
        return true;
    }

    // Bulk version — wraps the throttled insert in a transaction for speed.
    // Returns count of new snapshots actually written.
    recordStarSnapshotsBulk(rows, minIntervalSec) {
        let written = 0;
        const tx = this.db.transaction((rs) => {
            for (const { repo_full_name, stargazers_count } of rs) {
                if (this.recordStarSnapshot(repo_full_name, stargazers_count, minIntervalSec)) {
                    written++;
                }
            }
        });
        tx(rows || []);
        return written;
    }

    // Return Δstars over the last `days` days for one repo. Looks for the
    // oldest snapshot within the window and diffs against the most recent
    // (or the supplied `currentStars` if provided — typical use is "we just
    // fetched stars=N, what's the delta from N days ago"). Returns null when
    // there isn't enough history to compute a meaningful delta.
    getStarDelta(repoFullName, days = 7, currentStars = null) {
        if (!repoFullName) return null;
        const now = Math.floor(Date.now() / 1000);
        const cutoff = now - days * 86400;
        // Oldest snapshot within the window — that's the "N days ago" anchor.
        const old = this.db.prepare(`
            SELECT stargazers_count, fetched_at FROM repo_star_snapshots
            WHERE repo_full_name = ? AND fetched_at >= ?
            ORDER BY fetched_at ASC LIMIT 1
        `).get(repoFullName, cutoff);
        if (!old) return null;
        let nowStars = currentStars;
        if (nowStars === null) {
            const latest = this.db.prepare(`
                SELECT stargazers_count FROM repo_star_snapshots
                WHERE repo_full_name = ? ORDER BY fetched_at DESC LIMIT 1
            `).get(repoFullName);
            if (!latest) return null;
            nowStars = latest.stargazers_count;
        }
        const ageSeconds = now - old.fetched_at;
        // Require at least 2h of history before quoting a delta — otherwise the
        // number is too noisy to be meaningful.
        if (ageSeconds < 7200) return null;
        return {
            delta: nowStars - old.stargazers_count,
            days_actual: +(ageSeconds / 86400).toFixed(2),
            anchor_stars: old.stargazers_count,
            anchor_at: old.fetched_at
        };
    }

    close() {
        // Idempotent — may be invoked from both a signal handler and the
        // process 'exit' handler. Guard first: a pragma on an already-closed
        // connection throws ("The database connection is not open").
        if (!this.db.open) return;
        // Fold the WAL into the main DB and truncate it to 0 bytes so it doesn't
        // persist multi-MB on disk between restarts. Best-effort: a checkpoint
        // can fail if another connection holds the DB, but we still must close.
        try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* best effort */ }
        this.db.close();
    }
}

module.exports = LaunchpadDB;
