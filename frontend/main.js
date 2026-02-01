// State Management
const state = {
    isAuthenticated: false,
    currentView: 'loading',
    user: null,
    sessionId: null,
    publicIP: 'Scanning...',
    globalStats: { cpuLoad: 0, cpuTemp: 0, ramUsed: 0, ramTotal: 0, uptime: 0 },
    storageConfig: [],
    storageBackend: 'snapraid', // 'snapraid' or 'nonraid'
    disks: [],
    network: {
        interfaces: [],
        ddns: []
    },
    dockers: [],
    pollingIntervals: { stats: null, publicIP: null }
};

const API_BASE = window.location.origin + '/api';

// Local state for DHCP overrides (to track user changes before saving)
const localDhcpState = {};

// Security: HTML escape function to prevent XSS
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (state.sessionId) {
        headers['X-Session-Id'] = state.sessionId;
    }

    const response = await fetch(url, { ...options, headers });

    // Handle session expiration
    if (response.status === 401 && state.isAuthenticated) {
        state.isAuthenticated = false;
        state.sessionId = null;
        state.user = null;
        localStorage.removeItem('sessionId');
        switchView('login');
        throw new Error('Session expired');
    }

    return response;
}

// Session persistence
function saveSession(sessionId) {
    state.sessionId = sessionId;
    localStorage.setItem('sessionId', sessionId);
}

function loadSession() {
    const sessionId = localStorage.getItem('sessionId');
    if (sessionId) {
        state.sessionId = sessionId;
    }
    return sessionId;
}

function clearSession() {
    state.sessionId = null;
    state.user = null;
    state.isAuthenticated = false;
    localStorage.removeItem('sessionId');
}

// DOM Elements
const views = {
    setup: document.getElementById('setup-view'),
    storage: document.getElementById('storage-view'),
    login: document.getElementById('login-view'),
    dashboard: document.getElementById('dashboard-view')
};

const viewsMap = {
    'dashboard': 'Overview',
    'docker': 'Docker Manager',
    'storage': 'Storage Health',
    'network': 'Network Management',
    'system': 'System Administration'
};

// =============================================================================
// URL ROUTING
// =============================================================================

/**
 * Navigate to a URL path and update browser history
 */
function navigateTo(path, replace = false) {
    if (replace) {
        history.replaceState({ path }, '', path);
    } else {
        history.pushState({ path }, '', path);
    }
}

/**
 * Get view name from URL path
 */
