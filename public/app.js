// LaunchPad - Client-side JavaScript
// State
let projects = [];
let currentProject = null;
let editingProjectId = null;
let githubRepos = [];
let searchResults = [];
let trendingRepos = [];
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
    
    // Legacy alias — old GitHubNeo tab now folds into GitHub
    if (viewName === 'githubNeo') viewName = 'github';

    // Load data for view
    if (viewName === 'discover') {
        loadTrending();
    } else if (viewName === 'github') {
        loadNeoView();
    } else if (viewName === 'settings') {
        loadSettings();
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
            patEl.textContent = `Token is set (${data.github_pat.preview}). Enter a new value and Save to replace, or Clear to remove.`;
            patEl.style.color = '#22c55e';
        } else {
            patEl.textContent = 'No token set — private-repo features and Bulk Import are disabled.';
            patEl.style.color = '#f59e0b';
        }

        const cloneDirEl = document.getElementById('cloneDirEffective');
        cloneDirEl.textContent = `Effective path: ${data.clone_base_dir_effective}`;
        document.getElementById('settingsCloneDir').placeholder = data.clone_base_dir_effective;
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
        alert(`Error: ${e.message}`);
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
        alert(`Error: ${e.message}`);
    }
}

async function testGitHubPat() {
    const resEl = document.getElementById('patTestResult');
    resEl.textContent = 'Testing…';
    resEl.style.color = '#888';
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
        alert(`Error: ${e.message}`);
    }
}

async function saveSettingsCloneDir() {
    const value = document.getElementById('settingsCloneDir').value.trim();
    if (!value) {
        alert('Enter a path (e.g., /home/bfoster) or leave the default.');
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
        alert(`Error: ${e.message}`);
    }
}

