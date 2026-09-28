const express = require('express');
const { Octokit } = require('@octokit/rest');
const LaunchpadDB = require('./database');

const app = express();
const PORT = 3020;
// Bind to loopback by default — LaunchPad has no auth and exposes endpoints that
// shell out to git/npm, so it must not be reachable from the LAN. Set HOST=0.0.0.0
// explicitly (behind a trusted network) only if you accept that risk.
const HOST = process.env.HOST || '127.0.0.1';

// Initialize database. Path is injectable via LAUNCHPAD_DB so the test suite can
// run against :memory: without creating or locking the real launchpad.db; unset in
// production, where the constructor defaults to the on-disk file. (Gate 3 F3)
const db = new LaunchpadDB(process.env.LAUNCHPAD_DB);

// Any git operation we spawn should fail fast on auth prompts instead of
// hanging — GIT_TERMINAL_PROMPT=0 tells git "no interactive stdin available".
process.env.GIT_TERMINAL_PROMPT = '0';

// Auth strategy: relies on `gh auth setup-git` having registered the GitHub
// CLI as the credential helper for github.com URLs (one-time global config).
// With that in place, plain `git clone/fetch/pull/push` use gh's stored OAuth
// token silently — no PAT injection, no GCM "Select an account" prompts, no
// per-repo .git/credentials files.
//
// To set it up: run `gh auth setup-git` once. Verify with
// `git config --global --get credential.https://github.com.helper` —
// should return `!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential`.

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

// Derive the clone base directory (Settings > env > portable default).
// Default lives under the OS home dir so a fresh clone works on any machine;
// override per-install via the clone_base_dir setting or CLONE_BASE_DIR env.
function getCloneBaseDir() {
    const os = require('os');
    const path = require('path');
    return db.getSetting('clone_base_dir') || process.env.CLONE_BASE_DIR || path.join(os.homedir(), 'github');
}

// --- Local repo discovery (see repo-scan.js) ---
// Folders searched for existing clones before anything is cloned. Settings >
// env (both ';'-separated) > nothing; the clone base dir is always included so
// Launchpad's own clones are found.
const repoScan = require('./repo-scan');
function getScanRoots() {
    const raw = db.getSetting('scan_roots') || process.env.SCAN_ROOTS || '';
    const roots = raw.split(/[;\r\n]+/).map(s => s.trim()).filter(Boolean);
    return [...roots, getCloneBaseDir()];
}

// The walk takes well under a second on a few dozen repos, but Import can fire
// once per row — cache briefly and let callers force a fresh scan.
const REPO_INDEX_TTL_MS = 30 * 1000;
let repoIndexCache = { at: 0, index: null };
function getRepoIndex({ force = false } = {}) {
    if (force || !repoIndexCache.index || Date.now() - repoIndexCache.at > REPO_INDEX_TTL_MS) {
        repoIndexCache = { at: Date.now(), index: repoScan.buildRepoIndex(repoScan.scanForRepos(getScanRoots())) };
    }
    return repoIndexCache.index;
}
function findLocalRepo(repoUrl, opts) {
    return repoScan.pickLocalMatch(getRepoIndex(opts), repoUrl);
}

// Clone a GitHub repo into `targetDir`. Only a recognised github.com URL is
// accepted, and git is handed a URL rebuilt from owner/repo — so a client-
// supplied repo_url (file://, ext::, a flag) can never reach git. Throws an
// Error carrying an HTTP `status` for the auth / not-found cases.
async function cloneGitHubRepo(repoUrl, targetDir) {
    const path = require('path');
    const fs = require('fs');
    const key = repoScan.repoKey(repoUrl);
    if (!key) throw Object.assign(new Error('Only github.com repositories can be cloned'), { status: 400 });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
        await _execFileAsync('git', ['clone', '--', `https://github.com/${key}.git`, targetDir], { timeout: 300000, windowsHide: true });
    } catch (cloneErr) {
        const msg = (cloneErr.stderr || cloneErr.message || '').trim();
        if (/authentication failed|could not read username|terminal prompts disabled/i.test(msg)) {
            throw Object.assign(new Error('Authentication failed — run `gh auth login` and `gh auth setup-git` in a terminal, then retry'), { status: 401, details: msg });
        }
        if (/not found|repository.*does not exist|could not find remote/i.test(msg)) {
            throw Object.assign(new Error('Repository not found or access denied on GitHub'), { status: 404, details: msg });
        }
        throw cloneErr;
    }
    // Make the new clone visible to the next lookup without waiting out the TTL.
    repoIndexCache.at = 0;
}

// Canonical clone target for a project, or null if its name would escape the base.
function cloneTargetFor(project) {
    const path = require('path');
    const baseDir = getCloneBaseDir();
    const targetDir = path.join(baseDir, project.name);
    const rel = path.relative(path.resolve(baseDir), path.resolve(targetDir));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return targetDir;
}

// After a project is imported: link an existing local copy if there is exactly
// one, leave it alone if there are several (the user picks), and clone into the
// clone base only when no copy exists anywhere. The clone runs in the
// background so a bulk import returns immediately; outcomes land in the Build
// Log. Returns a summary: { status: 'linked'|'ambiguous'|'cloning'|'skipped', ... }.
const cloningProjects = new Set();
function linkOrCloneImported(project) {
    const fs = require('fs');
    const match = findLocalRepo(project.repo_url, { force: true });
    if (match.status === 'found') {
        db.updateProject(project.id, { local_path: match.path });
        db.addUpdate({ project_id: project.id, type: 'progress', title: 'Linked existing local clone', content: `Found at ${match.path}` });
        return { status: 'linked', path: match.path };
    }
    if (match.status === 'ambiguous') {
        db.addUpdate({ project_id: project.id, type: 'progress', title: 'Several local copies found — not cloned',
            content: `Set Local Path to the one to use:\n${match.candidates.join('\n')}` });
        return { status: 'ambiguous', candidates: match.candidates };
    }
    const targetDir = cloneTargetFor(project);
    if (!repoScan.repoKey(project.repo_url) || !targetDir) return { status: 'skipped', reason: 'not a clonable GitHub repo' };
    if (fs.existsSync(targetDir)) {
        db.addUpdate({ project_id: project.id, type: 'failed', title: 'Clone skipped',
            content: `${targetDir} already exists but is not a clone of ${project.repo_url}` });
        return { status: 'skipped', reason: 'target folder exists' };
    }
    cloningProjects.add(project.id);
    cloneGitHubRepo(project.repo_url, targetDir)
        .then(() => {
            db.updateProject(project.id, { local_path: targetDir });
            db.addUpdate({ project_id: project.id, type: 'progress', title: 'Cloned to local', content: `Repository cloned to ${targetDir}` });
        })
        .catch((err) => {
            db.addUpdate({ project_id: project.id, type: 'failed', title: 'Clone failed', content: `${err.message}${err.details ? `\n${err.details}` : ''}` });
        })
        .finally(() => cloningProjects.delete(project.id));
    return { status: 'cloning', path: targetDir };
}