function getViewFromPath(path) {
    const cleanPath = path.replace(/^\//, '').split('?')[0];
    if (!cleanPath || cleanPath === 'home' || cleanPath === 'dashboard') return 'dashboard';
    if (viewsMap[cleanPath]) return cleanPath;
    return 'dashboard';
}

/**
 * Handle route change from URL
 */
function handleRouteChange() {
    const path = window.location.pathname;
    const view = getViewFromPath(path);

    // Update sidebar active state
    navLinks.forEach(link => {
        link.classList.toggle('active', link.dataset.view === view);
    });

    // Update title and render
    if (viewTitle) viewTitle.textContent = viewsMap[view] || 'HomePiNAS';
    renderContent(view);
    updateHeaderIPVisibility();
}

// Listen for browser back/forward
window.addEventListener('popstate', () => {
    if (state.isAuthenticated) {
        handleRouteChange();
    }
});

const setupForm = document.getElementById('setup-form');
const loginForm = document.getElementById('login-form');
const navLinks = document.querySelectorAll('.nav-links li');
const dashboardContent = document.getElementById('dashboard-content');
const viewTitle = document.getElementById('view-title');
const resetBtn = document.getElementById('reset-setup-btn');

// DDNS Elements
const ddnsModal = document.getElementById('ddns-modal');
const ddnsForm = document.getElementById('ddns-form');
const serviceSelect = document.getElementById('ddns-service-select');
const dynamicFields = document.getElementById('ddns-dynamic-fields');

// Initialize State from Backend
async function initAuth() {
    try {
        // Try to load existing session
        loadSession();

        const [statusRes, disksRes, backendRes] = await Promise.all([
            fetch(`${API_BASE}/system/status`),
            fetch(`${API_BASE}/system/disks`),
            fetch(`${API_BASE}/storage/backend`)
        ]);

        if (!statusRes.ok || !disksRes.ok) {
            throw new Error('Failed to fetch initial data');
        }

        const status = await statusRes.json();
        state.disks = await disksRes.json();
        
        // Get storage backend type
        if (backendRes.ok) {
            const backendData = await backendRes.json();
            state.storageBackend = backendData.backend || 'snapraid';
        }

        state.user = status.user;
        state.storageConfig = status.storageConfig;
        state.network = status.network;

        // If we have a session, try to validate it
        if (state.sessionId && state.user && state.storageConfig.length > 0) {
            state.isAuthenticated = true;
            switchView('dashboard');

            // Check URL and navigate to correct view
            const urlPath = window.location.pathname;
            if (urlPath && urlPath !== '/' && urlPath !== '/login' && urlPath !== '/setup') {
                const urlView = getViewFromPath(urlPath);
                if (urlView !== 'dashboard') {
                    handleRouteChange();
                }
            }
        } else if (state.user && state.storageConfig.length > 0) {
            switchView('login');
        } else if (state.user) {
            switchView('storage');
            initStorageSetup();
        } else {
            switchView('setup');
        }
    } catch (e) {
        console.error('Backend Offline', e);
        switchView('setup');
    }

    startGlobalPolling();
}

function startGlobalPolling() {
    // Polling System Stats (CPU/RAM/Temp)
    state.pollingIntervals.stats = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/system/stats`);
            if (res.ok) {
                state.globalStats = await res.json();

                // Re-render dashboard if active to show real-time changes
                if (state.currentView === "dashboard") renderDashboard();
            }
        } catch (e) {
            console.error('Stats polling error:', e);
        }
    }, 2000);

    // Polling Public IP
    updatePublicIP();
    state.pollingIntervals.publicIP = setInterval(updatePublicIP, 1000 * 60 * 10);
}

// Public IP Tracker
async function updatePublicIP() {
    const val = document.getElementById('public-ip-val');
    const mockIps = ['84.120.45.122', '84.120.45.123', '84.120.45.124'];
    state.publicIP = mockIps[Math.floor(Math.random() * mockIps.length)];
    if (val) val.textContent = state.publicIP;

    const activeNav = document.querySelector('.nav-links li.active');
    if (activeNav && activeNav.dataset.view === 'network') renderNetworkManager();
}

// Router / View Switcher
function switchView(viewName) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    if (views[viewName]) {
        views[viewName].classList.add('active');
        if (viewName === 'dashboard') renderContent('dashboard');
        // Update username display
        const usernameEl = document.getElementById("username-display");
        if (usernameEl && state.user) usernameEl.textContent = state.user.username || "Admin";
    }
    updateHeaderIPVisibility();
}

function updateHeaderIPVisibility() {
    const ipContainer = document.getElementById('public-ip-container');
    if (ipContainer) {
        const activeNav = document.querySelector('.nav-links li.active');
        const view = activeNav ? activeNav.dataset.view : '';
        const isAuth = views.dashboard.classList.contains('active');
        ipContainer.style.display = (isAuth && (view === 'network' || view === 'dashboard')) ? 'flex' : 'none';
    }
}

// First-Time Setup
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

        // Save session from setup response
        if (data.sessionId) {
            saveSession(data.sessionId);
        }

        // Store only username, never password
        state.user = { username };
        switchView('storage');
        initStorageSetup();
    } catch (e) {
        console.error('Setup error:', e);
        alert('Hardware Link Failed');
        btn.disabled = false;
        btn.textContent = 'Initialize Gateway';
    }
});

function initStorageSetup() {
    const tableBody = document.getElementById('granular-disk-list');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    state.disks.forEach(disk => {
        const tr = document.createElement('tr');

        // Create elements safely to prevent XSS
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

// Storage Progress Modal Functions
const progressModal = document.getElementById('storage-progress-modal');
const progressSteps = {
    format: document.getElementById('step-format'),
    mount: document.getElementById('step-mount'),
    snapraid: document.getElementById('step-snapraid'),
    mergerfs: document.getElementById('step-mergerfs'),
    fstab: document.getElementById('step-fstab'),
    sync: document.getElementById('step-sync')
};

function showProgressModal() {
    if (progressModal) {
        progressModal.classList.add('active');
        // Reset all steps
        Object.values(progressSteps).forEach(step => {
            if (step) {
                step.classList.remove('active', 'completed', 'error');
                const icon = step.querySelector('.step-icon');
                if (icon) icon.textContent = '⏳';
            }
        });
        
        // Update step labels based on backend type
        if (state.storageBackend === 'nonraid') {
            const snapraidStep = progressSteps.snapraid;
            const mergerfsStep = progressSteps.mergerfs;
            const syncStep = progressSteps.sync;
            
            if (snapraidStep) {
                const text = snapraidStep.querySelector('.step-text');
                if (text) text.textContent = 'Creating NonRAID config...';
            }
            if (mergerfsStep) {
                const text = mergerfsStep.querySelector('.step-text');
                if (text) text.textContent = 'Configuring parity protection...';
            }
            if (syncStep) {
                const text = syncStep.querySelector('.step-text');
                if (text) text.textContent = 'Starting NonRAID service...';
            }
        }
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
        if (statusText && statusText.length > 0) {
            status.textContent = `${percentValue}% - ${statusText}`;
        } else {
            status.textContent = `${percentValue}% complete`;
        }
    }
}

async function pollSyncProgress() {
    return new Promise((resolve) => {
        // Poll more frequently at start for better responsiveness
        let pollCount = 0;

        const pollInterval = setInterval(async () => {
            pollCount++;
            try {
                const res = await fetch(`${API_BASE}/storage/snapraid/sync/progress`);
                const data = await res.json();

                // Always update the progress display
                updateSyncProgress(data.progress || 0, data.status || 'Syncing...');

                if (!data.running) {
                    clearInterval(pollInterval);
                    if (data.error) {
                        updateProgressStep('sync', 'error');
                        resolve({ success: false, error: data.error });
                    } else {
                        // Ensure we show 100% at completion
                        updateSyncProgress(100, data.status || 'Sync completed');
                        updateProgressStep('sync', 'completed');
                        resolve({ success: true });
                    }
                }

                // Safety timeout after 5 minutes of polling
                if (pollCount > 150) {
                    clearInterval(pollInterval);
                    updateProgressStep('sync', 'completed');
                    updateSyncProgress(100, 'Sync timeout - may still be running in background');
                    resolve({ success: true });
                }
            } catch (e) {
                // Don't fail immediately on network errors, retry a few times
                if (pollCount > 5) {
                    clearInterval(pollInterval);
                    resolve({ success: false, error: e.message });
                }
            }
        }, 1000); // Poll every second for better UI responsiveness
    });
}

const saveStorageBtn = document.getElementById('save-storage-btn');
if (saveStorageBtn) {
    saveStorageBtn.addEventListener('click', async () => {
        const selections = [];
        document.querySelectorAll('.role-selector').forEach(sel => {
            const diskId = sel.dataset.disk;
            const activeBtn = sel.querySelector('.role-btn.active');
            const role = activeBtn ? activeBtn.dataset.role : 'none';
            if (role !== 'none') {
                selections.push({
                    id: diskId,
                    role,
                    format: true
                });
            }
        });

        const dataDisks = selections.filter(s => s.role === 'data');
        const parityDisks = selections.filter(s => s.role === 'parity');

        if (dataDisks.length === 0) {
            alert('Please assign at least one disk as "Data" to create a pool.');
            return;
        }

        // Parity is optional, but if selected, must be >= largest data disk
        if (parityDisks.length > 0) {
            // Helper function to parse disk size to bytes
            const parseSize = (sizeStr) => {
                if (!sizeStr) return 0;
                const match = sizeStr.match(/^([\d.]+)\s*(TB|GB|MB|KB|B)?$/i);
                if (!match) return 0;
                const num = parseFloat(match[1]);
                const unit = (match[2] || 'B').toUpperCase();
                const multipliers = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
                return num * (multipliers[unit] || 1);
            };

            // Get disk sizes from state
            const getDiskSize = (diskId) => {
                const disk = state.disks.find(d => d.id === diskId);
                return disk ? parseSize(disk.size) : 0;
            };

            const largestDataSize = Math.max(...dataDisks.map(d => getDiskSize(d.id)));
            const smallestParitySize = Math.min(...parityDisks.map(d => getDiskSize(d.id)));

            if (smallestParitySize < largestDataSize) {
                alert('El disco de paridad debe ser igual o mayor que el disco de datos más grande.\n\nParity disk must be equal or larger than the largest data disk.');
                return;
            }
        }

        const diskList = selections.map(s => `${s.id} (${s.role})`).join('\n');
        const confirmed = confirm(`⚠️ WARNING: This will FORMAT the following disks:\n\n${diskList}\n\nAll data will be ERASED!\n\nDo you want to continue?`);

        if (!confirmed) return;

        saveStorageBtn.disabled = true;
        showProgressModal();

        try {
            // Step 1: Format
            updateProgressStep('format', 'active');
            await new Promise(r => setTimeout(r, 500));

            // Determine the correct endpoint and payload based on backend
            let configEndpoint, requestBody;
            
            if (state.storageBackend === 'nonraid') {
                configEndpoint = `${API_BASE}/storage/array/configure`;
                // NonRAID expects dataDisks and parityDisk arrays
                const dataDisks = selections.filter(s => s.role === 'data').map(s => s.id);
                const parityDisk = selections.filter(s => s.role === 'parity').map(s => s.id);
                requestBody = { dataDisks, parityDisk: parityDisk[0], shareMode: 'individual' };
            } else {
                configEndpoint = `${API_BASE}/storage/pool/configure`;
                requestBody = { disks: selections };
            }

            // Call configure endpoint
            const res = await authFetch(configEndpoint, {
                method: 'POST',
                body: JSON.stringify(requestBody)
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Configuration failed');
            }

            // Update steps based on results
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

            // Step 6: Sync/Start service
            updateProgressStep('sync', 'active');
            
            if (state.storageBackend === 'nonraid') {
                // NonRAID: Just start the service, no sync needed
                updateSyncProgress(0, 'Starting NonRAID service...');
                await new Promise(r => setTimeout(r, 1000));
                updateSyncProgress(100, 'NonRAID service started');
                updateProgressStep('sync', 'completed');
            } else {
                // SnapRAID: Start sync in background
                updateSyncProgress(0, 'Starting initial sync...');
                try {
                    await authFetch(`${API_BASE}/storage/snapraid/sync`, { method: 'POST' });
                    // Poll for progress
                    const syncResult = await pollSyncProgress();

                    if (!syncResult.success) {
                        console.warn('Sync warning:', syncResult.error);
                        // Don't fail the whole process, sync can be run later
                        updateProgressStep('sync', 'completed');
                        updateSyncProgress(100, 'Sync will complete in background');
                    }
                } catch (syncError) {
                    console.warn('Sync skipped:', syncError);
                    updateProgressStep('sync', 'completed');
                    updateSyncProgress(100, 'Sync scheduled for later');
                }
            }

            state.storageConfig = selections;

            // Update progress message
            const progressMsg = document.getElementById('progress-message');
            if (progressMsg) {
                if (state.storageBackend === 'nonraid') {
                    progressMsg.innerHTML = `✅ <strong>NonRAID Array Created!</strong><br>Disks mounted at /mnt/disk[N]`;
                } else {
                    progressMsg.innerHTML = `✅ <strong>Storage Pool Created!</strong><br>Pool mounted at: ${escapeHtml(data.poolMount || '/mnt/storage')}`;
                }
            }

            // Show continue button
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
                        switchView('dashboard');
                    } else {
                        switchView('login');
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

            // Add retry button
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

// Authentication
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

            // Save session
            if (data.sessionId) {
                saveSession(data.sessionId);
            }

            state.isAuthenticated = true;
            state.user = data.user;
            switchView('dashboard');
        } catch (e) {
            console.error('Login error:', e);
            alert('Security Server Offline or Network Link Broken');
            btn.textContent = 'Access Gateway';
            btn.disabled = false;
        }
    });
}

// Navigation
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        const view = link.dataset.view;

        // Update URL
        const path = view === 'dashboard' ? '/' : '/' + view;
        navigateTo(path);

        viewTitle.textContent = viewsMap[view] || 'HomePiNAS';
        renderContent(view);
        updateHeaderIPVisibility();
    });
});

function renderContent(view) {
    state.currentView = view;
    dashboardContent.innerHTML = '';
    if (view === 'dashboard') renderDashboard();
    else if (view === 'docker') renderDockerManager();
    else if (view === 'storage') renderStorageDashboard();
    else if (view === 'network') renderNetworkManager();
    else if (view === 'system') renderSystemView();
}

// Real-Time Dashboard
async function renderDashboard() {
    const stats = state.globalStats;
    const cpuTemp = Number(stats.cpuTemp) || 0;
    const cpuLoad = Number(stats.cpuLoad) || 0;
    const ramUsedPercent = Number(stats.ramUsedPercent) || 0;
    const publicIP = escapeHtml(state.publicIP);
    const lanIP = escapeHtml(state.network.interfaces[0]?.ip || 'Scanning...');
    const ddnsCount = (state.network.ddns || []).filter(d => d.enabled).length;

    // CPU Model - save once and reuse (CPU doesn't change)
    if (stats.cpuModel && stats.cpuModel !== 'Unknown CPU') {
        localStorage.setItem('cpuModel', stats.cpuModel);
    }
    const cpuModel = localStorage.getItem('cpuModel') || stats.cpuModel || 'Unknown CPU';

    // Format uptime intelligently
    const uptimeSeconds = Number(stats.uptime) || 0;
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    let uptimeStr;
    if (days > 0) {
        uptimeStr = `${days} día${days > 1 ? 's' : ''} ${hours}h`;
    } else if (hours > 0) {
        uptimeStr = `${hours} hora${hours > 1 ? 's' : ''} ${minutes}m`;
    } else {
        uptimeStr = `${minutes} minuto${minutes !== 1 ? 's' : ''}`;
    }

    // Generate core loads HTML (compact version)
    let coreLoadsHtml = '';
    if (stats.coreLoads && stats.coreLoads.length > 0) {
        coreLoadsHtml = stats.coreLoads.map((core, i) => `
            <div class="core-bar-mini">
                <span>C${i}</span>
                <div class="core-progress-mini">
                    <div class="core-fill-mini" style="width: ${core.load}%; background: ${core.load > 80 ? '#ef4444' : core.load > 50 ? '#f59e0b' : '#10b981'}"></div>
                </div>
                <span>${core.load}%</span>
            </div>
        `).join('');
    }

    // Fetch fan mode
    let fanMode = 'balanced';
    try {
        const fanModeRes = await fetch(`${API_BASE}/system/fan/mode`);
        if (fanModeRes.ok) {
            const fanModeData = await fanModeRes.json();
            fanMode = fanModeData.mode || 'balanced';
        }
    } catch (e) {
        console.error('Error fetching fan mode:', e);
    }

    // Generate fan mode selector HTML (only mode buttons, no RPM display)
    const fansFullHtml = `
        <div class="fan-mode-selector">
            <button class="fan-mode-btn ${fanMode === 'silent' ? 'active' : ''}" data-mode="silent" onclick="setFanMode('silent')">
                <span class="mode-icon">🤫</span>
                <span class="mode-name">Silent</span>
            </button>
            <button class="fan-mode-btn ${fanMode === 'balanced' ? 'active' : ''}" data-mode="balanced" onclick="setFanMode('balanced')">
                <span class="mode-icon">⚖️</span>
                <span class="mode-name">Balanced</span>
            </button>
            <button class="fan-mode-btn ${fanMode === 'performance' ? 'active' : ''}" data-mode="performance" onclick="setFanMode('performance')">
                <span class="mode-icon">🚀</span>
                <span class="mode-name">Performance</span>
            </button>
        </div>
    `;

    // Fetch disks for storage section
    let disksHtml = '';
    try {
        const disksRes = await fetch(`${API_BASE}/system/disks`);
        if (disksRes.ok) {
            const disks = await disksRes.json();

            // Group disks by role
            const disksByRole = { data: [], parity: [], cache: [], none: [] };
            disks.forEach(disk => {
                const config = state.storageConfig.find(s => s.id === disk.id);
                const role = config ? config.role : 'none';
                if (disksByRole[role]) {
                    disksByRole[role].push({ ...disk, role });
                } else {
                    disksByRole.none.push({ ...disk, role: 'none' });
                }
            });

            // Generate HTML for each role section
            const roleLabels = { data: '💾 Data', parity: '🛡️ Parity', cache: '⚡ Cache', none: '📦 Unassigned' };
            const roleColors = { data: '#6366f1', parity: '#f59e0b', cache: '#10b981', none: '#64748b' };

            for (const [role, roleDisks] of Object.entries(disksByRole)) {
                if (roleDisks.length > 0) {
                    disksHtml += `
                        <div class="disk-role-section">
                            <div class="disk-role-header" style="border-left: 3px solid ${roleColors[role]}">
                                <span>${roleLabels[role]}</span>
                                <span class="disk-count">${roleDisks.length} disk(s)</span>
                            </div>
                            <div class="disk-role-items">
                                ${roleDisks.map(disk => `
                                    <div class="disk-item-compact">
                                        <div class="disk-item-info">
                                            <span class="disk-name">${escapeHtml(disk.model || 'Unknown')}</span>
                                            <span class="disk-details">${escapeHtml(disk.id)} • ${escapeHtml(disk.size)} • ${escapeHtml(disk.type)}</span>
                                        </div>
                                        <div class="disk-item-temp ${disk.temp > 45 ? 'hot' : disk.temp > 38 ? 'warm' : 'cool'}">
                                            ${disk.temp || 0}°C
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }
            }
        }
    } catch (e) {
        console.error('Error fetching disks:', e);
        disksHtml = '<div class="no-disks">Unable to load disk information</div>';
    }

    dashboardContent.innerHTML = `
        <div class="glass-card overview-card" style="grid-column: 1 / -1;">
            <div class="overview-header">
                <h3>System Overview</h3>
                <div class="system-info-badge">
                    <span>${escapeHtml(stats.hostname || 'HomePiNAS')}</span>
                    <span class="separator">|</span>
                    <span>${escapeHtml(stats.distro || 'Linux')}</span>
                    <span class="separator">|</span>
                    <span>Uptime: ${uptimeStr}</span>
                </div>
            </div>
        </div>

        <div class="dashboard-grid-4">
            <div class="glass-card card-compact">
                <h3>🖥️ CPU</h3>
                <div class="cpu-model-compact">${escapeHtml(cpuModel)}</div>
                <div class="cpu-specs-row">
                    <span>${stats.cpuPhysicalCores || 0} Cores</span>
                    <span>${stats.cpuCores || 0} Threads</span>
                    <span>${stats.cpuSpeed || 0} GHz</span>
                    <span class="temp-badge ${cpuTemp > 70 ? 'hot' : cpuTemp > 55 ? 'warm' : 'cool'}">${cpuTemp}°C</span>
                </div>
                <div class="load-section">
                    <div class="load-header">
                        <span>Load</span>
                        <span style="color: ${cpuLoad > 80 ? '#ef4444' : cpuLoad > 50 ? '#f59e0b' : '#10b981'}">${cpuLoad}%</span>
                    </div>
                    <div class="progress-bar-mini">
                        <div class="progress-fill-mini" style="width: ${Math.min(cpuLoad, 100)}%; background: ${cpuLoad > 80 ? '#ef4444' : cpuLoad > 50 ? '#f59e0b' : 'var(--primary)'}"></div>
                    </div>
                </div>
                ${coreLoadsHtml ? `<div class="core-loads-mini">${coreLoadsHtml}</div>` : ''}
            </div>

            <div class="glass-card card-compact">
                <h3>💾 Memory</h3>
                <div class="memory-compact">
                    <div class="memory-circle-small">
                        <svg viewBox="0 0 36 36">
                            <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                            <path class="circle-fill" stroke="${ramUsedPercent > 80 ? '#ef4444' : ramUsedPercent > 60 ? '#f59e0b' : '#10b981'}"
                                  stroke-dasharray="${ramUsedPercent}, 100"
                                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        </svg>
                        <span class="memory-percent-small">${ramUsedPercent}%</span>
                    </div>
                    <div class="memory-details-compact">
                        <div class="mem-row"><span>Used</span><span>${stats.ramUsed || 0} GB</span></div>
                        <div class="mem-row"><span>Free</span><span>${stats.ramFree || 0} GB</span></div>
                        <div class="mem-row"><span>Total</span><span>${stats.ramTotal || 0} GB</span></div>
                        ${stats.swapTotal && parseFloat(stats.swapTotal) > 0 ? `<div class="mem-row swap"><span>Swap</span><span>${stats.swapUsed || 0}/${stats.swapTotal || 0} GB</span></div>` : ''}
                    </div>
                </div>
            </div>

            <div class="glass-card card-compact">
                <h3>🌀 Fans</h3>
                <div class="fans-compact">
                    ${fansFullHtml}
                </div>
            </div>

            <div class="glass-card card-compact">
                <h3>🌐 Network</h3>
                <div class="network-compact">
                    <div class="net-row"><span>Public IP</span><span class="ip-value">${publicIP}</span></div>
                    <div class="net-row"><span>LAN IP</span><span>${lanIP}</span></div>
                    <div class="net-row"><span>DDNS</span><span>${ddnsCount} Service(s)</span></div>
                </div>
            </div>
        </div>

        <div class="glass-card storage-overview" style="grid-column: 1 / -1;">
            <h3>💿 Connected Disks</h3>
            <div class="disks-by-role">
                ${disksHtml || '<div class="no-disks">No disks detected</div>'}
            </div>
        </div>
    `;
}

// Fan speed control - update percentage display while dragging
function updateFanPercent(fanId, value) {
    const percentEl = document.getElementById(`fan-percent-${fanId}`);
    if (percentEl) {
        percentEl.textContent = `${value}%`;
    }
}

// Fan speed control - apply speed when released
async function setFanSpeed(fanId, speed) {
    const percentEl = document.getElementById(`fan-percent-${fanId}`);
    if (percentEl) {
        percentEl.textContent = `${speed}% ⏳`;
    }

    try {
        const res = await authFetch(`${API_BASE}/system/fan`, {
            method: 'POST',
            body: JSON.stringify({ fanId, speed: parseInt(speed) })
        });
        const data = await res.json();

        if (percentEl) {
            if (res.ok) {
                percentEl.textContent = `${speed}% ✓`;
                setTimeout(() => {
                    percentEl.textContent = `${speed}%`;
                }, 1500);
            } else {
                percentEl.textContent = `${speed}% ✗`;
                console.error('Fan control error:', data.error);
            }
        }
    } catch (e) {
        console.error('Fan control error:', e);
        if (percentEl) {
            percentEl.textContent = `${speed}% ✗`;
        }
    }
}

window.updateFanPercent = updateFanPercent;
window.setFanSpeed = setFanSpeed;

// Fan mode control
async function setFanMode(mode) {
    // Update UI immediately
    document.querySelectorAll('.fan-mode-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.mode === mode) {
            btn.classList.add('active');
            btn.innerHTML = `<span class="mode-icon">${btn.querySelector('.mode-icon').textContent}</span><span class="mode-name">⏳</span>`;
        }
    });

    try {
        const res = await authFetch(`${API_BASE}/system/fan/mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        });
        const data = await res.json();

        if (res.ok) {
            // Update button to show success
            document.querySelectorAll('.fan-mode-btn').forEach(btn => {
                if (btn.dataset.mode === mode) {
                    const modeNames = { silent: 'Silent', balanced: 'Balanced', performance: 'Performance' };
                    btn.innerHTML = `<span class="mode-icon">${btn.querySelector('.mode-icon').textContent}</span><span class="mode-name">${modeNames[mode]} ✓</span>`;
                    setTimeout(() => {
                        btn.innerHTML = `<span class="mode-icon">${mode === 'silent' ? '🤫' : mode === 'balanced' ? '⚖️' : '🚀'}</span><span class="mode-name">${modeNames[mode]}</span>`;
                    }, 1500);
                }
            });
        } else {
            console.error('Fan mode error:', data.error);
            // Revert UI on error
            renderDashboard();
        }
    } catch (e) {
        console.error('Fan mode error:', e);
        renderDashboard();
    }
}

