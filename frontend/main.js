/**
 * HomePiNAS - Main Entry Point
 * v2.0.0 - Modular Architecture with URL Routing
 */

// Import state and configuration
import { state, API_BASE, viewsMap } from './state.js';

// Import utilities
import { escapeHtml } from './utils/helpers.js';
import { authFetch, saveSession, loadSession, clearSession, updatePublicIP } from './utils/api.js';

// Import router
import { initRouter, navigateTo, handleRoute, setupSidebarNavigation, switchToDashboard, registerView } from './router.js';

// Import views (they self-register with the router)
import './views/dashboard.js';
import './views/docker.js';
import './views/storage.js';
import './views/network.js';
import './views/system.js';

// DOM Elements
const views = {
    setup: document.getElementById('setup-view'),
    storage: document.getElementById('storage-view'),
    login: document.getElementById('login-view'),
    dashboard: document.getElementById('dashboard-view')
};

const setupForm = document.getElementById('setup-form');
const loginForm = document.getElementById('login-form');
const resetBtn = document.getElementById('reset-setup-btn');

// DDNS Elements
const ddnsModal = document.getElementById('ddns-modal');
const closeModalBtn = document.getElementById('close-modal');

// Storage Progress Modal Elements
const progressModal = document.getElementById('storage-progress-modal');
const progressSteps = {
    format: document.getElementById('step-format'),
    mount: document.getElementById('step-mount'),
    snapraid: document.getElementById('step-snapraid'),
    mergerfs: document.getElementById('step-mergerfs'),
    fstab: document.getElementById('step-fstab'),
    sync: document.getElementById('step-sync')
};

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize authentication and determine initial view
 */
async function initAuth() {
    try {
        loadSession();

        const [statusRes, disksRes] = await Promise.all([
            fetch(`${API_BASE}/system/status`),
            fetch(`${API_BASE}/system/disks`)
        ]);

        if (!statusRes.ok || !disksRes.ok) {
            throw new Error('Failed to fetch initial data');
        }

        const status = await statusRes.json();
        state.disks = await disksRes.json();

        state.user = status.user;
        state.storageConfig = status.storageConfig;
        state.network = status.network;

        // Determine initial view based on state
        if (state.sessionId && state.user && state.storageConfig.length > 0) {
            state.isAuthenticated = true;
            switchToDashboard();
            updateSidebarUser();

            // Handle current URL or default to dashboard
            const path = window.location.pathname;
            if (path === '/' || path === '/login' || path === '/setup') {
                navigateTo('/', true);
            } else {
                handleRoute(path);
            }
        } else if (state.user && state.storageConfig.length > 0) {
            navigateTo('/login', true);
            showView('login');
        } else if (state.user) {
            showView('storage');
            initStorageSetup();
        } else {
            navigateTo('/setup', true);
            showView('setup');
        }
    } catch (e) {
        console.error('Backend Offline', e);
        showView('setup');
    }

    startGlobalPolling();
}

/**
 * Show a specific view (setup/login/storage/dashboard)
 */
function showView(viewName) {
    Object.values(views).forEach(v => {
        if (v) v.classList.remove('active');
    });
    if (views[viewName]) {
        views[viewName].classList.add('active');
    }
    updateHeaderIPVisibility();
}

/**
 * Update header IP visibility based on current view
 */
function updateHeaderIPVisibility() {
    const ipContainer = document.getElementById('public-ip-container');
    if (ipContainer) {
        const activeNav = document.querySelector('.nav-links li.active');
        const view = activeNav ? activeNav.dataset.view : '';
        const isAuth = views.dashboard.classList.contains('active');
        ipContainer.style.display = (isAuth && (view === 'network' || view === 'dashboard')) ? 'flex' : 'none';
    }
}

/**
 * Update sidebar username display
 */
function updateSidebarUser() {
    const usernameEl = document.getElementById('sidebar-username');
    if (usernameEl && state.user) {
        usernameEl.textContent = state.user.username || 'Usuario';
    }
}

/**
 * Handle logout
 */
function handleLogout() {
    if (!confirm('¿Estás seguro de que quieres cerrar sesión?')) return;

    clearSession();
    state.isAuthenticated = false;
    state.user = null;
    navigateTo('/login', true);
    showView('login');
}

// Setup logout button
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
}

// =============================================================================
// GLOBAL POLLING
// =============================================================================

