(function () {
  'use strict';
  var KEY = 'launchpad-theme';
  var CHOICES = ['auto', 'light', 'dark'];

  function resolveTheme(choice, prefersDark) {
    if (choice === 'light') return 'light';
    if (choice === 'dark') return 'dark';
    return prefersDark ? 'dark' : 'light'; // auto / null / unknown
  }
  function nextThemeChoice(choice) {
    var i = CHOICES.indexOf(choice);
    return CHOICES[(i + 1) % CHOICES.length]; // i === -1 -> 'auto'
  }
  function themeIcon(choice) {
    return choice === 'light' ? '☀️'
         : choice === 'dark'  ? '🌙'
         :                      '🖥️';
  }

  // Export pure functions for node:test BEFORE any DOM work.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveTheme: resolveTheme, nextThemeChoice: nextThemeChoice, themeIcon: themeIcon };
  }

  // Browser-only wiring below.
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  function getChoice() {
    try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; }
  }
  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function apply(choice) {
    document.documentElement.dataset.theme = resolveTheme(choice, prefersDark());
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = themeIcon(choice);
      btn.title = 'Theme: ' + choice;
      btn.setAttribute('aria-label', 'Theme: ' + choice);
    }
  }
  function init() {
    apply(getChoice());
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var next = nextThemeChoice(getChoice());
        try { localStorage.setItem(KEY, next); } catch (e) {}
        apply(next);
      });
    }
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (getChoice() === 'auto') apply('auto');
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
