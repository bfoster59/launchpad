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
    
    // Load data for view
    if (viewName === 'discover') {
        loadTrending();
    } else if (viewName === 'githubNeo') {
        loadNeoView();
    } else if (viewName === 'settings') {
        loadSettings();
    }
}

// ========== SETTINGS ==========

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();

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
    showView(previousView);
}

// ========== PROJECT CREATION ==========

function showAddProject() {
    const form = `
        <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 32px; max-width: 600px; margin: 0 auto;">
            <h2 style="margin-bottom: 24px; color: #fff;">New Project</h2>
            <form id="newProjectForm" onsubmit="saveProject(event)">
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Project Name *</label>
                    <input type="text" name="name" required style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                </div>
                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Description</label>
                    <textarea name="description" rows="3" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;"></textarea>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Status</label>
                        <select name="status" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                            <option value="idea">💡 Idea</option>
                            <option value="planning">📋 Planning</option>
                            <option value="building">🔨 Building</option>
                            <option value="launched">🚀 Launched</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Category</label>
                        <select name="category" style="width: 100%; padding: 10px; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; color: #e0e0e0;">
                            <option value="app">📱 App</option>
                            <option value="saas">☁️ SaaS</option>
                            <option value="utility">🔧 Utility</option>
                            <option value="tool">🛠️ Tool</option>
                        </select>
                    </div>
                </div>
                <div style="display: flex; gap: 12px; margin-top: 24px;">
                    <button type="submit" class="btn btn-primary">Create Project</button>
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
    
    const data = {
        name: formData.get('name'),
        description: formData.get('description'),
        status: formData.get('status'),
        category: formData.get('category'),
        source: 'manual'
    };
    
    try {
        const response = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) throw new Error('Failed to create project');
        
        alert('Project created!');
        loadProjects();
        showView('myProjects');
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
        renderGitHubProjects();
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

function renderGitHubProjects() {
    const githubProjects = projects.filter(p => p.source === 'github');
    
    document.getElementById('githubProjectsList').innerHTML = githubProjects.length > 0
        ? githubProjects.map(p => renderProjectCard(p)).join('')
        : '<div class="empty-state">No GitHub repos imported yet</div>';
}

function renderProjectCard(p) {
    const categoryIcon = getCategoryIcon(p.category);
    const sourceIcon = p.source === 'github' ? '🐙' : '';
    const localIcon = p.local_path ? '📁' : '';
    
    return `
        <div class="project-card" onclick="showProject(${p.id})">
            <div class="project-status status-${p.status}">${p.status}</div>
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

async function showProject(id) {
    try {
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
        
        // Render clone/sync/launch buttons
        const cloneBtn = document.getElementById('cloneBtn');
        const syncBtn = document.getElementById('syncBtn');
        const launchBtn = document.getElementById('launchBtn');

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

        // Launch is available when we have something to launch (local or live url)
        if (launchBtn) {
            const canLaunch = Boolean(currentProject.local_path || currentProject.live_url);
            launchBtn.style.display = canLaunch ? 'inline-block' : 'none';
        }
        
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
                        <span style="color: #60a5fa; cursor: pointer; text-decoration: underline;" onclick="copyToClipboard('${currentProject.local_path}', this)" title="Click to copy path">${currentProject.local_path}</span>
                        <button class="btn btn-sm" style="margin-left: 8px;" onclick="copyTerminalCommand('${currentProject.local_path}')" title="Copy terminal command">📋 Copy cd command</button>
                    </div>
                </div>
            ` : ''}
            ${currentProject.tech_stack ? `
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
    
    const data = {
        name: formData.get('name'),
        description: formData.get('description'),
        status: formData.get('status'),
        category: formData.get('category'),
        repo_url: formData.get('repo_url') || null,
        live_url: formData.get('live_url') || null,
        readme: formData.get('readme') || null
    };
    
    try {
        const response = await fetch(`/api/projects/${currentProject.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) throw new Error('Failed to update project');
        
        alert('Project updated!');
        _restoreDetailFromBackup();
        loadProjects();
        showProject(currentProject.id);
    } catch (error) {
        alert(`Error: ${error.message}`);
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
        if (!res.ok) throw new Error(data.error || 'Launch failed');

        if (data.type === 'url') {
            window.open(data.url, '_blank');
            showToast(`Opened ${data.url}`);
        } else if (data.type === 'spawned') {
            const liveNote = data.live_url ? `\nLive URL: ${data.live_url}` : '';
            alert(`🚀 ${data.command} spawned in:\n${data.cwd}\n(pid ${data.pid})${liveNote}\n\n${data.note || ''}`);
            if (data.live_url) window.open(data.live_url, '_blank');
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

async function showCommitDialog(needsCommit) {
    if (!currentProject) return;

    let message = null;
    if (needsCommit) {
        message = prompt('Commit message:');
        if (message === null) return; // user cancelled
        message = message.trim();
        if (!message) {
            alert('Commit message cannot be empty.');
            return;
        }
    } else {
        if (!confirm('Push existing commits to origin?')) return;
    }

    try {
        const res = await fetch(`/api/projects/${currentProject.id}/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message || '', push: true, addAll: needsCommit })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Commit failed');

        // Summarize result
        const parts = [];
        if (data.results.commit) {
            if (data.results.commit.ok) parts.push('✅ Committed');
            else if (data.results.commit.skipped) parts.push('⏭ Nothing to commit');
            else parts.push(`❌ Commit failed: ${data.results.commit.error}`);
        }
        if (data.results.push) {
            if (data.results.push.ok) parts.push('✅ Pushed to origin');
            else parts.push(`❌ Push failed: ${data.results.push.error}`);
        }
        alert(parts.join('\n'));

        // Refresh sync status to reflect new state
        await checkSyncStatus();
    } catch (e) {
        alert(`Error: ${e.message}`);
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
        
        alert(`Cloned successfully to: ${data.local_path}`);
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

function showBulkImport() {
    document.getElementById('bulkImportModal').style.display = 'block';
    showImportTab('url'); // Default to URL tab
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
    const token = document.getElementById('githubToken').value.trim();
    if (!token) {
        alert('Enter your GitHub token');
        return;
    }
    
    try {
        // Set the token
        const tokenResponse = await fetch('/api/github/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        
        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json().catch(() => ({ error: 'Invalid token' }));
            throw new Error(errorData.error || 'Invalid token');
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
    if (!query) {
        alert('Enter a search term');
        return;
    }
    
    document.getElementById('searchLoading').style.display = 'block';
    document.getElementById('searchResults').style.display = 'none';
    
    try {
        const response = await fetch(`/api/github/search?q=${encodeURIComponent(query)}&per_page=20`);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Search failed');
        }
        
        searchResults = data.items;
        renderSearchResults();
        
        document.getElementById('searchLoading').style.display = 'none';
        document.getElementById('searchResults').style.display = 'block';
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
    
    container.innerHTML = `
        <div style="margin-bottom: 16px; color: #888;">Found ${searchResults.length} repositories</div>
        ${searchResults.map(repo => renderGitHubRepoCard(repo)).join('')}
    `;
}

// ========== TRENDING ==========

async function loadTrending() {
    try {
        const response = await fetch('/api/github/trending?since=monthly');
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to load trending');
        }
        
        trendingRepos = data.items;
        renderTrending();
    } catch (error) {
        console.error('Error loading trending:', error);
    }
}

function renderTrending() {
    const container = document.getElementById('trendingList');
    
    if (trendingRepos.length === 0) {
        container.innerHTML = '<div class="empty-state">Loading trending repos...</div>';
        return;
    }
    
    container.innerHTML = `
        <div style="margin-bottom: 16px; color: #888;">Top trending repos this month</div>
        ${trendingRepos.map(repo => renderGitHubRepoCard(repo)).join('')}
    `;
}

function renderGitHubRepoCard(repo) {
    return `
        <div class="github-repo-card">
            <div class="repo-header">
                <div class="repo-name">${repo.full_name}</div>
                <div class="repo-stars">⭐ ${repo.stargazers_count.toLocaleString()}</div>
            </div>
            <div class="repo-description">${repo.description || 'No description'}</div>
            <div class="repo-meta">
                ${repo.language ? `<span>🔧 ${repo.language}</span>` : ''}
                <span>🍴 ${repo.forks_count.toLocaleString()} forks</span>
            </div>
            <div class="repo-actions">
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

function copyTerminalCommand(path) {
    const command = `cd "${path}"`;
    navigator.clipboard.writeText(command).then(() => {
        alert('Copied to clipboard! Paste in your terminal to navigate to this project.');
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

async function loadNeoView() {
    try {
        const response = await fetch('/api/projects');
        neoProjects = await response.json();
        neoFilteredProjects = neoProjects;
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
    const listDiv = document.getElementById('neoRepoList');
    
    if (neoFilteredProjects.length === 0) {
        listDiv.innerHTML = '<div class="loading">No repositories found</div>';
        return;
    }
    
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
            <div class="neo-repo-item">
                <div class="neo-repo-header">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <a href="#" class="neo-repo-name" onclick="viewProject(${project.id}); return false;">
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

async function checkSingleSync(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}/sync-status`);
        const data = await response.json();
        
        // Update the project in our local array
        const index = neoProjects.findIndex(p => p.id === projectId);
        if (index !== -1) {
            neoProjects[index].sync_status = data.sync_status;
        }
        
        filterNeoRepos(); // Re-render
        alert(`Sync Status: ${getSyncText(data.sync_status)}\n\n${data.message || ''}`);
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
        
        // Update all projects
        results.forEach((data, i) => {
            const project = neoProjects.filter(p => p.local_path)[i];
            if (project) {
                project.sync_status = data.sync_status;
            }
        });
        
        filterNeoRepos();
        alert('✓ All repositories checked!');
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