function startGlobalPolling() {
    // Poll system stats every 2 seconds
    state.pollingIntervals.stats = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/system/stats`);
            if (res.ok) {
                state.globalStats = await res.json();

                // Re-render dashboard if active
                const activeNav = document.querySelector('.nav-links li.active');
                if (activeNav && activeNav.dataset.view === 'dashboard') {
                    const { renderDashboard } = await import('./views/dashboard.js');
                    renderDashboard();
                }
            }
        } catch (e) {
            console.error('Stats polling error:', e);
        }
    }, 2000);

    // Poll public IP every 10 minutes
    updatePublicIP();
    state.pollingIntervals.publicIP = setInterval(async () => {
        await updatePublicIP();
        const activeNav = document.querySelector('.nav-links li.active');
        if (activeNav && activeNav.dataset.view === 'network') {
            const { renderNetworkManager } = await import('./views/network.js');
            renderNetworkManager();
        }
    }, 1000 * 60 * 10);
}

// =============================================================================
// SETUP FORM
// =============================================================================

if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('new-username').value.trim();
        const password = document.getElementById('new-password').value;
        const btn = e.target.querySelector('button');
        btn.textContent = 'Hardware Sync...';
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (!res.ok) {
                alert(data.message || 'Setup failed');
                btn.disabled = false;
                btn.textContent = 'Initialize Gateway';
                return;
            }

            if (data.sessionId) {
                saveSession(data.sessionId);
            }

            state.user = { username };
            showView('storage');
            initStorageSetup();
        } catch (e) {
            console.error('Setup error:', e);
            alert('Hardware Link Failed');
            btn.disabled = false;
            btn.textContent = 'Initialize Gateway';
        }
    });
}

// =============================================================================
// LOGIN FORM
// =============================================================================

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const btn = e.target.querySelector('button[type="submit"]');

        btn.textContent = 'Hardware Auth...';
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                alert(data.message || 'Security Error: Credentials Rejected by Hardware.');
                btn.textContent = 'Access Gateway';
                btn.disabled = false;
                return;
            }

            if (data.sessionId) {
                saveSession(data.sessionId);
            }

            state.isAuthenticated = true;
            state.user = data.user;
            switchToDashboard();
            updateSidebarUser();
            navigateTo('/');
        } catch (e) {
            console.error('Login error:', e);
            alert('Security Server Offline or Network Link Broken');
            btn.textContent = 'Access Gateway';
            btn.disabled = false;
        }
    });
}

// =============================================================================
// STORAGE SETUP
// =============================================================================

function initStorageSetup() {
    const tableBody = document.getElementById('granular-disk-list');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    state.disks.forEach(disk => {
        const tr = document.createElement('tr');

        const diskInfoTd = document.createElement('td');
        const diskInfoDiv = document.createElement('div');
        diskInfoDiv.className = 'disk-info';

        const modelStrong = document.createElement('strong');
        modelStrong.textContent = disk.model || 'Unknown';

        const infoSpan = document.createElement('span');
        infoSpan.textContent = `${disk.id || 'N/A'} • ${disk.size || 'N/A'}`;

        diskInfoDiv.appendChild(modelStrong);
        diskInfoDiv.appendChild(infoSpan);
        diskInfoTd.appendChild(diskInfoDiv);

        const typeTd = document.createElement('td');
        const typeBadge = document.createElement('span');
        typeBadge.className = `badge ${escapeHtml((disk.type || 'unknown').toLowerCase())}`;
        typeBadge.textContent = disk.type || 'Unknown';
        typeTd.appendChild(typeBadge);

        const roleTd = document.createElement('td');
        const roleDiv = document.createElement('div');
        roleDiv.className = 'role-selector';
        roleDiv.dataset.disk = disk.id;

        const roles = ['none', 'data', 'parity'];
        if (disk.type === 'NVMe' || disk.type === 'SSD') {
            roles.push('cache');
        }

        roles.forEach((role, index) => {
            const btn = document.createElement('button');
            btn.className = `role-btn${index === 0 ? ' active' : ''}`;
            btn.dataset.role = role;
            btn.textContent = role.charAt(0).toUpperCase() + role.slice(1);
            roleDiv.appendChild(btn);
        });

        roleTd.appendChild(roleDiv);

        tr.appendChild(diskInfoTd);
        tr.appendChild(typeTd);
        tr.appendChild(roleTd);
        tableBody.appendChild(tr);
    });

    document.querySelectorAll('.role-btn').forEach(btn => {
        btn.onclick = (e) => {
            const container = e.target.parentElement;
            container.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            updateSummary();
        };
    });
}

function updateSummary() {
    const roles = { data: 0, parity: 0, cache: 0 };
    document.querySelectorAll('.role-btn.active').forEach(btn => {
        const role = btn.dataset.role;
        if (role !== 'none') roles[role]++;
    });
    document.getElementById('data-count').textContent = roles.data;
    document.getElementById('parity-count').textContent = roles.parity;
    document.getElementById('cache-count').textContent = roles.cache;
}

// =============================================================================
// STORAGE PROGRESS MODAL
// =============================================================================

function showProgressModal() {
    if (progressModal) {
        progressModal.classList.add('active');
        Object.values(progressSteps).forEach(step => {
            if (step) {
                step.classList.remove('active', 'completed', 'error');
                const icon = step.querySelector('.step-icon');
                if (icon) icon.textContent = '⏳';
            }
        });
    }
}

function hideProgressModal() {
    if (progressModal) progressModal.classList.remove('active');
}

function updateProgressStep(stepId, status) {
    const step = progressSteps[stepId];
    if (!step) return;

    const icon = step.querySelector('.step-icon');
    step.classList.remove('active', 'completed', 'error');

    if (status === 'active') {
        step.classList.add('active');
        if (icon) icon.textContent = '';
    } else if (status === 'completed') {
        step.classList.add('completed');
        if (icon) icon.textContent = '';
    } else if (status === 'error') {
        step.classList.add('error');
        if (icon) icon.textContent = '';
    }
}

function updateSyncProgress(percent, statusText) {
    const fill = document.getElementById('sync-progress-fill');
    const status = document.getElementById('sync-status');
    const percentValue = Math.min(100, Math.max(0, percent || 0));

    if (fill) {
        fill.style.width = `${percentValue}%`;
    }
    if (status) {
        status.textContent = statusText ? `${percentValue}% - ${statusText}` : `${percentValue}% complete`;
    }
}

async function pollSyncProgress() {
    return new Promise((resolve) => {
        let pollCount = 0;

        const pollInterval = setInterval(async () => {
            pollCount++;
            try {
                const res = await fetch(`${API_BASE}/storage/snapraid/sync/progress`);
                const data = await res.json();

                updateSyncProgress(data.progress || 0, data.status || 'Syncing...');

                if (!data.running) {
                    clearInterval(pollInterval);
                    if (data.error) {
                        updateProgressStep('sync', 'error');
                        resolve({ success: false, error: data.error });
                    } else {
                        updateSyncProgress(100, data.status || 'Sync completed');
                        updateProgressStep('sync', 'completed');
                        resolve({ success: true });
                    }
                }

                if (pollCount > 150) {
                    clearInterval(pollInterval);
                    updateProgressStep('sync', 'completed');
                    updateSyncProgress(100, 'Sync timeout - may still be running in background');
                    resolve({ success: true });
                }
            } catch (e) {
                if (pollCount > 5) {
                    clearInterval(pollInterval);
                    resolve({ success: false, error: e.message });
                }
            }
        }, 1000);
    });
}

// Save storage configuration
const saveStorageBtn = document.getElementById('save-storage-btn');
if (saveStorageBtn) {
    saveStorageBtn.addEventListener('click', async () => {
        const selections = [];
        document.querySelectorAll('.role-selector').forEach(sel => {
            const diskId = sel.dataset.disk;
            const activeBtn = sel.querySelector('.role-btn.active');
            const role = activeBtn ? activeBtn.dataset.role : 'none';
            if (role !== 'none') {
                selections.push({ id: diskId, role, format: true });
            }
        });

        const dataDisks = selections.filter(s => s.role === 'data');
        const parityDisks = selections.filter(s => s.role === 'parity');

        if (dataDisks.length === 0) {
            alert('Please assign at least one disk as "Data" to create a pool.');
            return;
        }

        if (parityDisks.length === 0) {
            alert('Please assign at least one disk as "Parity" for SnapRAID protection.');
            return;
        }

        const diskList = selections.map(s => `${s.id} (${s.role})`).join('\n');
        const confirmed = confirm(`⚠️ WARNING: This will FORMAT the following disks:\n\n${diskList}\n\nAll data will be ERASED!\n\nDo you want to continue?`);

        if (!confirmed) return;

        saveStorageBtn.disabled = true;
        showProgressModal();

        try {
            updateProgressStep('format', 'active');
            await new Promise(r => setTimeout(r, 500));

            const res = await authFetch(`${API_BASE}/storage/pool/configure`, {
                method: 'POST',
                body: JSON.stringify({ disks: selections })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Configuration failed');
            }

            updateProgressStep('format', 'completed');
            await new Promise(r => setTimeout(r, 300));

            updateProgressStep('mount', 'active');
            await new Promise(r => setTimeout(r, 500));
            updateProgressStep('mount', 'completed');

            updateProgressStep('snapraid', 'active');
            await new Promise(r => setTimeout(r, 500));
            updateProgressStep('snapraid', 'completed');

            updateProgressStep('mergerfs', 'active');
            await new Promise(r => setTimeout(r, 500));
            updateProgressStep('mergerfs', 'completed');

            updateProgressStep('fstab', 'active');
            await new Promise(r => setTimeout(r, 500));
            updateProgressStep('fstab', 'completed');

            updateProgressStep('sync', 'active');
            updateSyncProgress(0, 'Starting initial sync...');

            try {
                await authFetch(`${API_BASE}/storage/snapraid/sync`, { method: 'POST' });
                const syncResult = await pollSyncProgress();

                if (!syncResult.success) {
                    console.warn('Sync warning:', syncResult.error);
                    updateProgressStep('sync', 'completed');
                    updateSyncProgress(100, 'Sync will complete in background');
                }
            } catch (syncError) {
                console.warn('Sync skipped:', syncError);
                updateProgressStep('sync', 'completed');
                updateSyncProgress(100, 'Sync scheduled for later');
            }

            state.storageConfig = selections;

            const progressMsg = document.getElementById('progress-message');
            if (progressMsg) {
                progressMsg.innerHTML = `✅ <strong>Storage Pool Created!</strong><br>Pool mounted at: ${data.poolMount}`;
            }

            const progressFooter = document.querySelector('.progress-footer');
            if (progressFooter) {
                progressFooter.classList.add('complete');
                const continueBtn = document.createElement('button');
                continueBtn.className = 'btn-primary';
                continueBtn.textContent = 'Continue to Dashboard';
                continueBtn.onclick = () => {
                    hideProgressModal();
                    if (state.sessionId) {
                        state.isAuthenticated = true;
                        switchToDashboard();
                        updateSidebarUser();
                        navigateTo('/');
                    } else {
                        navigateTo('/login');
                        showView('login');
                    }
                };
                progressFooter.appendChild(continueBtn);
            }

        } catch (e) {
            console.error('Storage config error:', e);
            const progressMsg = document.getElementById('progress-message');
            if (progressMsg) {
                progressMsg.innerHTML = `❌ <strong>Configuration Failed:</strong><br>${escapeHtml(e.message)}`;
            }

            const progressFooter = document.querySelector('.progress-footer');
            if (progressFooter) {
                progressFooter.classList.add('complete');
                const retryBtn = document.createElement('button');
                retryBtn.className = 'btn-primary';
                retryBtn.textContent = 'Close & Retry';
                retryBtn.onclick = () => {
                    hideProgressModal();
                    saveStorageBtn.disabled = false;
                };
                progressFooter.appendChild(retryBtn);
            }
        }
    });
}

// =============================================================================
// RESET BUTTON
// =============================================================================

if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to RESET the entire NAS? This will delete all configuration and require a new setup.')) return;

        resetBtn.textContent = 'Resetting Node...';
        resetBtn.disabled = true;

        try {
            const res = await authFetch(`${API_BASE}/system/reset`, { method: 'POST' });
            const data = await res.json();

            if (res.ok && data.success) {
                clearSession();
                window.location.reload();
            } else {
                alert('Reset Failed: ' + (data.error || 'Unknown error'));
                resetBtn.textContent = 'Reset Setup & Data';
                resetBtn.disabled = false;
            }
        } catch (e) {
            console.error('Reset error:', e);
            alert(e.message || 'Reset Error: Communications Broken');
            resetBtn.textContent = 'Reset Setup & Data';
            resetBtn.disabled = false;
        }
    });
}

// =============================================================================
// DDNS MODAL
// =============================================================================

if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
        if (ddnsModal) ddnsModal.style.display = 'none';
    });
}

if (ddnsModal) {
    ddnsModal.addEventListener('click', (e) => {
        if (e.target === ddnsModal) {
            ddnsModal.style.display = 'none';
        }
    });
}

// =============================================================================
// SIDEBAR NAVIGATION
// =============================================================================

// Setup sidebar click handlers
const navLinks = document.querySelectorAll('.nav-links li');
navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();

        // Update active state
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');

        // Navigate using router
        const viewName = link.dataset.view;
        const path = viewName === 'dashboard' ? '/' : `/${viewName}`;
        navigateTo(path);

        // Update title
        const viewTitle = document.getElementById('view-title');
        if (viewTitle) {
            viewTitle.textContent = viewsMap[viewName] || 'HomePiNAS';
        }

        updateHeaderIPVisibility();
    });
});

// =============================================================================
// STARTUP
// =============================================================================

// Initialize router
initRouter();

// Initialize authentication and app
initAuth();

console.log('HomePiNAS v2.0.0 - Modular Architecture Loaded');
