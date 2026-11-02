// Helpers for browser-hosted workspaces and safe credential status reporting.
// The caller must resolve/allowlist the project path before building its URL.
function browserWorkspaceTarget(origin, cwd, command) {
    if (!origin) return null;
    let url;
    try { url = new URL(origin); } catch {
        throw new Error('BROWSER_EDITOR_ORIGIN must be an HTTP(S) origin');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || origin.includes('?') || origin.includes('#')) {
        throw new Error('BROWSER_EDITOR_ORIGIN must contain only an HTTP(S) origin, without credentials or a path');
    }
    url.searchParams.set('folder', cwd);
    return { success: true, mode: 'browser', url: url.href, cwd, command: command || null };
}

function credentialStatus(stored, environment) {
    return { set: Boolean(stored || environment), source: stored ? 'settings' : environment ? 'environment' : null };
}

// A successful spawn confirms a launcher process, not the existence of a window.
function launchNativeTerminal(spawn, file, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => reject(new Error('Unable to start the native terminal launcher')));
        child.once('spawn', () => {
            child.unref();
            resolve({ success: true, mode: 'native', command: `${file} ${args.join(' ')}`, cwd });
        });
    });
}

module.exports = { browserWorkspaceTarget, credentialStatus, launchNativeTerminal };
