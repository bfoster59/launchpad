const Database = require('better-sqlite3');
const path = require('path');

class LaunchpadDB {
    constructor() {
        this.db = new Database(path.join(__dirname, 'launchpad.db'));
        this.db.pragma('journal_mode = WAL');
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
            INSERT INTO projects (name, description, status, category, tech_stack, target_market, monetization, pricing, repo_url, live_url, local_path, source, readme, prompt, prd, stack, references_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
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
            project.references_json || null
        );

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
                         'last_commit_at'];
        
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

    close() {
        this.db.close();
    }
}

module.exports = LaunchpadDB;
