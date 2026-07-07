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
const { resolveSafeDir, runGit, sanitizeTerminalRunCommand, ALLOWED_TERMINAL_RUN } = app;

test('resolveSafeDir rejects every shell metacharacter', () => {
    // Broad coverage: every rejected character — including ones illegal as
    // directory names (<>|" and CR/LF), which can only be fed as non-existent
    // paths — yields null. (For a non-existent path the existence check alone
    // would also return null; the next test feeds a REAL in-base directory to
    // prove the metacharacter *regex* is specifically what rejects it.)
    for (const ch of ['`', '$', ';', '&', '|', '<', '>', '^', '"', "'", '%', '\n', '\r']) {
        assert.strictEqual(resolveSafeDir(`${CLONE_BASE}${ch}evil`), null,
            `expected null for metacharacter ${JSON.stringify(ch)}`);
    }
});

test('resolveSafeDir rejects a REAL in-base directory whose name contains a metacharacter', () => {
    // Isolates the regex guard from the existence check: each directory EXISTS and
    // is INSIDE the clone base, so the ONLY thing that can force null is the
    // metacharacter rejection — delete the regex in resolveSafeDir and this fails.
    // Only metacharacters legal in a directory name on both Windows and POSIX are
    // used (<>|" and CR/LF are covered by the non-existent-path test above).
    for (const ch of ['&', '$', ';', '^', '%', "'", '`']) {
        const dir = fs.mkdtempSync(path.join(CLONE_BASE, `meta${ch}-`));
        assert.strictEqual(resolveSafeDir(dir), null,
            `a real in-base dir containing ${JSON.stringify(ch)} must be rejected`);
    }
});

test('resolveSafeDir rejects out-of-base directories that really exist', () => {
    // Use REAL existing directories outside the base so the containment check —
    // not the existence check — is what forces null.
    assert.strictEqual(resolveSafeDir(path.dirname(CLONE_BASE)), null); // tmp root, above the base
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

test('terminal run-command whitelist stays free of shell/cmd metacharacters (winStart safety invariant)', () => {
    // The Windows open-terminal path runs `cmd /c start "" <exe> <rc>`; rc is safe
    // there only because the whitelist has no cmd metacharacters (Node's arg
    // escaping is not cmd.exe-aware). Guard the invariant so a future whitelist
    // addition can't silently make that path injectable.
    for (const cmd of ALLOWED_TERMINAL_RUN) {
        assert.ok(!/[&|<>^%"'`$;()!]/.test(cmd),
            `whitelisted terminal command must stay metacharacter-free: ${JSON.stringify(cmd)}`);
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
