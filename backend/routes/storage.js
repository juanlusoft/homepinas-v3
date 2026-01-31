/**
 * HomePiNAS - Storage Routes
 * v3.0.0 - Dual Backend Support
 *
 * Supports both SnapRAID + MergerFS and NonRAID storage backends
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const { getData, saveData } = require('../utils/data');
const { validateSession } = require('../utils/session');

// Constants - SnapRAID
const STORAGE_MOUNT_BASE = '/mnt/disks';
const POOL_MOUNT = '/mnt/storage';
const SNAPRAID_CONF = '/etc/snapraid.conf';

// Constants - NonRAID
const NONRAID_DAT = '/nonraid.dat';
const NONRAID_MOUNT_PREFIX = '/mnt/disk';

// Detect storage backend from config file
function getStorageBackend() {
    try {
        const configPath = path.join(__dirname, '..', 'storage-backend.conf');
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            const match = content.match(/STORAGE_BACKEND=(\w+)/);
            if (match) return match[1];
        }
    } catch (e) {}
    // Also check environment variable
    return process.env.STORAGE_BACKEND || 'snapraid';
}

// SnapRAID sync progress tracking
let snapraidSyncStatus = {
    running: false,
    progress: 0,
    status: '',
    startTime: null,
    error: null
};

// NonRAID status tracking
let nonraidStatus = {
    checking: false,
    progress: 0,
    step: '',
    error: null
};

// NonRAID configure status
let nonraidConfigureStatus = {
    active: false,
    step: '',
    progress: 0,
    error: null
};

// Helper: Execute command with promise
function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        require('child_process').exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr, stdout });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// GET /storage/backend - Get current storage backend
router.get('/backend', (req, res) => {
    res.json({ backend: getStorageBackend() });
});

// Get storage pool status
router.get('/pool/status', async (req, res) => {
    try {
        let snapraidConfigured = false;
        let mergerfsRunning = false;
        let poolSize = '0';
        let poolUsed = '0';
        let poolFree = '0';

        try {
            const snapraidConf = execSync(`cat ${SNAPRAID_CONF} 2>/dev/null || echo ""`, { encoding: 'utf8' });
            snapraidConfigured = snapraidConf.includes('content') && snapraidConf.includes('disk');
        } catch (e) {}

        try {
            const mounts = execSync('mount | grep mergerfs || echo ""', { encoding: 'utf8' });
            mergerfsRunning = mounts.includes('mergerfs');

            if (mergerfsRunning) {
                const df = execSync(`df -BG ${POOL_MOUNT} 2>/dev/null | tail -1`, { encoding: 'utf8' });
                const parts = df.trim().split(/\s+/);
                if (parts.length >= 4) {
                    poolSize = parts[1].replace('G', '');
                    poolUsed = parts[2].replace('G', '');
                    poolFree = parts[3].replace('G', '');
                }
            }
        } catch (e) {}

        let lastSync = null;
        try {
            const logContent = execSync('tail -20 /var/log/snapraid-sync.log 2>/dev/null || echo ""', { encoding: 'utf8' });
            const syncMatch = logContent.match(/SnapRAID Sync Finished: (.+?)=/);
            if (syncMatch) {
                lastSync = syncMatch[1].trim();
            }
        } catch (e) {}

        res.json({
            configured: snapraidConfigured,
            running: mergerfsRunning,
            poolMount: POOL_MOUNT,
            poolSize: poolSize + ' GB',
            poolUsed: poolUsed + ' GB',
            poolFree: poolFree + ' GB',
            lastSync
        });
    } catch (e) {
        console.error('Pool status error:', e);
        res.status(500).json({ error: 'Failed to get pool status' });
    }
});

// Apply storage configuration
router.post('/pool/configure', requireAuth, async (req, res) => {
    const { disks } = req.body;

    if (!disks || !Array.isArray(disks) || disks.length === 0) {
        return res.status(400).json({ error: 'No disks provided' });
    }

    const dataDisks = disks.filter(d => d.role === 'data');
    const parityDisks = disks.filter(d => d.role === 'parity');
    const cacheDisks = disks.filter(d => d.role === 'cache');

    if (dataDisks.length === 0) {
        return res.status(400).json({ error: 'At least one data disk is required' });
    }

    // Parity is now optional - SnapRAID will only be configured if parity disks are present

    try {
        const results = [];

        // 1. Format disks that need formatting
        for (const disk of disks) {
            if (disk.format) {
                results.push(`Formatting /dev/${disk.id}...`);
                try {
                    execSync(`sudo parted -s /dev/${disk.id} mklabel gpt`, { encoding: 'utf8' });
                    execSync(`sudo parted -s /dev/${disk.id} mkpart primary ext4 0% 100%`, { encoding: 'utf8' });
                    execSync(`sudo partprobe /dev/${disk.id}`, { encoding: 'utf8' });
                    execSync('sleep 2');

                    const partition = disk.id.includes('nvme') ? `${disk.id}p1` : `${disk.id}1`;
                    execSync(`sudo mkfs.ext4 -F -L ${disk.role}_${disk.id} /dev/${partition}`, { encoding: 'utf8' });
                    results.push(`Formatted /dev/${partition} as ext4`);
                } catch (e) {
                    results.push(`Warning: Format failed for ${disk.id}: ${e.message}`);
                }
            }
        }

        // 2. Create mount points and mount disks
        let diskNum = 1;
        const dataMounts = [];
        const parityMounts = [];
        const cacheMounts = [];

        for (const disk of dataDisks) {
            const partition = disk.id.includes('nvme') ? `${disk.id}p1` : `${disk.id}1`;
            const mountPoint = `${STORAGE_MOUNT_BASE}/disk${diskNum}`;

            execSync(`sudo mkdir -p ${mountPoint}`, { encoding: 'utf8' });
            execSync(`sudo mount /dev/${partition} ${mountPoint} 2>/dev/null || true`, { encoding: 'utf8' });
            execSync(`sudo mkdir -p ${mountPoint}/.snapraid`, { encoding: 'utf8' });

            dataMounts.push({ disk: disk.id, partition, mountPoint, num: diskNum });
            results.push(`Mounted /dev/${partition} at ${mountPoint}`);
            diskNum++;
        }

        let parityNum = 1;
        for (const disk of parityDisks) {
            const partition = disk.id.includes('nvme') ? `${disk.id}p1` : `${disk.id}1`;
            const mountPoint = `/mnt/parity${parityNum}`;

            execSync(`sudo mkdir -p ${mountPoint}`, { encoding: 'utf8' });
            execSync(`sudo mount /dev/${partition} ${mountPoint} 2>/dev/null || true`, { encoding: 'utf8' });

            parityMounts.push({ disk: disk.id, partition, mountPoint, num: parityNum });
            results.push(`Mounted /dev/${partition} at ${mountPoint} (parity)`);
            parityNum++;
        }

        let cacheNum = 1;
        for (const disk of cacheDisks) {
            const partition = disk.id.includes('nvme') ? `${disk.id}p1` : `${disk.id}1`;
            const mountPoint = `${STORAGE_MOUNT_BASE}/cache${cacheNum}`;

            execSync(`sudo mkdir -p ${mountPoint}`, { encoding: 'utf8' });
            execSync(`sudo mount /dev/${partition} ${mountPoint} 2>/dev/null || true`, { encoding: 'utf8' });

            cacheMounts.push({ disk: disk.id, partition, mountPoint, num: cacheNum });
            results.push(`Mounted /dev/${partition} at ${mountPoint} (cache)`);
            cacheNum++;
        }

        // 3. Generate SnapRAID config (only if parity disks are present)
        if (parityMounts.length > 0) {
            let snapraidConf = `# HomePiNAS SnapRAID Configuration
# Generated: ${new Date().toISOString()}

# Parity files
`;
            parityMounts.forEach((p, i) => {
                if (i === 0) {
                    snapraidConf += `parity ${p.mountPoint}/snapraid.parity\n`;
                } else {
                    snapraidConf += `${i + 1}-parity ${p.mountPoint}/snapraid.parity\n`;
                }
            });

            snapraidConf += `\n# Content files (stored on data disks)\n`;
            dataMounts.forEach(d => {
                snapraidConf += `content ${d.mountPoint}/.snapraid/snapraid.content\n`;
            });

            snapraidConf += `\n# Data disks\n`;
            dataMounts.forEach(d => {
                snapraidConf += `disk d${d.num} ${d.mountPoint}\n`;
            });

            snapraidConf += `\n# Exclude files
exclude *.unrecoverable
exclude /tmp/
exclude /lost+found/
exclude .Thumbs.db
exclude .DS_Store
exclude *.!sync
exclude .AppleDouble
exclude ._AppleDouble
exclude .Spotlight-V100
exclude .TemporaryItems
exclude .Trashes
exclude .fseventsd
`;

            execSync(`echo '${snapraidConf}' | sudo tee ${SNAPRAID_CONF}`, { shell: '/bin/bash' });
            results.push('SnapRAID configuration created');
        } else {
            results.push('SnapRAID skipped (no parity disks configured)');
        }

        // 4. Configure MergerFS
        const mergerfsSource = dataMounts.map(d => d.mountPoint).join(':');
        execSync(`sudo mkdir -p ${POOL_MOUNT}`, { encoding: 'utf8' });
        execSync(`sudo umount ${POOL_MOUNT} 2>/dev/null || true`, { encoding: 'utf8' });

        const mergerfsOpts = 'defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs';
        execSync(`sudo mergerfs -o ${mergerfsOpts} ${mergerfsSource} ${POOL_MOUNT}`, { encoding: 'utf8' });
        results.push(`MergerFS pool mounted at ${POOL_MOUNT}`);

        // Set permissions
        try {
            execSync(`sudo chown -R :sambashare ${POOL_MOUNT}`, { encoding: 'utf8' });
            execSync(`sudo chmod -R 2775 ${POOL_MOUNT}`, { encoding: 'utf8' });
            results.push('Samba permissions configured');
        } catch (e) {
            results.push('Warning: Could not set Samba permissions');
        }

        // 5. Update /etc/fstab
        let fstabEntries = '\n# HomePiNAS Storage Configuration\n';

        dataMounts.forEach(d => {
            fstabEntries += `UUID=$(sudo blkid -s UUID -o value /dev/${d.partition}) ${d.mountPoint} ext4 defaults,nofail 0 2\n`;
        });

        parityMounts.forEach(p => {
            fstabEntries += `UUID=$(sudo blkid -s UUID -o value /dev/${p.partition}) ${p.mountPoint} ext4 defaults,nofail 0 2\n`;
        });

        cacheMounts.forEach(c => {
            fstabEntries += `UUID=$(sudo blkid -s UUID -o value /dev/${c.partition}) ${c.mountPoint} ext4 defaults,nofail 0 2\n`;
        });

        fstabEntries += `${mergerfsSource} ${POOL_MOUNT} fuse.mergerfs ${mergerfsOpts},nofail 0 0\n`;

        execSync(`sudo sed -i '/# HomePiNAS Storage/,/^$/d' /etc/fstab`, { encoding: 'utf8' });
        execSync(`echo '${fstabEntries}' | sudo tee -a /etc/fstab`, { shell: '/bin/bash' });
        results.push('Updated /etc/fstab for persistence');

        results.push('Starting initial SnapRAID sync (this may take a while)...');

        // Save storage config
        const data = getData();
        data.storageConfig = disks.map(d => ({ id: d.id, role: d.role }));
        data.poolConfigured = true;
        saveData(data);

        logSecurityEvent('STORAGE_CONFIGURED', { disks: disks.map(d => d.id), dataCount: dataDisks.length, parityCount: parityDisks.length }, req.ip);

        res.json({
            success: true,
            message: 'Storage pool configured successfully',
            results,
            poolMount: POOL_MOUNT
        });

    } catch (e) {
        console.error('Storage configuration error:', e);
        res.status(500).json({ error: `Failed to configure storage: ${e.message}` });
    }
});

// Run SnapRAID sync
router.post('/snapraid/sync', requireAuth, async (req, res) => {
    if (snapraidSyncStatus.running) {
        return res.status(409).json({ error: 'Sync already in progress', progress: snapraidSyncStatus.progress });
    }

    snapraidSyncStatus = {
        running: true,
        progress: 0,
        status: 'Starting sync...',
        startTime: Date.now(),
        error: null
    };

    const syncProcess = spawn('sudo', ['snapraid', 'sync', '-v'], {
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';

    const parseOutput = (data) => {
        const text = data.toString();
        output += text;

        const lines = text.split('\n');
        for (const line of lines) {
            const progressMatch = line.match(/(\d+)%/);
            if (progressMatch) {
                snapraidSyncStatus.progress = parseInt(progressMatch[1]);
            }

            if (line.includes('completed') || line.includes('Nothing to do')) {
                snapraidSyncStatus.progress = 100;
                snapraidSyncStatus.status = 'Sync completed';
            }

            const fileMatch = line.match(/(\d+)\s+(files?|blocks?)/i);
            if (fileMatch) {
                snapraidSyncStatus.status = `Processing ${fileMatch[1]} ${fileMatch[2]}...`;
            }

            if (line.includes('Syncing')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }

            if (line.includes('Self test') || line.includes('Verifying')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }
        }
    };

    syncProcess.stdout.on('data', parseOutput);
    syncProcess.stderr.on('data', parseOutput);

    const progressSimulator = setInterval(() => {
        const elapsed = Date.now() - snapraidSyncStatus.startTime;

        if (snapraidSyncStatus.running && snapraidSyncStatus.progress === 0 && elapsed > 2000) {
            const simulatedProgress = Math.min(90, Math.floor((elapsed - 2000) / 100));
            if (simulatedProgress > snapraidSyncStatus.progress) {
                snapraidSyncStatus.progress = simulatedProgress;
                snapraidSyncStatus.status = 'Initializing parity data...';
            }
        }
    }, 500);

    syncProcess.on('close', (code) => {
        clearInterval(progressSimulator);

        if (code === 0) {
            snapraidSyncStatus.progress = 100;
            snapraidSyncStatus.status = 'Sync completed successfully';
            snapraidSyncStatus.error = null;
        } else {
            if (output.includes('Nothing to do')) {
                snapraidSyncStatus.progress = 100;
                snapraidSyncStatus.status = 'Already in sync (nothing to do)';
                snapraidSyncStatus.error = null;
            } else {
                snapraidSyncStatus.error = `Sync exited with code ${code}`;
                snapraidSyncStatus.status = 'Sync failed';
            }
        }
        snapraidSyncStatus.running = false;
        logSecurityEvent('SNAPRAID_SYNC_COMPLETE', { code, duration: Date.now() - snapraidSyncStatus.startTime }, '');
    });

    syncProcess.on('error', (err) => {
        clearInterval(progressSimulator);
        snapraidSyncStatus.error = err.message;
        snapraidSyncStatus.status = 'Sync failed to start';
        snapraidSyncStatus.running = false;
    });

    res.json({ success: true, message: 'SnapRAID sync started in background' });
});

// Get SnapRAID sync progress
router.get('/snapraid/sync/progress', (req, res) => {
    res.json(snapraidSyncStatus);
});

// Run SnapRAID scrub
router.post('/snapraid/scrub', requireAuth, async (req, res) => {
    try {
        execSync('sudo snapraid scrub -p 10', { encoding: 'utf8', timeout: 7200000 });
        logSecurityEvent('SNAPRAID_SCRUB', {}, req.ip);
        res.json({ success: true, message: 'SnapRAID scrub completed' });
    } catch (e) {
        console.error('SnapRAID scrub error:', e);
        res.status(500).json({ error: `SnapRAID scrub failed: ${e.message}` });
    }
});

// Get SnapRAID status
router.get('/snapraid/status', async (req, res) => {
    try {
        const status = execSync('sudo snapraid status 2>&1 || echo "Not configured"', { encoding: 'utf8' });
        res.json({ status });
    } catch (e) {
        res.json({ status: 'Not configured or error' });
    }
});

// Storage config
router.post('/config', (req, res) => {
    try {
        const { config } = req.body;
        const data = getData();

        if (data.storageConfig && data.storageConfig.length > 0) {
            const sessionId = req.headers['x-session-id'];
            const session = validateSession(sessionId);
            if (!session) {
                logSecurityEvent('UNAUTHORIZED_STORAGE_CHANGE', {}, req.ip);
                return res.status(401).json({ error: 'Authentication required' });
            }
        }

        if (!Array.isArray(config)) {
            return res.status(400).json({ error: 'Invalid configuration format' });
        }

        const validRoles = ['data', 'parity', 'cache', 'none'];
        for (const item of config) {
            if (!item.id || typeof item.id !== 'string') {
                return res.status(400).json({ error: 'Invalid disk ID in configuration' });
            }
            if (!item.role || !validRoles.includes(item.role)) {
                return res.status(400).json({ error: 'Invalid role in configuration' });
            }
        }

        data.storageConfig = config;
        saveData(data);

        logSecurityEvent('STORAGE_CONFIG', { disks: config.length }, req.ip);
        res.json({ success: true, message: 'Storage configuration saved' });
    } catch (e) {
        console.error('Storage config error:', e);
        res.status(500).json({ error: 'Failed to save storage configuration' });
    }
});

// ============================================
// NonRAID Endpoints (only active when backend = nonraid)
// ============================================

// GET /storage/array/status - Get NonRAID array status
router.get('/array/status', async (req, res) => {
    if (getStorageBackend() !== 'nonraid') {
        return res.status(400).json({ error: 'NonRAID backend not active' });
    }

    try {
        // Check if NonRAID is installed
        try {
            execSync('which nmdctl', { encoding: 'utf8' });
        } catch {
            return res.json({
                success: true,
                installed: false,
                status: 'NOT_INSTALLED'
            });
        }

        // Check if array exists
        if (!fs.existsSync(NONRAID_DAT)) {
            return res.json({
                success: true,
                installed: true,
                configured: false,
                status: 'NOT_CONFIGURED'
            });
        }

        // Get array status
        const { stdout } = await execPromise('sudo nmdctl status -o json');
        const status = JSON.parse(stdout);

        // Get disk usage for each mounted disk
        const disks = [];
        for (let i = 0; i < status.dataDisks; i++) {
            const mountPoint = `${NONRAID_MOUNT_PREFIX}${i + 1}`;
            try {
                const dfOut = execSync(`df -B1 "${mountPoint}" | tail -1`, { encoding: 'utf8' });
                const parts = dfOut.trim().split(/\s+/);
                disks.push({
                    slot: i + 1,
                    mountPoint,
                    device: parts[0],
                    total: parseInt(parts[1]),
                    used: parseInt(parts[2]),
                    available: parseInt(parts[3]),
                    usagePercent: parseInt(parts[4])
                });
            } catch {
                disks.push({
                    slot: i + 1,
                    mountPoint,
                    status: 'unmounted'
                });
            }
        }

        res.json({
            success: true,
            installed: true,
            configured: true,
            status: status.state,
            parityValid: status.parityValid,
            parityDisk: status.parityDisk,
            dataDisks: status.dataDisks,
            disks,
            lastCheck: status.lastCheck,
            checking: nonraidStatus.checking,
            checkProgress: nonraidStatus.progress
        });

    } catch (error) {
        console.error('Error getting array status:', error);
        res.status(500).json({ success: false, error: 'Failed to get array status' });
    }
});

// POST /storage/array/configure - Configure NonRAID array
router.post('/array/configure', requireAuth, async (req, res) => {
    if (getStorageBackend() !== 'nonraid') {
        return res.status(400).json({ error: 'NonRAID backend not active' });
    }

    const { dataDisks, parityDisk, shareMode } = req.body;

    if (!dataDisks || !Array.isArray(dataDisks) || dataDisks.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one data disk required' });
    }

    if (!parityDisk) {
        return res.status(400).json({ success: false, error: 'Parity disk required' });
    }

    const parity = Array.isArray(parityDisk) ? parityDisk[0] : parityDisk;

    nonraidConfigureStatus = {
        active: true,
        step: 'partition',
        progress: 0,
        error: null
    };

    res.json({ success: true, message: 'Configuration started' });

    // Run configuration async
    configureNonRAIDArray(dataDisks, parity, shareMode || 'individual').catch(err => {
        console.error('NonRAID configuration failed:', err);
        nonraidConfigureStatus.error = err.message || 'Configuration failed';
        nonraidConfigureStatus.active = false;
    });
});

async function configureNonRAIDArray(dataDisks, parityDisk, shareMode) {
    try {
        // Step 1: Partition disks
        nonraidConfigureStatus.step = 'partition';
        nonraidConfigureStatus.progress = 0;

        const allDisks = [...dataDisks, parityDisk];
        for (let i = 0; i < allDisks.length; i++) {
            const disk = allDisks[i];
            execSync(`sudo sgdisk -o -a 8 -n 1:32K:0 ${disk}`, { encoding: 'utf8' });
            nonraidConfigureStatus.progress = Math.round(((i + 1) / allDisks.length) * 100);
        }

        // Step 2: Create NonRAID array
        nonraidConfigureStatus.step = 'array';
        nonraidConfigureStatus.progress = 0;

        const dataPartitions = dataDisks.map(d => `${d}1`).join(' ');
        const parityPartition = `${parityDisk}1`;

        execSync(`sudo nmdctl create -p ${parityPartition} ${dataPartitions}`, { encoding: 'utf8' });
        nonraidConfigureStatus.progress = 100;

        // Step 3: Start array
        nonraidConfigureStatus.step = 'start';
        nonraidConfigureStatus.progress = 0;
        execSync('sudo nmdctl start', { encoding: 'utf8' });
        nonraidConfigureStatus.progress = 100;

        // Step 4: Create filesystems
        nonraidConfigureStatus.step = 'filesystem';
        nonraidConfigureStatus.progress = 0;

        for (let i = 0; i < dataDisks.length; i++) {
            execSync(`sudo mkfs.xfs -f /dev/nmd${i + 1}p1`, { encoding: 'utf8' });
            nonraidConfigureStatus.progress = Math.round(((i + 1) / dataDisks.length) * 100);
        }

        // Step 5: Mount disks
        nonraidConfigureStatus.step = 'mount';
        nonraidConfigureStatus.progress = 0;

        for (let i = 0; i < dataDisks.length; i++) {
            const mountPoint = `${NONRAID_MOUNT_PREFIX}${i + 1}`;
            execSync(`sudo mkdir -p ${mountPoint}`, { encoding: 'utf8' });
            nonraidConfigureStatus.progress = Math.round(((i + 1) / dataDisks.length) * 50);
        }

        execSync('sudo nmdctl mount', { encoding: 'utf8' });
        nonraidConfigureStatus.progress = 100;

        // Step 6: Configure Samba
        nonraidConfigureStatus.step = 'samba';
        nonraidConfigureStatus.progress = 0;
        await updateSambaConfigForNonRAID(dataDisks.length, shareMode);
        execSync('sudo systemctl restart smbd', { encoding: 'utf8' });
        nonraidConfigureStatus.progress = 100;

        // Step 7: Initial parity check
        nonraidConfigureStatus.step = 'check';
        nonraidConfigureStatus.progress = 0;

        nonraidStatus.checking = true;
        nonraidStatus.progress = 0;

        const checkProcess = spawn('sudo', ['nmdctl', 'check']);

        checkProcess.stdout.on('data', (data) => {
            const match = data.toString().match(/(\d+)%/);
            if (match) {
                nonraidStatus.progress = parseInt(match[1]);
                nonraidConfigureStatus.progress = parseInt(match[1]);
            }
        });

        checkProcess.on('close', () => {
            nonraidStatus.checking = false;
            nonraidStatus.progress = 100;
            nonraidConfigureStatus.active = false;
            nonraidConfigureStatus.step = 'complete';
            nonraidConfigureStatus.progress = 100;
        });

    } catch (error) {
        nonraidConfigureStatus.error = error.message || 'Configuration failed';
        nonraidConfigureStatus.active = false;
        throw error;
    }
}

async function updateSambaConfigForNonRAID(diskCount, shareMode) {
    let sambaConfig = `[global]
   workgroup = WORKGROUP
   server string = HomePiNAS
   security = user
   map to guest = Bad User
   server min protocol = SMB2
   client min protocol = SMB2

`;

    if (shareMode === 'individual') {
        for (let i = 1; i <= diskCount; i++) {
            sambaConfig += `
[Disk${i}]
   path = ${NONRAID_MOUNT_PREFIX}${i}
   browseable = yes
   read only = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
        }
    } else if (shareMode === 'merged') {
        const diskPaths = [];
        for (let i = 1; i <= diskCount; i++) {
            diskPaths.push(`${NONRAID_MOUNT_PREFIX}${i}`);
        }
        const mergerPaths = diskPaths.join(':');
        execSync('sudo mkdir -p /mnt/storage', { encoding: 'utf8' });
        execSync(`sudo mergerfs ${mergerPaths} /mnt/storage -o defaults,allow_other,use_ino,category.create=mfs`, { encoding: 'utf8' });

        sambaConfig += `
[Storage]
   path = /mnt/storage
   browseable = yes
   read only = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
    } else if (shareMode === 'categories') {
        const categories = ['Media', 'Documents', 'Backups', 'Downloads', 'Photos', 'Projects'];
        for (let i = 1; i <= diskCount; i++) {
            const category = categories[i - 1] || `Disk${i}`;
            sambaConfig += `
[${category}]
   path = ${NONRAID_MOUNT_PREFIX}${i}
   browseable = yes
   read only = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
        }
    }

    fs.writeFileSync('/tmp/smb.conf.new', sambaConfig);
    execSync('sudo mv /tmp/smb.conf.new /etc/samba/smb.conf', { encoding: 'utf8' });
}

// GET /storage/array/configure/progress
router.get('/array/configure/progress', (req, res) => {
    res.json({
        success: true,
        ...nonraidConfigureStatus
    });
});

// POST /storage/array/start
router.post('/array/start', requireAuth, async (req, res) => {
    if (getStorageBackend() !== 'nonraid') {
        return res.status(400).json({ error: 'NonRAID backend not active' });
    }
    try {
        execSync('sudo nmdctl start', { encoding: 'utf8' });
        execSync('sudo nmdctl mount', { encoding: 'utf8' });
        res.json({ success: true, message: 'Array started' });
    } catch (error) {
        console.error('Error starting array:', error);
        res.status(500).json({ success: false, error: 'Failed to start array' });
    }
});

// POST /storage/array/stop
router.post('/array/stop', requireAuth, async (req, res) => {
    if (getStorageBackend() !== 'nonraid') {
        return res.status(400).json({ error: 'NonRAID backend not active' });
    }
    try {
        execSync('sudo nmdctl unmount', { encoding: 'utf8' });
        execSync('sudo nmdctl stop', { encoding: 'utf8' });
        res.json({ success: true, message: 'Array stopped' });
    } catch (error) {
        console.error('Error stopping array:', error);
        res.status(500).json({ success: false, error: 'Failed to stop array' });
    }
});

// POST /storage/array/check
router.post('/array/check', requireAuth, async (req, res) => {
    if (getStorageBackend() !== 'nonraid') {
        return res.status(400).json({ error: 'NonRAID backend not active' });
    }
    if (nonraidStatus.checking) {
        return res.status(400).json({ success: false, error: 'Parity check already in progress' });
    }

    nonraidStatus.checking = true;
    nonraidStatus.progress = 0;
    nonraidStatus.error = null;

    res.json({ success: true, message: 'Parity check started' });

    const checkProcess = spawn('sudo', ['nmdctl', 'check']);

    checkProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+)%/);
        if (match) {
            nonraidStatus.progress = parseInt(match[1]);
        }
    });

    checkProcess.on('close', (code) => {
        nonraidStatus.checking = false;
        if (code !== 0) {
            nonraidStatus.error = 'Parity check failed';
        } else {
            nonraidStatus.progress = 100;
        }
    });
});

// GET /storage/array/check/progress
router.get('/array/check/progress', (req, res) => {
    res.json({
        success: true,
        checking: nonraidStatus.checking,
        progress: nonraidStatus.progress,
        error: nonraidStatus.error
    });
});

module.exports = router;
