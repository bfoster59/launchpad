// AI Review helper tests — repo-context gathering and prompt building against a
// temp directory. No network: runReview is exercised with a stub client.
//   npm test   ->   node --test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    gatherRepoContext, buildReviewPrompt, runReview, REVIEW_MODEL, MAX_TREE_ENTRIES, MAX_CONTEXT_CHARS
} = require('../ai-review');

function tempRepo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-review-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

test('reads README and manifests, lists tree, never reads .env contents', async () => {
    const dir = tempRepo({
        'README.md': '# Setup Sheets\nGenerates CNC setup sheets.',
        'package.json': '{"name":"setup-sheets"}',
        '.env': 'SECRET_VALUE=do-not-send',
        'src/index.js': 'console.log(1)',
        'node_modules/dep/index.js': 'x'
    });
    const ctx = await gatherRepoContext(dir, null);
    assert.deepStrictEqual(ctx.docs.map(d => d.name), ['README.md']);
    assert.deepStrictEqual(ctx.manifests.map(m => m.name), ['package.json']);
    assert.ok(ctx.tree.includes('src/index.js'));
    assert.ok(ctx.tree.includes('.env'), 'file names are listed');
    assert.ok(!ctx.tree.some(f => f.startsWith('node_modules/')), 'skips node_modules');
    const prompt = buildReviewPrompt({ name: 'Setup Sheets' }, ctx);
    assert.ok(!prompt.includes('do-not-send'), '.env contents must never reach the prompt');
    assert.ok(prompt.includes('Generates CNC setup sheets.'));
});

test('uses git ls-files and log when the repo is a git repo', async () => {
    const dir = tempRepo({ '.git/HEAD': 'ref: refs/heads/main', 'a.js': '' });
    const calls = [];
    const fakeGit = async (cwd, args) => {
        calls.push(args[0]);
        if (args[0] === 'ls-files') return { stdout: 'a.js\nsrc/b.js\n' };
        if (args[0] === 'log') return { stdout: '2026-09-01 initial commit' };
        if (args[0] === 'status') return { stdout: ' M a.js\n?? c.js\n' };
        return { stdout: '' };
    };
    const ctx = await gatherRepoContext(dir, fakeGit);
    assert.deepStrictEqual(ctx.tree, ['a.js', 'src/b.js']);
    assert.strictEqual(ctx.gitLog, '2026-09-01 initial commit');
    assert.strictEqual(ctx.gitStatus, '2 uncommitted change(s)');
    assert.deepStrictEqual(calls, ['ls-files', 'log', 'status']);
});

test('caps the file tree and the total prompt size', async () => {
    const files = {};
    for (let i = 0; i < MAX_TREE_ENTRIES + 50; i++) files[`f${String(i).padStart(4, '0')}.txt`] = '';
    const dir = tempRepo(files);
    const ctx = await gatherRepoContext(dir, null);
    assert.strictEqual(ctx.tree.length, MAX_TREE_ENTRIES);
    assert.strictEqual(ctx.treeTruncated, true);

    const huge = { ...ctx, docs: [{ name: 'README.md', text: 'x'.repeat(MAX_CONTEXT_CHARS * 2) }] };
    const prompt = buildReviewPrompt({ name: 'Big' }, huge);
    assert.ok(prompt.length < MAX_CONTEXT_CHARS + 200);
    assert.ok(prompt.includes('[snapshot truncated]'));
});

test('never follows a symlinked doc/manifest out of the repo', async (t) => {
    const outside = tempRepo({ 'secret.txt': 'PRIVATE-KEY-MATERIAL' });
    const dir = tempRepo({ 'package.json': '{"name":"ok"}' });
    try {
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'README.md'), 'file');
    } catch (e) {
        // Creating symlinks on Windows needs Developer Mode / admin.
        t.skip(`cannot create symlinks here (${e.code})`);
        return;
    }
    const ctx = await gatherRepoContext(dir, null);
    assert.deepStrictEqual(ctx.docs, [], 'symlinked README must not be read');
    const prompt = buildReviewPrompt({ name: 'X' }, ctx);
    assert.ok(!prompt.includes('PRIVATE-KEY-MATERIAL'));
});

test('redacts known secret formats from file contents before sending', async () => {
    const dir = tempRepo({
        'CLAUDE.md': [
            'anthropic sk-ant-api03-AbCdEf0123456789AbCdEf0123456789xyz',
            'github ghp_0123456789abcdefghijABCDEFGHIJ012345',
            'fine-grained github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123',
            'aws AKIAIOSFODNN7EXAMPLE',
            'slack xoxb-123456789012-abcdefghijkl',
            '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----',
            'Normal prose stays.'
        ].join('\n')
    });
    const ctx = await gatherRepoContext(dir, null);
    const prompt = buildReviewPrompt({ name: 'X' }, ctx);
    for (const leaked of ['sk-ant-api03-AbCd', 'ghp_0123', 'github_pat_11AB', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-1234', 'b3BlbnNzaC1rZXktdjEAAAA']) {
        assert.ok(!prompt.includes(leaked), `must redact ${leaked}`);
    }
    assert.ok(prompt.includes('[REDACTED]'));
    assert.ok(prompt.includes('Normal prose stays.'));
});

test('strips credentials embedded in the repo URL from the prompt', () => {
    const prompt = buildReviewPrompt(
        { name: 'X', repo_url: 'https://someone:tok3n-value@github.com/me/x.git' },
        { docs: [], manifests: [], tree: [], gitLog: null }
    );
    assert.ok(!prompt.includes('tok3n-value'));
    assert.ok(prompt.includes('https://github.com/me/x.git'));
});

function stubClient(message, captured) {
    return {
        beta: {
            messages: {
                stream(params) {
                    captured.params = params;
                    return { finalMessage: async () => message };
                }
            }
        }
    };
}

test('runReview sends Opus 5 with server-side fallback and returns the text', async () => {
    const captured = {};
    const client = stubClient({
        stop_reason: 'end_turn',
        model: REVIEW_MODEL,
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '## Verdict\n7/10 — Finish & ship' }]
    }, captured);
    const result = await runReview(client, { name: 'X' }, { docs: [], manifests: [], tree: [], gitLog: null });
    assert.strictEqual(captured.params.model, 'claude-opus-5');
    assert.strictEqual(captured.params.fallbacks, 'default');
    assert.deepStrictEqual(captured.params.betas, ['server-side-fallback-2026-07-01']);
    assert.strictEqual(result.markdown, '## Verdict\n7/10 — Finish & ship');
});

test('runReview throws on refusal', async () => {
    const client = stubClient({ stop_reason: 'refusal', model: REVIEW_MODEL, content: [] }, {});
    await assert.rejects(
        runReview(client, { name: 'X' }, { docs: [], manifests: [], tree: [], gitLog: null }),
        /declined/
    );
});
