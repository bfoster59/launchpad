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
