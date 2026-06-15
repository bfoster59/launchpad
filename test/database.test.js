// Database-layer tests — run against an isolated in-memory DB (no touching the
// real launchpad.db). Built-in node:test runner, zero dependencies.
//   npm test   ->   node --test
const { test } = require('node:test');
const assert = require('node:assert');
const LaunchpadDB = require('../database');

const freshDb = () => new LaunchpadDB(':memory:');

test('init creates a usable, empty projects table', () => {
    const db = freshDb();
    assert.deepStrictEqual(db.getAllProjects(), []);
});

test('addProject + getProject round-trip', () => {
    const db = freshDb();
    const p = db.addProject({ name: 'Alpha', description: 'first', repo_url: 'https://github.com/me/alpha', source: 'github' });
    assert.ok(p.id > 0);
    const got = db.getProject(p.id);
    assert.strictEqual(got.name, 'Alpha');
    assert.strictEqual(got.repo_url, 'https://github.com/me/alpha');
});

test('addProject applies status/category defaults', () => {
    const db = freshDb();
    const p = db.addProject({ name: 'Beta' });
    assert.strictEqual(p.status, 'idea');
    assert.strictEqual(p.category, 'app');
});

test('duplicate repo_url returns the existing project, no duplicate row (M3)', () => {
    const db = freshDb();
    const a = db.addProject({ name: 'X', repo_url: 'https://github.com/me/x', source: 'github' });
    const b = db.addProject({ name: 'X again', repo_url: 'https://github.com/me/x', source: 'github' });
    assert.strictEqual(a.id, b.id);
    const dupes = db.getAllProjects().filter(p => p.repo_url === 'https://github.com/me/x');
    assert.strictEqual(dupes.length, 1);
});

test('multiple manual projects with null repo_url are allowed (partial unique index)', () => {
    const db = freshDb();
    const a = db.addProject({ name: 'm1' });
    const b = db.addProject({ name: 'm2' });
    assert.notStrictEqual(a.id, b.id);
});

test('getAllProjects filters by status', () => {
    const db = freshDb();
    db.addProject({ name: 'idea1', status: 'idea' });
    db.addProject({ name: 'built1', status: 'building' });
    const building = db.getAllProjects({ status: 'building' });
    assert.strictEqual(building.length, 1);
    assert.strictEqual(building[0].name, 'built1');
});

test('settings get/set round-trip and upsert', () => {
    const db = freshDb();
    assert.strictEqual(db.getSetting('missing'), null);
    db.setSetting('clone_base_dir', 'C:/dev');
    assert.strictEqual(db.getSetting('clone_base_dir'), 'C:/dev');
    db.setSetting('clone_base_dir', 'C:/other');
    assert.strictEqual(db.getSetting('clone_base_dir'), 'C:/other');
});

test('updateProject persists changes', () => {
    const db = freshDb();
    const p = db.addProject({ name: 'U', status: 'idea' });
    db.updateProject(p.id, { status: 'building', description: 'updated' });
    const got = db.getProject(p.id);
    assert.strictEqual(got.status, 'building');
    assert.strictEqual(got.description, 'updated');
});
