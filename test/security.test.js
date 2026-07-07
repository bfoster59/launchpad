// Security-hardening regression tests (Gate 3 F2). These lock the command-
// injection defenses from the prior build under tests: if `resolveSafeDir`, the
// terminal-run whitelist, or the argument-array git calls are ever reverted to
// shell-string interpolation, one of these fails. Runs against an isolated
// :memory: DB and throwaway temp dirs — never touches the real launchpad.db.
//   npm test   ->   node --test
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Point the server at an isolated DB + a throwaway clone base BEFORE requiring it,
// so resolveSafeDir's allowlist is a directory we control and no real DB is made.
const CLONE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-base-'));
process.env.LAUNCHPAD_DB = ':memory:';
process.env.CLONE_BASE_DIR = CLONE_BASE;
const app = require('../server');
const { resolveSafeDir, runGit, sanitizeTerminalRunCommand } = app;

test('resolveSafeDir rejects every shell metacharacter', () => {
    // The regex guard fires before the filesystem check, so the metacharacter
    // alone must force null regardless of whether the path exists.
    for (const ch of ['`', '$', ';', '&', '|', '<', '>', '^', '"', "'", '%', '\n', '\r']) {
        assert.strictEqual(resolveSafeDir(`${CLONE_BASE}${ch}evil`), null,
            `expected null for metacharacter ${JSON.stringify(ch)}`);
    }
});

test('resolveSafeDir rejects traversal and out-of-base directories', () => {
    // Traversal that climbs above the clone base.
    assert.strictEqual(resolveSafeDir(path.join(CLONE_BASE, '..', '..', 'nope')), null);
    // A real directory that exists but is outside the base and not a tracked project.
    assert.strictEqual(resolveSafeDir(os.homedir()), null);
});

test('resolveSafeDir rejects non-existent and non-string inputs', () => {
    assert.strictEqual(resolveSafeDir(path.join(CLONE_BASE, 'does-not-exist-xyz')), null);
    assert.strictEqual(resolveSafeDir(null), null);
    assert.strictEqual(resolveSafeDir(undefined), null);
    assert.strictEqual(resolveSafeDir(42), null);
    assert.strictEqual(resolveSafeDir(''), null);
});

test('resolveSafeDir accepts a real directory inside the clone base', () => {
    // Positive control — proves the function is not simply returning null always.
    const inside = fs.mkdtempSync(path.join(CLONE_BASE, 'proj-'));
    assert.strictEqual(resolveSafeDir(inside), path.resolve(inside));
});

test('sanitizeTerminalRunCommand allows only the exact whitelist', () => {
    assert.strictEqual(sanitizeTerminalRunCommand('claude'), 'claude');
    assert.strictEqual(sanitizeTerminalRunCommand('npm run dev'), 'npm run dev');
    assert.strictEqual(sanitizeTerminalRunCommand('npm start'), 'npm start');
    for (const bad of ['rm -rf /', 'npm run dev; rm -rf /', 'claude && curl evil', 'npm  run  dev', '', undefined, null]) {
        assert.strictEqual(sanitizeTerminalRunCommand(bad), null,
            `expected null for non-whitelisted ${JSON.stringify(bad)}`);
    }
});

test('git runs via an argument array — a metachar-laden commit message is inert', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-git-'));
    await runGit(repo, ['init', '-q']);
    await runGit(repo, ['config', 'user.email', 't@example.com']);
    await runGit(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    await runGit(repo, ['add', 'a.txt']);
    // If this message were ever interpolated into a shell string, `touch pwned`
    // would execute and create ./pwned. With execFile + an arg array it is a
    // literal argument to `git commit -m`.
    const evilMsg = 'legit"; touch pwned; echo "done';
    await runGit(repo, ['commit', '-q', '-m', evilMsg]);
    assert.ok(!fs.existsSync(path.join(repo, 'pwned')), 'shell metacharacters must NOT execute');
    const { stdout } = await runGit(repo, ['log', '-1', '--pretty=%s']);
    assert.strictEqual(stdout.trim(), evilMsg, 'commit message must be preserved literally');
});