window.setFanMode = setFanMode;

// Real Storage Telemetry
async function renderStorageDashboard() {
    try {
        // Re-fetch disks to ensure real-time connection
        const res = await fetch(`${API_BASE}/system/disks`);
        if (!res.ok) throw new Error('Failed to fetch disks');
        state.disks = await res.json();

        const grid = document.createElement('div');
        grid.className = 'telemetry-grid';

        state.disks.forEach(disk => {
            const config = state.storageConfig.find(s => s.id === disk.id);
            const role = config ? config.role : 'none';
            const temp = Number(disk.temp) || 0;
            const tempClass = temp > 45 ? 'hot' : (temp > 38 ? 'warm' : 'cool');
            const usage = Math.min(Math.max(Number(disk.usage) || 0, 0), 100);

            const card = document.createElement('div');
            card.className = 'glass-card disk-card-advanced';

            // Create header
            const header = document.createElement('div');
            header.className = 'disk-header-adv';

            const headerInfo = document.createElement('div');
            const h4 = document.createElement('h4');
            h4.textContent = disk.model || 'Unknown';
            const infoSpan = document.createElement('span');
            infoSpan.style.cssText = 'font-size: 0.8rem; color: var(--text-dim); display: block;';
            infoSpan.textContent = `${disk.id || 'N/A'} • ${disk.type || 'Unknown'} • ${disk.size || 'N/A'}`;
            const serialSpan2 = document.createElement('span');
            serialSpan2.style.cssText = 'font-size: 0.75rem; color: var(--primary); display: block; margin-top: 4px; font-family: monospace;';
            serialSpan2.textContent = `SN: ${disk.serial || 'N/A'}`;
            headerInfo.appendChild(h4);
            headerInfo.appendChild(infoSpan);
            headerInfo.appendChild(serialSpan2);

            const roleBadge = document.createElement('span');
            roleBadge.className = `role-badge ${escapeHtml(role)}`;
            roleBadge.textContent = role;

            header.appendChild(headerInfo);
            header.appendChild(roleBadge);

            // Create progress container
            const progressContainer = document.createElement('div');
            progressContainer.className = 'disk-progress-container';
            progressContainer.innerHTML = `
                <div class="telemetry-stats-row"><span>Health Status</span><span style="color:#10b981">Optimal</span></div>
                <div class="disk-usage-bar"><div class="disk-usage-fill" style="width: ${usage}%; background: ${getRoleColor(role)}"></div></div>
            `;

            // Create telemetry row (only temperature, SN is in header)
            const telemetryRow = document.createElement('div');
            telemetryRow.className = 'telemetry-stats-row';

            const tempIndicator = document.createElement('div');
            tempIndicator.className = `temp-indicator ${tempClass}`;
            tempIndicator.innerHTML = `<span>🌡️</span><span>${temp}°C</span>`;

            telemetryRow.appendChild(tempIndicator);

            card.appendChild(header);
            card.appendChild(progressContainer);
            card.appendChild(telemetryRow);
            grid.appendChild(card);
        });

        dashboardContent.appendChild(grid);
    } catch (e) {
        console.error('Storage dashboard error:', e);
        dashboardContent.innerHTML = '<div class="glass-card"><h3>Error loading storage data</h3></div>';
    }
}

