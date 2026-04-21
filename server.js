const express = require('express');
const { Octokit } = require('@octokit/rest');
const LaunchpadDB = require('./database');

const app = express();
const PORT = 3020;
const HOST = '0.0.0.0';

// Initialize database
const db = new LaunchpadDB();

// Any git operation we spawn should fail fast on auth prompts instead of
// hanging — GIT_TERMINAL_PROMPT=0 tells git "no interactive stdin available".
process.env.GIT_TERMINAL_PROMPT = '0';

// Configure a per-repo credential helper after a private clone so future
// fetch/pull/push use the stored PAT without re-embedding it in origin.
function installCredentialHelper(repoDir, pat) {
    try {
        const fs = require('fs');
        const path = require('path');
        const { execSync } = require('child_process');
        const credPath = path.join(repoDir, '.git', 'credentials');
        fs.writeFileSync(credPath, `https://x-access-token:${pat}@github.com\n`, { mode: 0o600 });
        execSync(`git -C "${repoDir}" config credential.helper "store --file=.git/credentials"`, {
            stdio: 'ignore',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
    } catch (e) {
        console.error('credential helper install failed:', e.message);
    }
}

// GitHub client — loaded from settings table on boot, or env var fallback
let octokit = null;

function initOctokit() {
    const pat = db.getSetting('github_pat') || process.env.GITHUB_TOKEN;
    if (pat) {
        octokit = new Octokit({ auth: pat });
        return true;
    }
    return false;
}

// Derive the clone base directory (Settings > env > hardcoded default)
function getCloneBaseDir() {
    return db.getSetting('clone_base_dir') || process.env.CLONE_BASE_DIR || '/home/bfoster';
}

initOctokit();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' })); // Increase limit for bulk imports

// ========== PROJECT ENDPOINTS ==========

// Get all projects
app.get('/api/projects', (req, res) => {
    try {
        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.category) filters.category = req.query.category;
        
        const projects = db.getAllProjects(filters);
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get a single project with updates and metrics
app.get('/api/projects/:id', (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        const updates = db.getProjectUpdates(project.id);
        const metrics = db.getProjectMetrics(project.id);
        
        res.json({
            ...project,
            updates,
            metrics
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create project
app.post('/api/projects', (req, res) => {
    try {
        const project = db.addProject(req.body);
        res.json(project);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Update project
app.patch('/api/projects/:id', (req, res) => {
    try {
        const project = db.updateProject(parseInt(req.params.id), req.body);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(project);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Delete project
app.delete('/api/projects/:id', (req, res) => {
    try {
        const deleted = db.deleteProject(parseInt(req.params.id));
        if (!deleted) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get project stats
app.get('/api/stats', (req, res) => {
    try {
        const stats = db.getStats();
        const projects = db.getAllProjects();
        const total = projects.length;
        const launched = projects.filter(p => p.status === 'launched' || p.status === 'growing').length;
        
        res.json({
            ...stats,
            total,
            launched,
            inProgress: stats.building + stats.planning
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== UPDATE ENDPOINTS ==========

// Add update to project
app.post('/api/projects/:id/updates', (req, res) => {
    try {
        const update = db.addUpdate({
            project_id: parseInt(req.params.id),
            ...req.body
        });
        res.json(update);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get project updates
app.get('/api/projects/:id/updates', (req, res) => {
    try {
        const updates = db.getProjectUpdates(parseInt(req.params.id));
        res.json(updates);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete update
app.delete('/api/updates/:id', (req, res) => {
    try {
        const deleted = db.deleteUpdate(parseInt(req.params.id));
        if (!deleted) {
            return res.status(404).json({ error: 'Update not found' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ========== METRIC ENDPOINTS ==========

// Add metric
app.post('/api/projects/:id/metrics', (req, res) => {
    try {
        const metric = db.addMetric({
            project_id: parseInt(req.params.id),
            ...req.body
        });
        res.json(metric);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get project metrics
app.get('/api/projects/:id/metrics', (req, res) => {
    try {
        const metrics = db.getProjectMetrics(
            parseInt(req.params.id),
            req.query.metric_name
        );
        res.json(metrics);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== GITHUB ENDPOINTS ==========

// Search GitHub repos
app.get('/api/github/search', async (req, res) => {
    try {
        const { q, per_page = 10 } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Query required' });
        }
        
        const client = octokit || new Octokit();
        const { data } = await client.search.repos({
            q,
            sort: 'stars',
            order: 'desc',
            per_page: parseInt(per_page)
        });
        
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get trending repos
app.get('/api/github/trending', async (req, res) => {
    try {
        const { language = '', since = 'monthly' } = req.query;

        const now = new Date();
        const ranges = {
            daily: 24 * 60 * 60 * 1000,
            weekly: 7 * 24 * 60 * 60 * 1000,
            monthly: 30 * 24 * 60 * 60 * 1000,
            yearly: 365 * 24 * 60 * 60 * 1000
        };
        const dateFilter = new Date(now - (ranges[since] || ranges.monthly));
        const dateStr = dateFilter.toISOString().split('T')[0];

        let query = `created:>${dateStr}`;
        if (language) query += ` language:${language}`;

        // Use authenticated client when available — 5000/hr vs 60/hr unauthed
        const client = octokit || new Octokit();
        const { data } = await client.search.repos({
            q: query,
            sort: 'stars',
            order: 'desc',
            per_page: 10
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check GitHub sync status
app.get('/api/projects/:id/sync-status', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        const fs = require('fs');
        
        const project = db.getProject(parseInt(req.params.id));
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        if (!project.repo_url) {
            return res.json({ status: 'no_repo', message: 'No GitHub repository linked' });
        }
        
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.json({ status: 'not_cloned', message: 'Repository not cloned locally' });
        }
        
        // Check git status
        try {
            // Fetch latest from remote
            await execPromise(`cd "${project.local_path}" && git fetch origin 2>&1`);
            
            // Check for uncommitted changes
            const { stdout: statusOut } = await execPromise(`cd "${project.local_path}" && git status --porcelain`);
            const hasUncommitted = statusOut.trim().length > 0;
            
            // Check for unpushed commits
            const { stdout: unpushedOut } = await execPromise(`cd "${project.local_path}" && git log origin/$(git rev-parse --abbrev-ref HEAD)..HEAD --oneline 2>&1 || echo ""`);
            const hasUnpushed = unpushedOut.trim().length > 0 && !unpushedOut.includes('fatal');
            
            // Check if behind remote
            const { stdout: behindOut } = await execPromise(`cd "${project.local_path}" && git log HEAD..origin/$(git rev-parse --abbrev-ref HEAD) --oneline 2>&1 || echo ""`);
            const isBehind = behindOut.trim().length > 0 && !behindOut.includes('fatal');
            
            // Get current branch
            const { stdout: branchOut } = await execPromise(`cd "${project.local_path}" && git rev-parse --abbrev-ref HEAD`);
            const currentBranch = branchOut.trim();
            
            // Get last commit info
            const { stdout: lastCommitOut } = await execPromise(`cd "${project.local_path}" && git log -1 --format="%h|%s|%ar"`);
            const [hash, message, timeAgo] = lastCommitOut.trim().split('|');
            
            let status = 'synced';
            let messages = [];
            
            if (hasUncommitted) {
                status = 'dirty';
                messages.push('Uncommitted changes');
            }
            if (hasUnpushed) {
                status = 'unpushed';
                messages.push('Unpushed commits');
            }
            if (isBehind) {
                status = 'behind';
                messages.push('Behind remote - pull needed');
            }
            
            if (status === 'synced') {
                messages.push('Up to date with remote');
            }
            
            res.json({
                status,
                messages,
                details: {
                    branch: currentBranch,
                    lastCommit: {
                        hash,
                        message,
                        timeAgo
                    },
                    hasUncommitted,
                    hasUnpushed,
                    isBehind
                }
            });
        } catch (gitError) {
            res.json({ 
                status: 'error', 
                message: 'Git error: ' + gitError.message,
                details: { error: gitError.message }
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clone repo to local
// ========== GITHUB READ-ONLY HELPERS (issues, commits, branches) ==========

// Extract owner/repo from a github URL
function parseRepoUrl(url) {
    const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url || '');
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
}

// List recent issues on the repo (filters state)
app.get('/api/projects/:id/issues', async (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const parsed = parseRepoUrl(project.repo_url);
        if (!parsed) return res.status(400).json({ error: 'No parseable GitHub URL on this project' });

        const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
        const client = octokit || new Octokit();
        const { data } = await client.issues.listForRepo({
            owner: parsed.owner,
            repo: parsed.repo,
            state,
            per_page: 30
        });

        // Octokit returns PRs in issues feed too — filter them out
        const issues = data.filter(i => !i.pull_request).map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            user: i.user ? i.user.login : null,
            created_at: i.created_at,
            comments: i.comments,
            labels: (i.labels || []).map(l => ({ name: l.name || l, color: l.color }))
        }));
        res.json({ state, count: issues.length, issues });
    } catch (error) {
        const msg = error.status === 404 ? 'Repository not found or private without token' : error.message;
        res.status(error.status || 500).json({ error: msg });
    }
});

// List recent commits on the default branch
app.get('/api/projects/:id/commits', async (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const parsed = parseRepoUrl(project.repo_url);
        if (!parsed) return res.status(400).json({ error: 'No parseable GitHub URL on this project' });

        const limit = Math.min(parseInt(req.query.limit) || 10, 30);
        const client = octokit || new Octokit();
        const { data } = await client.repos.listCommits({
            owner: parsed.owner,
            repo: parsed.repo,
            per_page: limit
        });

        const commits = data.map(c => ({
            sha: c.sha,
            short: c.sha.substring(0, 7),
            message: (c.commit.message || '').split('\n')[0],
            author: c.commit.author ? c.commit.author.name : null,
            author_login: c.author ? c.author.login : null,
            date: c.commit.author ? c.commit.author.date : null,
            html_url: c.html_url
        }));
        res.json({ count: commits.length, commits });
    } catch (error) {
        const msg = error.status === 404 ? 'Repository not found or private without token' : error.message;
        res.status(error.status || 500).json({ error: msg });
    }
});

// List branches on the repo (useful for future branch switcher)
app.get('/api/projects/:id/branches', async (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const parsed = parseRepoUrl(project.repo_url);
        if (!parsed) return res.status(400).json({ error: 'No parseable GitHub URL on this project' });

        const client = octokit || new Octokit();
        const { data } = await client.repos.listBranches({
            owner: parsed.owner,
            repo: parsed.repo,
            per_page: 50
        });
        res.json({
            count: data.length,
            branches: data.map(b => ({ name: b.name, protected: b.protected, sha: b.commit.sha }))
        });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

// ========== UTILITY: Open terminal / folder in the project's local_path ==========

// Resolve the user's preferred terminal command template. Settings > env > platform default.
// If `runCommand` is given, append it so the terminal opens AND runs that command
// (useful for 'Open in Claude Code' — spawn terminal and auto-launch claude).
function getTerminalCommand(cwd, runCommand) {
    const stored = db.getSetting('terminal_app');
    const platform = process.platform;
    const cwdQuoted = `"${cwd.replace(/"/g, '\\"')}"`;
    const rc = runCommand ? String(runCommand).trim() : '';

    const defaults = {
        win32: {
            wt: rc
                ? `wt new-tab -d ${cwdQuoted} cmd /K "${rc}"`
                : `wt new-tab -d ${cwdQuoted}`,
            cmd: rc
                ? `start cmd /K "cd /d ${cwdQuoted} && ${rc}"`
                : `start cmd /K "cd /d ${cwdQuoted}"`,
            powershell: rc
                ? `start powershell -NoExit -Command "Set-Location -LiteralPath ${cwdQuoted}; ${rc}"`
                : `start powershell -NoExit -Command "Set-Location -LiteralPath ${cwdQuoted}"`,
            pwsh: rc
                ? `start pwsh -NoExit -Command "Set-Location -LiteralPath ${cwdQuoted}; ${rc}"`
                : `start pwsh -NoExit -Command "Set-Location -LiteralPath ${cwdQuoted}"`,
            gitbash: rc
                ? `start "" "C:\\Program Files\\Git\\bin\\bash.exe" --cd=${cwdQuoted} -c "${rc}; exec bash"`
                : `start "" "C:\\Program Files\\Git\\bin\\bash.exe" --cd=${cwdQuoted}`
        },
        darwin: {
            terminal: `open -a Terminal ${cwdQuoted}`,
            iterm: `open -a iTerm ${cwdQuoted}`
        },
        linux: {
            'gnome-terminal': rc
                ? `gnome-terminal --working-directory=${cwdQuoted} -- bash -c "${rc}; exec bash"`
                : `gnome-terminal --working-directory=${cwdQuoted}`,
            konsole: rc
                ? `konsole --workdir ${cwdQuoted} -e bash -c "${rc}; exec bash"`
                : `konsole --workdir ${cwdQuoted}`,
            xterm: rc
                ? `xterm -e "cd ${cwdQuoted} && ${rc}; bash"`
                : `xterm -e "cd ${cwdQuoted} && bash"`
        }
    };

    const platformDefaults = defaults[platform] || defaults.linux;
    if (stored && platformDefaults[stored]) return platformDefaults[stored];
    const fallbackKey = platform === 'win32' ? 'wt'
                      : platform === 'darwin' ? 'terminal'
                      : 'gnome-terminal';
    return platformDefaults[fallbackKey];
}

app.post('/api/util/open-terminal', (req, res) => {
    try {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const cwd = req.body.path;
        if (!cwd || !fs.existsSync(cwd)) {
            return res.status(400).json({ error: 'Path not found' });
        }
        // Optional command that the terminal should run after cd-ing.
        // Whitelist keeps arbitrary shell strings from being injected.
        const allowedRun = new Set(['claude', 'npm run dev', 'npm start']);
        const runCommand = allowedRun.has(req.body.command) ? req.body.command : null;
        const cmd = getTerminalCommand(cwd, runCommand);
        // spawn with shell:true + detached+unref so the terminal opens a
        // visible window and outlives the launchpad request.
        const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
        child.on('error', (err) => console.error('open-terminal:', err.message));
        child.unref();
        res.json({ success: true, command: cmd, cwd });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/util/open-folder', (req, res) => {
    try {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const cwd = req.body.path;
        if (!cwd || !fs.existsSync(cwd)) {
            return res.status(400).json({ error: 'Path not found' });
        }
        // Use the OS file-manager opener with path as an argument — no shell
        // string interpolation beyond the single path arg.
        const openerArgs = process.platform === 'win32' ? ['explorer', cwd]
                         : process.platform === 'darwin' ? ['open', cwd]
                         : ['xdg-open', cwd];
        const child = spawn(openerArgs[0], [openerArgs[1]], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => console.error('open-folder:', err.message));
        child.unref();
        res.json({ success: true, command: openerArgs.join(' '), cwd });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List valid terminal_app choices for the current platform (used by Settings UI)
app.get('/api/util/terminal-choices', (req, res) => {
    const platform = process.platform;
    const choices = {
        win32: ['wt', 'cmd', 'powershell', 'pwsh', 'gitbash'],
        darwin: ['terminal', 'iterm'],
        linux: ['gnome-terminal', 'konsole', 'xterm']
    };
    res.json({ platform, choices: choices[platform] || choices.linux });
});

// Install deps (npm install) for a project's local clone. Blocking — returns
// once install finishes or fails.
app.post('/api/projects/:id/install-deps', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        const fs = require('fs');
        const path = require('path');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.status(400).json({ error: 'Repository not cloned locally' });
        }
        if (!fs.existsSync(path.join(project.local_path, 'package.json'))) {
            return res.status(400).json({ error: 'No package.json — nothing to install' });
        }

        try {
            const { stdout, stderr } = await execPromise('npm install', {
                cwd: project.local_path,
                maxBuffer: 50 * 1024 * 1024
            });
            db.addUpdate({
                project_id: project.id,
                type: 'progress',
                title: 'Installed dependencies',
                content: `npm install completed in ${project.local_path}`
            });
            res.json({
                success: true,
                output: (stdout + stderr).split('\n').slice(-20).join('\n')
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: 'npm install failed',
                output: (e.stderr || e.message || '').split('\n').slice(-20).join('\n')
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// In-memory map of spawned dev servers: project_id -> { pid, command, cwd,
// url, startedAt, stdoutTail, child }. Lost on launchpad restart (iteration 2
// could persist PIDs and reconcile on boot).
const runningServers = new Map();

// Best-effort URL extraction from dev-server stdout. Matches 'Local: http://...'
// (Next.js), 'http://localhost:NNNN' (Vite, CRA), etc. Avoids Git URLs.
function extractUrl(text) {
    const urlMatch = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\S*/i);
    if (urlMatch) return urlMatch[0].replace(/[.,;:)]+$/, '');
    const portMatch = text.match(/localhost:(\d+)/i);
    if (portMatch) return `http://localhost:${portMatch[1]}`;
    return null;
}

// Get the running-server state for a project (polled by the UI for URL detection)
app.get('/api/projects/:id/running', (req, res) => {
    const id = parseInt(req.params.id);
    const entry = runningServers.get(id);
    if (!entry) return res.json({ running: false });
    res.json({
        running: true,
        pid: entry.pid,
        url: entry.url,
        command: entry.command,
        cwd: entry.cwd,
        startedAt: entry.startedAt,
        stdoutTail: entry.stdoutTail ? entry.stdoutTail.split('\n').slice(-10).join('\n') : ''
    });
});

// Stop a running dev server spawned via /launch.
app.post('/api/projects/:id/stop', (req, res) => {
    const { spawn } = require('child_process');
    const id = parseInt(req.params.id);
    const entry = runningServers.get(id);
    if (!entry) return res.status(404).json({ error: 'Not running in this launchpad instance' });

    if (process.platform === 'win32') {
        // /T kills the process tree (cmd wrapper + npm + node dev server).
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(entry.pid)], {
            detached: true, stdio: 'ignore'
        });
        killer.unref();
    } else {
        // Negative PID kills the process group on POSIX.
        try { process.kill(-entry.pid); } catch (e) { try { process.kill(entry.pid); } catch (e2) { /* ignore */ } }
    }
    runningServers.delete(id);
    db.addUpdate({
        project_id: id,
        type: 'progress',
        title: 'Stopped',
        content: `Killed dev server pid ${entry.pid}`
    });
    res.json({ success: true, pid: entry.pid });
});

// Launch the project — opens live_url, or spawns npm run dev / npm start
app.post('/api/projects/:id/launch', async (req, res) => {
    try {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const path = require('path');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });

        // No local clone? Fall back to live_url if set.
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            if (project.live_url) {
                return res.json({ type: 'url', url: project.live_url });
            }
            return res.status(400).json({ error: 'No local clone and no live URL available' });
        }

        const cwd = project.local_path;
        const pkgPath = path.join(cwd, 'package.json');

        if (fs.existsSync(pkgPath)) {
            let pkg;
            try {
                pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            } catch (e) {
                return res.status(400).json({ error: 'Invalid package.json: ' + e.message });
            }
            const scripts = pkg.scripts || {};
            const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
            if (!scriptName) {
                return res.status(400).json({ error: 'package.json has no dev or start script' });
            }
            // Catch the common case: deps not installed. A detached spawn
            // would silently fail otherwise — the user clicks Launch, gets
            // a PID, but Next.js never boots.
            const nodeModules = path.join(cwd, 'node_modules');
            if (!fs.existsSync(nodeModules)) {
                return res.status(409).json({
                    type: 'install_needed',
                    error: 'Dependencies not installed — run `npm install` first',
                    suggestion: `cd ${cwd} && npm install`,
                    cwd
                });
            }
            // Kill any prior entry for this project (stale PID would confuse UI)
            if (runningServers.has(project.id)) {
                const prev = runningServers.get(project.id);
                try {
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/F', '/T', '/PID', String(prev.pid)], { detached: true, stdio: 'ignore' }).unref();
                    } else {
                        process.kill(-prev.pid);
                    }
                } catch (e) { /* ignore */ }
                runningServers.delete(project.id);
            }

            // shell:true lets Windows resolve npm.cmd; detached+unref so the
            // process isn't in the event-loop critical path; stdio pipes so we
            // can observe stdout for port detection.
            const child = spawn('npm', ['run', scriptName], {
                cwd,
                detached: true,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const entry = {
                pid: child.pid,
                command: `npm run ${scriptName}`,
                cwd,
                url: null,
                startedAt: Date.now(),
                stdoutTail: '',
                child
            };
            runningServers.set(project.id, entry);

            // Capture stdout/stderr to extract the URL the dev server prints at startup
            const readChunk = (chunk) => {
                const text = chunk.toString();
                entry.stdoutTail = (entry.stdoutTail + text).slice(-8192);
                if (!entry.url) {
                    const u = extractUrl(text);
                    if (u) entry.url = u;
                }
            };
            if (child.stdout) child.stdout.on('data', readChunk);
            if (child.stderr) child.stderr.on('data', readChunk);
            child.on('exit', (code) => {
                const e = runningServers.get(project.id);
                if (e && e.pid === child.pid) runningServers.delete(project.id);
            });
            child.on('error', (err) => console.error('spawn error:', err.message));

            db.addUpdate({
                project_id: project.id,
                type: 'progress',
                title: 'Launched',
                content: `Spawned: npm run ${scriptName} (pid ${child.pid}) in ${cwd}`
            });

            return res.json({
                type: 'spawned',
                pid: child.pid,
                command: `npm run ${scriptName}`,
                cwd,
                live_url: project.live_url || null,
                note: 'Dev server running. URL will appear once detected.'
            });
        }

        // No package.json — if the project has a live_url, open that.
        if (project.live_url) {
            return res.json({ type: 'url', url: project.live_url });
        }

        return res.status(400).json({
            error: 'No recognized launch target (no package.json dev/start, no live_url)'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Commit + optionally push the project's local clone
app.post('/api/projects/:id/commit', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        const fs = require('fs');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.status(400).json({ error: 'Repository not cloned locally' });
        }

        const message = (req.body.message || '').trim();
        const push = req.body.push !== false;
        const addAll = req.body.addAll !== false;

        if (addAll && !message) {
            return res.status(400).json({ error: 'Commit message required when committing new changes' });
        }

        const cwd = project.local_path;
        const shq = (s) => `"${s.replace(/"/g, '\\"')}"`;
        const results = {};

        if (addAll) {
            // Only commit when there's something staged
            try {
                await execPromise(`cd ${shq(cwd)} && git add -A`);
                const { stdout: statusOut } = await execPromise(`cd ${shq(cwd)} && git status --porcelain`);
                if (!statusOut.trim()) {
                    results.commit = { skipped: true, reason: 'nothing to commit' };
                } else {
                    const { stdout: commitOut } = await execPromise(`cd ${shq(cwd)} && git commit -m ${shq(message)}`);
                    results.commit = { ok: true, output: commitOut.trim() };
                    db.addUpdate({
                        project_id: project.id,
                        type: 'progress',
                        title: 'Commit',
                        content: message
                    });
                    // Activity on a dormant project nudges lifecycle to 'building'
                    if (project.status === 'idea' || project.status === 'paused') {
                        db.updateProject(project.id, { status: 'building' });
                        results.statusBumped = 'building';
                    }
                }
            } catch (e) {
                results.commit = { ok: false, error: e.stderr || e.message };
            }
        }

        if (push) {
            try {
                const { stdout, stderr } = await execPromise(`cd ${shq(cwd)} && git push`);
                results.push = { ok: true, output: (stdout + stderr).trim() };
            } catch (e) {
                results.push = { ok: false, error: (e.stderr || e.message).trim() };
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Pull (fast-forward only) to catch up a project behind origin
app.post('/api/projects/:id/pull', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        const fs = require('fs');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.status(400).json({ error: 'Repository not cloned locally' });
        }

        const cwd = project.local_path;
        try {
            const { stdout, stderr } = await execPromise(`cd "${cwd}" && git pull --ff-only`);
            res.json({ success: true, output: (stdout + stderr).trim() });
        } catch (e) {
            res.status(409).json({
                success: false,
                error: 'Fast-forward pull failed — resolve manually in terminal',
                details: (e.stderr || e.message).trim()
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/projects/:id/clone', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        const path = require('path');
        
        const project = db.getProject(parseInt(req.params.id));
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        if (!project.repo_url) {
            return res.status(400).json({ error: 'Project has no repository URL' });
        }
        
        // Determine target directory — Settings > env > default '/home/bfoster'.
        // On Windows '/home/bfoster' resolves to C:\home\bfoster, mirroring Beelink layout.
        const baseDir = getCloneBaseDir();
        const targetDir = path.join(baseDir, project.name);
        
        // Check if already cloned
        const fs = require('fs');
        if (fs.existsSync(targetDir)) {
            return res.status(409).json({ error: 'Already cloned', local_path: targetDir });
        }
        
        // Clone the repo — use fs.mkdirSync for cross-platform dir creation;
        // `mkdir -p` is Unix-only and Windows cmd tries to create a literal
        // folder named '-p'.
        const repoDir = path.dirname(targetDir);
        fs.mkdirSync(repoDir, { recursive: true });

        // If a PAT is stored, inject it into the clone URL so private repos
        // work without a terminal prompt. We then rewrite origin to the clean
        // URL so the token isn't persisted in .git/config.
        const storedPat = db.getSetting('github_pat') || process.env.GITHUB_TOKEN;
        let cloneUrl = project.repo_url;
        const isGitHubHttps = /^https:\/\/github\.com\//i.test(project.repo_url);
        if (storedPat && isGitHubHttps) {
            cloneUrl = project.repo_url.replace(/^https:\/\//, `https://x-access-token:${storedPat}@`);
        }

        try {
            await execPromise(`git clone "${cloneUrl}" "${targetDir}"`);
        } catch (cloneErr) {
            const msg = (cloneErr.stderr || cloneErr.message || '').trim();
            // Classify the common failure modes so the UI can show something useful
            if (/authentication failed|could not read username|terminal prompts disabled/i.test(msg)) {
                return res.status(401).json({
                    error: 'Authentication failed — set a GitHub PAT in Settings (needs repo scope) and retry',
                    details: msg
                });
            }
            if (/not found|repository.*does not exist|could not find remote/i.test(msg)) {
                return res.status(404).json({
                    error: 'Repository not found or access denied on GitHub',
                    details: msg
                });
            }
            throw cloneErr; // re-throw for the outer catch to 500
        }

        // Strip any injected token from origin AND install a per-repo credential
        // helper so future fetch/pull/push authenticate without re-embedding the
        // token in the URL. The PAT lives only in <repo>/.git/credentials
        // (not tracked).
        if (cloneUrl !== project.repo_url) {
            try {
                await execPromise(`git -C "${targetDir}" remote set-url origin "${project.repo_url}"`);
                installCredentialHelper(targetDir, storedPat);
            } catch (e) { /* non-fatal: clone succeeded */ }
        }
        
        // Update project with local path
        const updated = db.updateProject(project.id, { local_path: targetDir });
        
        // Add update
        db.addUpdate({
            project_id: project.id,
            type: 'progress',
            title: 'Cloned to local',
            content: `Repository cloned to ${targetDir}`
        });
        
        res.json({ success: true, local_path: targetDir, project: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// Set GitHub token
app.post('/api/github/token', (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        // Persist to settings table so the token survives server restarts
        db.setSetting('github_pat', token);
        octokit = new Octokit({ auth: token });
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ========== SETTINGS ENDPOINTS ==========

// Get all settings (masks github_pat — only returns a hint that it's set)
app.get('/api/settings', (req, res) => {
    try {
        const all = db.getAllSettings();
        const result = {};
        all.forEach(s => {
            if (s.key === 'github_pat') {
                result[s.key] = { set: !!s.value, preview: s.value ? `${s.value.slice(0, 7)}…` : null };
            } else {
                result[s.key] = s.value;
            }
            result[`${s.key}_updated_at`] = s.updated_at;
        });
        // Always include derived clone base dir so the UI can show the effective value.
        result.clone_base_dir_effective = getCloneBaseDir();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a single setting
app.put('/api/settings/:key', (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        const allowed = new Set(['github_pat', 'clone_base_dir', 'terminal_app']);
        if (!allowed.has(key)) {
            return res.status(400).json({ error: `Unknown setting: ${key}` });
        }
        if (value === null || value === '') {
            db.deleteSetting(key);
            if (key === 'github_pat') octokit = null;
        } else {
            db.setSetting(key, value);
            if (key === 'github_pat') octokit = new Octokit({ auth: value });
        }
        res.json({ success: true, key, effective_clone_base_dir: getCloneBaseDir() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Verify the stored PAT by hitting /user
app.post('/api/settings/test-github', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(400).json({ ok: false, error: 'No GitHub token set' });
        }
        const { data } = await octokit.users.getAuthenticated();
        res.json({ ok: true, login: data.login, scopes_note: 'token valid' });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// Get user's GitHub repos
app.get('/api/github/repos', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(401).json({ error: 'GitHub token not set' });
        }
        
        const { data: user } = await octokit.users.getAuthenticated();
        const { data: repos } = await octokit.repos.listForAuthenticatedUser({
            sort: 'updated',
            per_page: 100
        });
        
        // Enrich repos with commit activity
        const enrichedRepos = await Promise.all(
            repos.map(async (repo) => {
                try {
                    // Get latest commit date
                    const { data: commits } = await octokit.repos.listCommits({
                        owner: repo.owner.login,
                        repo: repo.name,
                        per_page: 1
                    });
                    
                    const lastCommit = commits[0]?.commit?.author?.date;
                    const daysSinceCommit = lastCommit 
                        ? Math.floor((Date.now() - new Date(lastCommit)) / (1000 * 60 * 60 * 24))
                        : null;
                    
                    // Infer status
                    let status = 'idea';
                    if (repo.homepage) {
                        status = 'launched';
                    } else if (daysSinceCommit !== null) {
                        if (daysSinceCommit < 7) status = 'building';
                        else if (daysSinceCommit < 90) status = 'paused';
                    }
                    
                    return {
                        ...repo,
                        lastCommit,
                        daysSinceCommit,
                        inferredStatus: status
                    };
                } catch (error) {
                    return {
                        ...repo,
                        lastCommit: null,
                        daysSinceCommit: null,
                        inferredStatus: 'idea'
                    };
                }
            })
        );
        
        res.json({
            user: user.login,
            repos: enrichedRepos
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Import a single repo by URL (public repos, no auth needed)
app.post('/api/github/import-url', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }
        
        // Parse GitHub URL
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            return res.status(400).json({ error: 'Invalid GitHub URL' });
        }
        
        const [, owner, repo] = match;
        const repoName = repo.replace(/\.git$/, '');

        // Use the authenticated client when a PAT is stored so private repos
        // are visible; otherwise fall back to an anonymous client for public repos.
        const client = octokit || new Octokit();
        const { data: repoData } = await client.repos.get({
            owner,
            repo: repoName
        });
        
        // Check if already exists
        const existing = db.getAllProjects().find(p => p.repo_url === repoData.html_url);
        if (existing) {
            return res.status(409).json({ error: 'Repository already imported', project: existing });
        }
        
        // Fetch README
        let readme = null;
        try {
            const { data: readmeData } = await client.repos.getReadme({
                owner,
                repo: repoName
            });
            readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
        } catch (error) {
            console.log('No README found for', repoName);
        }
        
        // Create project
        const project = db.addProject({
            name: repoData.name,
            description: repoData.description || `GitHub repository: ${repoData.name}`,
            status: repoData.homepage ? 'launched' : 'building',
            category: 'app',
            tech_stack: repoData.language,
            repo_url: repoData.html_url,
            live_url: repoData.homepage || null,
            source: 'github',
            readme
        });
        
        // Add initial update
        db.addUpdate({
            project_id: project.id,
            type: 'progress',
            title: 'Imported from GitHub',
            content: `Imported from ${repoData.html_url}`
        });
        
        res.json({ success: true, project });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Import selected repos as projects
app.post('/api/github/import', async (req, res) => {
    try {
        const { repos } = req.body;
        if (!Array.isArray(repos)) {
            return res.status(400).json({ error: 'repos must be an array' });
        }
        
        const imported = [];
        
        for (const repoData of repos) {
            // Check if project already exists by repo_url
            const existing = db.getAllProjects().find(p => p.repo_url === repoData.html_url);
            if (existing) {
                console.log(`Skipping ${repoData.name} - already imported`);
                continue;
            }
            
            const project = db.addProject({
                name: repoData.name,
                description: repoData.description || `GitHub repository: ${repoData.name}`,
                status: repoData.inferredStatus || 'idea',
                category: 'app',
                tech_stack: repoData.language,
                repo_url: repoData.html_url,
                live_url: repoData.homepage || null,
                source: 'github'
            });
            
            // Add initial update
            if (repoData.lastCommit) {
                db.addUpdate({
                    project_id: project.id,
                    type: 'progress',
                    title: 'Imported from GitHub',
                    content: `Last commit: ${new Date(repoData.lastCommit).toLocaleDateString()}`
                });
            }
            
            imported.push(project);
        }
        
        res.json({
            imported: imported.length,
            projects: imported
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, HOST, () => {
    console.log(`\n🚀 LaunchPad - Entrepreneur's Project Tracker`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://192.168.5.102:${PORT}`);
    console.log(`\n📊 Ready to track your empire\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    db.close();
    process.exit(0);
});