initOctokit();

// --- Safe process-execution helpers (Gate 3 phase 1: command-injection fix) ---
// Run git in `cwd` using an argument array — NO shell. Repo paths and refs are
// passed as literal args, so they can never be parsed as shell metacharacters.
// Replaces the old `cd "${path}" && git …` exec strings that were injectable via
// attacker-settable project.local_path / repo_url / name.
const _execFileAsync = require('util').promisify(require('child_process').execFile);
function runGit(cwd, args, opts = {}) {
    return _execFileAsync('git', ['-C', cwd, ...args], {
        timeout: 15000, windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...opts
    });
}

// Validate a user-supplied directory path before handing it to a process.
// Returns the resolved absolute path, or null if it contains shell
// metacharacters, doesn't exist, isn't a directory, or escapes the allowlisted
// clone base (unless it is the local_path of an already-tracked project).
function resolveSafeDir(requested) {
    const path = require('path');
    const fs = require('fs');
    if (!requested || typeof requested !== 'string') return null;
    // Reject shell metacharacters, incl. '%' (cmd.exe %VAR% expansion in the
    // open-terminal launch). '(' ')' are intentionally NOT rejected — they are
    // common in real Windows paths (e.g. "Program Files (x86)").
    if (/[`$;&|<>^"'%\n\r]/.test(requested)) return null;
    let resolved;
    try { resolved = path.resolve(requested); } catch (e) { return null; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
    // Windows paths are case-insensitive — normalize before comparing so a
    // legit project isn't false-rejected over a drive-letter/casing mismatch.
    const norm = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
    const base = path.resolve(getCloneBaseDir());
    const rel = path.relative(norm(base), norm(resolved));
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
    try {
        if (db.getAllProjects().some(p => p.local_path && norm(path.resolve(p.local_path)) === norm(resolved))) return resolved;
    } catch (e) { /* ignore */ }
    return null;
}

// Whitelist of commands the terminal launcher may auto-run after cd-ing into a
// project. Anything not on the list is dropped (returns null) so an attacker can
// never get an arbitrary command into the terminal invocation. (Gate 3 F2/F4)
const ALLOWED_TERMINAL_RUN = new Set(['claude', 'npm run dev', 'npm start']);
function sanitizeTerminalRunCommand(cmd) {
    return ALLOWED_TERMINAL_RUN.has(cmd) ? cmd : null;
}

// --- GitHub call resilience (Gate 3 phase 3b: M4) ---
// Map an async fn over items with bounded concurrency (no external deps).
// Replaces Promise.all over a 100-repo list, which fired up to 100 parallel
// GitHub calls and tripped secondary rate limits.
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// True when an Octokit error is a rate-limit (primary or secondary) rather than
// a genuine 403 permission denial — only those are worth retrying.
function isRateLimited(e) {
    if (e.status === 429) return true;
    if (e.status !== 403) return false;
    const h = (e.response && e.response.headers) || {};
    if (h['retry-after']) return true;
    if (h['x-ratelimit-remaining'] === '0') return true;
    return /rate limit/i.test(e.message || '');
}

// Retry an Octokit call on rate-limit or 5xx with backoff (honors retry-after).
async function githubRetry(fn, { tries = 3, baseDelayMs = 1000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const retriable = isRateLimited(e) || (e.status >= 500 && e.status < 600);
            if (!retriable || attempt === tries - 1) throw e;
            const retryAfter = Number(e.response && e.response.headers && e.response.headers['retry-after']);
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 30000) // clamp — don't let an upstream retry-after hang the request
                : baseDelayMs * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

// Middleware
app.use(express.static('public'));

// --- Same-origin / anti-CSRF + DNS-rebinding guard (Gate 3 F1) ---
// LaunchPad has no auth and its state-changing endpoints shell out to git/npm, so
// a cross-origin web page (or a DNS-rebinding attack that resolves a hostile
// domain to 127.0.0.1) must not be able to drive them. Loopback binding stops LAN
// callers but NOT the user's own browser issuing cross-origin requests. A request
// counts as same-origin only when ALL of these hold:
//   • Host is one of our allowed hosts — a rebinding attack arrives with the
//     attacker's Host (e.g. evil.com:3020) and is rejected before any handler runs.
//   • Origin, if present, is one of our own origins.
//   • Sec-Fetch-Site, if present (all current browsers send it), is same-origin or
//     none (a direct address-bar navigation / non-browser client).
const GUARD_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const GUARD_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
// Honor a deliberate non-loopback HOST bind (the documented "you accept that risk"
// opt-in) so the guard never 403s legitimate writes on an intentional deployment.
// For HOST=0.0.0.0 (bind-all) there is no single host to name, so enumerate this
// machine's own non-internal IPv4 addresses.
if (process.env.HOST && process.env.HOST !== '127.0.0.1' && process.env.HOST !== 'localhost') {
    const bindHosts = [];
    if (process.env.HOST === '0.0.0.0') {
        for (const iface of Object.values(require('os').networkInterfaces())) {
            for (const net of iface || []) {
                if (net.family === 'IPv4' && !net.internal) bindHosts.push(net.address);
            }
        }
    } else {
        bindHosts.push(process.env.HOST);
    }
    for (const h of bindHosts) {
        GUARD_HOSTS.add(`${h}:${PORT}`);
        GUARD_ORIGINS.add(`http://${h}:${PORT}`);
    }
}

// True iff the request's Host/Origin/Sec-Fetch-Site all check out as same-origin.
function isSameOrigin(req) {
    if (!GUARD_HOSTS.has(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin && !GUARD_ORIGINS.has(origin)) return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return true;
}
function rejectCrossOrigin(res) {
    return res.status(403).json({ error: 'Forbidden: cross-origin or cross-site request rejected' });
}

// Global guard: gate every state-changing method. Read-only GETs pass through so
// the static SPA and data reads work as-is — EXCEPT the few GET routes that mutate
// state, which opt in explicitly via requireSameOrigin (F1 covers "GETs that
// mutate", which this method-based gate would otherwise let through).
function originGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!isSameOrigin(req)) return rejectCrossOrigin(res);
    next();
}
// Per-route guard for GET endpoints that DO change state (git fetch, DB writes).
function requireSameOrigin(req, res, next) {
    if (!isSameOrigin(req)) return rejectCrossOrigin(res);
    next();
}
app.use(originGuard);

app.use(express.json({ limit: '10mb' })); // Increase limit for bulk imports

// Validate :id route params once, globally — reject non-positive-integers with
// a JSON 400 instead of letting NaN/garbage reach better-sqlite3 (which throws a
// 500 on a NaN bind) or silently matching nothing.
app.param('id', (req, res, next, val) => {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    next();
});

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