function showToast(msg) {
    // Simple temp toast — appears top-right for 3s
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:16px;right:16px;background:#22c55e;color:#0b0b0b;padding:10px 16px;border-radius:8px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

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
    const stackOpts = STACK_PRESETS.map(s => `<option value="${s}">${s}</option>`).join('');
    const form = `
        <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 32px; max-width: 760px; margin: 0 auto;">
            <h2 style="margin-bottom: 8px; color: #fff;">🏗️ New Project — Build Room</h2>
            <div style="color: #888; margin-bottom: 24px; font-size: 0.9rem;">Capture the vision, stack, and entry-points once so Claude Code has everything it needs when you open a terminal.</div>
            <form id="newProjectForm" onsubmit="saveProject(event)">

                <fieldset style="border: 1px solid #333; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: #93c5fd; padding: 0 8px;">Basics</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Project Name *</label>
                        <input type="text" name="name" required style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">One-line description</label>
                        <input type="text" name="description" placeholder="What this project is, in one sentence" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
                        <div>
                            <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Status</label>
                            <select name="status" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                                <option value="idea">💡 Idea</option>
                                <option value="planning">📋 Planning</option>
                                <option value="building">🔨 Building</option>
                                <option value="launched">🚀 Launched</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Category</label>
                            <select name="category" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                                <option value="app">📱 App</option>
                                <option value="saas">☁️ SaaS</option>
                                <option value="utility">🔧 Utility</option>
                                <option value="tool">🛠️ Tool</option>
                            </select>
                        </div>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid #333; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: #93c5fd; padding: 0 8px;">Concept</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Prompt / vision</label>
                        <textarea name="prompt" rows="4" placeholder="Describe the app in natural language — the prompt you'd give Claude Code to start building. Who is it for? What problem does it solve? What are the core features?" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: inherit;"></textarea>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">PRD (Product Requirements Document) <span style="color: #666; font-weight: normal;">— optional, fill later from Edit</span></label>
                        <textarea name="prd" rows="5" placeholder="Detailed requirements: user stories, acceptance criteria, non-goals, constraints." style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;"></textarea>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid #333; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: #93c5fd; padding: 0 8px;">Stack</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Preset</label>
                        <select name="stack_preset" onchange="document.querySelector('textarea[name=stack]').value = this.value === 'Custom (describe below)' ? '' : this.value" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                            <option value="">— pick a preset (optional) —</option>
                            ${stackOpts}
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Stack detail</label>
                        <textarea name="stack" rows="2" placeholder="e.g., Next.js 15 + TypeScript + Tailwind + SQLite (better-sqlite3) + Drizzle ORM" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace;"></textarea>
                    </div>
                </fieldset>

                <fieldset style="border: 1px solid #333; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                    <legend style="color: #93c5fd; padding: 0 8px;">Paths &amp; Links</legend>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Local Path <span style="color: #666; font-weight: normal;">— where Claude Code will work</span></label>
                        <input type="text" name="local_path" placeholder="e.g., C:\\home\\bfoster\\my-project" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace;">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">GitHub Repository URL</label>
                        <input type="url" name="repo_url" placeholder="https://github.com/user/repo" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">Live URL</label>
                        <input type="url" name="live_url" placeholder="https://your-app.vercel.app" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; color: #e0e0e0;">References <span style="color: #666; font-weight: normal;">— one per line (URLs, doc titles, file paths)</span></label>
                        <textarea name="references" rows="3" placeholder="https://nextjs.org/docs&#10;C:\\reference\\PRD-draft.md&#10;https://example.com/api-spec" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;"></textarea>
                    </div>
                </fieldset>

                <div style="display: flex; gap: 12px;">
                    <button type="submit" class="btn btn-primary">🚀 Create Build Room</button>
                    <button type="button" class="btn btn-secondary" onclick="showView('myProjects')">Cancel</button>
                </div>
            </form>
        </div>
    `;
    document.getElementById('myProjectsList').innerHTML = form;
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
        alert(`Error: ${error.message}`);
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

    return `
        <div class="project-card" onclick="showProject(${p.id})">
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
                <div class="project-status status-${p.status}">${p.status}</div>
                ${syncBadge}
            </div>
            <div class="project-name">${sourceIcon} ${localIcon} ${p.name}</div>
            <div class="project-description">${p.description || 'No description'}</div>
            <div class="project-meta">
                <span>${categoryIcon} ${p.category}</span>
                ${p.tech_stack ? `<span>🔧 ${p.tech_stack.split(',')[0].trim()}</span>` : ''}
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
                        <div class="update-title">${u.title}</div>
                        <div class="update-time">${formatDate(u.created_at)}</div>
                    </div>
                    ${u.content ? `<div class="update-content">${u.content}</div>` : ''}
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
                        ? `<a href="${escapeHtml(r)}" target="_blank" style="color: #93c5fd;">🔗 ${escapeHtml(r)}</a>`
                        : `<div style="color: #e0e0e0; font-family: monospace; font-size: 0.9rem;">📄 ${escapeHtml(r)}</div>`;
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
                <div class="info-value">${currentProject.status}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Category</div>
                <div class="info-value">${currentProject.category}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Source</div>
                <div class="info-value">${currentProject.source}</div>
            </div>
            ${currentProject.local_path ? `
                <div class="info-row">
                    <div class="info-label">Local Path</div>
                    <div class="info-value" style="font-family: monospace; font-size: 0.85rem;">
                        <span style="color: #60a5fa; cursor: pointer; text-decoration: underline;" onclick="copyToClipboard(${attrStr(currentProject.local_path)}, this)" title="Click to copy path">${currentProject.local_path}</span>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="copyTerminalCommand(${attrStr(currentProject.local_path)})" title="Copy cd command">📋 Copy cd command</button>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="openInTerminal(${attrStr(currentProject.local_path)})" title="Open a new terminal in this folder">💻 Open Terminal</button>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="openInFolder(${attrStr(currentProject.local_path)})" title="Open in Explorer">📂 Open Folder</button>
                    </div>
                </div>
            ` : ''}
            ${currentProject.stack ? `
                <div class="info-row">
                    <div class="info-label">Stack</div>
                    <div class="info-value" style="font-family: monospace; font-size: 0.85rem;">${currentProject.stack}</div>
                </div>
            ` : ''}
            ${currentProject.tech_stack && currentProject.tech_stack !== currentProject.stack ? `
                <div class="info-row">
                    <div class="info-label">Tech Stack</div>
                    <div class="info-value">${currentProject.tech_stack}</div>
                </div>
            ` : ''}
            ${currentProject.repo_url ? `
                <div class="info-row">
                    <div class="info-label">Repository</div>
                    <div class="info-value"><a href="${currentProject.repo_url}" target="_blank" style="color: #60a5fa;">View on GitHub</a></div>
                </div>
            ` : ''}
            ${currentProject.live_url ? `
                <div class="info-row">
                    <div class="info-label">Live Site</div>
                    <div class="info-value"><a href="${currentProject.live_url}" target="_blank" style="color: #60a5fa;">Visit</a></div>
                </div>
            ` : ''}
            ${currentProject.target_market ? `
                <div class="info-row">
                    <div class="info-label">Target Market</div>
                    <div class="info-value">${currentProject.target_market}</div>
                </div>
            ` : ''}
            ${currentProject.monetization ? `
                <div class="info-row">
                    <div class="info-label">Monetization</div>
                    <div class="info-value">${currentProject.monetization}</div>
                </div>
            ` : ''}
            ${currentProject.pricing ? `
                <div class="info-row">
                    <div class="info-label">Pricing</div>
                    <div class="info-value">${currentProject.pricing}</div>
                </div>
            ` : ''}
            <div class="info-row">
                <div class="info-label">Created</div>
                <div class="info-value" style="color: #888; font-size: 0.85rem;">${currentProject.created_at ? new Date(currentProject.created_at * 1000).toLocaleString() : '—'}</div>
            </div>
            <div class="info-row">
                <div class="info-label">Last updated</div>
                <div class="info-value" style="color: #888; font-size: 0.85rem;">${currentProject.updated_at ? new Date(currentProject.updated_at * 1000).toLocaleString() : '—'}</div>
            </div>
            ${currentProject.launched_at ? `
                <div class="info-row">
                    <div class="info-label">Launched</div>
                    <div class="info-value" style="color: #888; font-size: 0.85rem;">${new Date(currentProject.launched_at * 1000).toLocaleString()}</div>
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
        <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 32px; max-width: 800px; margin: 0 auto;">
            <h2 style="margin-bottom: 24px; color: #fff;">Edit Project</h2>
            <form id="editProjectForm" onsubmit="updateProject(event)">
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Project Name *</label>
                    <input type="text" name="name" value="${currentProject.name}" required style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Description</label>
                    <textarea name="description" rows="3" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">${currentProject.description || ''}</textarea>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Status</label>
                        <select name="status" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                            <option value="idea" ${currentProject.status === 'idea' ? 'selected' : ''}>💡 Idea</option>
                            <option value="planning" ${currentProject.status === 'planning' ? 'selected' : ''}>📋 Planning</option>
                            <option value="building" ${currentProject.status === 'building' ? 'selected' : ''}>🔨 Building</option>
                            <option value="launched" ${currentProject.status === 'launched' ? 'selected' : ''}>🚀 Launched</option>
                            <option value="paused" ${currentProject.status === 'paused' ? 'selected' : ''}>⏸️ Paused</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Category</label>
                        <select name="category" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                            <option value="app" ${currentProject.category === 'app' ? 'selected' : ''}>📱 App</option>
                            <option value="saas" ${currentProject.category === 'saas' ? 'selected' : ''}>☁️ SaaS</option>
                            <option value="utility" ${currentProject.category === 'utility' ? 'selected' : ''}>🔧 Utility</option>
                            <option value="tool" ${currentProject.category === 'tool' ? 'selected' : ''}>🛠️ Tool</option>
                        </select>
                    </div>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Repository URL</label>
                    <input type="url" name="repo_url" value="${currentProject.repo_url || ''}" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Live URL</label>
                    <input type="url" name="live_url" value="${currentProject.live_url || ''}" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Local Path</label>
                    <input type="text" name="local_path" value="${(currentProject.local_path || '').replace(/"/g, '&quot;')}" placeholder="e.g., C:\\home\\bfoster\\my-project" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace;">
                    <div style="color: #666; font-size: 0.8rem; margin-top: 4px;">Where the local clone lives. Leave blank if not cloned yet.</div>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Stack</label>
                    <input type="text" name="stack" value="${(currentProject.stack || '').replace(/"/g, '&quot;')}" placeholder="e.g., Next.js 15 + TypeScript + Tailwind + SQLite" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Prompt / Vision</label>
                    <textarea name="prompt" rows="4" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">${escapeHtml(currentProject.prompt || '')}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">PRD</label>
                    <textarea name="prd" rows="6" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;">${escapeHtml(currentProject.prd || '')}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">References (one per line)</label>
                    <textarea name="references" rows="3" placeholder="https://docs... or file paths" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;">${(() => {
                        try { const r = currentProject.references_json ? JSON.parse(currentProject.references_json) : []; return escapeHtml(r.join('\n')); }
                        catch { return ''; }
                    })()}</textarea>
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">README (optional)</label>
                    <textarea name="readme" rows="8" placeholder="Paste or edit README content here..." style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;">${(currentProject.readme || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
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
        alert(`Error: ${error.message}`);
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

        if (data.running) {
            if (launchBtn) launchBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (data.url) {
                if (urlChip) {
                    urlChip.innerHTML = `🟢 Running: <a href="${data.url}" target="_blank" style="color: #93c5fd;">${data.url}</a> (pid ${data.pid})`;
                    urlChip.style.display = 'inline';
                }
                // Auto-open browser the first time we learn the URL for this session
                if (_lastDetectedUrl !== data.url) {
                    _lastDetectedUrl = data.url;
                    window.open(data.url, '_blank');
                }
            } else {
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
            if (urlChip) urlChip.style.display = 'none';
            _lastDetectedUrl = null;
        }
    } catch (e) { /* non-fatal */ }
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
    if (!confirm('Stop the running dev server?')) return;
    try {
        const r = await fetch(`/api/projects/${currentProject.id}/stop`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Stop failed');
        showToast(`Stopped pid ${data.pid}`);
        await refreshRunningState();
    } catch (e) {
        alert(`Error: ${e.message}`);
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
        alert(`Error: ${e.message}`);
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

        if (!res.ok) throw new Error(data.error || 'Launch failed');

        if (data.type === 'url') {
            window.open(data.url, '_blank');
            showToast(`Opened ${data.url}`);
        } else if (data.type === 'spawned') {
            showToast(`${data.command} started (pid ${data.pid}) — waiting for URL…`);
            if (data.live_url) window.open(data.live_url, '_blank');
            // Kick off poll so the URL chip + Stop button appear immediately,
            // and auto-opens the browser once the dev server prints its URL.
            startRunningPoll();
        } else {
            alert(JSON.stringify(data, null, 2));
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
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
    setTimeout(() => document.getElementById('commitMessage').focus(), 50);
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
        if (data.results.commit) {
            if (data.results.commit.ok) parts.push('✅ Committed');
            else if (data.results.commit.skipped) parts.push('⏭ Nothing to commit');
            else parts.push(`❌ Commit failed:\n${data.results.commit.error}`);
        }
        if (data.results.push) {
            if (data.results.push.ok) parts.push('✅ Pushed to origin\n' + (data.results.push.output || ''));
            else parts.push(`❌ Push failed:\n${data.results.push.error}`);
        }
        resultEl.textContent = parts.join('\n\n') || 'Done.';

        // If at least one step succeeded, refresh sync + schedule auto-close
        const anySuccess = (data.results.commit && data.results.commit.ok) ||
                           (data.results.push && data.results.push.ok) ||
                           (data.results.commit && data.results.commit.skipped);
        if (anySuccess) {
            setTimeout(() => {
                closeCommitModal();
                // If the sync panel is visible, refresh it
                if (document.getElementById('syncStatus') && document.getElementById('syncStatus').style.display !== 'none') {
                    checkSyncStatus();
                }
            }, 1500);
        }
    } catch (e) {
        resultEl.textContent = `❌ ${e.message}`;
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
        alert(`Error: ${e.message}`);
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
            throw new Error(data.error || 'Failed to clone');
        }
        
        showToast(`✅ Cloned to ${data.local_path}`);
        showProject(currentProject.id); // Reload
    } catch (error) {
        alert(`Error: ${error.message}`);
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
            <div style="padding: 16px; background: #0f0f0f; border-left: 4px solid ${statusColor}; border-radius: 8px;">
                <div style="font-weight: 600; color: ${statusColor}; margin-bottom: 8px;">
                    ${statusIcon} ${data.status.toUpperCase().replace('_', ' ')}
                </div>
        `;
        
        if (data.messages) {
            statusHTML += `<ul style="margin: 8px 0; padding-left: 20px; color: #e0e0e0;">`;
            data.messages.forEach(msg => {
                statusHTML += `<li>${msg}</li>`;
            });
            statusHTML += `</ul>`;
        }
        
        if (data.details && data.details.lastCommit) {
            statusHTML += `
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333; font-size: 0.9rem; color: #888;">
                    <div><strong>Branch:</strong> ${data.details.branch}</div>
                    <div><strong>Last commit:</strong> ${data.details.lastCommit.hash} - ${data.details.lastCommit.message}</div>
                    <div><strong>When:</strong> ${data.details.lastCommit.timeAgo}</div>
                </div>
            `;
        }

        // Action buttons appropriate to the sync state
        const actions = [];
        if (data.status === 'dirty' || data.status === 'unpushed') {
            const needsCommit = data.status === 'dirty';
            actions.push(`<button class="btn btn-primary" onclick="showCommitDialog(${needsCommit ? 'true' : 'false'})">💾 Commit ${needsCommit ? '& ' : ''}Push</button>`);
        }
        if (data.status === 'behind') {
            actions.push(`<button class="btn btn-primary" onclick="pullProject()">⬇️ Pull (ff-only)</button>`);
        }
        if (actions.length) {
            statusHTML += `<div style="margin-top: 12px; display: flex; gap: 8px;">${actions.join('')}</div>`;
        }

        statusHTML += `</div>`;
        
        syncStatus.innerHTML = statusHTML;
        syncStatus.style.display = 'block';
        
        btn.disabled = false;
        btn.textContent = '🔄 Check Sync Status';
    } catch (error) {
        alert(`Error: ${error.message}`);
        document.getElementById('syncBtn').disabled = false;
        document.getElementById('syncBtn').textContent = '🔄 Check Sync Status';
    }
}

// ========== BULK IMPORT ==========

async function showBulkImport() {
    document.getElementById('bulkImportModal').style.display = 'block';
    showImportTab('url'); // Default to URL tab
    // If a PAT is stored in Settings, prefill the field so users don't re-paste.
    try {
        const s = await (await fetch('/api/settings')).json();
        const input = document.getElementById('githubToken');
        if (s.github_pat && s.github_pat.set && !input.value) {
            // Server hides the real token (only returns a 7-char preview). Mark the
            // field so loadGitHubRepos knows to use the stored PAT rather than
            // whatever's in the field.
            input.value = '__USE_STORED__';
            input.placeholder = `Using stored token (${s.github_pat.preview}) — edit to override`;
            input.dataset.usesStored = 'true';
        }
    } catch (e) { /* non-fatal */ }
}

function hideBulkImport() {
    document.getElementById('bulkImportModal').style.display = 'none';
    document.getElementById('importUrl').value = '';
    document.getElementById('githubToken').value = '';
    document.getElementById('repoList').style.display = 'none';
    showImportTab('url');
}

function showImportTab(tab) {
    // Update tab buttons
    document.getElementById('importUrlTab').classList.toggle('active', tab === 'url');
    document.getElementById('importBulkTab').classList.toggle('active', tab === 'bulk');
    
    // Update tab sections
    document.getElementById('importUrlSection').style.display = tab === 'url' ? 'block' : 'none';
    document.getElementById('importBulkSection').style.display = tab === 'bulk' ? 'block' : 'none';
}

async function importByUrl() {
    const url = document.getElementById('importUrl').value.trim();
    if (!url) {
        alert('Enter a GitHub URL');
        return;
    }
    
    await importGitHubRepo(url);
    hideBulkImport();
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
        document.getElementById('repoCount').textContent = githubRepos.length;
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function renderGitHubReposList() {
    const container = document.getElementById('repoListContent');
    
    if (githubRepos.length === 0) {
        container.innerHTML = '<div class="empty-state">No repositories found</div>';
        return;
    }
    
    // Check which repos are already imported
    const importedUrls = new Set(projects.filter(p => p.repo_url).map(p => p.repo_url));
    
    container.innerHTML = githubRepos.map(repo => {
        const isImported = importedUrls.has(repo.html_url);
        const statusBadge = getStatusBadge(repo.inferredStatus);
        
        return `
            <div style="padding: 16px; background: ${isImported ? '#0f0f0f' : '#1a1a1a'}; border: 1px solid #333; border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; align-items: start; gap: 12px;">
                    <input type="checkbox" 
                           class="repo-checkbox" 
                           data-repo='${JSON.stringify(repo).replace(/'/g, "&apos;")}' 
                           ${isImported ? 'disabled' : ''} 
                           style="margin-top: 4px;">
                    <div style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div style="font-weight: 600; color: ${isImported ? '#666' : '#fff'};">${repo.name}</div>
                            ${isImported ? '<span style="color: #10b981; font-size: 0.85rem;">✓ Imported</span>' : statusBadge}
                        </div>
                        <div style="color: #888; font-size: 0.9rem; margin-bottom: 8px;">${repo.description || 'No description'}</div>
                        <div style="display: flex; gap: 16px; font-size: 0.85rem; color: #666;">
                            ${repo.language ? `<span>🔧 ${repo.language}</span>` : ''}
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
        planning: '#3b82f6',
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
        
        alert(`Imported ${data.imported} projects!`);
        loadProjects();
        hideBulkImport();
    } catch (error) {
        alert(`Error: ${error.message}`);
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
    // Re-render trending/search so the pin button state updates
    if (typeof trendingRepos !== 'undefined' && trendingRepos.length) renderTrending();
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

// ========== TRENDING ==========

async function loadTrending() {
    const range = document.getElementById('trendingRange')?.value || 'monthly';
    const lang = document.getElementById('discoverLanguage')?.value || '';
    const params = new URLSearchParams({ since: range });
    if (lang) params.set('language', lang);
    try {
        const response = await fetch(`/api/github/trending?${params.toString()}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load trending');
        trendingRepos = data.items || [];
        renderTrending();
        renderPinned();
    } catch (error) {
        console.error('Error loading trending:', error);
        const container = document.getElementById('trendingList');
        if (container) container.innerHTML = `<div class="empty-state">Couldn't load trending: ${error.message}</div>`;
    }
}

function renderTrending() {
    const container = document.getElementById('trendingList');
    if (!container) return;
    if (!trendingRepos || trendingRepos.length === 0) {
        container.innerHTML = '<div class="empty-state">No trending repos — try a different range.</div>';
        return;
    }
    container.innerHTML = trendingRepos.map(repo => renderGitHubRepoCard(repo)).join('');
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
                <div class="repo-name" style="font-weight: 600; color: #93c5fd;">${repo.full_name}</div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="btn btn-sm ${pinned ? 'btn-primary' : 'btn-secondary'}" onclick="togglePin('${repo.full_name}', '${repoJson}'); event.stopPropagation();" title="${pinned ? 'Unpin' : 'Pin to top'}">${pinned ? '📌 Pinned' : '📌 Pin'}</button>
                    <div class="repo-stars" style="color: #888; font-size: 0.9rem;">⭐ ${stars}</div>
                </div>
            </div>
            <div class="repo-description" style="margin: 8px 0; color: #ccc;">${repo.description || 'No description'}</div>
            <div class="repo-meta" style="color: #888; font-size: 0.85rem; display: flex; gap: 12px;">
                ${repo.language ? `<span>🔧 ${repo.language}</span>` : ''}
                <span>🍴 ${forks} forks</span>
            </div>
            <div class="repo-actions" style="margin-top: 12px; display: flex; gap: 8px;">
                <button class="btn btn-sm" onclick="importGitHubRepo('${repo.html_url}')">📥 Import</button>
                <a href="${repo.html_url}" target="_blank" class="btn btn-sm btn-secondary">View on GitHub</a>
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
                alert('Repository already imported');
                return;
            }
            throw new Error(data.error || 'Import failed');
        }
        
        alert(`Imported ${data.project.name}!`);
        loadProjects();
    } catch (error) {
        alert(`Error: ${error.message}`);
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
            element.style.color = '#60a5fa';
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
            const labels = (i.labels || []).map(l => `<span style="background: #${l.color || '888'}22; color: #${l.color || 'ccc'}; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${l.name}</span>`).join(' ');
            return `
                <div class="update-item" style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
                    <div style="flex: 1;">
                        <div class="update-title">
                            <a href="${i.html_url}" target="_blank" style="color: #93c5fd; text-decoration: none;">
                                ${stateIcon} #${i.number} · ${i.title}
                            </a>
                        </div>
                        <div style="font-size: 0.8rem; color: #888; margin-top: 4px;">
                            by ${i.user || 'unknown'} · ${formatDate(new Date(i.created_at).getTime() / 1000)} · 💬 ${i.comments}
                        </div>
                        ${labels ? `<div style="margin-top: 6px;">${labels}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        list.innerHTML = `<div class="empty-state">⚠ ${e.message}</div>`;
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
                        <a href="${c.html_url}" target="_blank" style="color: #93c5fd; text-decoration: none; font-family: monospace;">${c.short}</a>
                        · ${escapeHtml(c.message)}
                    </div>
                    <div class="update-time">${c.date ? formatDate(new Date(c.date).getTime() / 1000) : ''}</div>
                </div>
                <div style="font-size: 0.8rem; color: #888; margin-top: 4px;">
                    ${c.author_login ? `@${c.author_login}` : c.author || 'unknown'}
                </div>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = `<div class="empty-state">⚠ ${e.message}</div>`;
    }
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        alert(`Error: ${e.message}`);
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
        alert(`Error: ${e.message}`);
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
        alert(`Error: ${e.message}`);
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

