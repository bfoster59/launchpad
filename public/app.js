// LaunchPad - Client-side JavaScript
// State
let projects = [];
let currentProject = null;
let editingProjectId = null;
let githubRepos = [];
let searchResults = [];
let currentView = 'dashboard';
let previousView = 'dashboard';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
    loadStats();
});

// Navigation
// Encode a string for safe embedding in an inline HTML onclick="..." handler.
// Backslashes and quotes otherwise get eaten by the double-pass
// (browser attribute parse, then JS string parse) and paths like
// C:\home\bfoster\matrix-tv turn into C:homefostermatrix-tv.
function attrStr(s) {
    return JSON.stringify(String(s == null ? '' : s))
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// --- Toasts (polish P4): consistent non-blocking feedback ---
function showToast(message, type = 'info', timeout = 3500) {
    try {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.setAttribute('role', 'status');
        el.textContent = message; // textContent, not innerHTML — safe with error text
        const close = document.createElement('button');
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        close.onclick = () => el.remove();
        el.appendChild(close);
        container.appendChild(el);
        if (timeout > 0) setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 200); }, timeout);
    } catch (e) { /* never let a toast break a flow */ }
}
window.showToast = showToast;

// --- Keyboard shortcuts (polish P4): number keys 1-6 switch tabs (ignored while typing) ---
(function () {
    const ORDER = ['dashboard', 'myProjects', 'github', 'explore', 'learn', 'settings'];
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (e.key >= '1' && e.key <= '6') {
            const v = ORDER[parseInt(e.key, 10) - 1];
            if (v && typeof showView === 'function') { showView(v); e.preventDefault(); }
        }
    });
})();

function showView(viewName) {
    // Track previous view (but don't track 'detail' as previous)
    if (currentView !== 'detail') {
        previousView = currentView;
    }
    currentView = viewName;
    
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewName + 'View').classList.add('active');
    
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const navTab = document.querySelector(`[data-view="${viewName}"]`);
    if (navTab) {
        navTab.classList.add('active');
    }
    
    // Legacy aliases — old tab names still work after the renames
    if (viewName === 'githubNeo') viewName = 'github';
    if (viewName === 'discover') viewName = 'explore';

    // Load data for view
    if (viewName === 'explore') {
        loadExplore();
    } else if (viewName === 'github') {
        loadNeoView();
    } else if (viewName === 'settings') {
        loadSettings();
    } else if (viewName === 'learn') {
        if (typeof loadLearn === 'function') loadLearn();
    } else if (viewName === 'myProjects') {
        // Always re-render so the New Project form can't stick around after
        // the user navigates away without cancelling.
        if (typeof renderMyProjects === 'function' && typeof projects !== 'undefined') {
            renderMyProjects();
        }
    }
}

// ========== SETTINGS ==========

async function loadSettings() {
    try {
        const [settingsRes, termRes] = await Promise.all([
            fetch('/api/settings'),
            fetch('/api/util/terminal-choices')
        ]);
        const data = await settingsRes.json();
        const termData = await termRes.json();

        // Populate the terminal dropdown with platform-appropriate choices
        const termSelect = document.getElementById('settingsTerminal');
        const currentChoice = data.terminal_app || '';
        termSelect.innerHTML = '<option value="">Use platform default</option>' +
            termData.choices.map(c => `<option value="${c}"${c === currentChoice ? ' selected' : ''}>${c}</option>`).join('');
        document.getElementById('terminalChoicesRow').textContent =
            `Platform detected: ${termData.platform} — choices: ${termData.choices.join(', ')}`;

        const patEl = document.getElementById('patStatus');
        if (data.github_pat && data.github_pat.set) {
            patEl.textContent = `Token is set. Enter a new value and Save to replace, or Clear to remove.`;
            patEl.style.color = '#22c55e';
        } else {
            patEl.textContent = 'No token set — private-repo features and Bulk Import are disabled.';
            patEl.style.color = '#f59e0b';
        }

        const cloneDirEl = document.getElementById('cloneDirEffective');
        cloneDirEl.textContent = `Effective path: ${data.clone_base_dir_effective}`;
        document.getElementById('settingsCloneDir').placeholder = data.clone_base_dir_effective;

        document.getElementById('scanRootsEffective').textContent =
            `Searching: ${(data.scan_roots_effective || []).join('  ·  ')}`;
        document.getElementById('settingsScanRoots').value = data.scan_roots || '';
    } catch (e) {
        console.error('loadSettings error', e);
    }
}

