const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { browserWorkspaceTarget, credentialStatus, launchNativeTerminal } = require('../workspace-access');

test('no browser configuration preserves native mode', () => {
    assert.equal(browserWorkspaceTarget(undefined, '/work/projects/demo'), null);
});
test('browser editor URL contains exactly the selected folder, encoded once', () => {
    const cwd = '/work/projects/demo with spaces #1';
    const result = browserWorkspaceTarget('https://editor.example.test', cwd, 'claude');
    const url = new URL(result.url);
    assert.equal(url.origin, 'https://editor.example.test');
    assert.equal(url.searchParams.get('folder'), cwd);
    assert.equal(url.searchParams.size, 1);
    assert.equal(result.command, 'claude');
    assert.equal(result.mode, 'browser');
});
test('browser origin rejects credentials, executable schemes and extra URL components', () => {
    for (const origin of ['not a URL', 'javascript:alert(1)', 'file:///tmp/a',
        'https://user:password@example.test', 'https://example.test/editor',
        'https://example.test/?', 'https://example.test/#', 'https://example.test/?token=test']) {
        assert.throws(() => browserWorkspaceTarget(origin, '/work/projects/demo'), /BROWSER_EDITOR_ORIGIN/);
    }
});
test('credential status supports environment fallback and reveals no credential bytes', () => {
    const credential = 'test-only-value-do-not-return';
    const result = credentialStatus('', credential);
    assert.deepEqual(result, { set: true, source: 'environment' });
    assert.ok(!JSON.stringify(result).includes(credential));
});
test('stored credentials take precedence and missing credentials stay explicit', () => {
    assert.deepEqual(credentialStatus('stored', 'env'), { set: true, source: 'settings' });
    assert.deepEqual(credentialStatus(null, undefined), { set: false, source: null });
});
test('native launcher uses discrete arguments and does not report success before spawn', async () => {
    const child = new EventEmitter();
    let unreferenced = false;
    child.unref = () => { unreferenced = true; };
    let settled = false;
    const result = launchNativeTerminal((file, args, options) => {
        assert.equal(file, 'test-terminal');
        assert.deepEqual(args, ['--workdir', '/work/projects/my project']);
        assert.equal(options.cwd, '/work/projects/my project');
        assert.equal(options.shell, undefined);
        return child;
    }, 'test-terminal', ['--workdir', '/work/projects/my project'], '/work/projects/my project');
    result.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit('spawn');
    assert.equal((await result).mode, 'native');
    assert.equal(unreferenced, true);
});
test('native launcher failure is an error without returning underlying error text', async () => {
    const child = new EventEmitter();
    const pending = launchNativeTerminal(() => child, 'test-terminal', [], '/work/projects/demo');
    child.emit('error', new Error('sensitive underlying detail'));
    await assert.rejects(pending, error => error.message === 'Unable to start the native terminal launcher');
});
test('synchronous native spawn failures reject the operation', async () => {
    await assert.rejects(launchNativeTerminal(() => { throw new Error('spawn failed'); }, 'x', [], '/tmp'));
});
