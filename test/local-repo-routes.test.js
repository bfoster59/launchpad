// Import / Clone / detect routes link existing local clones instead of cloning
// twice. Scan roots and clone base point at throwaway temp trees with fake
// .git/config files, the DB is :memory:, and every case is chosen so no real
// `git clone` (network) is ever spawned.
//   npm test   ->   node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-routes-'));
const scanRoot = path.join(root, 'dev');
const cloneBase = path.join(root, 'clones');
process.env.LAUNCHPAD_DB = ':memory:';
process.env.SCAN_ROOTS = scanRoot;
process.env.CLONE_BASE_DIR = cloneBase;
const app = require('../server');

function fakeRepo(dir, originUrl) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`);
    return dir;
}

const alphaDir = fakeRepo(path.join(scanRoot, 'active', 'alpha-local'), 'https://github.com/tester/alpha.git');
fakeRepo(path.join(scanRoot, 'active', 'beta'), 'https://github.com/tester/beta.git');
fakeRepo(path.join(scanRoot, 'WORK', 'Beta'), 'git@github.com:tester/beta.git');
const gammaDir = fakeRepo(path.join(scanRoot, 'active', 'gamma'), 'https://github.com/tester/gamma.git');
const deltaDir = fakeRepo(path.join(scanRoot, 'nested', 'x', 'delta'), 'https://github.com/tester/delta.git');
// A non-repo folder squatting on the canonical clone target for 'epsilon'.
fs.mkdirSync(path.join(cloneBase, 'epsilon'), { recursive: true });

let server, port;
before(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
});
after(() => {
    if (server) server.close();
    fs.rmSync(root, { recursive: true, force: true });
});

const sameOrigin = {
    host: `127.0.0.1:${app.PORT}`,
    origin: `http://127.0.0.1:${app.PORT}`,
    'sec-fetch-site': 'same-origin',
};

function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body != null ? JSON.stringify(body) : null;
        const headers = { ...sameOrigin };
        if (data != null) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = Buffer.byteLength(data);
        }
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
            let chunks = '';
            res.on('data', (c) => (chunks += c));
            res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
        });
        req.on('error', reject);
        if (data != null) req.write(data);
        req.end();
    });
}

const repo = (name) => ({ name, html_url: `https://github.com/tester/${name}`, description: null, language: 'JavaScript' });

test('bulk import links a single existing local copy found by repo URL (folder name differs)', async () => {
    const res = await request('POST', '/api/github/import', { repos: [repo('alpha')] });
    assert.strictEqual(res.status, 200);
    const [p] = res.body.projects;
    assert.strictEqual(p.local.status, 'linked');
    assert.strictEqual(p.local_path, alphaDir);
});

test('bulk import leaves ambiguous repos unlinked and uncloned', async () => {
    const res = await request('POST', '/api/github/import', { repos: [repo('beta')] });
    const [p] = res.body.projects;
    assert.strictEqual(p.local.status, 'ambiguous');
    assert.strictEqual(p.local.candidates.length, 2);
    assert.strictEqual(p.local_path, null);
    assert.ok(!fs.existsSync(path.join(cloneBase, 'beta')), 'must not clone when copies exist');
});

test('bulk import never overwrites an existing non-repo folder at the clone target', async () => {
    const res = await request('POST', '/api/github/import', { repos: [repo('epsilon')] });
    const [p] = res.body.projects;
    assert.strictEqual(p.local.status, 'skipped');
    assert.strictEqual(p.local_path, null);
    assert.deepStrictEqual(fs.readdirSync(path.join(cloneBase, 'epsilon')), []);
});

test('bulk import refuses to clone a non-GitHub repo URL', async () => {
    const res = await request('POST', '/api/github/import', {
        repos: [{ name: 'evil', html_url: 'file:///C:/somewhere/evil', description: null }],
    });
    const [p] = res.body.projects;
    assert.strictEqual(p.local.status, 'skipped');
    assert.ok(!fs.existsSync(path.join(cloneBase, 'evil')));
});

test('Clone to Local links an existing copy instead of cloning', async () => {
    const created = await request('POST', '/api/projects', { name: 'gamma', repo_url: 'https://github.com/tester/gamma' });
    assert.ok(created.status === 200 || created.status === 201, `create failed: ${created.status}`);
    const id = (created.body.project || created.body).id;
    const res = await request('POST', `/api/projects/${id}/clone`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.linked, true);
    assert.strictEqual(res.body.local_path, gammaDir);
    assert.ok(!fs.existsSync(path.join(cloneBase, 'gamma')));
});

// --- Hotfix regressions (post-merge inspection, 2026-09-28) ---