async function saveSettingsPat() {
    const value = document.getElementById('settingsPat').value.trim();
    if (!value) {
        alert('Enter a token value (or use Clear Token to remove).');
        return;
    }
    try {
        const res = await fetch('/api/settings/github_pat', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        document.getElementById('settingsPat').value = '';
        await loadSettings();
        showToast('GitHub token saved and loaded.');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function clearSettingsPat() {
    if (!confirm('Clear the stored GitHub token?')) return;
    try {
        await fetch('/api/settings/github_pat', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: '' })
        });
        await loadSettings();
        showToast('Token cleared.');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function testGitHubPat() {
    const resEl = document.getElementById('patTestResult');
    resEl.textContent = 'Testing…';
    resEl.style.color = 'var(--text-muted)';
    try {
        const res = await fetch('/api/settings/test-github', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            resEl.textContent = `✅ Connected as @${data.login}`;
            resEl.style.color = '#22c55e';
        } else {
            resEl.textContent = `❌ ${data.error || 'Connection failed'}`;
            resEl.style.color = '#ef4444';
        }
    } catch (e) {
        resEl.textContent = `❌ ${e.message}`;
        resEl.style.color = '#ef4444';
    }
}

async function saveSettingsTerminal() {
    const value = document.getElementById('settingsTerminal').value;
    try {
        const res = await fetch('/api/settings/terminal_app', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        await loadSettings();
        showToast(value ? `Terminal set to ${value}` : 'Using platform default');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function saveSettingsCloneDir() {
    const value = document.getElementById('settingsCloneDir').value.trim();
    if (!value) {
        alert('Enter a path (e.g., C:\\dev\\clones) or leave the default.');
        return;
    }
    try {
        const res = await fetch('/api/settings/clone_base_dir', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        document.getElementById('settingsCloneDir').value = '';
        await loadSettings();
        showToast('Clone base directory saved.');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

// Empty clears the setting (only the clone base is searched then).
async function saveSettingsScanRoots() {
    const value = document.getElementById('settingsScanRoots').value.trim();
    try {
        const res = await fetch('/api/settings/scan_roots', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        await loadSettings();
        showToast('Scan roots saved.');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

// showToast(message, type, timeout) is defined once near the top (polish P4) —
// the old always-green top-right toast was replaced by the typed toast system.

function goBack() {
    stopRunningPoll();
    showView(previousView);
}

// ========== PROJECT CREATION ==========

const STACK_PRESETS = [
    'Next.js + TypeScript + Tailwind',
    'Next.js + TypeScript + Tailwind + SQLite',
    'Vite + React + TypeScript',
    'Vite + React + Tailwind',
    'Express + SQLite (Node)',
    'Express + TypeScript + SQLite',
    'FastAPI + SQLite (Python)',
    'FastAPI + Postgres (Python)',
    'Electron + React + TypeScript',
    'Python CLI (Click)',
    'Python CLI (Typer)',
    'Node CLI (Commander)',
    'Go CLI (Cobra)',
    'Rust CLI (clap)',
    'Tauri + React',
    'SvelteKit',
    'Astro',
    'Remix',
    'Nuxt',
    'Hono + Cloudflare Workers',
    'Static HTML/CSS/JS',
    'Custom (describe below)'
];

function showAddProject() {
    // The form is injected into #myProjectsList, so make sure that view is
    // showing — otherwise the "+ New Project" button on the Dashboard injects
    // into a hidden view and appears to do nothing. (showView -> renderMyProjects
    // is synchronous, so the form we inject below is not clobbered.)
    if (currentView !== 'myProjects') showView('myProjects');
    const stackOpts = STACK_PRESETS.map(s => `<option value="${s}">${s}</option>`).join('');
    const form = `
        <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; max-width: 760px; margin: 0 auto; grid-column: 1 / -1;">
            <h2 style="margin-bottom: 8px; color: var(--text);">🏗️ New Project — Build Room</h2>
            <div style="color: var(--text-muted); margin-bottom: 24px; font-size: 0.9rem;">Capture the vision, stack, and entry-points once so Claude Code has everything it needs when you open a terminal.</div>
            <form id="newProjectForm" onsubmit="saveProject(event)">

                <fieldset style="border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: var(--accent-soft); padding: 0 8px;">Basics</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Project Name *</label>
                        <input type="text" name="name" required style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">One-line description</label>
                        <input type="text" name="description" placeholder="What this project is, in one sentence" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
                        <div>
                            <label style="display: block; margin-bottom: 6px; color: var(--text);">Status</label>
                            <select name="status" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                                <option value="idea">💡 Idea</option>
                                <option value="planning">📋 Planning</option>
                                <option value="building">🔨 Building</option>
                                <option value="launched">🚀 Launched</option>
                                <option value="infrastructure">🏗️ Infrastructure</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 6px; color: var(--text);">Category</label>
                            <select name="category" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                                <option value="app">📱 App</option>
                                <option value="saas">☁️ SaaS</option>
                                <option value="utility">🔧 Utility</option>
                                <option value="tool">🛠️ Tool</option>
                            </select>
                        </div>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: var(--accent-soft); padding: 0 8px;">Concept</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Prompt / vision</label>
                        <textarea name="prompt" rows="4" placeholder="Describe the app in natural language — the prompt you'd give Claude Code to start building. Who is it for? What problem does it solve? What are the core features?" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit;"></textarea>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">PRD (Product Requirements Document) <span style="color: var(--text-subtle); font-weight: normal;">— optional, fill later from Edit</span></label>
                        <textarea name="prd" rows="5" placeholder="Detailed requirements: user stories, acceptance criteria, non-goals, constraints." style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace; font-size: 0.9rem;"></textarea>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: var(--accent-soft); padding: 0 8px;">Stack</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Preset</label>
                        <select name="stack_preset" onchange="document.querySelector('textarea[name=stack]').value = this.value === 'Custom (describe below)' ? '' : this.value" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                            <option value="">— pick a preset (optional) —</option>
                            ${stackOpts}
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Stack detail</label>
                        <textarea name="stack" rows="2" placeholder="e.g., Next.js 15 + TypeScript + Tailwind + SQLite (better-sqlite3) + Drizzle ORM" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace;"></textarea>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: var(--accent-soft); padding: 0 8px;">Paths &amp; Links</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Local Path <span style="color: var(--text-subtle); font-weight: normal;">— where Claude Code will work</span></label>
                        <input type="text" name="local_path" placeholder="e.g., C:\\home\\bfoster\\my-project" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace;">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">GitHub Repository URL</label>
                        <input type="url" name="repo_url" placeholder="https://github.com/user/repo" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">Live URL</label>
                        <input type="url" name="live_url" placeholder="https://your-app.vercel.app" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: var(--text);">References <span style="color: var(--text-subtle); font-weight: normal;">— one per line (URLs, doc titles, file paths)</span></label>
                        <textarea name="references" rows="3" placeholder="https://nextjs.org/docs&#10;C:\\reference\\PRD-draft.md&#10;https://example.com/api-spec" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace; font-size: 0.9rem;"></textarea>
                    </div>
                </fieldset>

                <div style="display: flex; gap: 12px;">
                    <button type="submit" class="btn btn-primary">🚀 Create Build Room</button>
                    <button type="button" class="btn btn-secondary" onclick="cancelNewProject()">Cancel</button>
                </div>
            </form>
        </div>
    `;
    document.getElementById('myProjectsList').innerHTML = form;
}

// Cancel the New Project form: restore the My Projects card grid.
// showView('myProjects') alone doesn't work because the view is already
// active — the form is INSIDE #myProjectsList and needs to be replaced
// with the actual card list.
function cancelNewProject() {
    if (typeof renderMyProjects === 'function') {
        renderMyProjects();
    } else {
        // Fallback: reload projects from API (slower but guaranteed)
        loadProjects();
    }
    showView('myProjects');
}

async function saveProject(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);

    // Normalize References textarea → JSON array of non-blank lines
    const refsRaw = (formData.get('references') || '').toString();
    const references = refsRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const data = {
        name: formData.get('name'),
        description: formData.get('description') || null,
        status: formData.get('status'),
        category: formData.get('category'),
        source: 'manual',
        prompt: formData.get('prompt') || null,
        prd: formData.get('prd') || null,
        stack: formData.get('stack') || null,
        tech_stack: formData.get('stack') || null, // mirror for card display
        local_path: formData.get('local_path') || null,
        repo_url: formData.get('repo_url') || null,
        live_url: formData.get('live_url') || null,
        references_json: references.length ? JSON.stringify(references) : null
    };
    
    try {
        const response = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) throw new Error('Failed to create project');
        
        const created = await response.json();
        showToast('✅ Build room created');
        await loadProjects();
        // Drop the user directly into the new project's build room
        if (created && created.id) {
            showProject(created.id);
        } else {
            showView('myProjects');
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// ========== DATA LOADING ==========

async function loadProjects() {
    try {
        const response = await fetch('/api/projects');
        projects = await response.json();
        renderDashboard();
        renderMyProjects();
        // GitHub tab renders via loadNeoView() on tab activation (merged view).
    } catch (error) {
        console.error('Error loading projects:', error);
    }
}

async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        
        document.getElementById('statsBar').innerHTML = `
            <div class="stat">
                <div class="stat-value">${stats.total}</div>
                <div>Total</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.building + stats.planning}</div>
                <div>Building</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.launched}</div>
                <div>Launched</div>
            </div>
        `;
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// ========== RENDERING ==========

function renderDashboard() {
    const recent = projects.slice(0, 6);
    const recentIds = new Set(recent.map(p => p.id));
    
    // Get active projects that are NOT already in recent projects
    const active = projects
        .filter(p => (p.status === 'building' || p.status === 'planning') && !recentIds.has(p.id))
        .slice(0, 6);
    
    document.getElementById('recentProjects').innerHTML = recent.length > 0
        ? recent.map(p => renderProjectCard(p)).join('')
        : '<div class="empty-state">No projects yet</div>';
        
    document.getElementById('activeProjects').innerHTML = active.length > 0
        ? active.map(p => renderProjectCard(p)).join('')
        : '<div class="empty-state">No active projects (or already shown in Recent)</div>';
}

function renderMyProjects() {
    const myProjects = projects.filter(p => p.source === 'manual');
    
    document.getElementById('myProjectsList').innerHTML = myProjects.length > 0
        ? myProjects.map(p => renderProjectCard(p)).join('')
        : '<div class="empty-state">No projects yet. Create your first one!</div>';
}

// renderGitHubProjects — removed 2026-04-20 when GitHub + GitHubNeo tabs merged.
// GitHub view now renders via loadNeoView (Popular cards + filterable list).

function renderProjectCard(p) {
    const categoryIcon = getCategoryIcon(p.category);
    const sourceIcon = p.source === 'github' ? '🐙' : '';
    const localIcon = p.local_path ? '📁' : '';

    // Git sync badge — only rendered when the project has a local clone and
    // sync state has been checked (either by opening the detail or by 'Check All').
    let syncBadge = '';
    if (p.local_path && p.sync_status) {
        const s = p.sync_status;
        const icon = getSyncIcon(s);
        const label = getSyncText(s);
        const badgeClass = getSyncBadgeClass(s);
        syncBadge = `<span class="neo-sync-badge ${badgeClass}" style="margin-left: 6px;">${icon} ${label}</span>`;
    }

    // External activity badge — last_commit_at is what github reported on
    // the most recent sync; last_seen_commit_at is what the user has opened.
    // Cleared automatically when the detail view is opened.
    let externalBadge = '';
    if (p.last_commit_at && p.last_commit_at > (p.last_seen_commit_at || 0)) {
        externalBadge = `<span title="New github activity since you last opened this project" style="background: var(--accent); color: var(--accent-contrast); padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; margin-left: 6px;">↗ External</span>`;
    }

    return `
        <div class="project-card" onclick="showProject(${p.id})">
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
                <div class="project-status status-${p.status}">${p.status}</div>
                <div>${externalBadge}${syncBadge}</div>
            </div>
            <div class="project-name">${sourceIcon} ${localIcon} ${escapeHtml(p.name)}</div>
            <div class="project-description">${escapeHtml(p.description || 'No description')}</div>
            <div class="project-meta">
                <span>${categoryIcon} ${escapeHtml(p.category)}</span>
                ${p.tech_stack ? `<span>🔧 ${escapeHtml(p.tech_stack.split(',')[0].trim())}</span>` : ''}
            </div>
        </div>
    `;
}

// ========== PROJECT DETAIL ==========

// Cached the initial detail-view template at page load so showProject can
// always rehydrate its expected DOM, even after editProject (or anything else)
// replaces .project-detail innerHTML.
let _detailTemplateHTML = null;
function _ensureDetailDom() {
    if (!_detailTemplateHTML) {
        _detailTemplateHTML = document.querySelector('.project-detail').innerHTML;
    }
    if (!document.getElementById('detailTitle')) {
        const pd = document.querySelector('.project-detail');
        while (pd.firstChild) pd.removeChild(pd.firstChild);
        pd.insertAdjacentHTML('afterbegin', _detailTemplateHTML);
        _editBackupHTML = null; // any stale backup is irrelevant now
    }
}

async function showProject(id) {
    try {
        _ensureDetailDom();
        const response = await fetch(`/api/projects/${id}`);
        currentProject = await response.json();

        // Acknowledge external activity — this clears the "↗ External" badge
        // by setting last_seen_commit_at = last_commit_at on the server.
        // Fire-and-forget so the detail render isn't blocked.
        if (currentProject.last_commit_at &&
            (currentProject.last_commit_at > (currentProject.last_seen_commit_at || 0))) {
            fetch(`/api/projects/${id}/mark-seen`, { method: 'POST' }).catch(() => {});
            // Mirror locally so card lists stop showing the badge before reload.
            const lists = [typeof projects !== 'undefined' ? projects : null,
                           typeof neoProjects !== 'undefined' ? neoProjects : null];
            lists.forEach(l => {
                if (!l) return;
                const p = l.find(x => x.id === id);
                if (p) p.last_seen_commit_at = p.last_commit_at;
            });
        }

        document.getElementById('detailTitle').textContent = currentProject.name;
        document.getElementById('detailDescription').textContent = currentProject.description || '';
        
        // Render updates
        const updatesList = document.getElementById('updatesList');
        if (currentProject.updates.length === 0) {
            updatesList.innerHTML = '<div class="empty-state">No updates yet</div>';
        } else {
            updatesList.innerHTML = currentProject.updates.map(u => `
                <div class="update-item">
                    <div class="update-header">
                        <div class="update-title">${escapeHtml(u.title)}</div>
                        <div class="update-time">${formatDate(u.created_at)}</div>
                    </div>
                    ${u.content ? `<div class="update-content">${escapeHtml(u.content)}</div>` : ''}
                </div>
            `).join('');
        }
        
        // Render README if available
        const readmeSection = document.getElementById('readmeSection');
        if (currentProject.readme) {
            readmeSection.style.display = 'block';
            document.getElementById('readmeContent').textContent = currentProject.readme;
        } else {
            readmeSection.style.display = 'none';
        }

        // Build-room sections: Prompt, PRD, References
        const promptSection = document.getElementById('promptSection');
        if (promptSection) {
            if (currentProject.prompt) {
                promptSection.style.display = 'block';
                document.getElementById('promptContent').textContent = currentProject.prompt;
            } else {
                promptSection.style.display = 'none';
            }
        }
        const prdSection = document.getElementById('prdSection');
        if (prdSection) {
            if (currentProject.prd) {
                prdSection.style.display = 'block';
                document.getElementById('prdContent').textContent = currentProject.prd;
            } else {
                prdSection.style.display = 'none';
            }
        }
        const refsSection = document.getElementById('referencesSection');
        if (refsSection) {
            let refs = [];
            try {
                refs = currentProject.references_json
                    ? JSON.parse(currentProject.references_json)
                    : [];
            } catch { refs = []; }
            if (refs.length) {
                refsSection.style.display = 'block';
                document.getElementById('referencesList').innerHTML = refs.map(r => {
                    const isUrl = /^https?:\/\//i.test(r);
                    return isUrl
                        ? `<a href="${escapeHtml(r)}" target="_blank" style="color: var(--accent-soft);">🔗 ${escapeHtml(r)}</a>`
                        : `<div style="color: var(--text); font-family: monospace; font-size: 0.9rem;">📄 ${escapeHtml(r)}</div>`;
                }).join('');
            } else {
                refsSection.style.display = 'none';
            }
        }
        
        // Render clone/sync/launch/commit/install-deps buttons based on state
        const cloneBtn = document.getElementById('cloneBtn');
        const syncBtn = document.getElementById('syncBtn');
        const launchBtn = document.getElementById('launchBtn');
        const commitBtn = document.getElementById('commitBtn');
        const installDepsBtn = document.getElementById('installDepsBtn');

        if (currentProject.repo_url && !currentProject.local_path) {
            cloneBtn.style.display = 'inline-block';
            syncBtn.style.display = 'none';
        } else if (currentProject.local_path) {
            cloneBtn.style.display = 'none';
            syncBtn.style.display = 'inline-block';
        } else {
            cloneBtn.style.display = 'none';
            syncBtn.style.display = 'none';
        }

        if (launchBtn) {
            const canLaunch = Boolean(currentProject.local_path || currentProject.live_url);
            launchBtn.style.display = canLaunch ? 'inline-block' : 'none';
        }
        if (commitBtn) {
            commitBtn.style.display = currentProject.local_path ? 'inline-block' : 'none';
        }
        if (installDepsBtn) {
            installDepsBtn.style.display = currentProject.local_path ? 'inline-block' : 'none';
        }
        const claudeBtn = document.getElementById('claudeCodeBtn');
        if (claudeBtn) {
            claudeBtn.style.display = currentProject.local_path ? 'inline-block' : 'none';
        }

        // Kick off running-server polling so Stop button + URL chip update live
        startRunningPoll();

        // Load GitHub-side data (issues + commits) in parallel when the repo
        // has a github URL. Sections hide themselves if there's no repo.
        loadIssues('open');
        loadCommits();
        
        // Render info
        document.getElementById('projectInfo').innerHTML = `
            <div class="info-row">
                <div class="info-label">Status</div>
                <div class="info-value">${escapeHtml(currentProject.status)}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Category</div>
                <div class="info-value">${escapeHtml(currentProject.category)}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Source</div>
                <div class="info-value">${escapeHtml(currentProject.source)}</div>
            </div>
            ${currentProject.local_path ? `
                <div class="info-row">
                    <div class="info-label">Local Path</div>
                    <div class="info-value" style="font-family: monospace; font-size: 0.85rem;">
                        <span style="color: var(--accent); cursor: pointer; text-decoration: underline;" onclick="copyToClipboard(${attrStr(currentProject.local_path)}, this)" title="Click to copy path">${escapeHtml(currentProject.local_path)}</span>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="copyTerminalCommand(${attrStr(currentProject.local_path)})" title="Copy cd command">📋 Copy cd command</button>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="openInTerminal(${attrStr(currentProject.local_path)})" title="Open a new terminal in this folder">💻 Open Terminal</button>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="openInFolder(${attrStr(currentProject.local_path)})" title="Open in Explorer">📂 Open Folder</button>
                    </div>
                </div>
            ` : ''}
            <!-- Running URL — populated by refreshRunningState() while a dev
                 server is alive. Hidden by default; shown when the launch poll
                 detects a localhost URL in the dev server's stdout. -->
            <div class="info-row" id="runningUrlRow" style="display: none;">
                <div class="info-label">Running on</div>
                <div class="info-value" style="font-family: monospace; font-size: 0.85rem;">
                    <a id="runningUrlLink" href="#" target="_blank" style="color: #22c55e;">—</a>
                    <span id="runningUrlPid" style="color: var(--text-subtle); margin-left: 8px;"></span>
                </div>
            </div>
            ${currentProject.stack ? `
                <div class="info-row">
                    <div class="info-label">Stack</div>
                    <div class="info-value" style="font-family: monospace; font-size: 0.85rem;">${escapeHtml(currentProject.stack)}</div>
                </div>
            ` : ''}
            ${currentProject.tech_stack && currentProject.tech_stack !== currentProject.stack ? `
                <div class="info-row">
                    <div class="info-label">Tech Stack</div>
                    <div class="info-value">${escapeHtml(currentProject.tech_stack)}</div>
                </div>
            ` : ''}
            ${currentProject.repo_url ? `
                <div class="info-row">
                    <div class="info-label">Repository</div>
                    <div class="info-value"><a href="${safeUrl(currentProject.repo_url)}" target="_blank" style="color: var(--accent);">View on GitHub</a></div>
                </div>
            ` : ''}
            ${currentProject.live_url ? `
                <div class="info-row">
                    <div class="info-label">Live Site</div>
                    <div class="info-value"><a href="${safeUrl(currentProject.live_url)}" target="_blank" style="color: var(--accent);">Visit</a></div>
                </div>
            ` : ''}
            ${currentProject.target_market ? `
                <div class="info-row">
                    <div class="info-label">Target Market</div>
                    <div class="info-value">${escapeHtml(currentProject.target_market)}</div>
                </div>
            ` : ''}
            ${currentProject.monetization ? `
                <div class="info-row">
                    <div class="info-label">Monetization</div>
                    <div class="info-value">${escapeHtml(currentProject.monetization)}</div>
                </div>
            ` : ''}
            ${currentProject.pricing ? `
                <div class="info-row">
                    <div class="info-label">Pricing</div>
                    <div class="info-value">${escapeHtml(currentProject.pricing)}</div>
                </div>
            ` : ''}
            <div class="info-row">
                <div class="info-label">Created</div>
                <div class="info-value" style="color: var(--text-muted); font-size: 0.85rem;">${currentProject.created_at ? new Date(currentProject.created_at * 1000).toLocaleString() : '—'}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Last updated</div>
                <div class="info-value" style="color: var(--text-muted); font-size: 0.85rem;">${currentProject.updated_at ? new Date(currentProject.updated_at * 1000).toLocaleString() : '—'}</div>
            </div>
            ${currentProject.launched_at ? `
                <div class="info-row">
                    <div class="info-label">Launched</div>
                    <div class="info-value" style="color: var(--text-muted); font-size: 0.85rem;">${new Date(currentProject.launched_at * 1000).toLocaleString()}</div>
                </div>
            ` : ''}
        `;
        
        showView('detail');
    } catch (error) {
        console.error('Error loading project:', error);
    }
}

// Snapshot of the detail view HTML taken before editProject replaces it,
// so Cancel/Save can restore the DOM structure that showProject() expects.
let _editBackupHTML = null;

function _restoreDetailFromBackup() {
    if (_editBackupHTML === null) return;
    const el = document.querySelector('.project-detail');
    while (el.firstChild) el.removeChild(el.firstChild);
    el.insertAdjacentHTML('afterbegin', _editBackupHTML);
    _editBackupHTML = null;
}

function cancelEdit() {
    _restoreDetailFromBackup();
    if (currentProject) showProject(currentProject.id);
}

async function editProject() {
    if (!currentProject) return;

    const form = `
        <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; max-width: 800px; margin: 0 auto;">
            <h2 style="margin-bottom: 24px; color: var(--text);">Edit Project</h2>
            <form id="editProjectForm" onsubmit="updateProject(event)">
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Project Name *</label>
                    <input type="text" name="name" value="${escapeHtml(currentProject.name)}" required style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Description</label>
                    <textarea name="description" rows="3" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">${escapeHtml(currentProject.description || '')}</textarea>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: var(--text);">Status</label>
                        <select name="status" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                            <option value="idea" ${currentProject.status === 'idea' ? 'selected' : ''}>💡 Idea</option>
                            <option value="planning" ${currentProject.status === 'planning' ? 'selected' : ''}>📋 Planning</option>
                            <option value="building" ${currentProject.status === 'building' ? 'selected' : ''}>🔨 Building</option>
                            <option value="launched" ${currentProject.status === 'launched' ? 'selected' : ''}>🚀 Launched</option>
                            <option value="paused" ${currentProject.status === 'paused' ? 'selected' : ''}>⏸️ Paused</option>
                            <option value="infrastructure" ${currentProject.status === 'infrastructure' ? 'selected' : ''}>🏗️ Infrastructure</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: var(--text);">Category</label>
                        <select name="category" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                            <option value="app" ${currentProject.category === 'app' ? 'selected' : ''}>📱 App</option>
                            <option value="saas" ${currentProject.category === 'saas' ? 'selected' : ''}>☁️ SaaS</option>
                            <option value="utility" ${currentProject.category === 'utility' ? 'selected' : ''}>🔧 Utility</option>
                            <option value="tool" ${currentProject.category === 'tool' ? 'selected' : ''}>🛠️ Tool</option>
                        </select>
                    </div>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Repository URL</label>
                    <input type="url" name="repo_url" value="${escapeHtml(currentProject.repo_url || '')}" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Live URL</label>
                    <input type="url" name="live_url" value="${escapeHtml(currentProject.live_url || '')}" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Local Path</label>
                    <input type="text" name="local_path" value="${escapeHtml(currentProject.local_path || '')}" placeholder="e.g., C:\\home\\bfoster\\my-project" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace;">
                    <div style="color: var(--text-subtle); font-size: 0.8rem; margin-top: 4px;">Where the local clone lives. Leave blank if not cloned yet.</div>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Stack</label>
                    <input type="text" name="stack" value="${escapeHtml(currentProject.stack || '')}" placeholder="e.g., Next.js 15 + TypeScript + Tailwind + SQLite" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">Prompt / Vision</label>
                    <textarea name="prompt" rows="4" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">${escapeHtml(currentProject.prompt || '')}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">PRD</label>
                    <textarea name="prd" rows="6" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace; font-size: 0.9rem;">${escapeHtml(currentProject.prd || '')}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">References (one per line)</label>
                    <textarea name="references" rows="3" placeholder="https://docs... or file paths" style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace; font-size: 0.9rem;">${(() => {
                        try { const r = currentProject.references_json ? JSON.parse(currentProject.references_json) : []; return escapeHtml(r.join('\n')); }
                        catch { return ''; }
                    })()}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text);">README (optional)</label>
                    <textarea name="readme" rows="8" placeholder="Paste or edit README content here..." style="width: 100%; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace; font-size: 0.9rem;">${escapeHtml(currentProject.readme || '')}</textarea>
                </div>
                <div style="display: flex; gap: 12px; margin-top: 24px;">
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                    <button type="button" class="btn btn-secondary" onclick="cancelEdit()">Cancel</button>
                </div>
            </form>
        </div>
    `;
    
    const _pd = document.querySelector('.project-detail');
    _editBackupHTML = _pd.innerHTML;
    while (_pd.firstChild) _pd.removeChild(_pd.firstChild);
    _pd.insertAdjacentHTML('afterbegin', form);
}

async function updateProject(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    const refsRaw = (formData.get('references') || '').toString();
    const references = refsRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const data = {
        name: formData.get('name'),
        description: formData.get('description'),
        status: formData.get('status'),
        category: formData.get('category'),
        repo_url: formData.get('repo_url') || null,
        live_url: formData.get('live_url') || null,
        local_path: formData.get('local_path') || null,
        readme: formData.get('readme') || null,
        stack: formData.get('stack') || null,
        prompt: formData.get('prompt') || null,
        prd: formData.get('prd') || null,
        references_json: references.length ? JSON.stringify(references) : null
    };
    
    try {
        const response = await fetch(`/api/projects/${currentProject.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) throw new Error('Failed to update project');
        
        showToast('✅ Project updated');
        _restoreDetailFromBackup();
        loadProjects();
        showProject(currentProject.id);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// Poll the running-server endpoint while the detail view is open, updating
// the URL chip + Launch/Stop button state. Cleared when leaving the view.
let _runningPollTimer = null;
let _lastDetectedUrl = null;

async function refreshRunningState() {
    if (!currentProject) return;
    try {
        const r = await fetch(`/api/projects/${currentProject.id}/running`);
        const data = await r.json();
        const launchBtn = document.getElementById('launchBtn');
        const stopBtn = document.getElementById('stopBtn');
        const urlChip = document.getElementById('detectedUrl');
        const browserBtn = document.getElementById('openInBrowserBtn');
        const urlRow = document.getElementById('runningUrlRow');
        const urlLink = document.getElementById('runningUrlLink');
        const urlPid = document.getElementById('runningUrlPid');

        if (data.running) {
            if (launchBtn) launchBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (data.url) {
                // Action-row pill (primary surface — impossible to miss)
                if (browserBtn) {
                    browserBtn.style.display = 'inline-block';
                    browserBtn.dataset.url = data.url;
                    browserBtn.title = `Open ${data.url}`;
                }
                // Info-panel row (secondary surface — for reference / re-open)
                if (urlRow) urlRow.style.display = '';
                if (urlLink) {
                    urlLink.href = data.url;
                    urlLink.textContent = data.url;
                }
                if (urlPid) urlPid.textContent = `pid ${data.pid}`;
                // Tiny chip — kept for backward compatibility, less prominent
                if (urlChip) {
                    // safeUrl() blocks non-http(s) schemes (javascript:/data:) and
                    // HTML-escapes for the href attribute; escapeHtml() for the text.
                    // Consistent with urlLink above and the rest of app.js. (Gate 3 F7)
                    urlChip.innerHTML = `🟢 <a href="${safeUrl(data.url)}" target="_blank" style="color: var(--accent-soft);">${escapeHtml(data.url)}</a>`;
                    urlChip.style.display = 'inline';
                }
                // Auto-open browser the first time we learn the URL for this session
                if (_lastDetectedUrl !== data.url) {
                    _lastDetectedUrl = data.url;
                    window.open(data.url, '_blank');
                }
            } else {
                if (browserBtn) browserBtn.style.display = 'none';
                if (urlRow) urlRow.style.display = 'none';
                if (urlChip) {
                    urlChip.textContent = `⏳ Running (pid ${data.pid}) — waiting for URL…`;
                    urlChip.style.display = 'inline';
                }
            }
        } else {
            // Not running — restore the default button visibility via showProject's rules
            const canLaunch = currentProject && (currentProject.local_path || currentProject.live_url);
            if (launchBtn) launchBtn.style.display = canLaunch ? 'inline-block' : 'none';
            if (stopBtn) stopBtn.style.display = 'none';
            if (browserBtn) browserBtn.style.display = 'none';
            if (urlRow) urlRow.style.display = 'none';
            if (urlChip) urlChip.style.display = 'none';
            _lastDetectedUrl = null;
        }
    } catch (e) { /* non-fatal */ }
}

// Click handler for the 🌐 Open in Browser pill — opens the running URL.
// dataset.url is set by refreshRunningState whenever a URL is detected.
function openInBrowser() {
    const btn = document.getElementById('openInBrowserBtn');
    const url = btn?.dataset?.url;
    if (url) window.open(url, '_blank');
}

function startRunningPoll() {
    stopRunningPoll();
    refreshRunningState();
    _runningPollTimer = setInterval(refreshRunningState, 2000);
}

function stopRunningPoll() {
    if (_runningPollTimer) {
        clearInterval(_runningPollTimer);
        _runningPollTimer = null;
    }
}

async function stopDevServer() {
    if (!currentProject) return;
    // Name the server being stopped — the browser titles the dialog with
    // Launchpad's own address (localhost:3020), which reads like the target.
    let port = '';
    try { port = _lastDetectedUrl ? new URL(_lastDetectedUrl).port : ''; } catch (e) { /* no URL yet */ }
    const where = port ? ` on port ${port}` : '';
    if (!confirm(`Stop the ${currentProject.name} dev server${where}?`)) return;
    try {
        const r = await fetch(`/api/projects/${currentProject.id}/stop`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Stop failed');
        showToast(`Stopped pid ${data.pid}`);
        await refreshRunningState();
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function runInstallDeps() {
    if (!currentProject) return;
    const btn = document.getElementById('launchBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Installing deps…';
    try {
        const res = await fetch(`/api/projects/${currentProject.id}/install-deps`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(`npm install failed:\n\n${data.output || data.error || ''}`);
            return;
        }
        showToast('✅ Dependencies installed');
        // Try launching now that deps are present
        await launchProject();
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function launchProject() {
    if (!currentProject) return;

    const btn = document.getElementById('launchBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Launching…';

    try {
        const res = await fetch(`/api/projects/${currentProject.id}/launch`, { method: 'POST' });
        const data = await res.json();

        // Specific handling for "deps not installed" so the user can install inline
        if (res.status === 409 && data.type === 'install_needed') {
            const go = confirm(`Dependencies not installed.\n\nRun npm install in:\n${data.cwd}\n\nThis may take a minute.`);
            if (go) await runInstallDeps();
            return;
        }

        // Server now waits ~2.5s after spawn and returns 500 + output if the
        // child died early (port conflict, missing script, etc). Show that
        // output verbatim so the user can diagnose without digging through logs.
        if (data.type === 'failed') {
            alert(`❌ ${data.error}\n\nDev server output:\n\n${data.output || '(no output captured)'}\n\nIn: ${data.cwd}`);
            return;
        }
        if (!res.ok) throw new Error(data.error || 'Launch failed');

        if (data.type === 'url') {
            window.open(data.url, '_blank');
            showToast(`Opened ${data.url}`);
        } else if (data.type === 'spawned') {
            // The launch endpoint may have detected the URL during its 2.5s
            // wait — if so, open it immediately instead of relying on polling.
            if (data.url) {
                showToast(`✅ Running at ${data.url}`);
                window.open(data.url, '_blank');
                _lastDetectedUrl = data.url;
            } else {
                showToast(`${data.command} started (pid ${data.pid}) — waiting for URL…`);
                if (data.live_url) window.open(data.live_url, '_blank');
            }
            // Kick off poll so the URL chip + Stop button appear immediately,
            // and auto-opens the browser once the dev server prints its URL.
            startRunningPoll();
        } else {
            alert(JSON.stringify(data, null, 2));
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// Legacy shim — inline 'Commit Push' buttons on the sync-status card call this.
// Forwards to the proper modal with sensible preselection.
function showCommitDialog(needsCommit) {
    openCommitModal({ addAll: !!needsCommit, push: true });
}

// Open the commit modal for an arbitrary project (not the one currently in
// detail view). Used by the inline 💾 Commit button on DIRTY rows in the Browse
// GitHub modal. Loads the full project record into `currentProject` so the
// existing commit flow (preview / submit / sync refresh) works unchanged.
async function quickCommitProject(projectId) {
    try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) throw new Error('Failed to load project');
        currentProject = await res.json();
        openCommitModal({ addAll: true, push: true });
    } catch (e) {
        alert(`Couldn't open commit dialog: ${e.message}`);
    }
}

function openCommitModal(opts) {
    if (!currentProject) return;
    const options = opts || {};
    document.getElementById('commitModal').style.display = 'block';
    const ctxEl = document.getElementById('commitContext');
    ctxEl.textContent = `${currentProject.name} — ${currentProject.local_path || 'no local clone'}`;
    document.getElementById('commitMessage').value = '';
    document.getElementById('commitAddAll').checked = options.addAll !== false;
    document.getElementById('commitPush').checked = options.push !== false;
    document.getElementById('commitResult').style.display = 'none';
    document.getElementById('commitResult').textContent = '';
    document.getElementById('commitSubmitBtn').disabled = false;
    document.getElementById('commitSubmitBtn').textContent = 'Commit';
    // Reset + load the diff preview. While it's in flight the submit button is
    // disabled — we don't want users firing off a commit before they see what's
    // about to be staged.
    document.getElementById('commitOverrideWrap').style.display = 'none';
    document.getElementById('commitOverride').checked = false;
    loadCommitPreview();
    setTimeout(() => document.getElementById('commitMessage').focus(), 50);
}

// Cached preview state so submitCommit can re-check before sending.
let _commitPreviewState = null;

async function loadCommitPreview() {
    const el = document.getElementById('commitPreview');
    const submitBtn = document.getElementById('commitSubmitBtn');
    el.innerHTML = '<div style="color: var(--text-muted);">Scanning staged changes…</div>';
    submitBtn.disabled = true;
    _commitPreviewState = null;

    try {
        const res = await fetch(`/api/projects/${currentProject.id}/staged-preview`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preview failed');
        _commitPreviewState = data;

        if (data.count === 0) {
            el.innerHTML = '<div style="color: var(--text-muted);">Nothing staged — working tree is clean.</div>';
            submitBtn.disabled = false;
            return;
        }

        const warnEls = data.warnings.length ? `
            <div style="margin-bottom: 10px; padding: 10px; background: var(--danger-bg); border: 1px solid #ef4444; border-radius: 6px; color: #fca5a5;">
                <div style="font-weight: 700; margin-bottom: 6px;">⚠️ ${data.warnings.length} warning${data.warnings.length > 1 ? 's' : ''}</div>
                ${data.warnings.map(w => `<div style="font-family: monospace; font-size: 0.8rem;">• ${escapeHtml(w.message)}</div>`).join('')}
            </div>
        ` : '';

        const fileRows = data.files.map(f => {
            const sizeKb = f.size > 0 ? `${(f.size / 1024).toFixed(1)} KB` : '—';
            const chips = [
                f.isSecret ? '<span style="background: #ef4444; color: #fff; padding: 1px 6px; border-radius: 4px; font-size: 0.7rem; margin-left: 6px;">SECRET?</span>' : '',
                f.isBig ? '<span style="background: #f59e0b; color: #000; padding: 1px 6px; border-radius: 4px; font-size: 0.7rem; margin-left: 6px;">LARGE</span>' : ''
            ].join('');
            const statusColor = ({
                added: '#22c55e', modified: '#f59e0b', deleted: '#ef4444',
                renamed: 'var(--accent)', copied: 'var(--accent)', conflicted: '#ef4444', changed: 'var(--text-muted)'
            })[f.status] || 'var(--text-muted)';
            return `
                <div style="display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
                    <span style="color: ${statusColor}; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; min-width: 70px;">${f.status}</span>
                    <span style="font-family: monospace; flex: 1; color: var(--text); word-break: break-all;">${escapeHtml(f.path)}</span>
                    <span style="color: var(--text-subtle); font-size: 0.75rem;">${sizeKb}</span>
                    ${chips}
                </div>
            `;
        }).join('');

        el.innerHTML = `
            ${warnEls}
            <div style="color: var(--text-muted); margin-bottom: 8px;">${data.count} file${data.count > 1 ? 's' : ''} will be staged (${(data.totalSize / 1024).toFixed(1)} KB total)</div>
            ${fileRows}
        `;

        // Suggest a commit message if the textarea is still empty. The user
        // can edit or replace it freely — this is a starting point, not a fait
        // accompli. Built from the file list so the message reflects the diff.
        const msgEl = document.getElementById('commitMessage');
        if (msgEl && !msgEl.value.trim()) {
            const suggested = suggestCommitMessage(data.files);
            if (suggested) {
                msgEl.value = suggested;
                msgEl.select(); // pre-select so the user can overwrite in one keystroke
            }
        }

        // Gate the submit button: warnings require explicit override.
        const overrideWrap = document.getElementById('commitOverrideWrap');
        const override = document.getElementById('commitOverride');
        if (data.hasBlockers) {
            overrideWrap.style.display = 'block';
            submitBtn.disabled = true;
            override.onchange = () => {
                submitBtn.disabled = !override.checked;
            };
        } else {
            overrideWrap.style.display = 'none';
            submitBtn.disabled = false;
        }
    } catch (e) {
        el.innerHTML = `<div style="color: #ef4444;">Preview failed: ${escapeHtml(e.message)}</div>`;
        submitBtn.disabled = false; // Allow commit anyway — preview is advisory
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// Sanitize a user-supplied URL before putting it in an href. Only http(s) is
// allowed — a `javascript:`/`data:` scheme would be click-to-XSS. Returns '#'
// for anything else; the allowed URL is still HTML-escaped for the attribute.
function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

// Build a starter commit message from the changed-files list. The user is
// expected to edit this — the goal is to save typing, not to be authoritative.
// Conventional-commit-ish prefixes are applied when the change matches a
// known pattern (deps, docs, tests, config). Falls back to a verb + file list.
function suggestCommitMessage(files) {
    if (!Array.isArray(files) || files.length === 0) return '';

    // Tally status counts to pick a dominant verb.
    const statusCounts = {};
    files.forEach(f => { statusCounts[f.status] = (statusCounts[f.status] || 0) + 1; });
    const dominantStatus = Object.entries(statusCounts).sort((a, b) => b[1] - a[1])[0][0];
    const verb = ({ added: 'Add', modified: 'Update', deleted: 'Remove', renamed: 'Rename' })[dominantStatus] || 'Update';

    const paths = files.map(f => f.path);
    const basenames = paths.map(p => p.split('/').pop());
    const isDep = p => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements.*\.txt|Pipfile(\.lock)?|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i.test(p);
    const isDoc = p => /\.(md|mdx|txt|rst)$/i.test(p) || /^docs?\//i.test(p);
    const isTest = p => /(^|\/)(__tests__|tests?|spec)\//i.test(p) || /\.(test|spec)\.(js|ts|jsx|tsx|py)$/i.test(p);
    const isConfig = p => /\.(ya?ml|toml|ini|cfg|conf)$/i.test(p) || /^\.[\w-]+(rc|ignore|env)$/i.test(p.split('/').pop());

    // Single-category shortcuts.
    if (paths.every(isDep))    return `chore: update dependencies`;
    if (paths.every(isDoc))    return paths.length === 1 ? `docs: update ${basenames[0]}` : `docs: update ${paths.length} files`;
    if (paths.every(isTest))   return paths.length === 1 ? `test: update ${basenames[0]}` : `test: update ${paths.length} files`;
    if (paths.every(isConfig)) return paths.length === 1 ? `chore: update ${basenames[0]}` : `chore: update config (${paths.length} files)`;

    // Single file → "Verb path/to/file" (keep relative path for context).
    if (paths.length === 1) return `${verb} ${paths[0]}`;

    // All in the same directory → "Verb N files in <dir>"
    const dirs = new Set(paths.map(p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''));
    if (dirs.size === 1) {
        const dir = [...dirs][0];
        return dir ? `${verb} ${paths.length} files in ${dir}` : `${verb} ${paths.length} files`;
    }

    // Mixed — verb + top 3 basenames.
    const sample = basenames.slice(0, 3).join(', ');
    const tail = paths.length > 3 ? ` (+${paths.length - 3} more)` : '';
    return `${verb} ${sample}${tail}`;
}

function closeCommitModal() {
    document.getElementById('commitModal').style.display = 'none';
}

async function submitCommit() {
    if (!currentProject) return;
    const message = document.getElementById('commitMessage').value.trim();
    const addAll = document.getElementById('commitAddAll').checked;
    const push = document.getElementById('commitPush').checked;

    if (addAll && !message) {
        alert('Commit message is required when staging new changes.');
        return;
    }
    if (!addAll && !push) {
        alert('Nothing to do — enable either "stage changes" or "push".');
        return;
    }
    // Hard gate: if the preview flagged warnings (secrets / big files), the
    // override checkbox must be explicitly checked. Belt-and-suspenders — the
    // submit button is also disabled in that case, but a careful user could
    // still manage to call this directly.
    if (addAll && _commitPreviewState && _commitPreviewState.hasBlockers) {
        const ov = document.getElementById('commitOverride');
        if (!ov || !ov.checked) {
            alert('This commit has warnings (secrets or large files). Tick the override box to confirm.');
            return;
        }
    }

    const submitBtn = document.getElementById('commitSubmitBtn');
    const resultEl = document.getElementById('commitResult');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Working…';
    resultEl.style.display = 'block';
    resultEl.textContent = 'Working…';

    try {
        const res = await fetch(`/api/projects/${currentProject.id}/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, push, addAll })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Commit failed');

        const parts = [];
        let anyFailure = false;
        if (data.results.commit) {
            if (data.results.commit.ok) parts.push('✅ Committed');
            else if (data.results.commit.skipped) parts.push('⏭ Nothing to commit');
            else { parts.push(`❌ Commit failed:\n${data.results.commit.error}`); anyFailure = true; }
        }
        if (data.results.push) {
            if (data.results.push.ok) parts.push('✅ Pushed to origin\n' + (data.results.push.output || ''));
            else { parts.push(`❌ Push failed:\n${data.results.push.error}`); anyFailure = true; }
        }
        resultEl.textContent = parts.join('\n\n') || 'Done.';
        // Red border + scroll into view on failure so the message can't be missed.
        resultEl.style.borderLeft = anyFailure ? '4px solid #ef4444' : '4px solid #10b981';
        resultEl.style.padding = '10px 12px';
        resultEl.style.background = 'var(--surface-inset)';
        resultEl.style.whiteSpace = 'pre-wrap';
        resultEl.scrollIntoView({ block: 'nearest' });

        // Only auto-close when every requested step succeeded (commit-skipped counts
        // as success). Any failure → leave modal open so the user can see the error.
        const allSucceeded = !anyFailure;
        if (allSucceeded) {
            setTimeout(() => {
                closeCommitModal();
                if (document.getElementById('syncStatus') && document.getElementById('syncStatus').style.display !== 'none') {
                    checkSyncStatus();
                }
                // Refresh local-clone detect so the import modal's tags update.
                if (typeof refreshLocalCloneStatus === 'function') refreshLocalCloneStatus();
            }, 1500);
        }
    } catch (e) {
        resultEl.textContent = `❌ ${e.message}`;
        resultEl.style.borderLeft = '4px solid #ef4444';
        resultEl.style.padding = '10px 12px';
        resultEl.style.background = 'var(--surface-inset)';
        resultEl.style.whiteSpace = 'pre-wrap';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Commit';
    }
}

async function pullProject() {
    if (!currentProject) return;
    if (!confirm('Pull latest from origin (fast-forward only)?')) return;
    try {
        const res = await fetch(`/api/projects/${currentProject.id}/pull`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(`Pull failed: ${data.error || 'unknown'}\n\n${data.details || ''}`);
            return;
        }
        alert(`✅ Pulled:\n\n${data.output || 'up to date'}`);
        await checkSyncStatus();
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function cloneProject() {
    if (!currentProject) return;
    
    if (!confirm(`Clone ${currentProject.name} to local storage?`)) return;
    
    try {
        const btn = document.getElementById('cloneBtn');
        btn.disabled = true;
        btn.textContent = 'Cloning...';
        
        const response = await fetch(`/api/projects/${currentProject.id}/clone`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            const where = data.candidates ? `\n${data.candidates.join('\n')}` : '';
            throw new Error((data.error || 'Failed to clone') + where);
        }

        showToast(data.linked ? `🔗 Linked existing clone at ${data.local_path}` : `✅ Cloned to ${data.local_path}`);
        showProject(currentProject.id); // Reload
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        document.getElementById('cloneBtn').disabled = false;
        document.getElementById('cloneBtn').textContent = 'Clone to Local';
    }
}

async function checkSyncStatus() {
    if (!currentProject) return;
    
    try {
        const btn = document.getElementById('syncBtn');
        const syncStatus = document.getElementById('syncStatus');
        
        btn.disabled = true;
        btn.textContent = 'Checking...';
        syncStatus.style.display = 'none';
        
        const response = await fetch(`/api/projects/${currentProject.id}/sync-status`);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to check sync');
        }
        
        // Display sync status
        let statusColor = '#10b981'; // green
        let statusIcon = '✓';
        
        if (data.status === 'behind') {
            statusColor = '#f59e0b'; // orange
            statusIcon = '⚠️';
        } else if (data.status === 'dirty' || data.status === 'unpushed') {
            statusColor = '#ef4444'; // red
            statusIcon = '⚠️';
        } else if (data.status === 'error' || data.status === 'not_cloned' || data.status === 'no_repo') {
            statusColor = '#6b7280'; // gray
            statusIcon = 'ℹ️';
        }
        
        let statusHTML = `
            <div style="padding: 16px; background: var(--surface-inset); border-left: 4px solid ${statusColor}; border-radius: 8px;">
                <div style="font-weight: 600; color: ${statusColor}; margin-bottom: 8px;">
                    ${statusIcon} ${data.status.toUpperCase().replace('_', ' ')}
                </div>
        `;
        
        if (data.messages) {
            statusHTML += `<ul style="margin: 8px 0; padding-left: 20px; color: var(--text);">`;
            data.messages.forEach(msg => {
                statusHTML += `<li>${msg}</li>`;
            });
            statusHTML += `</ul>`;
        }
        
        if (data.details && data.details.lastCommit) {
            // T1.4 — branch warning. If the remote tells us a default branch
            // and we're not on it, render the branch in yellow with a note.
            // onDefaultBranch === null means we couldn't determine the default,
            // so no warning is shown (better than a false alarm).
            const branchOffDefault = data.details.onDefaultBranch === false;
            const branchHTML = branchOffDefault
                ? `<div style="color: #fbbf24;"><strong>Branch:</strong> ${escapeHtml(data.details.branch)} ⚠️ <em>not the default branch (${escapeHtml(data.details.defaultBranch)})</em></div>`
                : `<div><strong>Branch:</strong> ${escapeHtml(data.details.branch)}${data.details.defaultBranch ? ` <span style="color: var(--text-subtle);">(default)</span>` : ''}</div>`;
            statusHTML += `
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 0.9rem; color: var(--text-muted);">
                    ${branchHTML}
                    <div><strong>Last commit:</strong> ${escapeHtml(data.details.lastCommit.hash)} - ${escapeHtml(data.details.lastCommit.message)}</div>
                    <div><strong>When:</strong> ${escapeHtml(data.details.lastCommit.timeAgo)}</div>
                </div>
            `;
        }

        // T1.5 — Pull preview. When behind, list the incoming commits ABOVE
        // the Pull button so the user sees what will land before they click.
        if (data.status === 'behind' && data.details && data.details.incomingCommits && data.details.incomingCommits.length) {
            const rows = data.details.incomingCommits.map(c => `
                <div style="font-family: monospace; font-size: 0.8rem; padding: 3px 0; border-bottom: 1px dashed var(--border);">
                    <span style="color: var(--accent);">${escapeHtml(c.hash)}</span>
                    <span style="color: var(--text-muted);"> · ${escapeHtml(c.author || 'unknown')}</span>
                    <span style="color: var(--text);"> — ${escapeHtml(c.message || '')}</span>
                </div>
            `).join('');
            statusHTML += `
                <div style="margin-top: 12px; padding: 10px; background: var(--surface-inset); border: 1px solid var(--border); border-radius: 6px;">
                    <div style="color: #fbbf24; font-weight: 600; margin-bottom: 6px;">⬇ ${data.details.incomingCommits.length} incoming commit${data.details.incomingCommits.length > 1 ? 's' : ''}:</div>
                    ${rows}
                </div>
            `;
        }

        // Action buttons appropriate to the sync state. Commit button is
        // stamped with the current branch so the user knows where the push
        // will land (T1.4 reinforcement).
        const actions = [];
        const branchLabel = data.details && data.details.branch ? ` to ${data.details.branch}` : '';
        if (data.status === 'dirty' || data.status === 'unpushed') {
            const needsCommit = data.status === 'dirty';
            actions.push(`<button class="btn btn-primary" onclick="showCommitDialog(${needsCommit ? 'true' : 'false'})">💾 Commit ${needsCommit ? '& ' : ''}Push${branchLabel}</button>`);
        }
        if (data.status === 'behind') {
            actions.push(`<button class="btn btn-primary" onclick="pullProject()">⬇️ Pull (ff-only)${branchLabel}</button>`);
        }
        if (actions.length) {
            statusHTML += `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">${actions.join('')}</div>`;
        }

        statusHTML += `</div>`;
        
        syncStatus.innerHTML = statusHTML;
        syncStatus.style.display = 'block';
        
        btn.disabled = false;
        btn.textContent = '🔄 Check Sync Status';
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        document.getElementById('syncBtn').disabled = false;
        document.getElementById('syncBtn').textContent = '🔄 Check Sync Status';
    }
}

// ========== BULK IMPORT ==========

// Cache of user's repos (fetched once per modal-open via loadBrowseRepos).
// Shared between Browse and Bulk tabs so Bulk doesn't re-hit the API.
let browseReposCache = null;
// Map of project_id → { status: 'cloned'|'dirty'|'not_cloned', path, dirty }
// Refreshed when the import modal opens — fast filesystem-only scan.
let localCloneStatus = {};
let importSearchDebounce = null;

async function showBulkImport() {
    document.getElementById('bulkImportModal').style.display = 'block';
    // Default to Browse GitHub — the user's own repos, one click to import.
    showImportTab('browse');

    // Prefill the bulk-tab PAT input from Settings so the user doesn't paste twice.
    try {
        const s = await (await fetch('/api/settings')).json();
        const input = document.getElementById('githubToken');
        if (s.github_pat && s.github_pat.set && !input.value) {
            input.value = '__USE_STORED__';
            input.placeholder = `Using stored token — edit to override`;
            input.dataset.usesStored = 'true';
        }
    } catch (e) { /* non-fatal */ }

    // Kick off the local-clone scan in parallel — fast, no network. It updates
    // `localCloneStatus` and re-renders the Browse list when done.
    refreshLocalCloneStatus();

    // Auto-load Browse tab. Will error out cleanly if no PAT — message shown inline.
    loadBrowseRepos(false);
}

// Refresh local clone detection (fast filesystem scan + cheap git status).
// Auto-backfills local_path for any clones found at the canonical path.
async function refreshLocalCloneStatus() {
    try {
        const res = await fetch('/api/local-clone-detect');
        const data = await res.json();
        if (!res.ok) return;
        localCloneStatus = data.results || {};
        // Re-render whatever import tab is open so tags reflect the new info.
        if (browseReposCache) renderBrowseFromCache();
        if (typeof renderGitHubReposList === 'function' && document.getElementById('repoList')?.style.display !== 'none') {
            renderGitHubReposList();
        }
        // The server may have backfilled local_path — refresh the projects array.
        await loadProjects();
        if (browseReposCache) renderBrowseFromCache();
        // Background clones from Import: re-check until they finish so the
        // CLONING tag flips to CLONED without reopening the modal.
        if (Object.values(localCloneStatus).some(r => r.status === 'cloning')) {
            clearTimeout(refreshLocalCloneStatus._timer);
            refreshLocalCloneStatus._timer = setTimeout(refreshLocalCloneStatus, 4000);
        }
    } catch (e) { /* non-fatal */ }
}

function hideBulkImport() {
    document.getElementById('bulkImportModal').style.display = 'none';
    document.getElementById('importUrl').value = '';
    document.getElementById('githubToken').value = '';
    document.getElementById('repoList').style.display = 'none';
    const searchInput = document.getElementById('importSearchQuery');
    if (searchInput) searchInput.value = '';
    const results = document.getElementById('importSearchResults');
    if (results) { results.style.display = 'none'; results.innerHTML = ''; }
    showImportTab('browse');
}

function showImportTab(tab) {
    // Tab buttons
    document.getElementById('importBrowseTab').classList.toggle('active', tab === 'browse');
    document.getElementById('importUrlTab').classList.toggle('active', tab === 'url');
    document.getElementById('importBulkTab').classList.toggle('active', tab === 'bulk');

    // Tab sections
    document.getElementById('importBrowseSection').style.display = tab === 'browse' ? 'block' : 'none';
    document.getElementById('importUrlSection').style.display = tab === 'url' ? 'block' : 'none';
    document.getElementById('importBulkSection').style.display = tab === 'bulk' ? 'block' : 'none';
}

// ---------- Browse GitHub tab ----------

async function loadBrowseRepos(forceRefresh = false) {
    const container = document.getElementById('browseRepoList');
    const userLabel = document.getElementById('browseUserLabel');

    if (browseReposCache && !forceRefresh) {
        renderBrowseRepos(browseReposCache.user, browseReposCache.repos);
        return;
    }

    container.innerHTML = '<div class="loading">Loading your repositories…</div>';
    userLabel.textContent = '';

    try {
        const res = await fetch('/api/github/repos');
        const data = await res.json();
        if (!res.ok) {
            const msg = data.error || 'Failed to load repositories';
            // No PAT yet — point the user at the Bulk tab where they can paste one.
            if (res.status === 401) {
                container.innerHTML = `
                    <div class="empty-state" style="padding: 24px; text-align: center;">
                        <div style="margin-bottom: 12px;">No GitHub token configured.</div>
                        <button class="btn btn-secondary" onclick="showImportTab('bulk')">Add token in Bulk Import tab</button>
                    </div>`;
                return;
            }
            throw new Error(msg);
        }
        browseReposCache = data;
        renderBrowseRepos(data.user, data.repos);
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color: #ef4444;">Error: ${err.message}</div>`;
    }
}

// Build the chip list for one row. May return 1+ chips. Rules:
//   - not in DB                       → [NEW]
//   - DIRTY / AHEAD / BEHIND each stand alone or stack (all true facts)
//   - SYNCED only shown when all three are confirmed false (full sync ran, clean)
//   - CLONED is a fallback: cloned locally but no sync info, not dirty
//   - NOT CLONED is the floor: in DB, no local clone detected anywhere
//
// `project` is the DB row (or null). `detect` is the local filesystem detect
// for this project, or null if the scan hasn't run yet.
const TAG_STYLES = {
    NEW:        { bg: '#22c55e', fg: '#052e16' },
    DIRTY:      { bg: '#ef4444', fg: '#3a0a0a' },
    AHEAD:      { bg: '#f59e0b', fg: '#3a2200' },
    BEHIND:     { bg: '#3b82f6', fg: '#0a1f3a' },
    SYNCED:     { bg: '#10b981', fg: '#053024' },
    CLONED:     { bg: '#14b8a6', fg: '#042f2e' },
    'NOT CLONED': { bg: '#6b7280', fg: '#0f0f0f' },
    CLONING:    { bg: '#8b5cf6', fg: '#1e0a3a' },
    AMBIGUOUS:  { bg: '#f59e0b', fg: '#3a2200' },
    ERROR:      { bg: '#ef4444', fg: '#3a0a0a' }
};

// One-line summary of what Import did about a local copy (server `local` field).
function describeLocalOutcome(local) {
    if (!local) return 'not cloned';
    if (local.status === 'linked') return `linked existing clone at ${local.path}`;
    if (local.status === 'cloning') return `cloning to ${local.path}`;
    if (local.status === 'ambiguous') return `${local.candidates.length} local copies found — set Local Path`;
    return `not cloned (${local.reason || 'see Build Log'})`;
}
function chip(label) {
    const s = TAG_STYLES[label] || TAG_STYLES['NOT CLONED'];
    return { label, bg: s.bg, fg: s.fg };
}

function getBrowseTags(project, detect) {
    if (!project) return [chip('NEW')];

    const dirty = !!(detect && detect.dirty);
    const cloned = !!(detect && (detect.status === 'cloned' || detect.status === 'dirty'));
    const s = project.sync_status;

    const chips = [];
    if (dirty || s === 'dirty') chips.push(chip('DIRTY'));
    if (s === 'behind') chips.push(chip('BEHIND'));
    if (s === 'unpushed' || s === 'ahead') chips.push(chip('AHEAD'));

    if (chips.length > 0) return chips; // DIRTY/AHEAD/BEHIND all imply cloned — no need to add CLONED.
    if (s === 'synced') return [chip('SYNCED')];
    if (cloned) return [chip('CLONED')];
    if (detect && detect.status === 'cloning') return [chip('CLONING')];
    if (detect && detect.status === 'ambiguous') return [chip('AMBIGUOUS')];
    if (s === 'error') return [chip('ERROR')];
    return [chip('NOT CLONED')];
}

// Re-render Browse list from cache (used by filter inputs — no API call).
function renderBrowseFromCache() {
    if (!browseReposCache) return;
    renderBrowseRepos(browseReposCache.user, browseReposCache.repos);
}

function renderBrowseRepos(user, repos) {
    const container = document.getElementById('browseRepoList');
    const userLabel = document.getElementById('browseUserLabel');

    // Build URL → project map (case-insensitive, .git suffix stripped) so we can attach sync_status.
    const projectByUrl = new Map();
    const normalizeUrl = u => (u || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    (projects || []).forEach(p => {
        if (p.repo_url) projectByUrl.set(normalizeUrl(p.repo_url), p);
    });

    // Read filters (elements may not exist yet on first render — fall back to defaults).
    const searchTerm = (document.getElementById('browseSearch')?.value || '').trim().toLowerCase();
    const statusFilter = document.getElementById('browseStatusFilter')?.value || 'all';

    const enriched = repos.map(repo => {
        const proj = projectByUrl.get(normalizeUrl(repo.html_url));
        return { repo, project: proj || null, isImported: !!proj };
    });

    // Counts for the header reflect the unfiltered totals.
    const totalCount = enriched.length;
    const newCount = enriched.filter(e => !e.isImported).length;

    // Apply filters. `statusFilter` matches against the rendered chip labels
    // so what the user picks lines up with what they see.
    const filtered = enriched.filter(({ repo, project, isImported }) => {
        if (searchTerm) {
            const hay = `${repo.name} ${repo.description || ''}`.toLowerCase();
            if (!hay.includes(searchTerm)) return false;
        }
        if (statusFilter === 'all') return true;
        if (statusFilter === 'new') return !isImported;
        if (statusFilter === 'imported') return isImported;
        if (!isImported) return false;
        const detect = localCloneStatus[project.id];
        const labels = getBrowseTags(project, detect).map(c => c.label.toLowerCase().replace(' ', '_'));
        return labels.includes(statusFilter);
    });

    // Within the filtered list, still surface NEW first.
    const newOnes = filtered.filter(e => !e.isImported);
    const existing = filtered.filter(e => e.isImported);
    const ordered = [...newOnes, ...existing];

    userLabel.innerHTML = user
        ? `@${escapeHtml(user)} · ${totalCount} repos${newCount > 0 ? ` · <span style="color: #22c55e; font-weight: 600;">${newCount} new</span>` : ''}${filtered.length !== totalCount ? ` · <span style="color: var(--text-muted);">${filtered.length} shown</span>` : ''}`
        : '';

    if (!repos.length) {
        container.innerHTML = '<div class="empty-state">No repositories found on this account.</div>';
        return;
    }
    if (!filtered.length) {
        container.innerHTML = '<div class="empty-state">No repositories match the current filters.</div>';
        return;
    }

    const separatorIdx = newOnes.length > 0 && existing.length > 0 ? newOnes.length : -1;

    container.innerHTML = ordered.map(({ repo, project, isImported }, idx) => {
        const detect = project ? localCloneStatus[project.id] : null;
        const tags = getBrowseTags(project, detect);

        const lastCommit = repo.daysSinceCommit !== null && repo.daysSinceCommit !== undefined
            ? `${repo.daysSinceCommit}d ago` : '';
        const cursor = isImported ? 'default' : 'pointer';
        const bg = isImported ? 'var(--surface-inset)' : '#152418';
        const borderColor = isImported ? 'var(--border)' : '#22c55e';
        // Inline Commit button on DIRTY rows — opens the existing commit modal
        // for this project without navigating away from the import modal.
        const isDirty = tags.some(t => t.label === 'DIRTY');
        const commitBtn = isDirty
            ? `<button class="btn btn-sm" style="background: #ef4444; color: #fff;" onclick="event.stopPropagation(); quickCommitProject(${project.id})" title="Commit + push uncommitted changes">💾 Commit</button>`
            : '';
        const openBtn = isImported
            ? `<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showProject(${project.id})">Open</button>`
            : `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); importGitHubRepo(${attrStr(repo.html_url)})">📥 Import</button>`;
        const action = `<div style="display: flex; gap: 6px;">${commitBtn}${openBtn}</div>`;
        const onclickAttr = isImported
            ? ` onclick="showProject(${project.id})"`
            : ` onclick="importGitHubRepo(${attrStr(repo.html_url)})"`;

        const tagBadges = tags.map(t =>
            `<span style="background: ${t.bg}; color: ${t.fg}; font-weight: 700; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; margin-right: 6px; letter-spacing: 0.5px;">${t.label}</span>`
        ).join('');

        const separator = idx === separatorIdx
            ? '<div style="margin: 16px 0 10px; padding: 6px 0; color: var(--text-subtle); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid var(--border);">Already imported</div>'
            : '';

        return `${separator}
            <div style="padding: 12px 14px; background: ${bg}; border: 1px solid ${borderColor}; border-radius: 8px; margin-bottom: 10px; cursor: ${cursor}; display: flex; justify-content: space-between; align-items: center; gap: 12px;"${onclickAttr}>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; color: ${isImported ? 'var(--text-muted)' : 'var(--text)'}; margin-bottom: 4px; display: flex; align-items: center; flex-wrap: wrap; gap: 2px;">
                        ${tagBadges}<span>${escapeHtml(repo.name)}${repo.private ? ' 🔒' : ''}</span>
                    </div>
                    <div style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(repo.description || 'No description')}</div>
                    <div style="display: flex; gap: 14px; font-size: 0.8rem; color: var(--text-subtle);">
                        ${repo.language ? `<span>🔧 ${escapeHtml(repo.language)}</span>` : ''}
                        <span>⭐ ${repo.stargazers_count || 0}</span>
                        ${lastCommit ? `<span>📅 ${lastCommit}</span>` : ''}
                    </div>
                </div>
                <div style="flex-shrink: 0;">${action}</div>
            </div>`;
    }).join('');
}

// ---------- Import by URL — keyword search ----------

function onImportSearchInput() {
    if (importSearchDebounce) clearTimeout(importSearchDebounce);
    const q = document.getElementById('importSearchQuery').value.trim();
    const results = document.getElementById('importSearchResults');
    if (q.length < 2) {
        results.style.display = 'none';
        results.innerHTML = '';
        return;
    }
    importSearchDebounce = setTimeout(runImportSearch, 350);
}

async function runImportSearch() {
    const q = document.getElementById('importSearchQuery').value.trim();
    const results = document.getElementById('importSearchResults');
    if (!q) return;

    results.style.display = 'block';
    results.innerHTML = '<div style="padding: 12px; color: var(--text-muted);">Searching…</div>';

    try {
        const res = await fetch(`/api/github/search?q=${encodeURIComponent(q)}&per_page=10`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        const items = data.items || [];
        if (!items.length) {
            results.innerHTML = '<div style="padding: 12px; color: var(--text-muted);">No matches.</div>';
            return;
        }
        results.innerHTML = items.map(repo => `
            <div onclick="selectImportSearchResult(${attrStr(repo.html_url)})"
                 style="padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer;"
                 onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''">
                <div style="font-weight: 600; color: var(--text);">${escapeHtml(repo.full_name)}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(repo.description || 'No description')}</div>
                <div style="color: var(--text-subtle); font-size: 0.78rem; margin-top: 4px;">
                    ⭐ ${repo.stargazers_count || 0}
                    ${repo.language ? ` · ${escapeHtml(repo.language)}` : ''}
                </div>
            </div>`).join('');
    } catch (err) {
        results.innerHTML = `<div style="padding: 12px; color: #ef4444;">${escapeHtml(err.message)}</div>`;
    }
}

function selectImportSearchResult(url) {
    document.getElementById('importUrl').value = url;
    const results = document.getElementById('importSearchResults');
    results.style.display = 'none';
    results.innerHTML = '';
}

async function importByUrl() {
    const url = document.getElementById('importUrl').value.trim();
    if (!url) {
        alert('Enter a GitHub URL');
        return;
    }
    await importGitHubRepo(url);
    // Clear the URL field so the user can import another without retyping.
    // Modal stays open — user clicks Done when finished.
    document.getElementById('importUrl').value = '';
}

async function loadGitHubRepos() {
    const input = document.getElementById('githubToken');
    const rawToken = input.value.trim();
    const usingStored = input.dataset.usesStored === 'true' && rawToken === '__USE_STORED__';

    if (!rawToken) {
        alert('Enter your GitHub token');
        return;
    }

    try {
        // If the user didn't override the stored token, the server already has it
        // loaded from Settings — skip the re-save round-trip.
        if (!usingStored) {
            const tokenResponse = await fetch('/api/github/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: rawToken })
            });
            if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json().catch(() => ({ error: 'Invalid token' }));
                throw new Error(errorData.error || 'Invalid token');
            }
        }
        
        // Load repos
        const reposResponse = await fetch('/api/github/repos');
        
        // Check content type before parsing
        const contentType = reposResponse.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Server returned invalid response. Try again.');
        }
        
        const data = await reposResponse.json();
        
        if (!reposResponse.ok) {
            throw new Error(data.error || 'Failed to load repos');
        }
        
        githubRepos = data.repos;
        renderGitHubReposList();
        
        document.getElementById('repoList').style.display = 'block';
        // renderGitHubReposList() updates the count itself, taking active filters into account.
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

function renderGitHubReposList() {
    const container = document.getElementById('repoListContent');

    if (githubRepos.length === 0) {
        container.innerHTML = '<div class="empty-state">No repositories found</div>';
        return;
    }

    // Normalize URLs so .git suffix / trailing-slash / case differences don't break matching.
    const normalizeUrl = u => (u || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    const importedUrls = new Set(projects.filter(p => p.repo_url).map(p => normalizeUrl(p.repo_url)));

    // Apply filters from the bulk-tab search input and import-status dropdown.
    const searchTerm = (document.getElementById('bulkSearch')?.value || '').trim().toLowerCase();
    const statusFilter = document.getElementById('bulkStatusFilter')?.value || 'all';

    const filteredRepos = githubRepos.filter(repo => {
        const isImported = importedUrls.has(normalizeUrl(repo.html_url));
        if (statusFilter === 'new' && isImported) return false;
        if (statusFilter === 'imported' && !isImported) return false;
        if (searchTerm) {
            const hay = `${repo.name} ${repo.description || ''}`.toLowerCase();
            if (!hay.includes(searchTerm)) return false;
        }
        return true;
    });

    // Update the count chip to reflect what's actually shown.
    const countEl = document.getElementById('repoCount');
    if (countEl) countEl.textContent = filteredRepos.length;

    if (filteredRepos.length === 0) {
        container.innerHTML = '<div class="empty-state">No repositories match the current filters</div>';
        return;
    }

    container.innerHTML = filteredRepos.map(repo => {
        const isImported = importedUrls.has(normalizeUrl(repo.html_url));
        const statusBadge = getStatusBadge(repo.inferredStatus);
        
        return `
            <div style="padding: 16px; background: ${isImported ? 'var(--surface-inset)' : 'var(--surface)'}; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; align-items: start; gap: 12px;">
                    <input type="checkbox" 
                           class="repo-checkbox" 
                           data-repo='${JSON.stringify(repo).replace(/'/g, "&apos;")}' 
                           ${isImported ? 'disabled' : ''} 
                           style="margin-top: 4px;">
                    <div style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div style="font-weight: 600; color: ${isImported ? 'var(--text-subtle)' : 'var(--text)'};">${escapeHtml(repo.name)}</div>
                            ${isImported ? '<span style="color: #10b981; font-size: 0.85rem;">✓ Imported</span>' : statusBadge}
                        </div>
                        <div style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 8px;">${escapeHtml(repo.description || 'No description')}</div>
                        <div style="display: flex; gap: 16px; font-size: 0.85rem; color: var(--text-subtle);">
                            ${repo.language ? `<span>🔧 ${escapeHtml(repo.language)}</span>` : ''}
                            <span>⭐ ${repo.stargazers_count}</span>
                            ${repo.daysSinceCommit !== null ? `<span>Last commit: ${repo.daysSinceCommit}d ago</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function getStatusBadge(status) {
    const colors = {
        idea: '#6b7280',
        planning: 'var(--accent-strong)',
        building: '#f59e0b',
        launched: '#10b981',
        paused: '#ef4444'
    };
    
    return `<span style="background: ${colors[status] || '#6b7280'}; color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;">${status}</span>`;
}

function selectAllRepos() {
    const checkboxes = document.querySelectorAll('.repo-checkbox:not(:disabled)');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    
    // Toggle: if all checked, uncheck all. Otherwise, check all.
    checkboxes.forEach(cb => {
        cb.checked = !allChecked;
    });
}

async function importSelectedRepos() {
    const checkboxes = document.querySelectorAll('.repo-checkbox:checked');
    if (checkboxes.length === 0) {
        alert('Select at least one repository');
        return;
    }
    
    const repos = Array.from(checkboxes).map(cb => JSON.parse(cb.dataset.repo));
    
    try {
        const response = await fetch('/api/github/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repos })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Import failed');
        }
        
        const counts = {};
        (data.projects || []).forEach(p => {
            const s = (p.local && p.local.status) || 'skipped';
            counts[s] = (counts[s] || 0) + 1;
        });
        const parts = [
            counts.linked && `${counts.linked} linked to existing local copies`,
            counts.cloning && `${counts.cloning} cloning into the Clone Base Directory`,
            counts.ambiguous && `${counts.ambiguous} with several local copies (set Local Path)`,
            counts.skipped && `${counts.skipped} not cloned (see Build Log)`,
        ].filter(Boolean);
        alert(`Imported ${data.imported} projects!${parts.length ? `\n\n${parts.join('\n')}` : ''}`);
        loadProjects();
        hideBulkImport();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// ========== GITHUB SEARCH ==========

async function searchGitHub() {
    const query = document.getElementById('searchInput').value.trim();
    const language = document.getElementById('discoverLanguage')?.value || '';
    if (!query && !language) {
        alert('Enter a search term or pick a language');
        return;
    }
    const fullQuery = language ? `${query} language:${language}` : query;

    document.getElementById('searchResultsSection').style.display = 'block';
    document.getElementById('searchLoading').style.display = 'block';
    document.getElementById('searchResults').style.display = 'none';

    try {
        const response = await fetch(`/api/github/search?q=${encodeURIComponent(fullQuery)}&per_page=20`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Search failed');

        searchResults = data.items;
        renderSearchResults();

        document.getElementById('searchLoading').style.display = 'none';
        document.getElementById('searchResults').style.display = 'grid';
    } catch (error) {
        alert(`Search error: ${error.message}`);
        document.getElementById('searchLoading').style.display = 'none';
    }
}

function renderSearchResults() {
    const container = document.getElementById('searchResults');
    if (searchResults.length === 0) {
        container.innerHTML = '<div class="empty-state">No results found</div>';
        return;
    }
    container.innerHTML = searchResults.map(repo => renderGitHubRepoCard(repo)).join('');
}

// ========== PINNED (localStorage) ==========

function getPinned() {
    try { return JSON.parse(localStorage.getItem('launchpad.pinned') || '{}'); }
    catch { return {}; }
}

function setPinned(map) {
    localStorage.setItem('launchpad.pinned', JSON.stringify(map));
}

function isPinned(fullName) {
    return !!getPinned()[fullName];
}

function togglePin(fullName, repoJson) {
    const map = getPinned();
    if (map[fullName]) {
        delete map[fullName];
        if (typeof showToast === 'function') showToast(`Unpinned ${fullName}`);
    } else {
        let repo;
        try { repo = JSON.parse(decodeURIComponent(repoJson)); }
        catch { repo = { full_name: fullName, html_url: `https://github.com/${fullName}` }; }
        map[fullName] = {
            full_name: repo.full_name,
            description: repo.description,
            html_url: repo.html_url,
            language: repo.language,
            stargazers_count: repo.stargazers_count || 0,
            forks_count: repo.forks_count || 0,
            pinnedAt: Date.now()
        };
        if (typeof showToast === 'function') showToast(`📌 Pinned ${fullName}`);
    }
    setPinned(map);
    renderPinned();
    // Re-render explore + search so pin-button state updates everywhere
    if (document.getElementById('exploreGrid')?.children.length) loadExplore();
    if (typeof searchResults !== 'undefined' && searchResults.length) renderSearchResults();
}

function renderPinned() {
    const section = document.getElementById('pinnedSection');
    const list = document.getElementById('pinnedList');
    if (!section || !list) return;
    const map = getPinned();
    const pins = Object.values(map).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    if (pins.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    list.innerHTML = pins.map(r => renderGitHubRepoCard(r)).join('');
}

// ========== EXPLORE — outward-facing GitHub Top 5 ==========
//
// Five categories, top 5 each. Server-side query lives in /api/github/explore.
// Selected tab persists in localStorage so the user lands back where they left.
// Time range and language filter apply across all tabs.

// Cards (default) or Rows. Persisted across reloads.
function getExploreView() {
    return localStorage.getItem('launchpad.exploreView') || 'cards';
}

function setExploreView(mode) {
    localStorage.setItem('launchpad.exploreView', mode);
    // Toggle button active state.
    const cardsBtn = document.getElementById('exploreViewCards');
    const rowsBtn  = document.getElementById('exploreViewRows');
    if (cardsBtn) cardsBtn.classList.toggle('active', mode === 'cards');
    if (rowsBtn)  rowsBtn.classList.toggle('active', mode === 'rows');
    // Swap containers immediately, then re-run loadExplore so the right one
    // gets rendered (cheaper than maintaining two simultaneous renders).
    const grid = document.getElementById('exploreGrid');
    const list = document.getElementById('exploreList');
    if (grid) grid.style.display = mode === 'cards' ? '' : 'none';
    if (list) list.style.display = mode === 'rows' ? '' : 'none';
    loadExplore();
}

const EXPLORE_CATEGORIES = [
    { key: 'trending',    label: '🔥 Trending',      hint: 'Created recently and gaining stars fast' },
    { key: 're-emerging', label: '🌅 Re-emerging',   hint: 'Older repos shipping renewed activity this week' },
    { key: 'popular',     label: '⭐ Most Popular',  hint: 'All-time most starred (ignores time range)' },
    { key: 'new',         label: '🚀 New & Rising',  hint: 'Recently created, lower star floor — surfaces small hot repos' },
    { key: 'discussed',   label: '💬 Most Discussed', hint: 'Popular repos with active issues + recent activity' },
    { key: 'forked',      label: '🔱 Most Forked',   hint: 'Most-forked repos in the time window' }
];

function getExploreTab() {
    const stored = localStorage.getItem('launchpad.exploreTab');
    return EXPLORE_CATEGORIES.some(c => c.key === stored) ? stored : 'trending';
}

function setExploreTab(key) {
    localStorage.setItem('launchpad.exploreTab', key);
    loadExplore();
}

function clearExploreFilters() {
    const lang = document.getElementById('discoverLanguage');
    const topic = document.getElementById('exploreTopic');
    const user = document.getElementById('exploreUser');
    const range = document.getElementById('exploreRange');
    const spoken = document.getElementById('exploreSpokenLang');
    if (spoken) spoken.value = 'english'; // Reset to the sensible default, not "any".
    if (lang) lang.value = '';
    if (topic) topic.value = '';
    if (user) user.value = '';
    if (range) range.value = 'monthly';
    loadExplore();
}

async function loadExplore() {
    const range = document.getElementById('exploreRange')?.value || 'monthly';
    const lang = document.getElementById('discoverLanguage')?.value || '';
    const topic = document.getElementById('exploreTopic')?.value.trim() || '';
    const user = document.getElementById('exploreUser')?.value.trim() || '';
    const activeKey = getExploreTab();

    // Render tab bar (always — even while results load)
    const tabsEl = document.getElementById('exploreTabs');
    if (tabsEl) {
        tabsEl.innerHTML = EXPLORE_CATEGORIES.map(c =>
            `<button class="import-tab${c.key === activeKey ? ' active' : ''}" title="${escapeHtml(c.hint)}" onclick="setExploreTab('${c.key}')">${c.label}</button>`
        ).join('');
    }

    const mode = getExploreView();
    const grid = document.getElementById('exploreGrid');
    const list = document.getElementById('exploreList');
    if (!grid || !list) return;
    // Ensure the right container is visible (also handled in setExploreView,
    // but we re-assert here so a first-render after page-load lands correctly).
    grid.style.display = mode === 'cards' ? '' : 'none';
    list.style.display = mode === 'rows' ? '' : 'none';
    // Sync toggle button visual state with what we'll render.
    const cardsBtn = document.getElementById('exploreViewCards');
    const rowsBtn  = document.getElementById('exploreViewRows');
    if (cardsBtn) cardsBtn.classList.toggle('active', mode === 'cards');
    if (rowsBtn)  rowsBtn.classList.toggle('active', mode === 'rows');
    const target = mode === 'cards' ? grid : list;
    target.innerHTML = '<div class="loading">Loading…</div>';

    const params = new URLSearchParams({ category: activeKey, since: range });
    if (lang) params.set('language', lang);
    if (topic) params.set('topic', topic);
    if (user) params.set('user', user);

    const spokenLangEl = document.getElementById('exploreSpokenLang');
    // First call after page-load: restore the user's last choice from localStorage.
    if (spokenLangEl && !spokenLangEl.dataset.restored) {
        const saved = localStorage.getItem('launchpad.exploreSpokenLang');
        if (saved) spokenLangEl.value = saved;
        spokenLangEl.dataset.restored = '1';
    }
    const spokenLang = spokenLangEl?.value || 'english';
    if (spokenLangEl) localStorage.setItem('launchpad.exploreSpokenLang', spokenLang);

    try {
        const response = await fetch(`/api/github/explore?${params.toString()}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load category');

        // Spoken-language filter — client-side because GitHub's search API
        // doesn't expose a "description language" qualifier. Detection looks at
        // both `description` and `name` so repos with no description still
        // get a fair shake when the name itself is plainly English.
        const rawRepos = data.items || [];
        const filteredRepos = filterReposBySpokenLanguage(rawRepos, spokenLang);
        // Take the top 15 after filtering — the server over-fetches 50 to
        // leave headroom for the strict English filter.
        const repos = filteredRepos.slice(0, 15);

        if (repos.length === 0) {
            const noLangHint = spokenLang === 'english'
                ? 'No English-only results matched. Try switching to "Any language" in the filter row.'
                : 'No repos match this category — try a different time range, topic, or language filter.';
            target.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">${noLangHint}</div>`;
            renderPinned();
            return;
        }
        if (mode === 'cards') {
            // Cards view — #1 styled larger (matches GitHub tab Top 5 pattern).
            grid.innerHTML = repos.map((repo, i) => renderExploreRepoCard(repo, i)).join('');
        } else {
            // Rows view — compact horizontal layout, all rows same size.
            list.innerHTML = repos.map((repo, i) => renderExploreRepoRow(repo, i)).join('');
        }
        renderPinned();
    } catch (error) {
        console.error('Error loading explore:', error);
        target.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">Couldn't load: ${escapeHtml(error.message)}</div>`;
    }
}

// Compact one-line-ish row layout (GitHub-tab "rows" pattern). Same info as
// the card but laid out horizontally: rank · name+description · stars · forks ·
// language · last push · actions.
function renderExploreRepoRow(repo, rank) {
    const isFirst = rank === 0;
    const stars = (repo.stargazers_count || 0).toLocaleString();
    const forks = (repo.forks_count || 0).toLocaleString();
    const openIssues = (repo.open_issues_count || 0).toLocaleString();
    const pinned = isPinned(repo.full_name);
    const repoJson = encodeURIComponent(JSON.stringify({
        full_name: repo.full_name, description: repo.description, html_url: repo.html_url,
        language: repo.language, stargazers_count: repo.stargazers_count || 0, forks_count: repo.forks_count || 0
    }));
    const rankColor = isFirst ? 'var(--accent)' : 'var(--text-subtle)';
    const rankWeight = isFirst ? '700' : '600';
    const pushedRel  = repo.pushed_at  ? relTime(repo.pushed_at)  : '';
    const topics = Array.isArray(repo.topics) ? repo.topics.slice(0, 4) : [];
    const topicChips = topics.length
        ? topics.map(t => `<span onclick="event.stopPropagation(); applyExploreTopic('${escapeHtml(t)}')" style="background: var(--surface-inset); color: var(--accent-soft); padding: 1px 6px; border-radius: 999px; font-size: 0.7rem; cursor: pointer; border: 1px solid var(--border);">#${escapeHtml(t)}</span>`).join(' ')
        : '';
    return `
        <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--surface-inset); border: 1px solid ${isFirst ? 'var(--accent)' : 'var(--border)'}; border-radius: 8px; margin-bottom: 8px;">
            <div style="color: ${rankColor}; font-weight: ${rankWeight}; min-width: 32px; text-align: center; font-size: ${isFirst ? '1rem' : '0.85rem'};">#${rank + 1}</div>
            <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
                    <a href="${escapeHtml(repo.html_url)}" target="_blank" style="color: var(--accent-soft); text-decoration: none; font-weight: 600;">${escapeHtml(repo.full_name)}</a>
                    ${repo.language ? `<span style="color: var(--text-muted); font-size: 0.78rem;">🔧 ${escapeHtml(repo.language)}</span>` : ''}
                    ${pushedRel ? `<span style="color: var(--text-subtle); font-size: 0.75rem;">⚡ ${pushedRel}</span>` : ''}
                </div>
                <div style="color: var(--text-muted); font-size: 0.86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px;">${escapeHtml(repo.description || 'No description')}</div>
                ${topicChips ? `<div style="display: flex; gap: 4px; flex-wrap: wrap;">${topicChips}</div>` : ''}
            </div>
            <div style="display: flex; gap: 12px; align-items: center; color: var(--text-muted); font-size: 0.82rem; flex-shrink: 0;">
                <span title="Stars">⭐ ${stars}</span>
                ${renderVelocityChip(repo)}
                <span title="Forks">🍴 ${forks}</span>
                <span title="Open issues">🐛 ${openIssues}</span>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="btn btn-sm ${pinned ? 'btn-primary' : 'btn-secondary'}" onclick="togglePin(${attrStr(repo.full_name)}, ${attrStr(repoJson)}); event.stopPropagation();" title="${pinned ? 'Unpin' : 'Pin to top'}">📌</button>
                <button class="btn btn-sm" onclick="importGitHubRepo(${attrStr(repo.html_url)})">📥</button>
            </div>
        </div>
    `;
}

// Detect the dominant script in a string. Returns one of:
//   'english' (latin-script), 'chinese', 'japanese', 'russian', 'arabic',
//   'hebrew', 'hindi', 'thai', 'korean', 'other', 'unknown'
// The check is character-set based rather than dictionary-based — fast, good
// enough for "is this English or not" decisions on repo descriptions, and
// doesn't ship a 1MB language model. Japanese is detected via hiragana /
// katakana presence (mixed CJK + hiragana = Japanese, pure CJK = Chinese).
function detectScript(text) {
    if (!text) return 'unknown';
    const s = String(text);
    let cjk = 0, hiragana = 0, katakana = 0, hangul = 0;
    let cyrillic = 0, arabic = 0, hebrew = 0, devanagari = 0, thai = 0, latin = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
        else if (c >= 0x3040 && c <= 0x309F) hiragana++;
        else if (c >= 0x30A0 && c <= 0x30FF) katakana++;
        else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
        else if ((c >= 0x0400 && c <= 0x04FF) || (c >= 0x0500 && c <= 0x052F)) cyrillic++;
        else if (c >= 0x0600 && c <= 0x06FF) arabic++;
        else if (c >= 0x0590 && c <= 0x05FF) hebrew++;
        else if (c >= 0x0900 && c <= 0x097F) devanagari++;
        else if (c >= 0x0E00 && c <= 0x0E7F) thai++;
        else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) latin++;
    }
    // Japanese is the only script with hiragana/katakana, so any of those wins.
    if (hiragana || katakana) return 'japanese';
    if (hangul > latin) return 'korean';
    if (cjk > latin) return 'chinese';
    if (cyrillic > latin) return 'russian';
    if (arabic > latin) return 'arabic';
    if (hebrew > latin) return 'hebrew';
    if (devanagari > latin) return 'hindi';
    if (thai > latin) return 'thai';
    if (latin > 0) return 'english'; // Latin script — bucket as English (covers ES/FR/DE/etc. too, which is fine for our purpose)
    return 'unknown';
}

// Strict "is any non-Latin alphabetic character present" check.
// True if the string contains CJK ideographs, hiragana, katakana, hangul,
// Cyrillic, Arabic, Hebrew, Devanagari, or Thai. Emoji, math symbols, and
// general punctuation are ignored — we only care about *writing scripts*.
// This is the gate for the English filter: we reject anything with even a
// little CJK because a mixed Chinese/English description is still off-putting
// to an English-only reader.
const NON_LATIN_SCRIPT_RE = /[぀-ゟ゠-ヿ一-鿿豈-﫿㐀-䶿가-힯Ѐ-ӿԀ-ԯ؀-ۿݐ-ݿ֐-׿ऀ-ॿ฀-๿]/;

function hasNonLatinScript(s) {
    if (!s) return false;
    return NON_LATIN_SCRIPT_RE.test(String(s));
}

function filterReposBySpokenLanguage(repos, lang) {
    if (!lang || lang === 'any') return repos;
    return repos.filter(repo => {
        // Combine description + name so repos with no description still pass
        // when the name is plainly English.
        const text = `${repo.description || ''} ${repo.name || ''}`;
        if (lang === 'english') {
            // STRICT: reject if ANY non-Latin alphabetic character is present,
            // not just when non-Latin is dominant. A description with even a
            // handful of CJK chars is annoying to an English reader.
            return !hasNonLatinScript(text);
        }
        if (lang === 'other') {
            return hasNonLatinScript(text);
        }
        // Specific non-English buckets (chinese/japanese/russian/etc.) — fall
        // back to the dominant-script detector so we don't include repos that
        // just happen to have a Chinese character.
        return detectScript(text) === lang;
    });
}

// Render one Explore card with rank styling for #1 and rich metadata.
// Shows: stars, forks, watchers, open issues, language, license, topic chips,
// created date, last-push date, and full description (no truncation).
function renderExploreRepoCard(repo, rank) {
    const isFirst = rank === 0;
    const stars = (repo.stargazers_count || 0).toLocaleString();
    const forks = (repo.forks_count || 0).toLocaleString();
    const watchers = (repo.watchers_count || 0).toLocaleString();
    const openIssues = (repo.open_issues_count || 0).toLocaleString();
    const pinned = isPinned(repo.full_name);
    const repoJson = encodeURIComponent(JSON.stringify({
        full_name: repo.full_name,
        description: repo.description,
        html_url: repo.html_url,
        language: repo.language,
        stargazers_count: repo.stargazers_count || 0,
        forks_count: repo.forks_count || 0
    }));
    const cardStyle = isFirst
        ? 'border: 2px solid var(--accent); background: linear-gradient(135deg, var(--surface-2), var(--surface)); grid-column: span 2;'
        : '';
    const rankBadge = isFirst
        ? '<span style="background: var(--accent); color: var(--accent-contrast); font-weight: 700; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; margin-right: 8px;">#1</span>'
        : `<span style="color: var(--text-subtle); font-weight: 600; margin-right: 8px;">#${rank + 1}</span>`;

    // Topic chips — clickable to filter the Explore page. GitHub returns up
    // to 20 topics; we show the first 5 to avoid blowing out the card.
    const topics = Array.isArray(repo.topics) ? repo.topics.slice(0, 5) : [];
    const topicChips = topics.length ? `
        <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px;">
            ${topics.map(t =>
                `<span onclick="event.stopPropagation(); applyExploreTopic('${escapeHtml(t)}')"
                       style="background: var(--surface-inset); color: var(--accent-soft); padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; cursor: pointer; border: 1px solid var(--border);"
                       title="Filter by topic">#${escapeHtml(t)}</span>`
            ).join('')}
        </div>
    ` : '';

    // Dates — show both creation and last-push so users can see freshness.
    const createdRel = repo.created_at ? relTime(repo.created_at) : null;
    const pushedRel  = repo.pushed_at  ? relTime(repo.pushed_at)  : null;

    // License is a nested object when present; null otherwise.
    const license = repo.license && repo.license.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
        ? repo.license.spdx_id : null;

    return `
        <div class="github-repo-card project-card" style="${cardStyle}">
            <div class="repo-header" style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                    <div class="repo-name" style="font-weight: 600; color: var(--accent-soft);">
                        ${rankBadge}
                        <a href="${escapeHtml(repo.html_url)}" target="_blank" style="color: var(--accent-soft); text-decoration: none;">${escapeHtml(repo.full_name)}</a>
                    </div>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0;">
                    <button class="btn btn-sm ${pinned ? 'btn-primary' : 'btn-secondary'}" onclick="togglePin(${attrStr(repo.full_name)}, ${attrStr(repoJson)}); event.stopPropagation();" title="${pinned ? 'Unpin' : 'Pin to top'}">${pinned ? '📌' : '📌'}</button>
                </div>
            </div>

            <div class="repo-description" style="margin: 8px 0; color: var(--text-muted); line-height: 1.5;">${escapeHtml(repo.description || 'No description')}</div>

            ${topicChips}

            <div class="repo-meta" style="color: var(--text-muted); font-size: 0.85rem; display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px;">
                <span title="Stars">⭐ ${stars}</span>
                ${renderVelocityChip(repo)}
                <span title="Forks">🍴 ${forks}</span>
                <span title="Watchers">👁 ${watchers}</span>
                <span title="Open issues">🐛 ${openIssues}</span>
                ${repo.language ? `<span title="Primary language">🔧 ${escapeHtml(repo.language)}</span>` : ''}
                ${license ? `<span title="License">📄 ${escapeHtml(license)}</span>` : ''}
            </div>

            <div style="color: var(--text-subtle); font-size: 0.78rem; display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px;">
                ${createdRel ? `<span title="Created ${repo.created_at}">📅 Created ${createdRel}</span>` : ''}
                ${pushedRel  ? `<span title="Last push ${repo.pushed_at}">⚡ Last push ${pushedRel}</span>` : ''}
            </div>

            <div class="repo-actions" style="margin-top: 12px; display: flex; gap: 8px;">
                <button class="btn btn-sm" onclick="importGitHubRepo(${attrStr(repo.html_url)})">📥 Import</button>
                <a href="${escapeHtml(repo.html_url)}" target="_blank" class="btn btn-sm btn-secondary">View on GitHub</a>
            </div>
        </div>
    `;
}

// Set the topic filter field and re-run Explore. Wired to topic chips on cards.
function applyExploreTopic(topic) {
    const input = document.getElementById('exploreTopic');
    if (input) {
        input.value = topic;
        loadExplore();
    }
}

// Star-velocity chip — only renders when the server attached `stars_delta_7d`
// (or `stars_delta_30d` as a fallback). Velocity is the rate of new stars
// since our last snapshot, and is THE signal github.com/trending and
// OSSInsight use to define "trending." Until we've been running long enough
// to have history for a given repo, the server returns no delta and this
// chip stays empty. Builds up naturally over the first week of use.
function renderVelocityChip(repo) {
    const d7 = repo.stars_delta_7d;
    if (typeof d7 === 'number' && d7 > 0) {
        // Bright green pill — high signal.
        return `<span style="background: #052e16; color: #22c55e; padding: 1px 8px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; border: 1px solid #14532d;" title="New stars in the last 7 days (since we started tracking this repo)">📈 +${d7.toLocaleString()}/7d</span>`;
    }
    const d30 = repo.stars_delta_30d;
    if (typeof d30 === 'number' && d30 > 0 && (d7 === undefined || d7 === null)) {
        return `<span style="background: var(--surface); color: var(--text-muted); padding: 1px 8px; border-radius: 999px; font-size: 0.78rem;" title="New stars in the last 30 days">📈 +${d30.toLocaleString()}/30d</span>`;
    }
    return '';
}

// Human-readable relative time ("3d ago", "2mo ago"). Used for the new
// created/pushed labels on Explore cards.
function relTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!then) return '';
    const diffSec = (Date.now() - then) / 1000;
    if (diffSec < 60)     return 'just now';
    if (diffSec < 3600)   return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400)  return Math.floor(diffSec / 3600) + 'h ago';
    if (diffSec < 604800) return Math.floor(diffSec / 86400) + 'd ago';
    if (diffSec < 2592000) return Math.floor(diffSec / 604800) + 'w ago';
    if (diffSec < 31536000) return Math.floor(diffSec / 2592000) + 'mo ago';
    return Math.floor(diffSec / 31536000) + 'y ago';
}

function renderGitHubRepoCard(repo) {
    const stars = (repo.stargazers_count || 0).toLocaleString();
    const forks = (repo.forks_count || 0).toLocaleString();
    const pinned = isPinned(repo.full_name);
    const repoJson = encodeURIComponent(JSON.stringify({
        full_name: repo.full_name,
        description: repo.description,
        html_url: repo.html_url,
        language: repo.language,
        stargazers_count: repo.stargazers_count || 0,
        forks_count: repo.forks_count || 0
    }));
    return `
        <div class="github-repo-card project-card">
            <div class="repo-header" style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
                <div class="repo-name" style="font-weight: 600; color: var(--accent-soft);">${escapeHtml(repo.full_name)}</div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="btn btn-sm ${pinned ? 'btn-primary' : 'btn-secondary'}" onclick="togglePin(${attrStr(repo.full_name)}, ${attrStr(repoJson)}); event.stopPropagation();" title="${pinned ? 'Unpin' : 'Pin to top'}">${pinned ? '📌 Pinned' : '📌 Pin'}</button>
                    <div class="repo-stars" style="color: var(--text-muted); font-size: 0.9rem;">⭐ ${stars}</div>
                </div>
            </div>
            <div class="repo-description" style="margin: 8px 0; color: var(--text-muted);">${escapeHtml(repo.description || 'No description')}</div>
            <div class="repo-meta" style="color: var(--text-muted); font-size: 0.85rem; display: flex; gap: 12px;">
                ${repo.language ? `<span>🔧 ${escapeHtml(repo.language)}</span>` : ''}
                <span>🍴 ${forks} forks</span>
            </div>
            <div class="repo-actions" style="margin-top: 12px; display: flex; gap: 8px;">
                <button class="btn btn-sm" onclick="importGitHubRepo(${attrStr(repo.html_url)})">📥 Import</button>
                <a href="${escapeHtml(repo.html_url)}" target="_blank" class="btn btn-sm btn-secondary">View on GitHub</a>
            </div>
        </div>
    `;
}

async function importGitHubRepo(url) {
    try {
        const response = await fetch('/api/github/import-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (!response.ok) {
            if (response.status === 409) {
                showToast('Already imported');
                return;
            }
            throw new Error(data.error || 'Import failed');
        }

        // Reload projects so the imported repo shows up in `projects`. Await so
        // the Browse re-render below sees the new row.
        await loadProjects();
        showToast(`Imported ${data.project.name} — ${describeLocalOutcome(data.local)}`);
        if (data.local && data.local.status === 'cloning') refreshLocalCloneStatus();

        // If the Browse GitHub modal is open, re-render the list in place so the
        // tag flips from NEW → NOT CLONED (or whatever sync_status applies) and
        // the row drops down into the "Already imported" section immediately.
        const modal = document.getElementById('bulkImportModal');
        if (modal && modal.style.display !== 'none' && browseReposCache) {
            renderBrowseRepos(browseReposCache.user, browseReposCache.repos);
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// ========== UTILITIES ==========

function copyToClipboard(text, element) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = element.textContent;
        element.textContent = '✓ Copied!';
        element.style.color = '#10b981';
        setTimeout(() => {
            element.textContent = originalText;
            element.style.color = 'var(--accent)';
        }, 2000);
    }).catch(err => {
        alert('Failed to copy: ' + err);
    });
}

// ========== ISSUES + COMMITS (GitHub read-only) ==========

async function loadIssues(state) {
    if (!currentProject || !currentProject.repo_url) {
        const s = document.getElementById('issuesSection');
        if (s) s.style.display = 'none';
        return;
    }
    document.getElementById('issuesSection').style.display = 'block';
    document.getElementById('issuesOpenTab').classList.toggle('active', state === 'open');
    document.getElementById('issuesClosedTab').classList.toggle('active', state === 'closed');

    const list = document.getElementById('issuesList');
    list.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const res = await fetch(`/api/projects/${currentProject.id}/issues?state=${state}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Issues fetch failed');

        document.getElementById('issuesCount').textContent = `(${data.count})`;
        if (data.issues.length === 0) {
            list.innerHTML = `<div class="empty-state">No ${state} issues</div>`;
            return;
        }
        list.innerHTML = data.issues.map(i => {
            const stateColor = i.state === 'open' ? '#22c55e' : '#8b5cf6';
            const stateIcon = i.state === 'open' ? '🟢' : '🟣';
            const labels = (i.labels || []).map(l => {
                const isHex = /^[0-9a-f]{6}$/i.test(l.color);
                const bgColor = isHex ? l.color : '888';
                const textColor = isHex ? l.color : 'ccc';
                return `<span style="background: #${bgColor}22; color: #${textColor}; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${escapeHtml(l.name)}</span>`;
            }).join(' ');
            return `
                <div class="update-item" style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
                    <div style="flex: 1;">
                        <div class="update-title">
                            <a href="${escapeHtml(i.html_url)}" target="_blank" style="color: var(--accent-soft); text-decoration: none;">
                                ${stateIcon} #${i.number} · ${escapeHtml(i.title)}
                            </a>
                        </div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
                            by ${escapeHtml(i.user || 'unknown')} · ${formatDate(new Date(i.created_at).getTime() / 1000)} · 💬 ${i.comments}
                        </div>
                        ${labels ? `<div style="margin-top: 6px;">${labels}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        list.innerHTML = `<div class="empty-state">⚠ ${escapeHtml(e.message)}</div>`;
    }
}

async function loadCommits() {
    if (!currentProject || !currentProject.repo_url) {
        const s = document.getElementById('commitsSection');
        if (s) s.style.display = 'none';
        return;
    }
    document.getElementById('commitsSection').style.display = 'block';
    const list = document.getElementById('commitsList');
    list.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const res = await fetch(`/api/projects/${currentProject.id}/commits?limit=10`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Commits fetch failed');

        if (data.commits.length === 0) {
            list.innerHTML = '<div class="empty-state">No commits yet</div>';
            return;
        }
        list.innerHTML = data.commits.map(c => `
            <div class="update-item">
                <div class="update-header">
                    <div class="update-title">
                        <a href="${escapeHtml(c.html_url)}" target="_blank" style="color: var(--accent-soft); text-decoration: none; font-family: monospace;">${escapeHtml(c.short)}</a>
                        · ${escapeHtml(c.message)}
                    </div>
                    <div class="update-time">${c.date ? formatDate(new Date(c.date).getTime() / 1000) : ''}</div>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
                    ${c.author_login ? `@${escapeHtml(c.author_login)}` : escapeHtml(c.author || 'unknown')}
                </div>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = `<div class="empty-state">⚠ ${escapeHtml(e.message)}</div>`;
    }
}

async function openInTerminal(path) {
    try {
        const res = await fetch('/api/util/open-terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to open terminal');
        if (typeof showToast === 'function') showToast(`Opened terminal in ${path}`);
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

// Opens the user's preferred terminal in the project's local_path and auto-runs
// `claude` so Claude Code starts with the right cwd. If no local clone yet,
// alerts the user to clone first.
async function openInClaudeCode() {
    if (!currentProject) return;
    if (!currentProject.local_path) {
        alert('Clone the repo first — Claude Code needs a working directory.');
        return;
    }
    try {
        const res = await fetch('/api/util/open-terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentProject.local_path, command: 'claude' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to open Claude Code');
        showToast(`🤖 Claude Code opening in ${currentProject.local_path}`);
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

function copyPromptToClipboard() {
    if (!currentProject || !currentProject.prompt) return;
    navigator.clipboard.writeText(currentProject.prompt).then(() => {
        showToast('📋 Prompt copied — paste into Claude Code');
    }).catch(err => alert('Copy failed: ' + err));
}

async function openInFolder(path) {
    try {
        const res = await fetch('/api/util/open-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to open folder');
        if (typeof showToast === 'function') showToast(`Opened folder ${path}`);
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

function copyTerminalCommand(path) {
    const command = `cd "${path}"`;
    navigator.clipboard.writeText(command).then(() => {
        showToast('📋 cd command copied');
    }).catch(err => {
        alert('Failed to copy: ' + err);
    });
}

function getCategoryIcon(category) {
    const icons = {
        app: '📱',
        saas: '☁️',
        utility: '🔧',
        tool: '🛠️',
        service: '💼'
    };
    return icons[category] || '📦';
}

function formatDate(timestamp) {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    
    return date.toLocaleDateString();
}

// ========== GITHUB NEO VIEW ==========

let neoProjects = [];
let neoFilteredProjects = [];

// Legacy alias — Neo-era code called viewProject; the real detail-opener is showProject.
function viewProject(id) {
    showProject(id);
}

// Which layout the repository list uses on the GitHub tab. Persisted in localStorage.
function getGithubView() {
    return localStorage.getItem('launchpad.githubView') || 'cards';
}

function setGithubView(mode) {
    localStorage.setItem('launchpad.githubView', mode);
    document.getElementById('neoViewCards').classList.toggle('active', mode === 'cards');
    document.getElementById('neoViewRows').classList.toggle('active', mode === 'rows');
    document.getElementById('neoRepoGrid').style.display = mode === 'cards' ? '' : 'none';
    document.getElementById('neoRepoList').style.display = mode === 'rows' ? '' : 'none';
    renderNeoRepos();
}

async function loadNeoView() {
    try {
        const response = await fetch('/api/projects');
        neoProjects = await response.json();
        neoFilteredProjects = neoProjects;
        // Apply persisted view choice
        const mode = getGithubView();
        document.getElementById('neoViewCards').classList.toggle('active', mode === 'cards');
        document.getElementById('neoViewRows').classList.toggle('active', mode === 'rows');
        document.getElementById('neoRepoGrid').style.display = mode === 'cards' ? '' : 'none';
        document.getElementById('neoRepoList').style.display = mode === 'rows' ? '' : 'none';
        renderNeoPopular();
        renderNeoRepos();
    } catch (err) {
        document.getElementById('neoRepoList').innerHTML = '<div class="loading">Failed to load repositories</div>';
    }
}

// ========== POPULAR REPOSITORIES — TABBED TOP 5 ==========
//
// Replaces the old broken 4-card row that duplicated the same project across
// cards when stars were all 0. Now: 5 categories, top 5 each, deduped by id,
// #1 styled larger. Selected tab persists in localStorage.

const POPULAR_CATEGORIES = [
    {
        key: 'active',
        label: '🔥 Most Active',
        // Prefer GitHub's last commit timestamp (populated by Check Sync /
        // Check All); fall back to launchpad's updated_at when not synced.
        sort: (a, b) => {
            const ax = Math.max(a.last_commit_at || 0, a.updated_at || 0);
            const bx = Math.max(b.last_commit_at || 0, b.updated_at || 0);
            return bx - ax;
        },
        filter: () => true
    },
    {
        key: 'popular',
        label: '⭐ Most Popular',
        sort: (a, b) => (b.stars || 0) - (a.stars || 0),
        filter: (p) => (p.stars || 0) > 0,
        emptyHint: 'No repos have stars yet — none of your imported repos have public-facing stars > 0.'
    },
    {
        key: 'building',
        label: '🚀 Building',
        sort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
        filter: (p) => p.status === 'building',
        emptyHint: 'No projects in "building" status. Bump one from idea/planning to start.'
    },
    {
        key: 'ideas',
        label: '💡 Ideas',
        sort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
        filter: (p) => p.status === 'idea',
        emptyHint: 'No "idea" status projects — ideas backlog is empty.'
    },
    {
        key: 'newest',
        label: '📅 Newest',
        sort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
        filter: () => true
    }
];

function getPopularTab() {
    return localStorage.getItem('launchpad.popularTab') || 'active';
}

function setPopularTab(key) {
    localStorage.setItem('launchpad.popularTab', key);
    renderNeoPopular();
}

function renderNeoPopular() {
    const gridDiv = document.getElementById('neoPopularGrid');
    if (!gridDiv) return;

    if (!neoProjects || neoProjects.length === 0) {
        gridDiv.innerHTML = '<div class="loading">No repositories</div>';
        return;
    }

    const activeKey = getPopularTab();
    const tabs = POPULAR_CATEGORIES.map(c =>
        `<button class="import-tab${c.key === activeKey ? ' active' : ''}" onclick="setPopularTab('${c.key}')">${c.label}</button>`
    ).join('');

    const cat = POPULAR_CATEGORIES.find(c => c.key === activeKey) || POPULAR_CATEGORIES[0];
    const top5 = [...neoProjects].filter(cat.filter).sort(cat.sort).slice(0, 5);

    let body;
    if (top5.length === 0) {
        body = `<div class="empty-state" style="grid-column: 1 / -1;">${cat.emptyHint || 'Nothing to show in this category.'}</div>`;
    } else {
        body = top5.map((p, i) => {
            const isFirst = i === 0;
            const language = p.tech_stack || p.stack || 'Unknown';
            const stars = p.stars || 0;
            const forks = p.forks || 0;
            const cardStyle = isFirst
                ? 'border: 2px solid var(--accent); background: linear-gradient(135deg, var(--surface-2), var(--surface)); grid-column: span 2;'
                : '';
            const rankBadge = isFirst
                ? '<span style="background: var(--accent); color: var(--accent-contrast); font-weight: 700; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; margin-right: 8px;">#1</span>'
                : `<span style="color: var(--text-subtle); font-weight: 600; margin-right: 8px;">#${i + 1}</span>`;
            const localChip = p.local_path
                ? '<span style="color: #22c55e; font-size: 0.8rem; margin-left: 8px;">📁 cloned</span>'
                : '';
            return `
                <div class="neo-popular-card" style="${cardStyle} cursor: pointer;" onclick="if(!event.target.closest('a'))showProject(${p.id})">
                    <h3>
                        ${rankBadge}
                        <a href="#" onclick="event.stopPropagation(); showProject(${p.id}); return false;" style="color: #58a6ff; text-decoration: none;">
                            ${p.name}
                        </a>
                        ${localChip}
                    </h3>
                    <p>${p.description || 'No description'}</p>
                    <div class="neo-popular-meta">
                        <span><span class="neo-language-dot"></span> ${language}</span>
                        ${stars > 0 ? `<span>⭐ ${stars}</span>` : ''}
                        ${forks > 0 ? `<span>🔱 ${forks}</span>` : ''}
                        <span style="color: var(--text-subtle); margin-left: auto;">${p.status || ''}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    gridDiv.innerHTML = `
        <div style="grid-column: 1 / -1; display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px;">
            ${tabs}
        </div>
        ${body}
    `;
}

function renderNeoRepos() {
    const mode = getGithubView();
    const listDiv = document.getElementById('neoRepoList');
    const gridDiv = document.getElementById('neoRepoGrid');

    if (neoFilteredProjects.length === 0) {
        listDiv.innerHTML = '<div class="loading">No repositories found</div>';
        gridDiv.innerHTML = '<div class="empty-state">No repositories found</div>';
        return;
    }

    // Cards view — reuses the Dashboard/Recent-Projects card, which is
    // already clickable (renderProjectCard wraps each card with a click
    // handler that opens the detail view).
    gridDiv.innerHTML = neoFilteredProjects.map(p => renderProjectCard(p)).join('');

    // Rows view — the richer Neo layout with sync badge + inline actions.
    listDiv.innerHTML = neoFilteredProjects.map(project => {
        const syncStatus = project.sync_status || 'unknown';
        const syncIcon = getSyncIcon(syncStatus);
        const syncBadgeClass = getSyncBadgeClass(syncStatus);
        const syncText = getSyncText(syncStatus);
        
        const language = project.tech_stack || 'Unknown';
        const updated = project.updated_at ? timeAgo(project.updated_at) : 'Unknown';
        const localPath = project.local_path || '';
        const pathShort = localPath ? localPath.replace('/home/bfoster/projects/', '~/projects/') : '';
        
        const stars = project.stars || 0;
        const forks = project.forks || 0;

        // Visibility badge reflects the repo's actual GitHub visibility
        // (is_private: 1 = private, 0 = public, null = unknown/not a github
        // repo). Show nothing when there's no linked repo to describe.
        let visibilityBadge = '';
        if (project.is_private === 1) {
            visibilityBadge = '<span class="neo-private-badge">🔒 Private</span>';
        } else if (project.is_private === 0 || project.repo_url) {
            visibilityBadge = '<span class="neo-public-badge">Public</span>';
        }

        return `
            <div class="neo-repo-item" style="cursor: pointer;" onclick="if(!event.target.closest('.neo-action-btn,.neo-repo-actions,a,button'))showProject(${project.id})">
                <div class="neo-repo-header">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <a href="#" class="neo-repo-name" onclick="event.stopPropagation(); showProject(${project.id}); return false;">
                            ${escapeHtml(project.name)}
                        </a>
                        ${visibilityBadge}
                    </div>
                    ${syncStatus !== 'unknown' ? `
                        <span class="neo-sync-badge ${syncBadgeClass}">
                            ${syncIcon} ${syncText}
                        </span>
                    ` : ''}
                </div>
                
                <div class="neo-repo-description">
                    ${escapeHtml(project.description || 'No description')}
                </div>

                <div class="neo-repo-meta">
                    <span><span class="neo-language-dot"></span> ${escapeHtml(language)}</span>
                    ${stars > 0 ? `<span class="neo-meta-separator">•</span><span>⭐ ${stars}</span>` : ''}
                    ${forks > 0 ? `<span class="neo-meta-separator">•</span><span>🔱 ${forks}</span>` : ''}
                    ${pathShort ? `<span class="neo-meta-separator">•</span><span>📁 ${escapeHtml(pathShort)}</span>` : ''}
                    <span class="neo-meta-separator">•</span>
                    <span>Updated ${updated}</span>
                </div>
                
                ${localPath ? `
                    <div class="neo-repo-actions">
                        <button class="neo-action-btn" onclick="copyNeoPath(${attrStr(localPath)})">
                            📋 Copy cd
                        </button>
                        <button class="neo-action-btn" onclick="checkSingleSync(${project.id})">
                            🔄 Check
                        </button>
                        ${getSyncActionButton(project.id, syncStatus)}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function getSyncIcon(status) {
    const icons = {
        synced: '✓',
        ahead: '⚠️',
        behind: '⬇️',
        dirty: '🔴',
        not_cloned: '📦',
        no_repo: '⚠️',
        error: '❌'
    };
    return icons[status] || '❓';
}

function getSyncBadgeClass(status) {
    const classes = {
        synced: 'synced',
        ahead: 'ahead',
        behind: 'behind',
        dirty: 'dirty'
    };
    return classes[status] || '';
}

function getSyncText(status) {
    const texts = {
        synced: 'Synced',
        ahead: 'Ahead',
        behind: 'Behind',
        dirty: 'Uncommitted',
        not_cloned: 'Not Cloned',
        no_repo: 'No Repo',
        error: 'Error'
    };
    return texts[status] || 'Unknown';
}

function getSyncActionButton(projectId, status) {
    if (status === 'ahead') {
        return `<button class="neo-action-btn primary" onclick="syncProject(${projectId}, 'push')">⬆️ Push</button>`;
    } else if (status === 'behind') {
        return `<button class="neo-action-btn primary" onclick="syncProject(${projectId}, 'pull')">⬇️ Pull</button>`;
    } else if (status === 'synced') {
        return `<button class="neo-action-btn" disabled style="opacity: 0.5;">✓ Up to date</button>`;
    }
    return '';
}

function copyNeoPath(path) {
    const command = `cd "${path}"`;
    navigator.clipboard.writeText(command).then(() => {
        alert('✓ Copied! Paste in your terminal:\n\n' + command);
    }).catch(err => {
        alert('Failed to copy: ' + err);
    });
}

// Cache sync state across both global arrays so sync badges appear on
// Dashboard + My Projects cards too (not just GitHub tab).
function _setSyncStatus(projectId, status) {
    const lists = [typeof projects !== 'undefined' ? projects : null,
                   typeof neoProjects !== 'undefined' ? neoProjects : null,
                   typeof neoFilteredProjects !== 'undefined' ? neoFilteredProjects : null];
    lists.forEach(list => {
        if (!list) return;
        const p = list.find(x => x.id === projectId);
        if (p) p.sync_status = status;
    });
}

async function checkSingleSync(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}/sync-status`);
        const data = await response.json();
        _setSyncStatus(projectId, data.status);
        filterNeoRepos(); // Re-render GitHub tab if visible
        // Refresh Dashboard/My Projects cards if those arrays are populated
        if (typeof renderDashboard === 'function') renderDashboard();
        if (typeof renderMyProjects === 'function') renderMyProjects();
        if (typeof showToast === 'function') {
            showToast(`Sync: ${getSyncText(data.status)}`);
        } else {
            alert(`Sync Status: ${getSyncText(data.status)}\n\n${(data.messages || []).join(', ')}`);
        }
    } catch (err) {
        alert('Failed to check sync status: ' + err.message);
    }
}

// T1.6 — Refresh All. Hits the server endpoint that runs the same sweep used
// at boot. Reloads project state afterwards so external-activity badges and
// last_commit_at sort orders update without a manual page refresh.
async function refreshAllProjects() {
    const btn = document.getElementById('refreshAllBtn');
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '⏳ Refreshing…';
    try {
        const res = await fetch('/api/projects/refresh-all', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Refresh failed');
        // Reload the canonical project list so all fields (last_commit_at,
        // status auto-bumps) come back fresh.
        await loadProjects();
        if (typeof showToast === 'function') {
            showToast(`Refreshed ${data.scanned} project${data.scanned !== 1 ? 's' : ''}`);
        }
    } catch (e) {
        alert('Refresh failed: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function checkAllSyncStatus() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '⏳ Checking...';
    
    try {
        // Check all projects with local paths
        const promises = neoProjects
            .filter(p => p.local_path && p.local_path !== 'Not cloned')
            .map(p => fetch(`/api/projects/${p.id}/sync-status`).then(r => r.json()));
        
        const results = await Promise.all(promises);
        
        // Update all projects in every cache so cards everywhere reflect state
        const filtered = neoProjects.filter(p => p.local_path);
        results.forEach((data, i) => {
            if (filtered[i]) _setSyncStatus(filtered[i].id, data.status);
        });

        filterNeoRepos();
        if (typeof renderDashboard === 'function') renderDashboard();
        if (typeof renderMyProjects === 'function') renderMyProjects();
        if (typeof showToast === 'function') showToast(`Checked ${results.length} repositories`);
        else alert('✓ All repositories checked!');
    } catch (err) {
        alert('Failed to check all: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Check All';
    }
}

function filterNeoRepos() {
    const search = document.getElementById('neoSearchInput').value.toLowerCase();
    const syncFilter = document.getElementById('neoFilterSync').value;
    
    neoFilteredProjects = neoProjects.filter(project => {
        // Search filter
        const matchesSearch = !search || 
            project.name.toLowerCase().includes(search) ||
            (project.description && project.description.toLowerCase().includes(search));
        
        // Sync status filter
        const matchesSync = syncFilter === 'all' || project.sync_status === syncFilter;
        
        return matchesSearch && matchesSync;
    });
    
    renderNeoRepos();
}

async function syncProject(projectId, action) {
    if (!confirm(`This will ${action} the repository. Continue?`)) {
        return;
    }
    
    try {
        const project = neoProjects.find(p => p.id === projectId);
        if (!project || !project.local_path) {
            alert('Project path not found');
            return;
        }
        
        const command = action === 'push' ? 'git push' : 'git pull';
        alert(`To ${action}, run this in your terminal:\n\ncd "${project.local_path}"\n${command}`);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function timeAgo(timestamp) {
    const now = Date.now();
    const then = timestamp * 1000;
    const diff = Math.floor((now - then) / 1000);
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;

    const date = new Date(then);
    return date.toLocaleDateString();
}

// ===========================================================================
// LEARN — interactive github bootcamp. Complements the HTML+CSS David built.
// State lives in Learn.* below. All API calls go through /api/learn/*.
// ===========================================================================

const LEARN_DEBUG = false;
const Learn = {
    username: null,
    learner: null,
    curriculum: null,
    progress: {},        // lessonId → { status, score, attempts, completed_at }
    badges: new Set(),   // earned badge_ids
    activeLevel: null,   // currently viewed level key
    activeLesson: null,  // currently playing lesson object
    quizState: null,     // { qIndex, score, answers[] }
    challengeState: null // { attempts, solved }
};

function _dbg(...a) { if (LEARN_DEBUG) console.log('[learn]', ...a); }

// ----- Entry point -----
async function loadLearn() {
    // Ensure curriculum is cached (it's static — fetch once)
    if (!Learn.curriculum) {
        try {
            const res = await fetch('/api/learn/curriculum');
            Learn.curriculum = await res.json();
        } catch (e) {
            console.error('Failed to load curriculum:', e);
            return;
        }
    }
    // Restore prior login if any
    const stored = localStorage.getItem('launchpad.learn.username');
    if (stored) {
        await learnLoginAs(stored);
    } else {
        learnShowScreen('learnLoginScreen');
    }
}

function learnShowScreen(id) {
    ['learnLoginScreen', 'learnDashboardScreen', 'learnModulesScreen', 'learnLessonScreen']
        .forEach(s => {
            const el = document.getElementById(s);
            if (el) el.style.display = (s === id) ? 'block' : 'none';
        });
}

// ----- Login / user mgmt -----
async function learnDoLogin() {
    const input = document.getElementById('learnLoginInput');
    const name = (input?.value || '').trim();
    if (!name) {
        input?.focus();
        return;
    }
    try {
        const res = await fetch('/api/learn/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: name, display_name: name })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Login failed');
        await learnLoginAs(name);
    } catch (e) {
        alert('Login failed: ' + e.message);
    }
}

async function learnLoginAs(username) {
    Learn.username = username;
    localStorage.setItem('launchpad.learn.username', username);
    // Hydrate progress + badges
    try {
        const res = await fetch(`/api/learn/me/${encodeURIComponent(username)}`);
        if (res.status === 404) {
            // Stored username no longer exists server-side — re-create
            await fetch('/api/learn/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, display_name: username })
            });
            const r2 = await fetch(`/api/learn/me/${encodeURIComponent(username)}`);
            const data = await r2.json();
            _learnHydrate(data);
        } else {
            const data = await res.json();
            _learnHydrate(data);
        }
        learnRenderDashboard();
        learnShowScreen('learnDashboardScreen');
    } catch (e) {
        console.error('Hydrate failed:', e);
    }
}

function _learnHydrate(data) {
    Learn.learner = data.learner;
    Learn.progress = {};
    (data.progress || []).forEach(p => { Learn.progress[p.lesson_id] = p; });
    Learn.badges = new Set((data.badges || []).map(b => b.badge_id));
}

function learnSwitchUser() {
    if (!confirm('Switch user? Your progress is saved — you can come back anytime.')) return;
    localStorage.removeItem('launchpad.learn.username');
    Learn.username = null;
    Learn.learner = null;
    Learn.progress = {};
    Learn.badges = new Set();
    document.getElementById('learnLoginInput').value = '';
    learnShowScreen('learnLoginScreen');
}

async function learnResetProgress() {
    if (!Learn.username) return;
    if (!confirm('Wipe ALL your progress and badges for this user? This cannot be undone.')) return;
    try {
        await fetch('/api/learn/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: Learn.username })
        });
        await learnLoginAs(Learn.username);
    } catch (e) {
        alert('Reset failed: ' + e.message);
    }
}

// ----- Dashboard -----
function learnRenderDashboard() {
    const learner = Learn.learner;
    if (!learner) return;

    // Top bar
    document.getElementById('learnAvatar').textContent = (learner.display_name || learner.username).charAt(0).toUpperCase();
    document.getElementById('learnUserName').textContent = learner.display_name || learner.username;
    document.getElementById('learnLevelChip').textContent = learner.level.charAt(0).toUpperCase() + learner.level.slice(1);
    document.getElementById('learnLevelChip').dataset.level = learner.level;
    document.getElementById('learnXpTotal').textContent = learner.total_xp || 0;

    // Streak — last activity within 24h shows streak chip. (We approximate
    // streak as 1 for now; a real streak counter would track per-day completions.)
    const streak = _learnComputeStreak();
    if (streak > 0) {
        document.getElementById('learnStreakChip').style.display = '';
        document.getElementById('learnStreakCount').textContent = streak;
    } else {
        document.getElementById('learnStreakChip').style.display = 'none';
    }

    // Recommended Skills — render the curated set
    _learnRenderRecommendations();

    // Levels grid
    _learnRenderLevels();

    // Badges row
    _learnRenderBadges();

    // Recent activity
    _learnRenderActivity();
}

function _learnComputeStreak() {
    // Count completed lessons whose completed_at is within the last 24h.
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    const recent = Object.values(Learn.progress).filter(p =>
        p.status === 'completed' && p.completed_at && (now - p.completed_at) < day
    );
    return recent.length > 0 ? 1 : 0;
}

function _learnRenderRecommendations() {
    // Replace the existing placeholder card if curriculum has recommendations
    const recs = Learn.curriculum?.recommendedSkills;
    if (!recs || !recs.length) return;
    const section = document.querySelector('.learn-section .learn-recommend-card')?.closest('.learn-section');
    if (!section) return;
    const cardsHtml = recs.map(r => `
        <div class="learn-recommend-card">
            <div class="learn-recommend-icon">${r.tier === 'top' ? '🏅' : '🔌'}</div>
            <div class="learn-recommend-body">
                <div class="learn-recommend-title">${escapeHtml(r.name)} <span style="color:var(--text-subtle);font-weight:400;font-size:0.85rem;">— ${escapeHtml(r.author)}${r.stars ? ' · ⭐ ' + r.stars : ''}</span></div>
                <div class="learn-recommend-desc">${escapeHtml(r.blurb)}</div>
                <div style="margin-top:8px;font-size:0.85rem;color:var(--text-muted);"><strong>Why:</strong> ${escapeHtml(r.why)}</div>
                ${r.install?.claudeCode ? `<div style="margin-top:8px;"><strong style="color:var(--accent-soft);font-size:0.85rem;">Install:</strong> <code style="background:var(--surface-inset);padding:2px 6px;border-radius:4px;font-size:0.85rem;">${escapeHtml(r.install.claudeCode)}</code></div>` : ''}
            </div>
            <a href="${r.repo}" target="_blank" class="learn-btn learn-btn-secondary" style="text-decoration:none;display:inline-block;">View on GitHub →</a>
        </div>
    `).join('');
    section.innerHTML = `
        <h2 class="learn-section-title">🔌 Optional Power Tools</h2>
        <p class="learn-section-subtitle">Install these to put what you learn into practice — none are required to complete the curriculum.</p>
        ${cardsHtml}
    `;
}

function _learnRenderLevels() {
    const grid = document.getElementById('learnLevelsGrid');
    if (!grid) return;
    const levels = Learn.curriculum?.levels || [];
    grid.innerHTML = levels.map((lv, i) => {
        const stats = _learnLevelStats(lv);
        const locked = _learnLevelLocked(i);
        const pct = stats.total ? Math.round(100 * stats.done / stats.total) : 0;
        const cta = stats.done === 0 ? 'Start' : (stats.done === stats.total ? 'Review' : 'Continue');
        const emoji = lv.key === 'basic' ? '📘' : lv.key === 'adequate' ? '🎯' : '👑';
        const clickAction = locked
            ? `learnShowLockedHint('${lv.key}')`
            : `learnOpenLevel('${lv.key}')`;
        return `
            <div class="learn-level-card ${locked ? 'learn-level-locked' : ''}" data-level="${lv.key}"
                 style="--level-color:${lv.color};"
                 onclick="${clickAction}">
                <div class="learn-level-card-head">
                    <span class="learn-level-card-emoji">${emoji}</span>
                    <span class="learn-level-card-name">${lv.label}</span>
                    ${locked ? '<span class="learn-level-card-lock">🔒</span>' : ''}
                </div>
                <p class="learn-level-card-tagline">${escapeHtml(lv.tagline)}</p>
                <div class="learn-level-card-progress">
                    <div class="learn-level-card-progress-bar">
                        <div class="learn-level-card-progress-fill" style="width:${pct}%;background:${lv.color};"></div>
                    </div>
                    <div class="learn-level-card-progress-label">${stats.done} / ${stats.total} lessons</div>
                </div>
                ${locked
                    ? `<div class="learn-level-card-locked-hint">Reach ${_learnPrevLevelLabel(i)} 50% to unlock</div>`
                    : `<button class="learn-btn learn-btn-primary learn-btn-block">${cta} →</button>`}
            </div>
        `;
    }).join('');
}

function _learnLevelStats(level) {
    let total = 0, done = 0;
    (level.modules || []).forEach(m => (m.lessons || []).forEach(l => {
        total++;
        if (Learn.progress[l.id]?.status === 'completed') done++;
    }));
    return { total, done };
}

function _learnLevelLocked(idx) {
    if (idx === 0) return false;
    const prev = Learn.curriculum.levels[idx - 1];
    const stats = _learnLevelStats(prev);
    return stats.total > 0 && stats.done < Math.ceil(stats.total / 2);
}

function _learnPrevLevelLabel(idx) {
    return Learn.curriculum.levels[idx - 1]?.label || 'previous';
}

function learnShowLockedHint(key) {
    alert(`This level is locked. Complete at least 50% of the previous level to unlock it.`);
}

function _learnRenderBadges() {
    const row = document.getElementById('learnBadgesRow');
    if (!row) return;
    const allBadges = Learn.curriculum?.badges || {};
    const allKeys = Object.keys(allBadges);
    if (allKeys.length === 0) {
        row.innerHTML = '<div class="learn-activity-empty">No badges yet — complete lessons to earn them.</div>';
        return;
    }
    row.innerHTML = allKeys.map(key => {
        const b = allBadges[key];
        const earned = Learn.badges.has(key);
        return `
            <div class="learn-badge ${earned ? 'learn-badge-earned' : 'learn-badge-locked'}"
                 title="${escapeHtml(b.name)}: ${escapeHtml(b.desc)}">
                <span class="learn-badge-emoji">${earned ? b.emoji : '🔒'}</span>
                <span class="learn-badge-name">${earned ? escapeHtml(b.name) : '???'}</span>
            </div>
        `;
    }).join('');
}

function _learnRenderActivity() {
    const list = document.getElementById('learnActivityList');
    if (!list) return;
    const completed = Object.entries(Learn.progress)
        .filter(([_, p]) => p.status === 'completed' && p.completed_at)
        .sort((a, b) => b[1].completed_at - a[1].completed_at)
        .slice(0, 5);
    if (completed.length === 0) {
        list.innerHTML = '<div class="learn-activity-empty">No activity yet — pick a level to start your first lesson.</div>';
        return;
    }
    list.innerHTML = completed.map(([id, p]) => {
        const lesson = _learnFindLesson(id);
        if (!lesson) return '';
        return `
            <div class="learn-activity-item">
                <span class="learn-activity-icon">✅</span>
                <div class="learn-activity-body">
                    <div class="learn-activity-title">${escapeHtml(lesson.title)}</div>
                    <div class="learn-activity-meta">${lesson.level} · +${lesson.xp} XP · ${timeAgo(p.completed_at)}</div>
                </div>
            </div>
        `;
    }).join('');
}

function _learnFindLesson(lessonId) {
    for (const lv of (Learn.curriculum?.levels || [])) {
        for (const m of (lv.modules || [])) {
            for (const l of (m.lessons || [])) {
                if (l.id === lessonId) return l;
            }
        }
    }
    return null;
}

// ----- Module / lesson list -----
function learnShowDashboard() {
    learnRenderDashboard();
    learnShowScreen('learnDashboardScreen');
}

function learnOpenLevel(key) {
    Learn.activeLevel = key;
    const level = Learn.curriculum.levels.find(l => l.key === key);
    if (!level) return;

    document.getElementById('learnLevelEmoji').textContent =
        key === 'basic' ? '📘' : key === 'adequate' ? '🎯' : '👑';
    document.getElementById('learnLevelTitle').textContent = level.label + ' — ' + level.tagline;

    const stats = _learnLevelStats(level);
    const pct = stats.total ? Math.round(100 * stats.done / stats.total) : 0;
    const fill = document.getElementById('learnLevelProgressFill');
    fill.style.width = pct + '%';
    fill.style.background = level.color;
    document.getElementById('learnLevelProgressLabel').textContent =
        `${stats.done} of ${stats.total} lessons complete`;

    const list = document.getElementById('learnModulesList');
    list.innerHTML = (level.modules || []).map(m => `
        <section class="learn-module">
            <h3 class="learn-module-title">${escapeHtml(m.label)}</h3>
            <div class="learn-lessons-list">
                ${(m.lessons || []).map(l => _learnRenderLessonCard(l)).join('')}
            </div>
        </section>
    `).join('');

    learnShowScreen('learnModulesScreen');
}

function _learnRenderLessonCard(lesson) {
    const p = Learn.progress[lesson.id];
    let icon = '⚪', statusLabel = 'Not started';
    if (p?.status === 'in_progress') { icon = '🔵'; statusLabel = 'In progress'; }
    if (p?.status === 'completed')   { icon = '✅'; statusLabel = `Completed · ${p.score || 0}%`; }
    const badge = lesson.badge_id ? Learn.curriculum.badges[lesson.badge_id] : null;
    return `
        <div class="learn-lesson-card" onclick="learnStartLesson('${lesson.id}')">
            <div class="learn-lesson-card-icon">${icon}</div>
            <div class="learn-lesson-card-body">
                <div class="learn-lesson-card-title">${escapeHtml(lesson.title)}</div>
                <div class="learn-lesson-card-summary">${escapeHtml(lesson.summary || '')}</div>
                <div class="learn-lesson-card-meta">
                    <span>⚡ +${lesson.xp} XP</span>
                    ${badge ? `<span title="Earns: ${escapeHtml(badge.name)}">${badge.emoji} ${escapeHtml(badge.name)}</span>` : ''}
                    <span class="learn-lesson-card-status">${statusLabel}</span>
                </div>
            </div>
            <div class="learn-lesson-card-cta">▶</div>
        </div>
    `;
}

// ----- Lesson player -----
function learnStartLesson(lessonId) {
    const lesson = _learnFindLesson(lessonId);
    if (!lesson) return;
    Learn.activeLesson = lesson;
    Learn.quizState = { qIndex: 0, score: 0, answers: [] };
    Learn.challengeState = { attempts: 0, solved: false };
    localStorage.setItem('launchpad.learn.lastViewed', lessonId);

    document.getElementById('learnLessonTitle').textContent = lesson.title;
    document.getElementById('learnLessonSummary').textContent = lesson.summary || '';
    document.getElementById('learnLessonXpBadge').textContent = `+${lesson.xp} XP`;
    document.getElementById('learnLessonTrail').textContent =
        `${lesson.level.toUpperCase()} · ${lesson.id}`;

    // Mark in_progress server-side (fire-and-forget)
    if (!Learn.progress[lesson.id] || Learn.progress[lesson.id].status === 'not_started') {
        fetch('/api/learn/progress', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: Learn.username, lesson_id: lesson.id, status: 'in_progress', score: 0, attempts: 0 })
        }).catch(() => {});
    }

    learnShowScreen('learnLessonScreen');
    _learnSetStage('content');
    _learnRenderContent();
    _learnUpdateLessonProgressBar(0);
}

function _learnSetStage(stage) {
    ['Content', 'Quiz', 'Challenge', 'Complete'].forEach(s => {
        const el = document.getElementById('learnStage' + s);
        if (el) el.style.display = (s.toLowerCase() === stage) ? 'block' : 'none';
    });
}

function _learnUpdateLessonProgressBar(pct) {
    const fill = document.getElementById('learnLessonProgressFill');
    if (fill) fill.style.width = pct + '%';
}

// ---- Stage 1: Content ----
function _learnRenderContent() {
    const body = document.getElementById('learnContentBody');
    const blocks = Learn.activeLesson.content || [];
    body.innerHTML = blocks.map(b => {
        if (b.type === 'text') return `<div class="learn-content-text">${_learnMd(b.md)}</div>`;
        if (b.type === 'code') return `<pre class="learn-content-code"><code class="lang-${escapeHtml(b.lang || '')}">${escapeHtml(b.code || '')}</code></pre>`;
        if (b.type === 'callout') {
            const kind = b.kind || 'info';
            return `<div class="learn-callout learn-callout-${kind}"><span class="learn-callout-icon">${kind === 'tip' ? '💡' : kind === 'warn' ? '⚠️' : 'ℹ️'}</span><div>${_learnMd(b.md)}</div></div>`;
        }
        return '';
    }).join('');
}

// Tiny markdown parser — handles **bold**, *italic*, `code`, and triple-backtick blocks
function _learnMd(s) {
    if (!s) return '';
    let html = String(s);
    // Code blocks first (```...```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre class="learn-content-code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
    // Escape any remaining HTML in the rest, but preserve our pre blocks
    const parts = html.split(/(<pre[\s\S]*?<\/pre>)/);
    html = parts.map(p => {
        if (p.startsWith('<pre')) return p;
        let txt = escapeHtml(p);
        txt = txt.replace(/`([^`]+)`/g, '<code>$1</code>');
        txt = txt.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        txt = txt.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        txt = txt.replace(/\n\n/g, '</p><p>');
        txt = txt.replace(/\n- ([^\n]+)/g, '<li>$1</li>');
        txt = txt.replace(/(<li>[\s\S]+<\/li>)/, '<ul>$1</ul>');
        txt = txt.replace(/\n/g, '<br>');
        return `<p>${txt}</p>`;
    }).join('');
    return html;
}

function learnAdvanceFromContent() {
    _learnUpdateLessonProgressBar(33);
    _learnSetStage('quiz');
    _learnRenderQuizQuestion();
}

// ---- Stage 2: Quiz ----
function _learnRenderQuizQuestion() {
    const lesson = Learn.activeLesson;
    const quiz = lesson.quiz || [];
    const idx = Learn.quizState.qIndex;
    if (idx >= quiz.length) {
        // Quiz finished — go to challenge
        _learnUpdateLessonProgressBar(66);
        _learnSetStage('challenge');
        _learnRenderChallenge();
        return;
    }
    const q = quiz[idx];
    document.getElementById('learnQuizProgress').textContent = `Question ${idx + 1} of ${quiz.length}`;
    document.getElementById('learnQuizScore').textContent = `Score: ${Learn.quizState.score}`;
    const body = document.getElementById('learnQuizBody');

    if (q.type === 'mcq') {
        body.innerHTML = `
            <div class="learn-quiz-question">${escapeHtml(q.q)}</div>
            <div class="learn-quiz-choices">
                ${q.choices.map((c, i) => `
                    <button class="learn-quiz-choice" data-i="${i}" onclick="learnSubmitMCQ(${i})">${escapeHtml(c)}</button>
                `).join('')}
            </div>
            <div id="learnQuizFeedback" class="learn-quiz-feedback" style="display:none;"></div>
        `;
    } else if (q.type === 'short') {
        body.innerHTML = `
            <div class="learn-quiz-question">${escapeHtml(q.q)}</div>
            <input type="text" id="learnQuizInput" class="learn-input learn-quiz-input"
                   placeholder="Your answer…" autocomplete="off"
                   onkeypress="if(event.key==='Enter') learnSubmitShort()">
            <button class="learn-btn learn-btn-primary" onclick="learnSubmitShort()">Submit</button>
            <div id="learnQuizFeedback" class="learn-quiz-feedback" style="display:none;"></div>
        `;
        setTimeout(() => document.getElementById('learnQuizInput')?.focus(), 50);
    }
}

function learnSubmitMCQ(picked) {
    const q = Learn.activeLesson.quiz[Learn.quizState.qIndex];
    const correct = picked === q.answer;
    _learnQuizFeedback(correct, q.explain, q.choices[q.answer]);
    document.querySelectorAll('.learn-quiz-choice').forEach(b => {
        b.disabled = true;
        const i = parseInt(b.dataset.i);
        if (i === q.answer) b.classList.add('learn-quiz-choice-correct');
        else if (i === picked) b.classList.add('learn-quiz-choice-wrong');
    });
    if (correct) Learn.quizState.score++;
}

function learnSubmitShort() {
    const q = Learn.activeLesson.quiz[Learn.quizState.qIndex];
    const input = document.getElementById('learnQuizInput');
    const ans = (input.value || '').trim().toLowerCase();
    const accept = (q.accept || [q.answer]).map(a => a.toLowerCase());
    const correct = accept.includes(ans);
    _learnQuizFeedback(correct, q.explain, q.answer);
    input.disabled = true;
    if (correct) Learn.quizState.score++;
}

function _learnQuizFeedback(correct, explain, correctAnswer) {
    const fb = document.getElementById('learnQuizFeedback');
    fb.style.display = 'block';
    fb.className = 'learn-quiz-feedback ' + (correct ? 'learn-quiz-feedback-correct' : 'learn-quiz-feedback-wrong');
    fb.innerHTML = `
        <div class="learn-quiz-feedback-headline">${correct ? '✅ Correct!' : '❌ Not quite'}</div>
        ${!correct ? `<div class="learn-quiz-feedback-answer">Answer: <strong>${escapeHtml(correctAnswer || '')}</strong></div>` : ''}
        ${explain ? `<div class="learn-quiz-feedback-explain">${escapeHtml(explain)}</div>` : ''}
        <button class="learn-btn learn-btn-primary" onclick="learnNextQuizQuestion()">${Learn.quizState.qIndex + 1 < Learn.activeLesson.quiz.length ? 'Next Question →' : 'Onward to Challenge →'}</button>
    `;
}

function learnNextQuizQuestion() {
    Learn.quizState.qIndex++;
    _learnRenderQuizQuestion();
}

// ---- Stage 3: Challenge ----
function _learnRenderChallenge() {
    const ch = Learn.activeLesson.challenge;
    const body = document.getElementById('learnChallengeBody');
    document.getElementById('learnChallengeAttempts').textContent = '';

    if (!ch) {
        // No challenge — go straight to complete
        _learnLessonComplete();
        return;
    }

    if (ch.type === 'command-sandbox') {
        body.innerHTML = `
            <div class="learn-challenge-prompt">${escapeHtml(ch.prompt)}</div>
            <div class="learn-terminal">
                <span class="learn-terminal-prompt">$</span>
                <input type="text" id="learnChallengeInput" class="learn-terminal-input"
                       placeholder="type the command…" autocomplete="off"
                       onkeypress="if(event.key==='Enter') learnSubmitCommand()">
            </div>
            <div class="learn-challenge-actions">
                <button class="learn-btn learn-btn-primary" onclick="learnSubmitCommand()">Run ⏎</button>
                <button class="learn-btn learn-btn-ghost" onclick="learnShowHint()">💡 Hint</button>
            </div>
            <div id="learnChallengeFeedback" class="learn-challenge-feedback" style="display:none;"></div>
        `;
        setTimeout(() => document.getElementById('learnChallengeInput')?.focus(), 50);
    } else if (ch.type === 'order-steps') {
        const steps = (ch.steps || []).map((s, i) => ({ s, i }));
        // Shuffle
        for (let i = steps.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [steps[i], steps[j]] = [steps[j], steps[i]];
        }
        body.innerHTML = `
            <div class="learn-challenge-prompt">${escapeHtml(ch.prompt)}</div>
            <ul id="learnOrderList" class="learn-order-list">
                ${steps.map(s => `<li class="learn-order-item" draggable="true" data-i="${s.i}"><span class="learn-order-grip">≡</span><span>${escapeHtml(s.s)}</span></li>`).join('')}
            </ul>
            <div class="learn-challenge-actions">
                <button class="learn-btn learn-btn-primary" onclick="learnSubmitOrder()">Submit Order</button>
                <button class="learn-btn learn-btn-ghost" onclick="learnShowHint()">💡 Hint</button>
            </div>
            <div id="learnChallengeFeedback" class="learn-challenge-feedback" style="display:none;"></div>
        `;
        _learnWireDragOrder();
    } else if (ch.type === 'choose-path') {
        body.innerHTML = `
            <div class="learn-challenge-prompt">${escapeHtml(ch.prompt)}</div>
            <div class="learn-path-choices">
                ${ch.choices.map((c, i) => `
                    <button class="learn-path-choice" data-i="${i}" onclick="learnSubmitPath(${i})">${escapeHtml(c.label)}</button>
                `).join('')}
            </div>
            <div id="learnChallengeFeedback" class="learn-challenge-feedback" style="display:none;"></div>
        `;
    } else {
        // Unknown challenge type — skip
        _learnLessonComplete();
    }
}

function learnSubmitCommand() {
    const ch = Learn.activeLesson.challenge;
    const input = document.getElementById('learnChallengeInput');
    const ans = (input.value || '').trim();
    const accept = (ch.accept || [ch.expected]).map(s => s.trim());
    const ok = accept.some(a => a.toLowerCase() === ans.toLowerCase());
    Learn.challengeState.attempts++;
    document.getElementById('learnChallengeAttempts').textContent = `Attempts: ${Learn.challengeState.attempts}`;
    if (ok) {
        Learn.challengeState.solved = true;
        _learnChallengeFeedback(true, `Nice — \`${escapeHtml(ans)}\` is correct.`);
    } else {
        _learnChallengeFeedback(false, `\`${escapeHtml(ans)}\` isn't quite right. ${Learn.challengeState.attempts >= 2 ? 'Hint: ' + escapeHtml(ch.hint || '') : 'Try again.'}`);
    }
}

function learnSubmitOrder() {
    const ch = Learn.activeLesson.challenge;
    const items = Array.from(document.querySelectorAll('#learnOrderList .learn-order-item'));
    const userOrder = items.map(it => parseInt(it.dataset.i));
    const correct = userOrder.every((v, i) => v === i);
    Learn.challengeState.attempts++;
    if (correct) {
        Learn.challengeState.solved = true;
        _learnChallengeFeedback(true, 'Perfect order!');
    } else {
        _learnChallengeFeedback(false, `Not quite. ${Learn.challengeState.attempts >= 2 ? 'Hint: ' + escapeHtml(ch.hint || '') : 'Reshuffle and try again.'}`);
    }
}

function learnSubmitPath(i) {
    const ch = Learn.activeLesson.challenge;
    const choice = ch.choices[i];
    Learn.challengeState.attempts++;
    document.querySelectorAll('.learn-path-choice').forEach(b => {
        b.disabled = true;
        const idx = parseInt(b.dataset.i);
        if (ch.choices[idx].correct) b.classList.add('learn-quiz-choice-correct');
        else if (idx === i) b.classList.add('learn-quiz-choice-wrong');
    });
    if (choice.correct) {
        Learn.challengeState.solved = true;
        _learnChallengeFeedback(true, choice.explain);
    } else {
        _learnChallengeFeedback(false, choice.explain);
    }
}

function _learnChallengeFeedback(correct, msg) {
    const fb = document.getElementById('learnChallengeFeedback');
    fb.style.display = 'block';
    fb.className = 'learn-challenge-feedback ' + (correct ? 'learn-challenge-feedback-correct' : 'learn-challenge-feedback-wrong');
    fb.innerHTML = `
        <div class="learn-challenge-feedback-headline">${correct ? '🎯 Solved!' : '🤔 Not yet'}</div>
        <div>${msg}</div>
        ${correct ? `<button class="learn-btn learn-btn-primary" onclick="_learnLessonComplete()">Finish Lesson →</button>` : ''}
    `;
}

function learnShowHint() {
    const ch = Learn.activeLesson.challenge;
    if (!ch?.hint) return;
    const fb = document.getElementById('learnChallengeFeedback');
    fb.style.display = 'block';
    fb.className = 'learn-challenge-feedback';
    fb.innerHTML = `<div>💡 <strong>Hint:</strong> ${escapeHtml(ch.hint)}</div>`;
}

function _learnWireDragOrder() {
    const list = document.getElementById('learnOrderList');
    if (!list) return;
    let dragged = null;
    list.querySelectorAll('.learn-order-item').forEach(item => {
        item.addEventListener('dragstart', e => { dragged = item; item.classList.add('learn-dragging'); });
        item.addEventListener('dragend', () => { item.classList.remove('learn-dragging'); dragged = null; });
        item.addEventListener('dragover', e => {
            e.preventDefault();
            if (!dragged || dragged === item) return;
            const rect = item.getBoundingClientRect();
            const after = (e.clientY - rect.top) > rect.height / 2;
            list.insertBefore(dragged, after ? item.nextSibling : item);
        });
    });
}

// ---- Stage 4: Complete ----
async function _learnLessonComplete() {
    const lesson = Learn.activeLesson;
    const totalQs = (lesson.quiz || []).length;
    const score = totalQs ? Math.round(100 * Learn.quizState.score / totalQs) : 100;

    // Persist progress + collect any new badges/level-up
    let newBadges = [];
    let leveledUp = false;
    let learner = Learn.learner;
    try {
        const res = await fetch('/api/learn/progress', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: Learn.username,
                lesson_id: lesson.id,
                status: 'completed',
                score,
                attempts: Learn.challengeState.attempts || 1
            })
        });
        const data = await res.json();
        if (res.ok) {
            learner = data.learner;
            newBadges = data.newBadges || [];
            leveledUp = !!data.leveledUp;
            // Update local cache
            Learn.learner = learner;
            Learn.progress[lesson.id] = {
                lesson_id: lesson.id,
                status: 'completed',
                score,
                attempts: Learn.challengeState.attempts || 1,
                completed_at: Math.floor(Date.now() / 1000)
            };
            newBadges.forEach(b => Learn.badges.add(b));
        }
    } catch (e) {
        console.error('Save progress failed:', e);
    }

    _learnUpdateLessonProgressBar(100);
    _learnSetStage('complete');
    document.getElementById('learnCompleteXp').textContent = lesson.xp;

    // Animate XP counter
    _learnAnimateXp(0, lesson.xp);

    // Badge unlock — show first one in modal
    if (newBadges.length) {
        const badgeId = newBadges[0];
        const badge = Learn.curriculum.badges?.[badgeId];
        if (badge) {
            document.getElementById('learnCompleteBadgeWrap').style.display = 'block';
            document.getElementById('learnCompleteBadgeName').textContent = `${badge.emoji} ${badge.name}`;
            setTimeout(() => _learnShowBadgeModal(badge), 800);
        }
    } else {
        document.getElementById('learnCompleteBadgeWrap').style.display = 'none';
    }

    // Confetti!
    _learnConfetti();

    // Level-up overlay
    if (leveledUp && learner) {
        setTimeout(() => _learnShowLevelUp(learner.level), 1200);
    }

    // Hide "Continue to Next Lesson" button if there's no next lesson
    const next = _learnFindNextLesson(lesson);
    document.getElementById('learnContinueNextBtn').style.display = next ? '' : 'none';
}

function _learnAnimateXp(from, to) {
    const el = document.getElementById('learnCompleteXp');
    if (!el) return;
    const dur = 800;
    const start = performance.now();
    const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = Math.floor(from + (to - from) * t);
        if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

function _learnFindNextLesson(current) {
    const levels = Learn.curriculum?.levels || [];
    let found = false;
    for (const lv of levels) {
        for (const m of (lv.modules || [])) {
            for (const l of (m.lessons || [])) {
                if (found) return l;
                if (l.id === current.id) found = true;
            }
        }
    }
    return null;
}

function learnGoNextLesson() {
    const next = _learnFindNextLesson(Learn.activeLesson);
    if (next) learnStartLesson(next.id);
    else learnExitLesson();
}

function learnExitLesson() {
    Learn.activeLesson = null;
    if (Learn.activeLevel) learnOpenLevel(Learn.activeLevel);
    else learnShowDashboard();
}

// ---- Animations ----
function _learnConfetti() {
    const container = document.getElementById('learnConfetti');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'block';
    const colors = ['#60a5fa', '#fbbf24', '#a78bfa', '#22c55e', '#f472b6'];
    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('div');
        piece.className = 'learn-confetti-piece';
        piece.style.left = (Math.random() * 100) + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = (Math.random() * 0.5) + 's';
        piece.style.animationDuration = (2 + Math.random() * 1.5) + 's';
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        container.appendChild(piece);
    }
    setTimeout(() => { container.style.display = 'none'; }, 4000);
}

function _learnShowLevelUp(level) {
    const overlay = document.getElementById('learnLevelUpOverlay');
    if (!overlay) return;
    document.getElementById('learnLevelUpName').textContent = level.toUpperCase();
    overlay.style.display = 'flex';
    setTimeout(() => { overlay.style.display = 'none'; }, 2500);
}

function _learnShowBadgeModal(badge) {
    const modal = document.getElementById('learnBadgeModal');
    if (!modal) return;
    document.getElementById('learnBadgeModalEmoji').textContent = badge.emoji;
    document.getElementById('learnBadgeModalName').textContent = badge.name;
    document.getElementById('learnBadgeModalDesc').textContent = badge.desc;
    modal.style.display = 'flex';
}

function learnCloseBadgeModal(e) {
    if (e && e.target.id !== 'learnBadgeModal' && !e.target.classList?.contains('learn-btn')) return;
    document.getElementById('learnBadgeModal').style.display = 'none';
}
