// Local repo discovery. Walks the configured scan roots looking for git working
// trees, reads each one's origin URL straight from .git/config (no git process),
// and matches repos by GitHub owner/repo — never by folder name, since local
// folder names drift from repo names (Prompt_Architect vs prompt-architect).
// Used so Import / Clone link an existing local copy instead of cloning twice.
const fs = require('fs');
const path = require('path');

// Directories never worth descending into: dependency/build trees are huge and
// never hold the user's own repos. Hidden dirs (.git, .claude/worktrees, …) are
// skipped separately so a worktree is never mistaken for the primary clone.
const SKIP_DIRS = new Set([
    'node_modules', 'venv', 'env', '__pycache__', 'dist', 'build', 'target', 'bin', 'obj', 'vendor',
]);

// A copy under one of these folder names is a backup, not the working copy.
// It still counts as "exists" (so we never re-clone it), but a live copy wins.
const ARCHIVE_SEGMENTS = new Set(['archive', 'backup', 'backups', 'dead']);

// 'owner/repo' (lowercase) for any GitHub URL form, else null. Non-GitHub and
// malformed URLs return null — callers treat that as "cannot match or clone".
function repoKey(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.trim().match(
        /^(?:https?:\/\/(?:[^@\/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    );
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// Where a working tree's config lives. '.git' is normally a directory, but in
// a linked worktree or submodule it is a file pointing elsewhere.
function gitConfigPath(repoDir) {
    const dotGit = path.join(repoDir, '.git');
    let stat;
    try { stat = fs.statSync(dotGit); } catch (e) { return null; }
    if (stat.isDirectory()) return path.join(dotGit, 'config');
    try {
        const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (!m) return null;
        let gitDir = path.resolve(repoDir, m[1].trim());
        const commonFile = path.join(gitDir, 'commondir');
        if (fs.existsSync(commonFile)) gitDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim());
        return path.join(gitDir, 'config');
    } catch (e) { return null; }
}

// The origin remote's URL (or the first remote's, if there is no origin).
function readOriginUrl(repoDir) {
    const cfgPath = gitConfigPath(repoDir);
    if (!cfgPath) return null;
    let text;
    try { text = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { return null; }
    let remote = null;
    const urls = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const section = line.match(/^\[remote\s+"([^"]+)"\]$/);
        if (section) { remote = section[1]; continue; }
        if (line.startsWith('[')) { remote = null; continue; }
        const kv = remote && line.match(/^url\s*=\s*(.+)$/);
        if (kv && !urls[remote]) urls[remote] = kv[1].trim();
    }
    return urls.origin || Object.values(urls)[0] || null;
}

// Breadth-first walk of each root, up to maxDepth levels below it. A directory
// containing .git is recorded and NOT descended into. Unreadable dirs are
// skipped silently. Returns [{ path, url, key }].
function scanForRepos(roots, { maxDepth = 5 } = {}) {
    const seen = new Set();
    const found = [];
    const norm = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
    for (const root of roots || []) {
        if (!root) continue;
        const start = path.resolve(root);
        const queue = [[start, 0]];
        while (queue.length) {
            const [dir, depth] = queue.shift();
            if (seen.has(norm(dir))) continue;
            seen.add(norm(dir));
            if (fs.existsSync(path.join(dir, '.git'))) {
                const url = readOriginUrl(dir);
                found.push({ path: dir, url, key: repoKey(url) });
                continue;
            }
            if (depth >= maxDepth) continue;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
            for (const ent of entries) {
                if (!ent.isDirectory()) continue;
                if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name.toLowerCase())) continue;
                queue.push([path.join(dir, ent.name), depth + 1]);
            }
        }
    }
    return found;
}

// Map of 'owner/repo' → [local paths]. Repos without a GitHub origin are dropped.
function buildRepoIndex(repos) {
    const index = new Map();
    for (const r of repos) {
        if (!r.key) continue;
        if (!index.has(r.key)) index.set(r.key, []);
        index.get(r.key).push(r.path);
    }
    return index;
}

function isArchived(p) {
    return p.split(/[\\/]+/).some(seg => ARCHIVE_SEGMENTS.has(seg.toLowerCase()));
}

// Decide which local copy (if any) a repo URL maps to:
//   { status: 'found', path }            exactly one live copy, or one archived-only copy
//   { status: 'ambiguous', candidates }  several copies and no single live winner
//   { status: 'none' }                   nothing on disk
function pickLocalMatch(index, url) {
    const key = repoKey(url);
    const paths = (key && index.get(key)) || [];
    if (paths.length === 0) return { status: 'none' };
    const live = paths.filter(p => !isArchived(p));
    if (live.length === 1) return { status: 'found', path: live[0] };
    if (live.length === 0 && paths.length === 1) return { status: 'found', path: paths[0] };
    return { status: 'ambiguous', candidates: paths };
}

module.exports = { repoKey, readOriginUrl, scanForRepos, buildRepoIndex, pickLocalMatch };
