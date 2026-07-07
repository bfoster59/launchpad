// Origin-guard + input-validation route tests (Gate 3 F1/F2/F6). Boots the app on
// an ephemeral port against an isolated :memory: DB and drives it with raw HTTP so
// we can set Host / Origin / Sec-Fetch-Site headers that a browser-fetch client is
// forbidden from setting. Never touches the real launchpad.db.
//   npm test   ->   node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.LAUNCHPAD_DB = ':memory:';
const app = require('../server');

let server, port;

before(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
});

after(() => { if (server) server.close(); });

// Minimal HTTP client that lets us set ANY header (including Host), which the
// global fetch() forbids. Connects to the ephemeral loopback port regardless of
// the Host header we forge.
function request({ method = 'GET', path = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body != null ? JSON.stringify(body) : null;
        const h = { ...headers };
        if (data != null) {
            h['content-type'] = 'application/json';
            h['content-length'] = Buffer.byteLength(data);
        }
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
            let chunks = '';
            res.on('data', (c) => (chunks += c));
            res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
        });
        req.on('error', reject);
        if (data != null) req.write(data);
        req.end();
    });
}

// The guard validates the CLAIMED Host/Origin headers (built from the fixed
// server PORT), not the socket — so we forge the guard's canonical host/origin
// while http.request still connects to the ephemeral test port. Deriving from
// app.PORT keeps these robust if the port constant ever changes.
const guardHost = () => `127.0.0.1:${app.PORT}`;
const guardOrigin = () => `http://127.0.0.1:${app.PORT}`;
const sameOrigin = () => ({
    host: guardHost(),
    origin: guardOrigin(),
    'sec-fetch-site': 'same-origin',
});

test('cross-origin POST is rejected with 403', async () => {
    // Valid Host, hostile Origin — isolates the cross-origin rejection.
    const res = await request({
        method: 'POST', path: '/api/util/open-terminal',
        headers: { host: guardHost(), origin: 'http://evil.example.com' },
        body: { path: 'Z:/nope' },
    });
    assert.strictEqual(res.status, 403);
});

test('cross-site request (Sec-Fetch-Site) is rejected with 403', async () => {
    // Valid Host, no Origin, but the browser marks it cross-site.
    const res = await request({
        method: 'POST', path: '/api/projects/1/launch',
        headers: { host: guardHost(), 'sec-fetch-site': 'cross-site' },
        body: {},
    });
    assert.strictEqual(res.status, 403);
});

test('DNS-rebinding Host is rejected with 403', async () => {
    const res = await request({
        method: 'POST', path: '/api/util/open-terminal',
        headers: { host: 'attacker.example.com', 'sec-fetch-site': 'same-origin' },
        body: { path: 'Z:/nope' },
    });
    assert.strictEqual(res.status, 403);
});

test('same-origin POST passes the guard and reaches the handler', async () => {
    // A bogus path passes the guard, then 400s inside the handler (NOT 403) — and
    // because the path is invalid, no terminal is ever spawned. Proves the guard
    // does not block legitimate same-origin calls.
    const res = await request({
        method: 'POST', path: '/api/util/open-terminal',
        headers: sameOrigin(),
        body: { path: 'Z:/definitely/not/a/real/dir/xyz' },
    });
    assert.notStrictEqual(res.status, 403);
    assert.strictEqual(res.status, 400);
});

test(':id route param rejects a non-integer with 400', async () => {
    // GET is not gated by the origin guard, so this exercises the app.param check.
    const res = await request({ method: 'GET', path: '/api/projects/not-an-int' });
    assert.strictEqual(res.status, 400);
});

test('GET /api/settings never returns any bytes of the stored token', async () => {
    const token = 'ghp_TESTONLYtoken1234567890abcdef';
    const set = await request({
        method: 'POST', path: '/api/github/token',
        headers: sameOrigin(), body: { token },
    });
    assert.strictEqual(set.status, 200);
    const res = await request({ method: 'GET', path: '/api/settings' });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.includes('ghp_'), 'settings response must not contain the token or its prefix');
    assert.ok(!res.body.includes(token.slice(0, 7)), 'settings response must not contain any token slice');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.github_pat.set, true);
    assert.strictEqual(parsed.github_pat.preview, undefined);
});
