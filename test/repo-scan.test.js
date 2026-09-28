// Local repo discovery (repo-scan.js). Builds throwaway directory trees with fake
// .git/config files under os.tmpdir() — no real git, no network, never touches
// the user's actual repos.
//   npm test   ->   node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoKey, readOriginUrl, scanForRepos, buildRepoIndex, pickLocalMatch } = require('../repo-scan');

let root;

function fakeRepo(rel, originUrl) {
    const dir = path.join(root, rel);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const cfg = originUrl
        ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
        : `[core]\n\tbare = false\n`;
    fs.writeFileSync(path.join(dir, '.git', 'config'), cfg);
    return dir;
}

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-scan-'));
    fakeRepo('active/alpha', 'https://github.com/bfoster59/Alpha.git');
    fakeRepo('active/group/beta', 'git@github.com:bfoster59/beta.git');
    fakeRepo('WORK/Beta-copy', 'https://github.com/bfoster59/beta');
    fakeRepo('archive/dead/gamma', 'https://github.com/bfoster59/gamma.git');
    fakeRepo('active/nodeproj/node_modules/pkg', 'https://github.com/someone/pkg.git');
    fakeRepo('active/.hidden/delta', 'https://github.com/bfoster59/delta.git');
    fakeRepo('active/noremote', null);
    fakeRepo('a/b/c/d/e/f/g/too-deep', 'https://github.com/bfoster59/deep.git');
});

after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('repoKey normalizes https, ssh, .git suffix, trailing slash and case', () => {
    assert.strictEqual(repoKey('https://github.com/BFoster59/Alpha.git'), 'bfoster59/alpha');
    assert.strictEqual(repoKey('https://github.com/bfoster59/alpha/'), 'bfoster59/alpha');
    assert.strictEqual(repoKey('git@github.com:bfoster59/alpha.git'), 'bfoster59/alpha');
    assert.strictEqual(repoKey('ssh://git@github.com/bfoster59/alpha.git'), 'bfoster59/alpha');
    assert.strictEqual(repoKey('https://user@github.com/bfoster59/alpha'), 'bfoster59/alpha');
});

test('repoKey rejects non-GitHub and malformed URLs', () => {
    assert.strictEqual(repoKey('https://gitlab.com/x/y.git'), null);
    assert.strictEqual(repoKey('file:///C:/repos/x'), null);
    assert.strictEqual(repoKey('ext::sh -c touch% /tmp/pwned'), null);
    assert.strictEqual(repoKey('https://github.com/onlyowner'), null);
    assert.strictEqual(repoKey(''), null);
    assert.strictEqual(repoKey(null), null);
});

test('readOriginUrl reads the origin remote from .git/config', () => {
    assert.strictEqual(readOriginUrl(path.join(root, 'active/alpha')), 'https://github.com/bfoster59/Alpha.git');
    assert.strictEqual(readOriginUrl(path.join(root, 'active/noremote')), null);
    assert.strictEqual(readOriginUrl(path.join(root, 'does-not-exist')), null);
});

test('scanForRepos finds nested repos, skips node_modules, hidden dirs and too-deep trees', () => {
    const found = scanForRepos([root], { maxDepth: 5 }).map(r => path.relative(root, r.path).replace(/\\/g, '/')).sort();
    assert.deepStrictEqual(found, [
        'WORK/Beta-copy', 'active/alpha', 'active/group/beta', 'active/noremote', 'archive/dead/gamma'
    ]);
});

test('scanForRepos tolerates missing roots and duplicate roots', () => {
    const found = scanForRepos([path.join(root, 'nope'), root, root], { maxDepth: 5 });
    assert.strictEqual(found.length, 5);
});

test('pickLocalMatch: one copy is found, two live copies are ambiguous', () => {
    const index = buildRepoIndex(scanForRepos([root], { maxDepth: 5 }));
    const alpha = pickLocalMatch(index, 'https://github.com/bfoster59/alpha');
    assert.strictEqual(alpha.status, 'found');
    assert.strictEqual(alpha.path, path.join(root, 'active/alpha'));

    const beta = pickLocalMatch(index, 'https://github.com/bfoster59/beta');
    assert.strictEqual(beta.status, 'ambiguous');
    assert.strictEqual(beta.candidates.length, 2);
});

test('pickLocalMatch: an archive-only copy still counts as existing; unknown repo is none', () => {
    const index = buildRepoIndex(scanForRepos([root], { maxDepth: 5 }));
    const gamma = pickLocalMatch(index, 'https://github.com/bfoster59/gamma');
    assert.strictEqual(gamma.status, 'found');
    assert.strictEqual(gamma.path, path.join(root, 'archive/dead/gamma'));
    assert.strictEqual(pickLocalMatch(index, 'https://github.com/bfoster59/zeta').status, 'none');
    assert.strictEqual(pickLocalMatch(index, 'not a url').status, 'none');
});

test('pickLocalMatch: a live copy beats an archived copy of the same repo', () => {
    const index = new Map([['bfoster59/eps', [
        path.join(root, 'Backup', 'eps'),
        path.join(root, 'active', 'eps'),
    ]]]);
    const eps = pickLocalMatch(index, 'https://github.com/bfoster59/eps');
    assert.strictEqual(eps.status, 'found');
    assert.strictEqual(eps.path, path.join(root, 'active', 'eps'));
});
