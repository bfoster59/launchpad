// Real HTTP regressions. Uses an isolated database and never contacts GitHub.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-workspace-'));
const project = path.join(root, 'demo with spaces');
fs.mkdirSync(project);
process.env.LAUNCHPAD_DB = ':memory:';
process.env.CLONE_BASE_DIR = root;
process.env.BROWSER_EDITOR_ORIGIN = 'https://editor.example.test';
process.env.GITHUB_TOKEN = 'test-only-github-credential';
delete process.env.PUBLIC_ORIGIN;
const app = require('../server');
let server, port;
before(async () => {
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
});
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
function request(method, route, body, hostile = false) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { host: `127.0.0.1:${app.PORT}`, origin: hostile ? 'https://evil.example.test' : `http://127.0.0.1:${app.PORT}` };
        if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
        const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}
test('browser route opens an allowed project and does not append the command to its URL', async () => {
    const response = await request('POST', '/api/util/open-terminal', { path: project, command: 'claude' });
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'browser');
    assert.equal(new URL(response.body.url).searchParams.get('folder'), project);
    assert.equal(new URL(response.body.url).searchParams.size, 1);
    assert.equal(response.body.command, 'claude');
});
test('browser route keeps path allowlisting and the terminal-command whitelist', async () => {
    const outside = await request('POST', '/api/util/open-terminal', { path: os.tmpdir() });
    assert.equal(outside.status, 400);
    const command = await request('POST', '/api/util/open-terminal', { path: project, command: 'echo unsafe' });
    assert.equal(command.status, 200);
    assert.equal(command.body.command, null);
});
test('browser route still rejects hostile origins', async () => {
    const response = await request('POST', '/api/util/open-terminal', { path: project }, true);
    assert.equal(response.status, 403);
});
test('settings report environment authentication without any token bytes', async () => {
    const response = await request('GET', '/api/settings');
    assert.deepEqual(response.body.github_pat, { set: true, source: 'environment' });
    assert.ok(!response.text.includes(process.env.GITHUB_TOKEN));
});
test('clearing a database token restores the configured server credential', async () => {
    await request('PUT', '/api/settings/github_pat', { value: 'temporary-test-credential' });
    assert.equal((await request('GET', '/api/settings')).body.github_pat.source, 'settings');
    await request('PUT', '/api/settings/github_pat', { value: '' });
    assert.equal((await request('GET', '/api/settings')).body.github_pat.source, 'environment');
});
test('workspace metadata tells the browser which project action to show', async () => {
    const response = await request('GET', '/api/util/terminal-choices');
    assert.equal(response.body.workspace_mode, 'browser');
});