// Mark a project's external commits as "seen" — clears the External Activity
// badge by syncing last_seen_commit_at to last_commit_at. Called by showProject
// when the user opens the detail view for a project that has unseen activity.
app.post('/api/projects/:id/mark-seen', (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (project.last_commit_at) {
            db.updateProject(project.id, { last_seen_commit_at: project.last_commit_at });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
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

// ========== EXPLORE — outward-facing GitHub discovery ==========
//
// One endpoint, six categories. Each category builds an appropriate GitHub
// search query + sort key. `since` controls the time window for tabs that
// filter by date; the all-time "popular" tab ignores it. `language`, `topic`,
// and `user` filters apply across all tabs.
//
// Design notes:
// - We always exclude `archived:false fork:false mirror:false` to cut the
//   noise that otherwise dominates the "discussed" + "forked" tabs.
// - `per_page=10` (was 5) — users wanted broader visibility per category.
// - The `since` date is computed fresh on every request so the same query
//   doesn't get GitHub-cached into showing identical results all week.
// - `re-emerging` is a new category that surfaces *older* repos shipping
//   activity this week — fills the gap our prior "trending" left (it only
//   showed brand-new repos via created:>{since}).
// - True star velocity (Δstars/day) is not directly queryable in the GitHub
//   search API. Implementing it properly requires daily snapshots — see
//   roadmap Phase 2.
app.get('/api/github/explore', async (req, res) => {
    try {
        const { language = '', since = 'monthly', category = 'trending',
                topic = '', user = '' } = req.query;

        const now = new Date();
        const ranges = {
            daily: 24 * 60 * 60 * 1000,
            weekly: 7 * 24 * 60 * 60 * 1000,
            monthly: 30 * 24 * 60 * 60 * 1000,
            yearly: 365 * 24 * 60 * 60 * 1000
        };
        const ms = ranges[since] || ranges.monthly;
        const sinceDate = new Date(now - ms).toISOString().split('T')[0];
        const week  = new Date(now - 7 * 86400000).toISOString().split('T')[0];

        // Sanitise free-text filters before building qualifiers — github's
        // search syntax is whitespace-separated, so a stray space would
        // silently turn into a second qualifier. Allow the actual chars github
        // accepts (alphanumeric, dash, underscore, dot, slash).
        const clean = (s) => String(s || '').trim().replace(/[^a-zA-Z0-9._\-\/]/g, '');
        const langQ = language ? ` language:${clean(language)}` : '';
        const topicQ = topic ? ` topic:${clean(topic)}` : '';
        const userQ = user ? ` user:${clean(user)}` : '';
        const filters = `${langQ}${topicQ}${userQ}`;

        // Universal noise filters — keep these on every query, including
        // user-scoped ones. Forks and archived repos almost never belong in
        // discovery lists, and stripping mirrors hides duplicates.
        const noiseFilters = ` archived:false fork:false mirror:false`;

        // When a user filter is set, we relax the stars floors — small/personal
        // repos won't pass them. Keeping date floors on time-window tabs.
        const trendGate = userQ ? '' : ` stars:>50`;
        const newGate   = userQ ? '' : ` stars:>5`;
        const discussGate = userQ ? '' : ` stars:>500 help-wanted-issues:>3`;
        const forkGate  = userQ ? '' : ` forks:>50`;
        const popAllTime = userQ ? `stars:>0` : `stars:>5000`;
        const reEmergeGate = userQ ? '' : ` stars:>1000`;

        const categories = {
            // Brand-new + hot: created recently, sorted by stars accumulated since.
            trending:    { q: `created:>${sinceDate}${trendGate}${noiseFilters}${filters}`,
                           sort: 'stars',   order: 'desc' },
            // All-time popular within the filter set.
            popular:     { q: `${popAllTime}${noiseFilters}${filters}`,
                           sort: 'stars',   order: 'desc' },
            // New & rising: more permissive star floor than trending so we
            // surface smaller new repos picking up steam.
            new:         { q: `created:>${sinceDate}${newGate}${noiseFilters}${filters}`,
                           sort: 'stars',   order: 'desc' },
            // Active development on popular repos with engagement signals.
            discussed:   { q: `pushed:>${sinceDate}${discussGate}${noiseFilters}${filters}`,
                           sort: 'updated', order: 'desc' },
            // Heavily forked, time-windowed.
            forked:      { q: `created:>${sinceDate}${forkGate}${noiseFilters}${filters}`,
                           sort: 'forks',   order: 'desc' },
            // Older repos shipping activity in the last week — the gap our prior
            // "trending" left out. Catches projects that already existed but
            // surged into renewed development.
            're-emerging': { q: `pushed:>${week}${reEmergeGate} created:<${sinceDate}${noiseFilters}${filters}`,
                             sort: 'updated', order: 'desc' }
        };

        const cat = categories[category];
        if (!cat) return res.status(400).json({ error: `Unknown category: ${category}` });

        const client = octokit || new Octokit();
        // Over-fetch (50 vs the 15 we surface) so client-side filters — most
        // notably the strict English-only spoken-language filter — can drop
        // a generous chunk of results and still leave a full page of 15.
        // GitHub Search API caps at 100 per page; 50 is a comfortable middle.
        const { data } = await client.search.repos({
            q: cat.q,
            sort: cat.sort,
            order: cat.order,
            per_page: 50
        });

        // Snapshot every returned repo's star count for star-velocity tracking.
        // The DB throttle (6h minimum gap) prevents bloat when the user reloads
        // Explore repeatedly. Then attach Δ7d to each repo when we have enough
        // history to compute it — on the first day of running this, almost
        // everything will be null; over a week the page becomes meaningfully
        // velocity-aware.
        try {
            db.recordStarSnapshotsBulk(
                (data.items || []).map(r => ({
                    repo_full_name: r.full_name,
                    stargazers_count: r.stargazers_count || 0
                }))
            );
            (data.items || []).forEach(r => {
                const d7 = db.getStarDelta(r.full_name, 7, r.stargazers_count || 0);
                const d30 = db.getStarDelta(r.full_name, 30, r.stargazers_count || 0);
                if (d7) r.stars_delta_7d = d7.delta;
                if (d30) r.stars_delta_30d = d30.delta;
            });
        } catch (e) {
            // Velocity is a nice-to-have — don't fail the request if it errors.
            console.error('[explore] velocity tracking failed:', e.message);
        }

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Run a sync check for a single project. Returns the same shape the GET
// /sync-status endpoint returns. Extracted so the boot-time sweep + the
// manual "Refresh All" button can drive the same engine without duplicating
// shell commands or DB-update rules. SAFE — read-only against the network
// (git fetch) and only writes last_commit_at + (conservatively) auto-bumps.
async function runSyncCheck(project) {
    const fs = require('fs');

    if (!project.repo_url) return { status: 'no_repo', message: 'No GitHub repository linked' };
    if (!project.local_path || !fs.existsSync(project.local_path)) {
        return { status: 'not_cloned', message: 'Repository not cloned locally' };
    }

    const cwd = project.local_path;
    // Error-tolerant git: no upstream / detached HEAD reads as "" instead of
    // throwing (mirrors the old `… || echo ""`).
    const gitSoft = (args) => runGit(cwd, args).then(r => r.stdout).catch(() => '');

    try {
        await runGit(cwd, ['fetch', 'origin']);

        const { stdout: statusOut } = await runGit(cwd, ['status', '--porcelain']);
        const hasUncommitted = statusOut.trim().length > 0;

        const { stdout: branchOut } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const currentBranch = branchOut.trim();

        const unpushedOut = await gitSoft(['log', `origin/${currentBranch}..HEAD`, '--oneline']);
        const hasUnpushed = unpushedOut.trim().length > 0;

        const behindOut = await gitSoft(['log', `HEAD..origin/${currentBranch}`, '--pretty=format:%h|%an|%s']);
        const isBehind = behindOut.trim().length > 0;
        const incomingCommits = isBehind
            ? behindOut.trim().split('\n').slice(0, 20).map(line => {
                const [hash, author, ...msgParts] = line.split('|');
                return { hash, author, message: msgParts.join('|') };
              })
            : [];

        let defaultBranch = null;
        try {
            const { stdout: defOut } = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
            defaultBranch = defOut.trim().replace(/^origin\//, '') || null;
        } catch (e) { /* fall through to remote show */ }
        if (!defaultBranch) {
            try {
                const { stdout: rs } = await runGit(cwd, ['remote', 'show', 'origin']);
                const m = /HEAD branch:\s*(\S+)/.exec(rs);
                if (m && m[1] !== '(unknown)') defaultBranch = m[1];
            } catch (e) { /* leave null — UI suppresses warning when null */ }
        }

        const { stdout: lastCommitOut } = await runGit(cwd, ['log', '-1', '--format=%h|%s|%ar|%at']);
        const [hash, message, timeAgo, atUnixStr] = lastCommitOut.trim().split('|');
        const lastCommitAt = parseInt(atUnixStr) || null;

        if (lastCommitAt) {
            // This runs on every sync-status GET and the boot sweep, so it must
            // be idempotent: only write when something actually changed, and only
            // log the auto-bump the one time the status flips (not every sweep).
            const updates = {};
            if (lastCommitAt !== project.last_commit_at) {
                updates.last_commit_at = lastCommitAt;
            }
            const ageDays = (Date.now() / 1000 - lastCommitAt) / 86400;
            if (project.status === 'idea' && ageDays <= 7) {
                updates.status = 'building';
            }
            if (Object.keys(updates).length > 0) {
                db.updateProject(project.id, updates);
            }
            if (updates.status) {
                db.addUpdate({
                    project_id: project.id,
                    type: 'progress',
                    title: 'Auto-bumped status',
                    content: `idea → building (recent github activity, last commit ${Math.round(ageDays * 24)}h ago)`
                });
            }
        }

        let status = 'synced';
        const messages = [];
        if (hasUncommitted) { status = 'dirty'; messages.push('Uncommitted changes'); }
        if (hasUnpushed) { status = 'unpushed'; messages.push('Unpushed commits'); }
        if (isBehind) { status = 'behind'; messages.push('Behind remote - pull needed'); }
        if (status === 'synced') messages.push('Up to date with remote');

        return {
            status,
            messages,
            details: {
                branch: currentBranch,
                defaultBranch,
                onDefaultBranch: defaultBranch ? currentBranch === defaultBranch : null,
                lastCommit: { hash, message, timeAgo },
                hasUncommitted, hasUnpushed, isBehind, incomingCommits
            }
        };
    } catch (gitError) {
        return { status: 'error', message: 'Git error: ' + gitError.message, details: { error: gitError.message } };
    }
}

// Run runSyncCheck across many projects with a small concurrency cap so we
// don't fork 39 git processes simultaneously. Returns a { id, status }-shaped
// summary. Errors per-project are caught — one bad repo can't poison the sweep.
async function runSyncSweep(projects, concurrency = 4) {
    const results = [];
    let i = 0;
    async function worker() {
        while (i < projects.length) {
            const p = projects[i++];
            try {
                const r = await runSyncCheck(p);
                results.push({ id: p.id, name: p.name, status: r.status });
            } catch (e) {
                results.push({ id: p.id, name: p.name, status: 'error', error: e.message });
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, projects.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// Backfill repo visibility (public/private) onto github-sourced projects.
// Early imports didn't persist visibility, so the UI showed everything as
// "Public". One authenticated listForAuthenticatedUser call returns every
// repo with its `private` flag; we match by repo_url and update. Requires a
// PAT (private repos are invisible to an anonymous client anyway). Returns
// the number of projects updated. Safe to run repeatedly — keeps visibility
// accurate if a repo is later flipped public/private.
async function backfillVisibility() {
    if (!octokit) return 0;
    const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
        per_page: 100, affiliation: 'owner,collaborator,organization_member'
    });
    const byUrl = new Map(repos.map(r => [r.html_url, r.private ? 1 : 0]));
    let updated = 0;
    for (const p of db.getAllProjects()) {
        if (!p.repo_url || !byUrl.has(p.repo_url)) continue;
        const v = byUrl.get(p.repo_url);
        if (p.is_private !== v) {
            db.updateProject(p.id, { is_private: v });
            updated++;
        }
    }
    return updated;
}

// Check GitHub sync status
app.get('/api/projects/:id/sync-status', requireSameOrigin, async (req, res) => {
    try {
        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const result = await runSyncCheck(project);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual "Refresh All" — same engine the boot sweep runs, fired on demand.
app.post('/api/projects/refresh-all', async (req, res) => {
    try {
        const fs = require('fs');
        const all = db.getAllProjects();
        const cloned = all.filter(p => p.local_path && fs.existsSync(p.local_path) && p.repo_url);
        console.log(`[refresh-all] sweeping ${cloned.length} cloned projects`);
        const results = await runSyncSweep(cloned, 4);
        res.json({
            scanned: cloned.length,
            skipped: all.length - cloned.length,
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fast filesystem-only scan for the Import modal. NO network. NO git fetch.
// For each imported project, decide where its clone would live (db.local_path
// when set, else `${clone_base}/${project.name}`), check whether that dir
// exists with a `.git` subdir, and run a quick `git status --porcelain` to
// detect uncommitted changes. Also opportunistically backfill local_path on
// projects where we detect a clone at the canonical path.
app.get('/api/local-clone-detect', requireSameOrigin, async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');

        const baseDir = getCloneBaseDir();
        const all = db.getAllProjects();
        const isRepo = (dir) => !!dir && fs.existsSync(path.join(dir, '.git'));
        // Opening the Import modal is the natural "rescan" moment.
        const index = getRepoIndex({ force: true });

        const results = {};
        await Promise.all(all.map(async (p) => {
            if (cloningProjects.has(p.id)) {
                results[p.id] = { status: 'cloning', path: null, dirty: false };
                return;
            }

            // Resolve candidate path: a stored local_path that still holds a repo
            // wins; else the canonical clone-base path; else a scan-roots match
            // by repo URL (this also repairs local_paths left stale by a move).
            let candidate = isRepo(p.local_path) ? p.local_path : null;
            if (!candidate && isRepo(path.join(baseDir, p.name))) candidate = path.join(baseDir, p.name);
            if (!candidate && p.repo_url) {
                const match = repoScan.pickLocalMatch(index, p.repo_url);
                if (match.status === 'found') candidate = match.path;
                if (match.status === 'ambiguous') {
                    results[p.id] = { status: 'ambiguous', path: null, dirty: false, candidates: match.candidates };
                    return;
                }
            }

            if (!candidate) {
                results[p.id] = { status: 'not_cloned', path: null, dirty: false };
                return;
            }

            // Detected somewhere other than the stored path — record where.
            if (candidate !== p.local_path) {
                try { db.updateProject(p.id, { local_path: candidate }); } catch (e) { /* non-fatal */ }
            }

            // Cheap dirty check — no fetch, just local working-tree state.
            let dirty = false;
            try {
                const { stdout } = await runGit(candidate, ['status', '--porcelain'], { timeout: 3000 });
                dirty = stdout.trim().length > 0;
            } catch (e) { /* leave dirty = false */ }

            results[p.id] = {
                status: dirty ? 'dirty' : 'cloned',
                path: candidate,
                dirty
            };
        }));

        res.json({ base_dir: baseDir, results });
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

// Resolve the user's preferred terminal launcher as an executable + argument
// array (Settings > env > platform default). If `runCommand` is given, the
// terminal opens AND runs it. (Gate 3 F4)
//
// Returns `{ file, args }` for spawn WITHOUT a shell. The working directory is
// NOT part of this — it is passed as the spawn `cwd` option by the caller, so it
// is never interpolated into a shell/command string. `runCommand` is already
// whitelisted (sanitizeTerminalRunCommand) to a fixed safe set. This removes
// open-terminal's interpolation of the user-supplied path into a shell string —
// the last such user-controlled shell surface (the launch route's shell:true
// runs only a literal `npm run dev|start`, never a user path).
function getTerminalSpawn(cwd, runCommand) {
    const stored = db.getSetting('terminal_app');
    const platform = process.platform;
    const rc = runCommand ? String(runCommand).trim() : '';

    // On Windows, `start` opens a NEW console window; it is a cmd builtin, so we
    // invoke it as a discrete arg array to cmd (NOT shell:true). The new window
    // inherits cwd from the spawn `cwd` option — cwd is never in the arg string.
    const winStart = (exe, ...exeArgs) => ({ file: 'cmd', args: ['/c', 'start', '', exe, ...exeArgs] });

    const defaults = {
        win32: {
            // wt.exe opens its own window; -d takes the directory as a literal arg
            // (not shell-parsed). rc runs in a cmd shell inside the new tab.
            wt: rc ? { file: 'wt', args: ['new-tab', '-d', cwd, 'cmd', '/K', rc] }
                   : { file: 'wt', args: ['new-tab', '-d', cwd] },
            cmd: rc ? winStart('cmd', '/K', rc) : winStart('cmd', '/K'),
            // Force the dir with Set-Location so a user's $PROFILE (which may
            // `Set-Location $HOME` and runs before -Command) can't strand the
            // shell in home. cwd is resolveSafeDir-validated (single-quote among
            // the rejected chars) so the single-quoted PS literal is injection-safe;
            // `;` is a PS separator, not a cmd metacharacter, so it passes cleanly
            // through the nested `cmd /c start`.
            powershell: winStart('powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${cwd}'${rc ? '; ' + rc : ''}`),
            pwsh: winStart('pwsh', '-NoExit', '-Command', `Set-Location -LiteralPath '${cwd}'${rc ? '; ' + rc : ''}`),
            // bash.exe --cd=<dir> sets the startup dir reliably; a login shell
            // (-l) would instead cd to $HOME via /etc/profile, discarding cwd.
            gitbash: rc ? winStart('C:\\Program Files\\Git\\bin\\bash.exe', `--cd=${cwd}`, '-c', `${rc}; exec bash`)
                        : winStart('C:\\Program Files\\Git\\bin\\bash.exe', `--cd=${cwd}`)
        },
        darwin: {
            terminal: { file: 'open', args: ['-a', 'Terminal', cwd] },
            iterm: { file: 'open', args: ['-a', 'iTerm', cwd] }
        },
        linux: {
            // gnome-terminal/konsole get an explicit working-dir flag — their
            // client/server (D-Bus) model doesn't reliably inherit the launcher's
            // cwd. xterm does inherit the spawn `cwd` option. rc runs in a bash
            // that stays open. (cwd is resolveSafeDir-validated, passed as a
            // discrete arg — never shell-parsed.)
            'gnome-terminal': rc ? { file: 'gnome-terminal', args: [`--working-directory=${cwd}`, '--', 'bash', '-c', `${rc}; exec bash`] }
                                 : { file: 'gnome-terminal', args: [`--working-directory=${cwd}`] },
            konsole: rc ? { file: 'konsole', args: ['--workdir', cwd, '-e', 'bash', '-c', `${rc}; exec bash`] }
                        : { file: 'konsole', args: ['--workdir', cwd] },
            xterm: rc ? { file: 'xterm', args: ['-e', 'bash', '-c', `${rc}; exec bash`] }
                      : { file: 'xterm', args: [] }
        }
    };

    const platformDefaults = defaults[platform] || defaults.linux;
    const fallbackKey = platform === 'win32' ? 'wt'
                      : platform === 'darwin' ? 'terminal'
                      : 'gnome-terminal';
    return (stored && platformDefaults[stored]) ? platformDefaults[stored] : platformDefaults[fallbackKey];
}

app.post('/api/util/open-terminal', (req, res) => {
    try {
        const { spawn } = require('child_process');
        // Validate the directory (no shell metacharacters, real dir, inside the
        // allowlisted base or a tracked project). This stays as defense-in-depth
        // even though cwd is now passed as the spawn `cwd` option rather than
        // interpolated into any command string.
        const cwd = resolveSafeDir(req.body.path);
        if (!cwd) {
            return res.status(400).json({ error: 'Path not found or not an allowed project directory' });
        }
        // Optional command the terminal runs on open — whitelisted to a fixed set.
        const runCommand = sanitizeTerminalRunCommand(req.body.command);
        const { file, args } = getTerminalSpawn(cwd, runCommand);
        // No shell: spawn the terminal executable directly with an argument array.
        // cwd is the process working directory (not part of any command string);
        // detached + unref so the terminal window outlives this request.
        const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (err) => console.error('open-terminal:', err.message));
        child.unref();
        res.json({ success: true, command: `${file} ${args.join(' ')}`, cwd });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/util/open-folder', (req, res) => {
    try {
        const { spawn } = require('child_process');
        const cwd = resolveSafeDir(req.body.path);
        if (!cwd) {
            return res.status(400).json({ error: 'Path not found or not an allowed project directory' });
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
            // Parse the port from the npm script itself as a fallback for when
            // stdout capture comes up empty (Next.js suppresses pretty output
            // when stdout isn't a TTY, leaving us with no URL to extract).
            // Looks for `-p NNNN`, `--port NNNN`, `-p=NNNN`, `--port=NNNN`,
            // or env-style `PORT=NNNN`. First match wins.
            const scriptStr = String(scripts[scriptName] || '');
            const portFromScript = (() => {
                const patterns = [
                    /(?:^|\s)-p\s+(\d{2,5})/,
                    /(?:^|\s)--port[=\s]+(\d{2,5})/,
                    /(?:^|\s)PORT=(\d{2,5})/
                ];
                for (const re of patterns) {
                    const m = re.exec(scriptStr);
                    if (m) return parseInt(m[1]);
                }
                return null;
            })();
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
                // Pre-fill URL from the parsed port. stdout capture (if it
                // ever produces output) will overwrite this with whatever the
                // dev server actually prints — but having a working fallback
                // means the UI can show a clickable link immediately.
                url: portFromScript ? `http://localhost:${portFromScript}` : null,
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

            // Track whether the child died early so we can return a useful
            // error to the caller instead of an empty {running:false}. We hold
            // the captured stdout/stderr in entry.lastError so the UI can
            // surface it (e.g., EADDRINUSE from a zombie dev server).
            let earlyExit = null;
            child.on('exit', (code) => {
                const e = runningServers.get(project.id);
                if (e && e.pid === child.pid) {
                    e.exitedAt = Date.now();
                    e.exitCode = code;
                    e.lastError = (e.stdoutTail || '').slice(-2000);
                    // Keep the entry around for 60s so the UI poll can read
                    // the failure detail. After that, GC it.
                    setTimeout(() => {
                        const cur = runningServers.get(project.id);
                        if (cur && cur.exitedAt === e.exitedAt) runningServers.delete(project.id);
                    }, 60000);
                }
                earlyExit = { code, output: (entry.stdoutTail || '').slice(-2000) };
            });
            child.on('error', (err) => console.error('spawn error:', err.message));

            // Wait briefly to catch fast-failing spawns (port conflicts,
            // missing scripts, syntax errors). 2.5s is enough for Next.js /
            // Vite to either bind the port and start logging, or crash.
            await new Promise(r => setTimeout(r, 2500));

            if (earlyExit) {
                // Strip ANSI escape sequences so the error reads cleanly in the UI.
                const cleanOut = earlyExit.output.replace(/\x1b\[[0-9;]*m/g, '').trim();
                db.addUpdate({
                    project_id: project.id,
                    type: 'progress',
                    title: 'Launch failed',
                    content: `npm run ${scriptName} exited (code ${earlyExit.code}) in ${cwd}\n\n${cleanOut}`
                });
                return res.status(500).json({
                    type: 'failed',
                    error: `Dev server exited within 2.5s (exit code ${earlyExit.code}) — see output below`,
                    output: cleanOut,
                    cwd
                });
            }

            db.addUpdate({
                project_id: project.id,
                type: 'progress',
                title: 'Launched',
                content: `Spawned: npm run ${scriptName} (pid ${child.pid}) in ${cwd}` +
                         (entry.url ? ` — ${entry.url}` : '')
            });

            return res.json({
                type: 'spawned',
                pid: child.pid,
                command: `npm run ${scriptName}`,
                cwd,
                url: entry.url || null,         // Often already detected during the 2.5s wait
                live_url: project.live_url || null,
                note: entry.url ? `Running on ${entry.url}` : 'Dev server running. URL will appear once detected.'
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

// Preview what `git add -A` would stage. Returns the file list plus warnings
// about secrets, unusually large files, and binaries. Used by the commit modal
// to surface a diff preview BEFORE the user fires off git add + commit.
//
// Secret patterns are intentionally conservative — we'd rather false-positive
// on a `notes.env-example` than miss `.env`. The list mirrors common GitHub
// secret-scanning rules.
const SECRET_PATTERNS = [
    /(^|\/)\.env(\.|$)/i,                 // .env, .env.local, .env.production
    /(^|\/)\.env$/i,
    /\.(key|pem|p12|pfx|jks|keystore)$/i, // private keys / keystores
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH private keys
    /(^|\/)credentials(\.|$)/i,           // credentials, credentials.json
    /(^|\/)secrets?(\.|$)/i,              // secret(s), secret.json
    /(^|\/)\.aws\//i,
    /(^|\/)\.ssh\//i,
    /(^|\/)\.git-credentials$/i,
    /(^|\/)\.npmrc$/i,                    // can contain auth tokens
    /\.htpasswd$/i,
    /service-?account.*\.json$/i          // GCP / Firebase service accounts
];
const BIG_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// Map a single porcelain status code (XY) to a human label.
function statusLabel(xy) {
    const c = (xy || '').trim();
    if (c === 'A' || c === 'AA' || c === 'AM' || c === '??') return 'added';
    if (c === 'M' || c === 'MM' || c === 'AM') return 'modified';
    if (c === 'D' || c === 'AD') return 'deleted';
    if (c === 'R' || c.startsWith('R')) return 'renamed';
    if (c === 'C' || c.startsWith('C')) return 'copied';
    if (c === 'U' || c.includes('U')) return 'conflicted';
    return 'changed';
}

app.get('/api/projects/:id/staged-preview', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.status(400).json({ error: 'Repository not cloned locally' });
        }

        const cwd = project.local_path;

        // git status --porcelain shows ALL changes (staged, unstaged, untracked).
        // Since the commit modal does git add -A first, every line here will end
        // up staged. We surface them all so the user sees what's about to land.
        const { stdout: porcelain } = await runGit(cwd, ['status', '--porcelain']);
        const lines = porcelain.split('\n').filter(l => l.trim().length > 0);

        const files = [];
        const warnings = [];
        let totalSize = 0;

        for (const line of lines) {
            // Porcelain format: "XY filepath" — XY is 2 chars (status), then space, then path.
            // Renames look like "R  old -> new"; we only care about the new name.
            const code = line.substring(0, 2);
            let filePath = line.substring(3).trim();
            if (filePath.includes(' -> ')) {
                filePath = filePath.split(' -> ')[1].trim();
            }
            // Strip surrounding quotes git adds for paths with spaces
            if (filePath.startsWith('"') && filePath.endsWith('"')) {
                filePath = filePath.slice(1, -1).replace(/\\"/g, '"');
            }

            const status = statusLabel(code);
            let size = 0;
            try {
                const fullPath = path.join(cwd, filePath);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    size = fs.statSync(fullPath).size;
                    totalSize += size;
                }
            } catch (e) { /* deleted files / permission errors — leave size 0 */ }

            const isSecret = SECRET_PATTERNS.some(p => p.test(filePath));
            const isBig = size > BIG_FILE_BYTES;

            if (isSecret) {
                warnings.push({ type: 'secret', file: filePath,
                    message: `${filePath} matches a known-secret pattern (.env, *.key, credentials, etc.)` });
            }
            if (isBig) {
                warnings.push({ type: 'big', file: filePath,
                    message: `${filePath} is ${(size / 1024 / 1024).toFixed(1)} MB — over the 5 MB threshold` });
            }

            files.push({ path: filePath, status, size, isSecret, isBig });
        }

        res.json({
            count: files.length,
            totalSize,
            files,
            warnings,
            hasBlockers: warnings.length > 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Commit + optionally push the project's local clone
app.post('/api/projects/:id/commit', async (req, res) => {
    try {
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
        const results = {};

        if (addAll) {
            // Only commit when there's something staged
            try {
                await runGit(cwd, ['add', '-A']);
                const { stdout: statusOut } = await runGit(cwd, ['status', '--porcelain']);
                if (!statusOut.trim()) {
                    results.commit = { skipped: true, reason: 'nothing to commit' };
                } else {
                    const { stdout: commitOut } = await runGit(cwd, ['commit', '-m', message]);
                    results.commit = { ok: true, output: commitOut.trim() };
                    db.addUpdate({
                        project_id: project.id,
                        type: 'progress',
                        title: 'Commit',
                        content: message
                    });
                    // Activity on an 'idea' project nudges it to 'building'.
                    // 'paused' is an explicit user choice — never auto-override.
                    if (project.status === 'idea') {
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
                const { stdout, stderr } = await runGit(cwd, ['push']);
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
        const fs = require('fs');

        const project = db.getProject(parseInt(req.params.id));
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.local_path || !fs.existsSync(project.local_path)) {
            return res.status(400).json({ error: 'Repository not cloned locally' });
        }

        const cwd = project.local_path;
        try {
            const { stdout, stderr } = await runGit(cwd, ['pull', '--ff-only']);
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
        const path = require('path');
        
        const project = db.getProject(parseInt(req.params.id));
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        if (!project.repo_url) {
            return res.status(400).json({ error: 'Project has no repository URL' });
        }
        
        // Look for an existing local copy anywhere under the scan roots first —
        // cloning a repo that is already on disk just makes a second copy.
        const match = findLocalRepo(project.repo_url, { force: true });
        if (match.status === 'found') {
            const linked = db.updateProject(project.id, { local_path: match.path });
            db.addUpdate({ project_id: project.id, type: 'progress', title: 'Linked existing local clone', content: `Found at ${match.path}` });
            return res.json({ success: true, linked: true, local_path: match.path, project: linked });
        }
        if (match.status === 'ambiguous') {
            return res.status(409).json({
                error: 'Several local copies of this repo exist — set Local Path to the one to use',
                candidates: match.candidates
            });
        }

        // Determine target directory — Settings > env > portable default
        // (~/github via os.homedir()). See getCloneBaseDir(). cloneTargetFor()
        // rejects a project name like '../../x' escaping the clone base.
        const targetDir = cloneTargetFor(project);
        if (!targetDir) {
            return res.status(400).json({ error: 'Invalid project name — clone target escapes the base directory' });
        }

        // Check if already cloned
        const fs = require('fs');
        if (fs.existsSync(targetDir)) {
            return res.status(409).json({ error: 'Already cloned', local_path: targetDir });
        }

        // Clone via plain `git clone` — auth is handled by gh-as-credential-
        // helper (configured globally via `gh auth setup-git`). No URL token
        // injection, no per-repo credential files.
        try {
            await cloneGitHubRepo(project.repo_url, targetDir);
        } catch (cloneErr) {
            if (cloneErr.status) {
                return res.status(cloneErr.status).json({ error: cloneErr.message, details: cloneErr.details });
            }
            throw cloneErr;
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
                // Never return any bytes of the token — only whether one is set.
                // A 7-char preview still leaks the token class/prefix. (Gate 3 F6)
                result[s.key] = { set: !!s.value };
            } else {
                result[s.key] = s.value;
            }
            result[`${s.key}_updated_at`] = s.updated_at;
        });
        // Always include derived clone base dir so the UI can show the effective value.
        result.clone_base_dir_effective = getCloneBaseDir();
        result.scan_roots_effective = getScanRoots();
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
        const allowed = new Set(['github_pat', 'clone_base_dir', 'terminal_app', 'scan_roots']);
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
        if (key === 'scan_roots' || key === 'clone_base_dir') repoIndexCache.at = 0;
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
        
        // Enrich repos with commit activity. Bounded concurrency (5) + retry so
        // a 100-repo account doesn't fire 100 parallel calls and trip GitHub's
        // secondary rate limit (which previously mislabeled every repo 'idea').
        const enrichedRepos = await mapWithConcurrency(repos, 5,
            async (repo) => {
                try {
                    // Get latest commit date
                    const { data: commits } = await githubRetry(() => octokit.repos.listCommits({
                        owner: repo.owner.login,
                        repo: repo.name,
                        per_page: 1
                    }));

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
            }
        );

        res.json({
            user: user.login,
            repos: enrichedRepos
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Import a single repo by URL. Uses the authenticated client when a PAT is
// stored (so private repos resolve), else an anonymous client for public repos.
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
            is_private: repoData.private ? 1 : 0,
            readme
        });
        
        // Add initial update
        db.addUpdate({
            project_id: project.id,
            type: 'progress',
            title: 'Imported from GitHub',
            content: `Imported from ${repoData.html_url}`
        });

        const local = linkOrCloneImported(project);
        res.json({ success: true, project: db.getProject(project.id), local });
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
                source: 'github',
                is_private: repoData.private ? 1 : 0
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
            
            const local = linkOrCloneImported(project);
            imported.push({ ...db.getProject(project.id), local });
        }

        res.json({
            imported: imported.length,
            projects: imported
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== LEARN ENDPOINTS ==========

// Compute level from cumulative XP. Thresholds match the curriculum spec:
// <500 basic, <2000 adequate, ≥2000 expert.
function levelForXp(xp) {
    if (xp >= 2000) return 'expert';
    if (xp >= 500) return 'adequate';
    return 'basic';
}

// Walk the curriculum tree to find a lesson by id. Curriculum shape is
// { levels: [ { lessons: [ { id, xp, badge_id, ... } ] } ] }. Tolerates a
// bare-array export (legacy) and unknown shapes by returning null.
function findLessonInCurriculum(curriculum, lesson_id) {
    const levels = Array.isArray(curriculum) ? curriculum
        : (curriculum && Array.isArray(curriculum.levels) ? curriculum.levels : null);
    if (!levels) return null;
    for (const lvl of levels) {
        // Support both schemas: lessons directly on level, or grouped under modules[].
        const directLessons = Array.isArray(lvl?.lessons) ? lvl.lessons : [];
        for (const lesson of directLessons) {
            if (lesson?.id === lesson_id) return lesson;
        }
        const modules = Array.isArray(lvl?.modules) ? lvl.modules : [];
        for (const mod of modules) {
            const modLessons = Array.isArray(mod?.lessons) ? mod.lessons : [];
            for (const lesson of modLessons) {
                if (lesson?.id === lesson_id) return lesson;
            }
        }
    }
    return null;
}

// Loads the curriculum module fresh on each call so edits to the file are
// picked up without restarting the server. The file may not exist yet during
// early dev — we degrade to an empty curriculum rather than 500.
function loadCurriculum() {
    const path = require('path');
    const fs = require('fs');
    const curriculumPath = path.join(__dirname, 'public', 'learn', 'curriculum.js');
    if (!fs.existsSync(curriculumPath)) return { levels: [] };
    delete require.cache[require.resolve(curriculumPath)];
    return require(curriculumPath);
}

// POST /api/learn/login — upsert a learner profile and return the full row.
app.post('/api/learn/login', (req, res) => {
    try {
        const { username, display_name } = req.body || {};
        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'username is required' });
        }
        const learner = db.upsertLearner({ username: username.trim(), display_name });
        res.json(learner);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/learn/me/:username — full state for one learner.
app.get('/api/learn/me/:username', (req, res) => {
    try {
        const learner = db.getLearner(req.params.username);
        if (!learner) return res.status(404).json({ error: 'Learner not found' });
        res.json({
            learner,
            progress: db.getLearnerProgress(learner.username),
            badges: db.getLearnerBadges(learner.username)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/learn/curriculum — serves the hot-reloadable curriculum module.
app.get('/api/learn/curriculum', (req, res) => {
    try {
        res.json(loadCurriculum());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PATCH /api/learn/progress — record progress + award XP/badge on completion.
// On completion: looks up the lesson's xp + badge_id in the curriculum and
// applies them once (badges are INSERT OR IGNORE so re-completing a lesson
// won't double-award). XP is granted every time the row newly transitions to
// completed; we detect that by comparing the prior status to the new one.
app.patch('/api/learn/progress', (req, res) => {
    try {
        const { username, lesson_id, status, score, attempts } = req.body || {};
        if (!username || !lesson_id) {
            return res.status(400).json({ error: 'username and lesson_id are required' });
        }
        const learner = db.getLearner(username);
        if (!learner) return res.status(404).json({ error: 'Learner not found' });

        // Capture prior status so we only award XP on the first completion.
        const prior = db.getLearnerProgress(username).find(p => p.lesson_id === lesson_id);
        const wasCompleted = prior && prior.status === 'completed';

        db.upsertLessonProgress({ username, lesson_id, status, score, attempts });
        db.bumpLearnerActivity(username);

        const newBadges = [];
        let leveledUp = false;
        const priorLevel = learner.level;

        if (status === 'completed' && !wasCompleted) {
            const curriculum = loadCurriculum();
            const lesson = findLessonInCurriculum(curriculum, lesson_id);
            if (lesson) {
                if (Number.isFinite(lesson.xp) && lesson.xp > 0) db.addXp(username, lesson.xp);
                if (lesson.badge_id && db.addBadge(username, lesson.badge_id)) {
                    newBadges.push(lesson.badge_id);
                }
            }
            const updated = db.getLearner(username);
            const newLevel = levelForXp(updated.total_xp);
            if (newLevel !== priorLevel) {
                db.setLearnerLevel(username, newLevel);
                leveledUp = true;
            }
        }

        res.json({
            learner: db.getLearner(username),
            newBadges,
            leveledUp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/learn/reset — wipe a learner's progress, keep the profile row.
app.post('/api/learn/reset', (req, res) => {
    try {
        const { username } = req.body || {};
        if (!username) return res.status(400).json({ error: 'username is required' });
        if (!db.getLearner(username)) return res.status(404).json({ error: 'Learner not found' });
        db.resetLearner(username);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// JSON 404 for unmatched /api routes — without this, a typo'd API path falls
// through to express.static and returns an HTML "Cannot GET", breaking clients
// that expect JSON.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Central error handler. Express 5 forwards rejected async handlers here; this
// returns JSON and keeps stack traces out of the HTTP response. Must keep all
// four args (err, req, res, next) for Express to treat it as an error handler.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start the HTTP server only when run directly (`node server.js`), not when this
// module is required by the test suite.
if (require.main === module) {
app.listen(PORT, HOST, () => {
    console.log(`\n🚀 LaunchPad - Entrepreneur's Project Tracker`);
    console.log(`   Local:   http://localhost:${PORT}  (bound to ${HOST})`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
        console.log(`   ⚠  Bound to ${HOST} — reachable beyond this machine and there is NO auth.`);
    }
    console.log(`\n📊 Ready to track your empire\n`);

    // T1.6 — boot-time sync sweep. Defer 2s so the server is fully responsive
    // before we start fanning out git fetch calls. Concurrency 4 keeps load
    // sane on Bob's 39+ project list. All side effects are limited to
    // last_commit_at + the existing idea→building auto-bump (skips
    // paused/launched/planning/infrastructure).
    setTimeout(() => {
        try {
            const fs = require('fs');
            const all = db.getAllProjects();
            const cloned = all.filter(p => p.local_path && fs.existsSync(p.local_path) && p.repo_url);
            if (cloned.length === 0) return;
            console.log(`[boot-sweep] checking ${cloned.length} cloned projects (concurrency 4)...`);
            const t0 = Date.now();
            runSyncSweep(cloned, 4)
                .then(results => {
                    const summary = results.reduce((acc, r) => {
                        acc[r.status] = (acc[r.status] || 0) + 1;
                        return acc;
                    }, {});
                    console.log(`[boot-sweep] done in ${((Date.now() - t0) / 1000).toFixed(1)}s —`, summary);
                })
                .catch(err => console.error('[boot-sweep] failed:', err.message));
        } catch (e) {
            console.error('[boot-sweep] schedule failed:', e.message);
        }
    }, 2000);

    // Visibility backfill — fixes already-imported repos that predate
    // visibility tracking (one GitHub API call, matched by repo_url).
    setTimeout(() => {
        backfillVisibility()
            .then(n => { if (n > 0) console.log(`[visibility-backfill] updated ${n} project(s)`); })
            .catch(err => console.error('[visibility-backfill] failed:', err.message));
    }, 2500);
});

// Graceful shutdown — checkpoint + close the DB on every termination path, not
// just Ctrl-C, so the WAL is truncated instead of left multi-MB on disk.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\n👋 Shutting down (${signal})...`);
    db.close();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last-resort net for any other exit path; db.close() is idempotent.
process.on('exit', () => db.close());
}

module.exports = app;
// Test-only hooks: expose the security-critical pure helpers so the suite can
// assert them directly without binding a port. Attaching to the app function
// keeps `require('./server')` returning the Express app (the smoke test relies
// on `typeof app === 'function'`).
module.exports.PORT = PORT; // the origin guard's canonical host/origin uses this
module.exports.resolveSafeDir = resolveSafeDir;
module.exports.runGit = runGit;
module.exports.sanitizeTerminalRunCommand = sanitizeTerminalRunCommand;
module.exports.ALLOWED_TERMINAL_RUN = ALLOWED_TERMINAL_RUN;