function renderNeoPopular() {
    const gridDiv = document.getElementById('neoPopularGrid');
    
    if (neoProjects.length === 0) {
        gridDiv.innerHTML = '<div class="loading">No repositories</div>';
        return;
    }
    
    // Calculate popular repos
    const mostRecent = [...neoProjects].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
    const mostPopular = [...neoProjects].sort((a, b) => (b.stars || 0) - (a.stars || 0))[0];
    
    // Largest = most activity or commits (use updated_at as proxy)
    const largest = [...neoProjects].filter(p => p.local_path).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
    
    // Closest to ship = status 'building' with recent activity
    const closestToShip = [...neoProjects]
        .filter(p => p.status === 'building' || p.status === 'launched')
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0] || mostRecent;
    
    const cards = [
        { title: 'Most Recent', project: mostRecent, emoji: '🕐' },
        { title: 'Most Popular', project: mostPopular, emoji: '⭐' },
        { title: 'Largest', project: largest, emoji: '📦' },
        { title: 'Closest to Ship', project: closestToShip, emoji: '🚀' }
    ];
    
    gridDiv.innerHTML = cards.map(card => {
        const p = card.project;
        if (!p) return '';
        
        const language = p.tech_stack || 'Unknown';
        const stars = p.stars || 0;
        const forks = p.forks || 0;
        
        return `
            <div class="neo-popular-card">
                <h3>
                    <a href="#" onclick="viewProject(${p.id}); return false;" style="color: #58a6ff; text-decoration: none;">
                        ${p.name}
                    </a>
                </h3>
                <p>${p.description || 'No description'}</p>
                <div class="neo-popular-meta">
                    <span><span class="neo-language-dot"></span> ${language}</span>
                    <span>⭐ ${stars}</span>
                    <span>🔱 ${forks}</span>
                </div>
            </div>
        `;
    }).join('');
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
        
        return `
            <div class="neo-repo-item" style="cursor: pointer;" onclick="if(!event.target.closest('.neo-action-btn,.neo-repo-actions,a,button'))showProject(${project.id})">
                <div class="neo-repo-header">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <a href="#" class="neo-repo-name" onclick="event.stopPropagation(); showProject(${project.id}); return false;">
                            ${project.name}
                        </a>
                        <span class="neo-public-badge">Public</span>
                    </div>
                    ${syncStatus !== 'unknown' ? `
                        <span class="neo-sync-badge ${syncBadgeClass}">
                            ${syncIcon} ${syncText}
                        </span>
                    ` : ''}
                </div>
                
                <div class="neo-repo-description">
                    ${project.description || 'No description'}
                </div>
                
                <div class="neo-repo-meta">
                    <span><span class="neo-language-dot"></span> ${language}</span>
                    ${stars > 0 ? `<span class="neo-meta-separator">•</span><span>⭐ ${stars}</span>` : ''}
                    ${forks > 0 ? `<span class="neo-meta-separator">•</span><span>🔱 ${forks}</span>` : ''}
                    ${pathShort ? `<span class="neo-meta-separator">•</span><span>📁 ${pathShort}</span>` : ''}
                    <span class="neo-meta-separator">•</span>
                    <span>Updated ${updated}</span>
                </div>
                
                ${localPath ? `
                    <div class="neo-repo-actions">
                        <button class="neo-action-btn" onclick="copyNeoPath('${localPath}')">
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

