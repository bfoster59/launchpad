const test = require('node:test');
const assert = require('node:assert');
const { resolveTheme, nextThemeChoice, themeIcon } = require('../public/theme.js');

test('resolveTheme: explicit choice wins over OS', () => {
  assert.strictEqual(resolveTheme('light', true), 'light');
  assert.strictEqual(resolveTheme('dark', false), 'dark');
});

test('resolveTheme: auto/unset follows OS', () => {
  assert.strictEqual(resolveTheme('auto', true), 'dark');
  assert.strictEqual(resolveTheme('auto', false), 'light');
  assert.strictEqual(resolveTheme(null, true), 'dark');
});

test('nextThemeChoice cycles auto -> light -> dark -> auto', () => {
  assert.strictEqual(nextThemeChoice('auto'), 'light');
  assert.strictEqual(nextThemeChoice('light'), 'dark');
  assert.strictEqual(nextThemeChoice('dark'), 'auto');
  assert.strictEqual(nextThemeChoice('bogus'), 'auto');
});

test('themeIcon maps choice to glyph', () => {
  assert.strictEqual(themeIcon('light'), '☀️');
  assert.strictEqual(themeIcon('dark'), '🌙');
  assert.strictEqual(themeIcon('auto'), '🖥️');
});
