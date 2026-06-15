// Server-load smoke test. Requiring server.js must NOT bind a port (the listen
// call is guarded by `require.main === module`), so this just confirms the module
// loads cleanly and exports the Express app. Catches syntax/wiring regressions at
// module-eval time. (Loads the real DB and runs its idempotent CREATE-IF-NOT-EXISTS init.)
const { test } = require('node:test');
const assert = require('node:assert');

test('server module loads and exports an Express app (no port bound)', () => {
    const app = require('../server');
    assert.strictEqual(typeof app, 'function');
    assert.strictEqual(typeof app.listen, 'function');
});