// Real Docker Logic
async function renderDockerManager() {
    // Show loading immediately
    dashboardContent.innerHTML = "<div class=\"glass-card\" style=\"grid-column: 1 / -1; text-align: center; padding: 40px;\"><h3>Loading Docker Manager...</h3></div>";
    // Fetch containers and update status
    let updateStatus = { lastCheck: null, updatesAvailable: 0 };
    try {
        const [containersRes, updateRes] = await Promise.all([
            fetch(`${API_BASE}/docker/containers`),
            fetch(`${API_BASE}/docker/update-status`)
        ]);
        if (containersRes.ok) state.dockers = await containersRes.json();
        if (updateRes.ok) updateStatus = await updateRes.json();
    } catch (e) {
        console.error('Docker unreachable:', e);
        state.dockers = [];
    }

    // Fetch compose files
    let composeFiles = [];
    try {
        const composeRes = await fetch(`${API_BASE}/docker/compose/list`);
        if (composeRes.ok) composeFiles = await composeRes.json();
    } catch (e) {
        console.error('Compose list error:', e);
    }

    // Header with actions
    const headerCard = document.createElement('div');
    headerCard.className = 'glass-card';
    headerCard.style.cssText = 'grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px;';

    const headerLeft = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.style.margin = '0';
    h3.textContent = 'Containers';
    const updateInfo = document.createElement('span');
    updateInfo.style.cssText = 'font-size: 0.8rem; color: var(--text-dim); display: block; margin-top: 5px;';
    updateInfo.textContent = updateStatus.lastCheck
        ? `Last check: ${new Date(updateStatus.lastCheck).toLocaleString()}`
        : 'Updates not checked yet';
    headerLeft.appendChild(h3);
    headerLeft.appendChild(updateInfo);

    const headerRight = document.createElement('div');
    headerRight.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';

    const checkUpdatesBtn = document.createElement('button');
    checkUpdatesBtn.className = 'btn-primary';
    checkUpdatesBtn.style.cssText = 'background: #6366f1; padding: 8px 16px; font-size: 0.85rem;';
    checkUpdatesBtn.innerHTML = '🔄 Check Updates';
    checkUpdatesBtn.addEventListener('click', checkDockerUpdates);

    const importComposeBtn = document.createElement('button');
    importComposeBtn.className = 'btn-primary';
    importComposeBtn.style.cssText = 'background: #10b981; padding: 8px 16px; font-size: 0.85rem;';
    importComposeBtn.innerHTML = '📦 Import Compose';
    importComposeBtn.addEventListener('click', openComposeModal);

    headerRight.appendChild(checkUpdatesBtn);
    headerRight.appendChild(importComposeBtn);
    headerCard.appendChild(headerLeft);
    headerCard.appendChild(headerRight);
    dashboardContent.appendChild(headerCard);

    // Containers section
    if (state.dockers.length === 0) {
        const emptyCard = document.createElement('div');
        emptyCard.className = 'glass-card';
        emptyCard.style.cssText = 'grid-column: 1/-1; text-align:center; padding: 40px;';
        emptyCard.innerHTML = `
            <h4 style="color: var(--text-dim);">No Containers Detected</h4>
            <p style="color: var(--text-dim); font-size: 0.9rem;">Import a docker-compose file or run containers manually.</p>
        `;
        dashboardContent.appendChild(emptyCard);
    } else {
        const containerGrid = document.createElement('div');
        containerGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; grid-column: 1 / -1;';

        state.dockers.forEach(container => {
            const card = document.createElement('div');
            card.className = 'glass-card docker-card';
            card.style.padding = '20px';

            const isRunning = container.status === 'running';
            const hasUpdate = container.hasUpdate;

            // Header row
            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;';

            const info = document.createElement('div');
            const nameRow = document.createElement('div');
            nameRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';
            const h4 = document.createElement('h4');
            h4.style.margin = '0';
            h4.textContent = container.name || 'Unknown';
            nameRow.appendChild(h4);

            if (hasUpdate) {
                const updateBadge = document.createElement('span');
                updateBadge.style.cssText = 'background: #10b981; color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600;';
                updateBadge.textContent = 'UPDATE';
                nameRow.appendChild(updateBadge);
            }

            const imageSpan = document.createElement('span');
            imageSpan.style.cssText = 'font-size: 0.8rem; color: var(--text-dim); display: block; margin-top: 4px;';
            imageSpan.textContent = container.image || 'N/A';
            info.appendChild(nameRow);
            info.appendChild(imageSpan);

            const statusSpan = document.createElement('span');
            statusSpan.style.cssText = `
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 0.75rem;
                font-weight: 600;
                background: ${isRunning ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'};
                color: ${isRunning ? '#10b981' : '#ef4444'};
            `;
            statusSpan.textContent = isRunning ? 'RUNNING' : 'STOPPED';

            header.appendChild(info);
            header.appendChild(statusSpan);

            // Stats row (only if running)
            if (isRunning) {
                const statsRow = document.createElement('div');
                statsRow.style.cssText = 'display: flex; gap: 20px; margin-bottom: 15px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;';
                statsRow.innerHTML = `
                    <div style="flex: 1; text-align: center;">
                        <div style="font-size: 0.7rem; color: var(--text-dim);">CPU</div>
                        <div style="font-size: 1rem; font-weight: 600; color: ${container.cpu !== '---' && parseFloat(container.cpu) > 50 ? '#f59e0b' : '#10b981'}">${escapeHtml(container.cpu)}</div>
                    </div>
                    <div style="flex: 1; text-align: center;">
                        <div style="font-size: 0.7rem; color: var(--text-dim);">RAM</div>
                        <div style="font-size: 1rem; font-weight: 600; color: #6366f1;">${escapeHtml(container.ram)}</div>
                    </div>
                `;
                card.appendChild(header);
                card.appendChild(statsRow);
            } else {
                card.appendChild(header);
            }

            // Controls row
            const controls = document.createElement('div');
            controls.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

            const actionBtn = document.createElement('button');
            actionBtn.className = 'btn-sm';
            actionBtn.style.cssText = `flex: 1; padding: 8px; background: ${isRunning ? '#ef4444' : '#10b981'}; color: white; border: none; border-radius: 6px; cursor: pointer;`;
            actionBtn.textContent = isRunning ? 'Stop' : 'Start';
            actionBtn.addEventListener('click', () => handleDockerAction(container.id, isRunning ? 'stop' : 'start', actionBtn));

            const restartBtn = document.createElement('button');
            restartBtn.className = 'btn-sm';
            restartBtn.style.cssText = 'flex: 1; padding: 8px; background: #f59e0b; color: white; border: none; border-radius: 6px; cursor: pointer;';
            restartBtn.textContent = 'Restart';
            restartBtn.addEventListener('click', () => handleDockerAction(container.id, 'restart', restartBtn));

            controls.appendChild(actionBtn);
            controls.appendChild(restartBtn);

            if (hasUpdate) {
                const updateBtn = document.createElement('button');
                updateBtn.className = 'btn-sm';
                updateBtn.style.cssText = 'width: 100%; margin-top: 8px; padding: 10px; background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
                updateBtn.innerHTML = '⬆️ Update Container';
                updateBtn.addEventListener('click', () => updateContainer(container.id, container.name, updateBtn));
                controls.appendChild(updateBtn);
            }

            card.appendChild(controls);
            containerGrid.appendChild(card);
        });

        dashboardContent.appendChild(containerGrid);
    }

    // Compose Files Section
    if (composeFiles.length > 0) {
        const composeSectionTitle = document.createElement('h3');
        composeSectionTitle.style.cssText = 'grid-column: 1 / -1; margin-top: 30px; margin-bottom: 10px;';
        composeSectionTitle.textContent = 'Docker Compose Files';
        dashboardContent.appendChild(composeSectionTitle);

        const composeGrid = document.createElement('div');
        composeGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px; grid-column: 1 / -1;';

        composeFiles.forEach(compose => {
            const card = document.createElement('div');
            card.className = 'glass-card';
            card.style.padding = '15px';

            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';

            const name = document.createElement('h4');
            name.style.margin = '0';
            name.textContent = compose.name;

            const modified = document.createElement('span');
            modified.style.cssText = 'font-size: 0.75rem; color: var(--text-dim);';
            modified.textContent = new Date(compose.modified).toLocaleDateString();

            header.appendChild(name);
            header.appendChild(modified);

            const controls = document.createElement('div');
            controls.style.cssText = 'display: flex; gap: 8px;';

            const runBtn = document.createElement('button');
            runBtn.style.cssText = 'flex: 1; padding: 8px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem;';
            runBtn.textContent = 'Run';
            runBtn.addEventListener('click', () => runCompose(compose.name, runBtn));

            const stopBtn = document.createElement('button');
            stopBtn.style.cssText = 'flex: 1; padding: 8px; background: #f59e0b; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem;';
            stopBtn.textContent = 'Stop';
            stopBtn.addEventListener('click', () => stopCompose(compose.name, stopBtn));

            const deleteBtn = document.createElement('button');
            deleteBtn.style.cssText = 'padding: 8px 12px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem;';
            deleteBtn.textContent = '🗑️';
            deleteBtn.addEventListener('click', () => deleteCompose(compose.name));

            controls.appendChild(runBtn);
            controls.appendChild(stopBtn);
            controls.appendChild(deleteBtn);

            card.appendChild(header);
            card.appendChild(controls);
            composeGrid.appendChild(card);
        });

        dashboardContent.appendChild(composeGrid);
    }
}

