const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserFixture({ mode = 'browser', popup = true, reject = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const start = source.indexOf('async function openProjectWorkspace(');
    const end = source.indexOf('\nfunction openInTerminal(', start);
    assert.ok(start >= 0 && end > start);
    const events = [];
    const tab = { closed: false, opener: {}, location: { replace: url => events.push(['navigate', url]) },
        close: () => events.push(['close']) };
    const sandbox = { URL, workspaceMode: mode,
        window: { open: () => { events.push(['open']); return popup ? tab : null; },
            location: { assign: url => events.push(['fallback', url]) } },
        fetch: async (_url, init) => {
            events.push(['fetch', JSON.parse(init.body)]);
            return { ok: !reject, json: async () => reject ? { error: 'Path rejected' }
                : { mode, url: 'https://editor.example.test/?folder=%2Fwork%2Fprojects%2Fdemo' } };
        },
        showToast: message => events.push(['toast', message]),
        alert: message => events.push(['alert', message]),
    };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.openWorkspace = openProjectWorkspace;', sandbox);
    return { run: sandbox.openWorkspace, events, tab };
}
test('browser mode reserves a tab before awaiting the request and removes its opener', async () => {
    const f = browserFixture();
    await f.run('/work/projects/demo');
    assert.deepEqual(f.events.slice(0, 2).map(e => e[0]), ['open', 'fetch']);
    assert.equal(f.tab.opener, null);
    assert.equal(new URL(f.events.find(e => e[0] === 'navigate')[1]).searchParams.get('folder'), '/work/projects/demo');
});
test('browser Claude action requests only the whitelisted command and explains manual startup', async () => {
    const f = browserFixture();
    await f.run('/work/projects/demo', 'claude');
    assert.equal(f.events.find(e => e[0] === 'fetch')[1].command, 'claude');
    assert.match(f.events.find(e => e[0] === 'toast')[1], /then run claude/);
});
test('popup blocking has a usable current-tab fallback', async () => {
    const f = browserFixture({ popup: false });
    await f.run('/work/projects/demo', 'claude');
    assert.ok(f.events.some(e => e[0] === 'fallback'));
    assert.ok(f.events.some(e => e[0] === 'alert' && /run claude/.test(e[1])));
});
test('a rejected path closes the placeholder and never navigates', async () => {
    const f = browserFixture({ reject: true });
    await f.run('/work/projects/demo');
    assert.ok(f.events.some(e => e[0] === 'close'));
    assert.ok(!f.events.some(e => e[0] === 'navigate' || e[0] === 'fallback'));
    assert.match(f.events.find(e => e[0] === 'toast')[1], /Path rejected/);
});
test('native mode opens no browser tab and describes only a process launch', async () => {
    const f = browserFixture({ mode: 'native' });
    await f.run('/work/projects/demo');
    assert.ok(!f.events.some(e => e[0] === 'open'));
    assert.match(f.events.find(e => e[0] === 'toast')[1], /Started native terminal launcher/);
});