// A stub clone runner whose clones finish only when the test says so.
function pendingCloneRunner() {
    const calls = [];
    const runner = (url, dir) => new Promise((resolve, reject) => calls.push({ url, dir, resolve, reject }));
    return { runner, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const projectId = (res) => (res.body.project || res.body).id;

test('deleting a project mid-clone does not crash the server or leak a rejection', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    const { runner, calls } = pendingCloneRunner();
    app.setCloneRunner(runner);
    try {
        const res = await request('POST', '/api/github/import', { repos: [repo('zeta'), repo('eta')] });
        const [zeta, eta] = res.body.projects;
        assert.strictEqual(zeta.local.status, 'cloning');
        assert.strictEqual(calls.length, 2);
        await request('DELETE', `/api/projects/${zeta.id}`);
        await request('DELETE', `/api/projects/${eta.id}`);
        calls[0].resolve();                          // success path after delete
        calls[1].reject(new Error('network down'));  // failure path after delete
        await tick();
        assert.deepStrictEqual(rejections, []);
        const alive = await request('GET', '/api/settings');
        assert.strictEqual(alive.status, 200);
    } finally {
        process.off('unhandledRejection', onRejection);
        app.setCloneRunner(null);
    }
});

test('background clones run at most two at a time; same-named repos never share a folder', async () => {
    const { runner, calls } = pendingCloneRunner();
    app.setCloneRunner(runner);
    try {
        const res = await request('POST', '/api/github/import', {
            repos: [repo('q1'), repo('q2'), repo('q3'),
                { name: 'dupname', html_url: 'https://github.com/owner-a/dupname' },
                { name: 'dupname', html_url: 'https://github.com/owner-b/dupname' }],
        });
        const statuses = res.body.projects.map(p => p.local.status);
        assert.deepStrictEqual(statuses, ['cloning', 'cloning', 'cloning', 'cloning', 'skipped']);
        assert.strictEqual(calls.length, 2, 'only two git clones start immediately');
        assert.strictEqual(app.cloneQueueState().queued, 2);

        // Clone to Local on a project still cloning says so instead of "Already cloned".
        const busy = await request('POST', `/api/projects/${res.body.projects[3].id}/clone`);
        assert.strictEqual(busy.status, 409);
        assert.match(busy.body.error, /in progress/);

        for (let i = 0; i < 4; i++) { calls[i].resolve(); await tick(); }
        assert.strictEqual(calls.length, 4);
        assert.deepStrictEqual(app.cloneQueueState(), { active: 0, queued: 0, cloning: [] });
    } finally {
        app.setCloneRunner(null);
    }
});

test('local-clone-detect never replaces a stored local_path that still exists', async () => {
    const mono = fakeRepo(path.join(scanRoot, 'mono'), 'https://github.com/tester/mono.git');
    const sub = path.join(mono, 'packages', 'pkgA');
    fs.mkdirSync(sub, { recursive: true });
    const created = await request('POST', '/api/projects', { name: 'pkgA', repo_url: 'https://github.com/tester/mono', local_path: sub });
    const id = projectId(created);
    await request('GET', '/api/local-clone-detect');
    const after = await request('GET', `/api/projects/${id}`);
    assert.strictEqual((after.body.project || after.body).local_path, sub);
});

test('local-clone-detect does not link a same-named clone of a different repo', async () => {
    fakeRepo(path.join(cloneBase, 'utils'), 'https://github.com/someone-else/utils.git');
    const mine = fakeRepo(path.join(scanRoot, 'active', 'my-utils'), 'https://github.com/tester/utils.git');
    const created = await request('POST', '/api/projects', { name: 'utils', repo_url: 'https://github.com/tester/utils' });
    const id = projectId(created);
    const res = await request('GET', '/api/local-clone-detect');
    assert.strictEqual(res.body.results[id].path, mine);
});

test('local-clone-detect repairs a stale local_path from the scan and reports ambiguity', async () => {
    const created = await request('POST', '/api/projects', {
        name: 'delta', repo_url: 'https://github.com/tester/delta', local_path: path.join(root, 'moved-away', 'delta'),
    });
    const id = (created.body.project || created.body).id;
    const res = await request('GET', '/api/local-clone-detect');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results[id].status, 'cloned');
    assert.strictEqual(res.body.results[id].path, deltaDir);
    const after = await request('GET', `/api/projects/${id}`);
    assert.strictEqual((after.body.project || after.body).local_path, deltaDir);

    const beta = Object.values(res.body.results).find(r => r.status === 'ambiguous');
    assert.ok(beta, 'the ambiguous beta project is reported as such');
});