// Docker Update Functions
async function checkDockerUpdates() {
    const btn = event.target;
    btn.disabled = true;
    btn.innerHTML = '🔄 Checking...';

    try {
        const res = await authFetch(`${API_BASE}/docker/check-updates`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Check failed');

        alert(`Update check complete!\n\nImages checked: ${data.totalImages}\nUpdates available: ${data.updatesAvailable}`);
        renderContent('docker');
    } catch (e) {
        console.error('Docker update check error:', e);
        alert('Error: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '🔄 Check Updates';
    }
}

async function updateContainer(containerId, containerName, btn) {
    if (!confirm(`Update container "${containerName}"?\n\nThis will:\n1. Stop the container\n2. Pull the latest image\n3. Recreate the container\n\nVolumes and data will be preserved.`)) {
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '⏳ Updating...';

    try {
        const res = await authFetch(`${API_BASE}/docker/update`, {
            method: 'POST',
            body: JSON.stringify({ containerId })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Update failed');

        alert(`Container "${containerName}" updated successfully!`);
        renderContent('docker');
    } catch (e) {
        console.error('Container update error:', e);
        alert('Update failed: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '⬆️ Update Container';
    }
}

// Compose Functions
function openComposeModal() {
    const modal = document.createElement('div');
    modal.id = 'compose-modal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
    `;

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 30px; border-radius: 16px; width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h3 style="margin: 0;">Import Docker Compose</h3>
                <button id="close-compose-modal" style="background: none; border: none; color: white; font-size: 1.5rem; cursor: pointer;">&times;</button>
            </div>
            <div class="input-group" style="margin-bottom: 15px;">
                <input type="text" id="compose-name" placeholder=" " required>
                <label>Stack Name</label>
            </div>
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 8px; color: var(--text-dim);">docker-compose.yml content:</label>
                <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                    <label style="
                        flex: 1; padding: 12px; background: rgba(99, 102, 241, 0.2);
                        border: 2px dashed rgba(99, 102, 241, 0.5); border-radius: 8px;
                        color: #6366f1; text-align: center; cursor: pointer;
                        transition: all 0.2s ease;
                    ">
                        📁 Upload .yml file
                        <input type="file" id="compose-file-input" accept=".yml,.yaml" style="display: none;">
                    </label>
                </div>
                <textarea id="compose-content" style="
                    width: 100%; height: 300px; background: rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
                    color: white; font-family: monospace; padding: 15px; resize: vertical;
                " placeholder="version: '3'
services:
  myapp:
    image: nginx:latest
    ports:
      - '8080:80'"></textarea>
            </div>
            <div style="display: flex; gap: 10px;">
                <button id="save-compose-btn" class="btn-primary" style="flex: 1; padding: 12px;">Save Compose</button>
                <button id="save-run-compose-btn" class="btn-primary" style="flex: 1; padding: 12px; background: #10b981;">Save & Run</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('close-compose-modal').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // File upload handler
    document.getElementById("compose-file-input").addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                document.getElementById("compose-content").value = event.target.result;
                // Auto-fill stack name from filename if empty
                const nameInput = document.getElementById("compose-name");
                if (!nameInput.value.trim()) {
                    nameInput.value = file.name.replace(/.(yml|yaml)$/i, "").replace(/docker-compose[-_]?/i, "") || "stack";
                }
            };
            reader.readAsText(file);
        }
    });


    document.getElementById('save-compose-btn').addEventListener('click', () => saveCompose(false));
    document.getElementById('save-run-compose-btn').addEventListener('click', () => saveCompose(true));
}

async function saveCompose(andRun) {
    const name = document.getElementById("compose-name").value.trim();
    const content = document.getElementById("compose-content").value;

    if (!name) {
        alert("Please enter a stack name");
        return;
    }
    if (!content) {
        alert("Please enter compose content");
        return;
    }

    // Replace modal content with progress view
    const modal = document.getElementById("compose-modal");
    const modalContent = modal.querySelector("div");
    modalContent.innerHTML = `
        <h3 style="margin: 0 0 20px 0;">Deploying Stack: ${escapeHtml(name)}</h3>
        <div id="deploy-steps">
            <div class="deploy-step" id="step-save">
                <span class="step-icon">⏳</span>
                <span class="step-text">Saving compose file...</span>
            </div>
            ${andRun ? `<div class="deploy-step" id="step-pull">
                <span class="step-icon">⏳</span>
                <span class="step-text">Pulling images...</span>
            </div>
            <div class="deploy-step" id="step-start">
                <span class="step-icon">⏳</span>
                <span class="step-text">Starting containers...</span>
            </div>` : ""}
        </div>
        <div style="margin: 20px 0;">
            <div style="background: rgba(255,255,255,0.1); border-radius: 8px; height: 8px; overflow: hidden;">
                <div id="deploy-progress" style="height: 100%; background: linear-gradient(90deg, #6366f1, #10b981); width: 0%; transition: width 0.3s ease;"></div>
            </div>
            <div id="deploy-status" style="margin-top: 10px; font-size: 0.9rem; color: var(--text-dim); text-align: center;">Initializing...</div>
        </div>
        <div id="deploy-log" style="display: none; margin: 15px 0; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 8px; font-family: monospace; font-size: 0.8rem; max-height: 200px; overflow-y: auto; white-space: pre-wrap;"></div>
        <div id="deploy-actions" style="display: none; text-align: center;">
            <button id="deploy-close-btn" class="btn-primary" style="padding: 12px 30px;">Accept</button>
        </div>
    `;

    const updateStep = (stepId, status) => {
        const step = document.getElementById(stepId);
        if (!step) return;
        step.className = "deploy-step";
        if (status) step.classList.add(status);
    };

    const updateProgress = (percent, text) => {
        const bar = document.getElementById("deploy-progress");
        const status = document.getElementById("deploy-status");
        if (bar) bar.style.width = percent + "%";
        if (status) status.textContent = text;
    };

    const showResult = (success, message, log = "") => {
        const actions = document.getElementById("deploy-actions");
        const logDiv = document.getElementById("deploy-log");
        const btn = document.getElementById("deploy-close-btn");
        
        if (actions) actions.style.display = "block";
        if (!success && log && logDiv) {
            logDiv.style.display = "block";
            logDiv.textContent = log;
            logDiv.style.color = "#ef4444";
        }
        if (btn) {
            btn.textContent = success ? "Accept" : "Close";
            btn.style.background = success ? "#10b981" : "#ef4444";
            btn.onclick = () => {
                modal.remove();
                if (success) renderContent("docker");
            };
        }
        updateProgress(100, message);
    };

    try {
        // Step 1: Save compose file
        updateStep("step-save", "active");
        updateProgress(10, "Saving compose file...");

        const res = await authFetch(`${API_BASE}/docker/compose/import`, {
            method: "POST",
            body: JSON.stringify({ name, content })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Import failed");
        
        updateStep("step-save", "done");
        updateProgress(andRun ? 33 : 100, andRun ? "Compose saved, starting deployment..." : "Compose saved successfully!");

        if (andRun) {
            // Step 2: Pull & Start
            updateStep("step-pull", "active");
            updateProgress(50, "Pulling images and starting containers...");

            const runRes = await authFetch(`${API_BASE}/docker/compose/up`, {
                method: "POST",
                body: JSON.stringify({ name })
            });
            const runData = await runRes.json();

            if (!runRes.ok) {
                updateStep("step-pull", "error");
                updateStep("step-start", "error");
                throw new Error(runData.error || runData.output || "Run failed");
            }

            updateStep("step-pull", "done");
            updateStep("step-start", "done");
            showResult(true, "Stack deployed successfully! ✅");
        } else {
            showResult(true, "Compose file saved! ✅");
        }

    } catch (e) {
        console.error("Compose deploy error:", e);
        const currentStep = document.querySelector(".deploy-step.active");
        if (currentStep) currentStep.classList.replace("active", "error");
        showResult(false, "Deployment failed ❌", e.message);
    }
}

async function runCompose(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const res = await authFetch(`${API_BASE}/docker/compose/up`, {
            method: 'POST',
            body: JSON.stringify({ name })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Start failed');

        alert(`Compose "${name}" started!`);
        renderContent('docker');
    } catch (e) {
        console.error('Compose run error:', e);
        alert('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Run';
    }
}

async function stopCompose(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping...';

    try {
        const res = await authFetch(`${API_BASE}/docker/compose/down`, {
            method: 'POST',
            body: JSON.stringify({ name })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Stop failed');

        alert(`Compose "${name}" stopped!`);
        renderContent('docker');
    } catch (e) {
        console.error('Compose stop error:', e);
        alert('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Stop';
    }
}

async function deleteCompose(name) {
    if (!confirm(`Delete compose "${name}"?\n\nThis will stop all containers and remove the compose file.`)) {
        return;
    }

    try {
        const res = await authFetch(`${API_BASE}/docker/compose/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Delete failed');

        alert(`Compose "${name}" deleted!`);
        renderContent('docker');
    } catch (e) {
        console.error('Compose delete error:', e);
        alert('Error: ' + e.message);
    }
}

window.checkDockerUpdates = checkDockerUpdates;
window.updateContainer = updateContainer;
window.openComposeModal = openComposeModal;

async function handleDockerAction(id, action, btn) {
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        const res = await authFetch(`${API_BASE}/docker/action`, {
            method: 'POST',
            body: JSON.stringify({ id, action })
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Docker action failed');
        }

        renderContent('docker');
    } catch (e) {
        console.error('Docker action error:', e);
        alert(e.message || 'Docker Logic Fail');
        btn.disabled = false;
        btn.textContent = action === 'stop' ? 'Stop' : 'Start';
    }
}

// Keep window reference for backward compatibility
window.handleDockerAction = handleDockerAction;

// Network Manager (Refined)
async function renderNetworkManager() {
    try {
        const res = await fetch(`${API_BASE}/network/interfaces`);
        if (!res.ok) throw new Error('Failed to fetch interfaces');
        state.network.interfaces = await res.json();
    } catch (e) {
        console.error('Network fetch error:', e);
        dashboardContent.innerHTML = '<div class="glass-card"><h3>Error loading network data</h3></div>';
        return;
    }

    const container = document.createElement('div');
    container.className = 'network-grid';

    // 1. Interfaces Section
    const ifaceSection = document.createElement('div');
    const ifaceTitle = document.createElement('h3');
    ifaceTitle.textContent = 'CM5 Network Adapters';
    ifaceTitle.style.marginBottom = '20px';
    ifaceSection.appendChild(ifaceTitle);

    // Grid container for interface cards
    const interfacesGrid = document.createElement('div');
    interfacesGrid.className = 'interfaces-grid';

    state.network.interfaces.forEach(iface => {
        const card = document.createElement('div');
        card.className = 'glass-card interface-card';
        card.dataset.interfaceId = iface.id;

        const isConnected = iface.status === 'connected';
        // Use local state if available, otherwise use server state
        const isDhcp = localDhcpState[iface.id] !== undefined ? localDhcpState[iface.id] : iface.dhcp;

        // Create header
        const header = document.createElement('div');
        header.className = 'interface-header';

        const headerInfo = document.createElement('div');
        const h4 = document.createElement('h4');
        h4.textContent = `${iface.name || 'Unknown'} (${iface.id || 'N/A'})`;
        const statusSpan = document.createElement('span');
        statusSpan.style.cssText = `font-size: 0.8rem; color: ${isConnected ? '#10b981' : '#94a3b8'}`;
        statusSpan.textContent = (iface.status || 'unknown').toUpperCase();
        headerInfo.appendChild(h4);
        headerInfo.appendChild(statusSpan);

        const checkboxItem = document.createElement('div');
        checkboxItem.className = 'checkbox-item';

        const dhcpCheckbox = document.createElement('input');
        dhcpCheckbox.type = 'checkbox';
        dhcpCheckbox.id = `dhcp-${iface.id}`;
        dhcpCheckbox.checked = isDhcp;
        dhcpCheckbox.addEventListener('change', (e) => toggleDHCP(iface.id, e.target.checked, iface));

        const dhcpLabel = document.createElement('label');
        dhcpLabel.htmlFor = `dhcp-${iface.id}`;
        dhcpLabel.textContent = 'DHCP';

        checkboxItem.appendChild(dhcpCheckbox);
        checkboxItem.appendChild(dhcpLabel);

        header.appendChild(headerInfo);
        header.appendChild(checkboxItem);

        // Create form
        const netForm = document.createElement('div');
        netForm.className = 'net-form';
        netForm.id = `netform-${iface.id}`;

        if (isDhcp) {
            const inputGroup = document.createElement('div');
            inputGroup.className = 'input-group';
            inputGroup.style.gridColumn = '1 / -1';

            const ipInput = document.createElement('input');
            ipInput.type = 'text';
            ipInput.value = iface.ip || '';
            ipInput.disabled = true;
            ipInput.placeholder = ' ';

            const label = document.createElement('label');
            label.textContent = 'Hardware Assigned IP';

            inputGroup.appendChild(ipInput);
            inputGroup.appendChild(label);
            netForm.appendChild(inputGroup);
        } else {
            // IP Input
            const ipGroup = document.createElement('div');
            ipGroup.className = 'input-group';
            const ipInput = document.createElement('input');
            ipInput.type = 'text';
            ipInput.id = `ip-${iface.id}`;
            ipInput.value = iface.ip || '';
            ipInput.placeholder = ' ';
            const ipLabel = document.createElement('label');
            ipLabel.textContent = 'IP Address';
            ipGroup.appendChild(ipInput);
            ipGroup.appendChild(ipLabel);

            // Subnet Input
            const subnetGroup = document.createElement('div');
            subnetGroup.className = 'input-group';
            const subnetInput = document.createElement('input');
            subnetInput.type = 'text';
            subnetInput.id = `subnet-${iface.id}`;
            subnetInput.value = iface.subnet || '';
            subnetInput.placeholder = ' ';
            const subnetLabel = document.createElement('label');
            subnetLabel.textContent = 'Subnet Mask';
            subnetGroup.appendChild(subnetInput);
            subnetGroup.appendChild(subnetLabel);

            netForm.appendChild(ipGroup);
            netForm.appendChild(subnetGroup);
        }

        // Save button
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display: flex; align-items: flex-end; padding-bottom: 25px; grid-column: 1 / -1;';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary';
        saveBtn.style.cssText = 'padding: 10px; max-width: 200px;';
        saveBtn.textContent = 'Save to Node';
        saveBtn.addEventListener('click', () => applyNetwork(iface.id));

        btnContainer.appendChild(saveBtn);
        netForm.appendChild(btnContainer);

        card.appendChild(header);
        card.appendChild(netForm);
        interfacesGrid.appendChild(card);
    });

    ifaceSection.appendChild(interfacesGrid);

    // 2. DDNS Section
    const ddnsSection = document.createElement('div');
    const ddnsTitle = document.createElement('h3');
    ddnsTitle.style.cssText = 'margin-top: 40px; margin-bottom: 20px;';
    ddnsTitle.textContent = 'Remote Access (DDNS)';
    ddnsSection.appendChild(ddnsTitle);

    const ddnsGrid = document.createElement('div');
    ddnsGrid.className = 'ddns-grid';

    (state.network.ddns || []).forEach(service => {
        const card = document.createElement('div');
        card.className = 'glass-card ddns-card';

        const isOnline = service.status === 'online';

        // Header
        const ddnsHeader = document.createElement('div');
        ddnsHeader.className = 'ddns-header';

        const logo = document.createElement('div');
        logo.className = 'ddns-logo';
        logo.style.background = isOnline ? '#10b981' : '#ef4444';
        logo.textContent = (service.name || 'U').charAt(0);

        const headerInfo = document.createElement('div');
        const serviceH4 = document.createElement('h4');
        serviceH4.textContent = service.name || 'Unknown';
        const statusInfo = document.createElement('span');
        statusInfo.style.fontSize = '0.75rem';
        statusInfo.innerHTML = `<span class="status-dot ${isOnline ? 'status-check-online' : 'status-check-offline'}"></span>${(service.status || 'unknown').toUpperCase()}`;
        headerInfo.appendChild(serviceH4);
        headerInfo.appendChild(statusInfo);

        ddnsHeader.appendChild(logo);
        ddnsHeader.appendChild(headerInfo);

        // Domain row
        const domainRow = document.createElement('div');
        domainRow.className = 'status-row-net';
        const domainLabel = document.createElement('span');
        domainLabel.textContent = 'Domain';
        const domainValue = document.createElement('span');
        domainValue.style.color = 'white';
        domainValue.textContent = service.domain || 'N/A';
        domainRow.appendChild(domainLabel);
        domainRow.appendChild(domainValue);

        // IP row
        const ipRow = document.createElement('div');
        ipRow.className = 'status-row-net';
        const ipLabel = document.createElement('span');
        ipLabel.textContent = 'Gateway IP';
        const ipValue = document.createElement('span');
        ipValue.style.cssText = 'color: #10b981; font-weight: 600;';
        ipValue.textContent = isOnline ? (state.publicIP || '---') : '---';
        ipRow.appendChild(ipLabel);
        ipRow.appendChild(ipValue);

        card.appendChild(ddnsHeader);
        card.appendChild(domainRow);
        card.appendChild(ipRow);
        ddnsGrid.appendChild(card);
    });

    // Add service button
    const addCard = document.createElement('div');
    addCard.className = 'btn-add-ddns';
    addCard.addEventListener('click', openDDNSModal);

    const plusIcon = document.createElement('span');
    plusIcon.className = 'plus-icon';
    plusIcon.textContent = '+';
    const addText = document.createElement('span');
    addText.style.cssText = 'font-size: 0.9rem; font-weight: 600;';
    addText.textContent = 'Add Service';

    addCard.appendChild(plusIcon);
    addCard.appendChild(addText);
    ddnsGrid.appendChild(addCard);

    ddnsSection.appendChild(ddnsGrid);
    container.appendChild(ifaceSection);
    container.appendChild(ddnsSection);
    dashboardContent.appendChild(container);
}

// Network functions
function toggleDHCP(interfaceId, isChecked, iface) {
    // Update local state
    localDhcpState[interfaceId] = isChecked;

    // Re-render only the form for this interface
    const netForm = document.getElementById(`netform-${interfaceId}`);
    if (netForm) {
        renderNetForm(netForm, iface, isChecked);
    }
}

// Helper function to render the network form
function renderNetForm(netForm, iface, isDhcp) {
    netForm.innerHTML = '';

    if (isDhcp) {
        const inputGroup = document.createElement('div');
        inputGroup.className = 'input-group';
        inputGroup.style.gridColumn = '1 / -1';

        const ipInput = document.createElement('input');
        ipInput.type = 'text';
        ipInput.value = iface.ip || '';
        ipInput.disabled = true;
        ipInput.placeholder = ' ';

        const label = document.createElement('label');
        label.textContent = 'Hardware Assigned IP';

        inputGroup.appendChild(ipInput);
        inputGroup.appendChild(label);
        netForm.appendChild(inputGroup);
    } else {
        // IP Input
        const ipGroup = document.createElement('div');
        ipGroup.className = 'input-group';
        const ipInput = document.createElement('input');
        ipInput.type = 'text';
        ipInput.id = `ip-${iface.id}`;
        ipInput.value = iface.ip || '';
        ipInput.placeholder = ' ';
        const ipLabel = document.createElement('label');
        ipLabel.textContent = 'IP Address';
        ipGroup.appendChild(ipInput);
        ipGroup.appendChild(ipLabel);

        // Subnet Input
        const subnetGroup = document.createElement('div');
        subnetGroup.className = 'input-group';
        const subnetInput = document.createElement('input');
        subnetInput.type = 'text';
        subnetInput.id = `subnet-${iface.id}`;
        subnetInput.value = iface.subnet || '';
        subnetInput.placeholder = ' ';
        const subnetLabel = document.createElement('label');
        subnetLabel.textContent = 'Subnet Mask';
        subnetGroup.appendChild(subnetInput);
        subnetGroup.appendChild(subnetLabel);

        // Gateway Input
        const gatewayGroup = document.createElement('div');
        gatewayGroup.className = 'input-group';
        const gatewayInput = document.createElement('input');
        gatewayInput.type = 'text';
        gatewayInput.id = `gateway-${iface.id}`;
        gatewayInput.value = iface.gateway || '';
        gatewayInput.placeholder = ' ';
        const gatewayLabel = document.createElement('label');
        gatewayLabel.textContent = 'Gateway';
        gatewayGroup.appendChild(gatewayInput);
        gatewayGroup.appendChild(gatewayLabel);

        // DNS Input
        const dnsGroup = document.createElement('div');
        dnsGroup.className = 'input-group';
        const dnsInput = document.createElement('input');
        dnsInput.type = 'text';
        dnsInput.id = `dns-${iface.id}`;
        dnsInput.value = '';
        dnsInput.placeholder = ' ';
        const dnsLabel = document.createElement('label');
        dnsLabel.textContent = 'DNS (ej: 8.8.8.8)';
        dnsGroup.appendChild(dnsInput);
        dnsGroup.appendChild(dnsLabel);

        netForm.appendChild(ipGroup);
        netForm.appendChild(subnetGroup);
        netForm.appendChild(gatewayGroup);
        netForm.appendChild(dnsGroup);
    }

    // Save button
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; align-items: flex-end; padding-top: 10px; grid-column: 1 / -1;';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.style.cssText = 'padding: 10px; width: 100%;';
    saveBtn.textContent = 'Save to Node';
    saveBtn.addEventListener('click', () => applyNetwork(iface.id));

    btnContainer.appendChild(saveBtn);
    netForm.appendChild(btnContainer);
}

async function applyNetwork(interfaceId) {
    const dhcpCheckbox = document.getElementById(`dhcp-${interfaceId}`);
    const isDhcp = dhcpCheckbox ? dhcpCheckbox.checked : false;

    let config = { dhcp: isDhcp };

    if (!isDhcp) {
        const ipInput = document.getElementById(`ip-${interfaceId}`);
        const subnetInput = document.getElementById(`subnet-${interfaceId}`);
        const gatewayInput = document.getElementById(`gateway-${interfaceId}`);
        const dnsInput = document.getElementById(`dns-${interfaceId}`);

        if (ipInput) config.ip = ipInput.value.trim();
        if (subnetInput) config.subnet = subnetInput.value.trim();
        if (gatewayInput) config.gateway = gatewayInput.value.trim();
        if (dnsInput) config.dns = dnsInput.value.trim();

        // Basic validation
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

        if (config.ip && !ipRegex.test(config.ip)) {
            alert('Formato de IP inválido');
            return;
        }

        if (config.subnet && !ipRegex.test(config.subnet)) {
            alert('Formato de máscara de subred inválido');
            return;
        }

        if (config.gateway && !ipRegex.test(config.gateway)) {
            alert('Formato de puerta de enlace inválido');
            return;
        }

        if (config.dns && !ipRegex.test(config.dns)) {
            alert('Formato de DNS inválido');
            return;
        }
    }

    try {
        const res = await authFetch(`${API_BASE}/network/configure`, {
            method: 'POST',
            body: JSON.stringify({ id: interfaceId, config })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Network configuration failed');
        }

        alert(data.message || 'Configuration saved');
    } catch (e) {
        console.error('Network config error:', e);
        alert(e.message || 'Failed to apply network configuration');
    }
}

function openDDNSModal() {
    if (ddnsModal) {
        ddnsModal.style.display = 'flex';
    }
}

function closeDDNSModal() {
    if (ddnsModal) {
        ddnsModal.style.display = 'none';
    }
}

// Initialize modal close button
const closeModalBtn = document.getElementById('close-modal');
if (closeModalBtn) {
    closeModalBtn.addEventListener('click', closeDDNSModal);
}

// Close modal on outside click
if (ddnsModal) {
    ddnsModal.addEventListener('click', (e) => {
        if (e.target === ddnsModal) {
            closeDDNSModal();
        }
    });
}

// Terms and Conditions Modal
const termsModal = document.getElementById('terms-modal');
const termsLink = document.getElementById('terms-link');
const closeTermsBtn = document.getElementById('close-terms-modal');
const acceptTermsBtn = document.getElementById('accept-terms-btn');

if (termsLink) {
    termsLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (termsModal) termsModal.style.display = 'flex';
    });
}

if (closeTermsBtn) {
    closeTermsBtn.addEventListener('click', () => {
        if (termsModal) termsModal.style.display = 'none';
    });
}

if (acceptTermsBtn) {
    acceptTermsBtn.addEventListener('click', () => {
        if (termsModal) termsModal.style.display = 'none';
    });
}

if (termsModal) {
    termsModal.addEventListener('click', (e) => {
        if (e.target === termsModal) {
            termsModal.style.display = 'none';
        }
    });
}

// System View (Real Actions)
function renderSystemView() {
    // Format uptime intelligently
    const uptimeSeconds = Number(state.globalStats.uptime) || 0;
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    let uptimeStr;
    if (days > 0) {
        uptimeStr = `${days} día${days > 1 ? 's' : ''} ${hours}h`;
    } else if (hours > 0) {
        uptimeStr = `${hours} hora${hours > 1 ? 's' : ''} ${minutes}m`;
    } else {
        uptimeStr = `${minutes} minuto${minutes !== 1 ? 's' : ''}`;
    }
    const hostname = escapeHtml(state.globalStats.hostname || 'raspberrypi');

    const container = document.createElement('div');
    container.style.cssText = 'display: contents;';

    // Management card
    const mgmtCard = document.createElement('div');
    mgmtCard.className = 'glass-card';
    mgmtCard.style.gridColumn = '1 / -1';

    const mgmtTitle = document.createElement('h3');
    mgmtTitle.textContent = 'CM5 Node Management';

    const mgmtDesc = document.createElement('p');
    mgmtDesc.style.cssText = 'color: var(--text-dim); margin-top: 10px;';
    mgmtDesc.textContent = 'Execute physical actions on the NAS hardware.';

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 20px; margin-top: 30px;';

    const rebootBtn = document.createElement('button');
    rebootBtn.className = 'btn-primary';
    rebootBtn.style.cssText = 'background: #f59e0b; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4);';
    rebootBtn.textContent = 'Restart Node';
    rebootBtn.addEventListener('click', () => systemAction('reboot'));

    const shutdownBtn = document.createElement('button');
    shutdownBtn.className = 'btn-primary';
    shutdownBtn.style.cssText = 'background: #ef4444; box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);';
    shutdownBtn.textContent = 'Power Off';
    shutdownBtn.addEventListener('click', () => systemAction('shutdown'));

    btnContainer.appendChild(rebootBtn);
    btnContainer.appendChild(shutdownBtn);

    mgmtCard.appendChild(mgmtTitle);
    mgmtCard.appendChild(mgmtDesc);
    mgmtCard.appendChild(btnContainer);

    // Info card
    const infoCard = document.createElement('div');
    infoCard.className = 'glass-card';

    const infoTitle = document.createElement('h3');
    infoTitle.textContent = 'System Info';

    const uptimeRow = document.createElement('div');
    uptimeRow.className = 'stat-row';
    uptimeRow.innerHTML = `<span>Logic Uptime</span> <span>${uptimeStr}</span>`;

    const hostnameRow = document.createElement('div');
    hostnameRow.className = 'stat-row';
    hostnameRow.innerHTML = `<span>Node Name</span> <span>${hostname}</span>`;

    infoCard.appendChild(infoTitle);
    infoCard.appendChild(uptimeRow);
    infoCard.appendChild(hostnameRow);

    // Update card
    const updateCard = document.createElement('div');
    updateCard.className = 'glass-card';

    const updateTitle = document.createElement('h3');
    updateTitle.textContent = 'Software Updates';

    const updateDesc = document.createElement('p');
    updateDesc.style.cssText = 'color: var(--text-dim); margin-top: 10px;';
    updateDesc.textContent = 'Check for and install HomePiNAS updates from GitHub.';

    const updateStatus = document.createElement('div');
    updateStatus.id = 'update-status';
    updateStatus.style.cssText = 'margin-top: 15px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px;';
    updateStatus.innerHTML = '<span style="color: var(--text-dim);">Click "Check Updates" to verify...</span>';

    const updateBtnContainer = document.createElement('div');
    updateBtnContainer.style.cssText = 'display: flex; gap: 15px; margin-top: 20px;';

    const checkUpdateBtn = document.createElement('button');
    checkUpdateBtn.className = 'btn-primary';
    checkUpdateBtn.style.cssText = 'background: #6366f1; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);';
    checkUpdateBtn.textContent = 'Check Updates';
    checkUpdateBtn.addEventListener('click', checkForUpdates);

    const applyUpdateBtn = document.createElement('button');
    applyUpdateBtn.className = 'btn-primary';
    applyUpdateBtn.id = 'apply-update-btn';
    applyUpdateBtn.style.cssText = 'background: #10b981; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: none;';
    applyUpdateBtn.textContent = 'Install Update';
    applyUpdateBtn.addEventListener('click', applyUpdate);

    updateBtnContainer.appendChild(checkUpdateBtn);
    updateBtnContainer.appendChild(applyUpdateBtn);

    updateCard.appendChild(updateTitle);
    updateCard.appendChild(updateDesc);
    updateCard.appendChild(updateStatus);
    updateCard.appendChild(updateBtnContainer);

    dashboardContent.appendChild(mgmtCard);
    dashboardContent.appendChild(infoCard);
    dashboardContent.appendChild(updateCard);
}

async function systemAction(action) {
    const actionLabel = action === 'reboot' ? 'restart' : 'shut down';

    if (!confirm(`Are you sure you want to ${actionLabel} the NAS?`)) return;

    try {
        const res = await authFetch(`${API_BASE}/system/${action}`, { method: 'POST' });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'System action failed');
        }

        alert(`${action.toUpperCase()} command sent to Hardware.`);
    } catch (e) {
        console.error('System action error:', e);
        alert(e.message || 'System Logic Fail');
    }
}

window.systemAction = systemAction;

// Update Functions
async function checkForUpdates() {
    const statusEl = document.getElementById('update-status');
    const applyBtn = document.getElementById('apply-update-btn');

    if (!statusEl) return;

    statusEl.innerHTML = '<span style="color: #f59e0b;">Checking for updates...</span>';
    if (applyBtn) applyBtn.style.display = 'none';

    try {
        const res = await authFetch(`${API_BASE}/update/check`);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Failed to check updates');
        }

        if (data.updateAvailable) {
            statusEl.innerHTML = `
                <div style="color: #10b981; font-weight: 600;">Update Available!</div>
                <div style="margin-top: 8px; color: var(--text-dim);">
                    Current: <strong>v${escapeHtml(data.currentVersion)}</strong> →
                    Latest: <strong style="color: #10b981;">v${escapeHtml(data.latestVersion)}</strong>
                </div>
                <div style="margin-top: 10px; font-size: 0.85rem; color: var(--text-dim);">
                    <strong>Changes:</strong><br>
                    <code style="display: block; margin-top: 5px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; white-space: pre-wrap;">${escapeHtml(data.changelog || 'See GitHub for details')}</code>
                </div>
            `;
            if (applyBtn) applyBtn.style.display = 'inline-block';
        } else {
            statusEl.innerHTML = `
                <div style="color: #6366f1;">You're up to date!</div>
                <div style="margin-top: 8px; color: var(--text-dim);">
                    Version: <strong>v${escapeHtml(data.currentVersion)}</strong>
                </div>
            `;
        }
    } catch (e) {
        console.error('Update check error:', e);
        statusEl.innerHTML = `<span style="color: #ef4444;">Error: ${escapeHtml(e.message)}</span>`;
    }
}

async function applyUpdate() {
    if (!confirm('Install the update now? The service will restart and you may lose connection for ~30 seconds.')) {
        return;
    }

    const statusEl = document.getElementById('update-status');
    const applyBtn = document.getElementById('apply-update-btn');

    if (statusEl) {
        statusEl.innerHTML = '<span style="color: #f59e0b;">Installing update... Please wait.</span>';
    }
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Installing...';
    }

    try {
        const res = await authFetch(`${API_BASE}/update/apply`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Update failed');
        }

        if (statusEl) {
            statusEl.innerHTML = `
                <div style="color: #10b981; font-weight: 600;">Update started!</div>
                <div style="margin-top: 8px; color: var(--text-dim);">
                    The service is restarting. This page will refresh automatically in 30 seconds...
                </div>
                <div style="margin-top: 10px;">
                    <div class="progress-bar" style="height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                        <div id="update-progress" style="height: 100%; background: #10b981; width: 0%; transition: width 0.5s;"></div>
                    </div>
                </div>
            `;
        }

        // Progress animation and auto-refresh
        let progress = 0;
        const progressEl = document.getElementById('update-progress');
        const interval = setInterval(() => {
            progress += 3.33;
            if (progressEl) progressEl.style.width = `${Math.min(progress, 100)}%`;
            if (progress >= 100) {
                clearInterval(interval);
                window.location.reload();
            }
        }, 1000);

    } catch (e) {
        console.error('Update apply error:', e);
        if (statusEl) {
            statusEl.innerHTML = `<span style="color: #ef4444;">Update failed: ${escapeHtml(e.message)}</span>`;
        }
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Retry Update';
            applyBtn.style.display = 'inline-block';
        }
    }
}

window.checkForUpdates = checkForUpdates;
window.applyUpdate = applyUpdate;

// Helper Colors
function getRoleColor(role) {
    switch (role) {
        case 'data': return '#6366f1';
        case 'parity': return '#f59e0b';
        case 'cache': return '#10b981';
        case 'independent': return '#14b8a6';
        default: return '#475569';
    }
}

if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to RESET the entire NAS? This will delete all configuration and require a new setup.')) return;

        resetBtn.textContent = 'Resetting Node...';
        resetBtn.disabled = true;

        try {
            const res = await authFetch(`${API_BASE}/system/reset`, { method: 'POST' });
            const data = await res.json();

            if (res.ok && data.success) {
                // Clear local session
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


// Logout handler
const logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to logout?")) {
            clearSession();
            state.isAuthenticated = false;
            state.user = null;
            window.location.reload();
        }
    });
}

initAuth();
console.log("HomePiNAS Core v1.1.0 Loaded - (Secure Auth Active)");
