// AI Review — gathers a bounded snapshot of a local repo and asks Claude for a
// structured assessment. Pure helpers (gatherRepoContext, buildReviewPrompt) are
// exported for tests; runReview is the only function that touches the network.
//
// Safety: only reads a fixed allowlist of doc/manifest files plus file NAMES from
// the tree. Never reads .env or other arbitrary file contents.
const fs = require('fs');
const path = require('path');

const REVIEW_MODEL = 'claude-opus-5';

// Per-file and total caps keep the prompt bounded on huge repos.
const MAX_DOC_CHARS = 12000;
const MAX_TREE_ENTRIES = 400;
const MAX_CONTEXT_CHARS = 80000;

// Files whose CONTENTS are sent (repo root only). Each inner list is one
// document; the first spelling that exists wins — on case-insensitive
// filesystems (Windows) 'README.md' and 'readme.md' are the same file.
const DOC_FILES = [['README.md', 'readme.md', 'README'], ['CLAUDE.md'], ['TODO.md'], ['CHANGELOG.md']];
const MANIFEST_FILES = [
    'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml',
    'go.mod', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'Dockerfile'
];

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv',
    '__pycache__', 'target', 'coverage', '.cache'
]);

function readCapped(file, max) {
    try {
        const text = fs.readFileSync(file, 'utf-8');
        return text.length > max ? `${text.slice(0, max)}\n... [truncated]` : text;
    } catch (e) {
        return null;
    }
}

// Breadth-first walk of file names (no contents), used when git is unavailable.
function walkTree(root) {
    const out = [];
    const queue = [''];
    while (queue.length && out.length < MAX_TREE_ENTRIES) {
        const rel = queue.shift();
        let entries;
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
            if (out.length >= MAX_TREE_ENTRIES) break;
            const child = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) {
                if (!SKIP_DIRS.has(ent.name)) queue.push(child);
            } else {
                out.push(child);
            }
        }
    }
    return out;
}

// Collect README/manifests/tree/git history for `dir`. `runGit(cwd, args)` is
// injected (server.js's no-shell helper) so tests can stub it.
async function gatherRepoContext(dir, runGit) {
    const ctx = { docs: [], manifests: [], tree: [], treeTruncated: false, gitLog: null, gitStatus: null };

    for (const spellings of DOC_FILES) {
        for (const name of spellings) {
            const text = readCapped(path.join(dir, name), MAX_DOC_CHARS);
            if (text !== null) { ctx.docs.push({ name, text }); break; }
        }
    }
    for (const name of MANIFEST_FILES) {
        const text = readCapped(path.join(dir, name), MAX_DOC_CHARS);
        if (text !== null) ctx.manifests.push({ name, text });
    }

    const isGit = fs.existsSync(path.join(dir, '.git'));
    if (isGit && runGit) {
        try {
            const { stdout } = await runGit(dir, ['ls-files']);
            const files = stdout.split(/\r?\n/).filter(Boolean);
            ctx.treeTruncated = files.length > MAX_TREE_ENTRIES;
            ctx.tree = files.slice(0, MAX_TREE_ENTRIES);
        } catch (e) { /* fall through to fs walk */ }
        try {
            const { stdout } = await runGit(dir, ['log', '-20', '--date=short', '--pretty=format:%ad %s']);
            ctx.gitLog = stdout.trim() || null;
        } catch (e) { /* no commits yet */ }
        try {
            const { stdout } = await runGit(dir, ['status', '--short']);
            const lines = stdout.split(/\r?\n/).filter(Boolean);
            ctx.gitStatus = `${lines.length} uncommitted change(s)`;
        } catch (e) { /* ignore */ }
    }
    if (ctx.tree.length === 0) {
        ctx.tree = walkTree(dir);
        ctx.treeTruncated = ctx.tree.length >= MAX_TREE_ENTRIES;
    }
    return ctx;
}

const SYSTEM_PROMPT = `You are a senior software engineer reviewing one of the user's personal repositories inside LaunchPad, their project dashboard. The user starts many projects and wants a straight, evidence-based verdict on each one — not encouragement.

Base every claim on the repository snapshot provided. When the snapshot doesn't show something, say it is unknown rather than guessing. Be direct and concise.

Respond in Markdown using exactly these sections:

## Verdict
One line: a 1–10 score and one of Keep building / Finish & ship / Park / Retire, with the main reason.

## What it is
Two or three sentences: purpose, audience, and stack as shown by the code.

## Current state
How complete it is, how recently it was worked on, and whether it looks runnable. Cite evidence (files, commits).

## Strengths
Up to 4 bullets.

## Risks & problems
Up to 6 bullets, most serious first — bugs, security, missing tests, stale dependencies, and gaps between what the docs claim and what the code shows.

## Next 3 actions
A numbered list of the three most valuable concrete next steps, each small enough to finish in one sitting.`;

function section(title, body) {
    return `<${title}>\n${body}\n</${title}>`;
}

function buildReviewPrompt(project, ctx) {
    const meta = [
        `Name: ${project.name}`,
        project.description && `Description: ${project.description}`,
        project.status && `Status in LaunchPad: ${project.status}`,
        project.category && `Category: ${project.category}`,
        project.tech_stack && `Tech stack (user-entered): ${project.tech_stack}`,
        project.target_market && `Target market: ${project.target_market}`,
        project.repo_url && `Repo: ${project.repo_url}`,
        ctx.gitStatus && `Working tree: ${ctx.gitStatus}`
    ].filter(Boolean).join('\n');

    const parts = [section('project', meta)];
    for (const d of ctx.docs) parts.push(section(`file path="${d.name}"`, d.text));
    for (const m of ctx.manifests) parts.push(section(`file path="${m.name}"`, m.text));
    const tree = ctx.tree.join('\n') + (ctx.treeTruncated ? `\n... [more files not shown]` : '');
    parts.push(section('file_tree', tree || '(empty)'));
    parts.push(section('recent_commits', ctx.gitLog || '(no git history available)'));

    let body = parts.join('\n\n');
    if (body.length > MAX_CONTEXT_CHARS) body = `${body.slice(0, MAX_CONTEXT_CHARS)}\n... [snapshot truncated]`;
    return `${body}\n\nReview this repository.`;
}

// Calls Claude and returns { markdown, model }. Throws on refusal or empty output.
async function runReview(client, project, ctx) {
    const message = await client.beta.messages.stream({
        model: REVIEW_MODEL,
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        // Server-side fallback: if Opus 5 declines, the API re-runs on the
        // recommended fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildReviewPrompt(project, ctx) }]
    }).finalMessage();

    if (message.stop_reason === 'refusal') {
        throw new Error('Claude declined to review this repository.');
    }
    const markdown = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    if (!markdown) throw new Error('Claude returned an empty review.');
    return { markdown, model: message.model };
}

module.exports = {
    REVIEW_MODEL,
    MAX_TREE_ENTRIES,
    MAX_CONTEXT_CHARS,
    gatherRepoContext,
    buildReviewPrompt,
    runReview
};
