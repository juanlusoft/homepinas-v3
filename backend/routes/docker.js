/**
 * HomePiNAS - Docker Routes
 * v3.1.0 - Enhanced Docker Manager
 *
 * Features:
 * - List containers with CPU/RAM stats, ports, and update status
 * - Container notes/comments (passwords, notes)
 * - Import and run docker-compose files
 * - Check for image updates (pull and compare IDs)
 * - Update containers (stop, remove, pull, recreate)
 * - Compose stack management (up, down, delete)
 * - Container logs streaming
 * - Find compose file for container
 */

const express = require('express');
const router = express.Router();
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const { validateDockerAction, validateContainerId, sanitizeComposeName, validateComposeContent } = require('../utils/sanitize');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Paths for compose files and update cache
const COMPOSE_DIR = path.join(__dirname, '..', 'config', 'compose');
const UPDATE_CACHE_FILE = path.join(__dirname, '..', 'config', 'docker-updates.json');
const CONTAINER_NOTES_FILE = path.join(__dirname, '..', 'config', 'container-notes.json');

// Ensure directories exist
if (!fs.existsSync(COMPOSE_DIR)) {
    fs.mkdirSync(COMPOSE_DIR, { recursive: true });
}

// Load container notes
function loadContainerNotes() {
    try {
        if (fs.existsSync(CONTAINER_NOTES_FILE)) {
            return JSON.parse(fs.readFileSync(CONTAINER_NOTES_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading container notes:', e.message);
    }
    return {};
}

// Save container notes
function saveContainerNotes(notes) {
    try {
        fs.writeFileSync(CONTAINER_NOTES_FILE, JSON.stringify(notes, null, 2));
        return true;
    } catch (e) {
        console.error('Error saving container notes:', e.message);
        return false;
    }
}

// Find compose file for a container
function findComposeForContainer(containerName) {
    try {
        const dirs = fs.readdirSync(COMPOSE_DIR);
        for (const dir of dirs) {
            const composeFile = path.join(COMPOSE_DIR, dir, 'docker-compose.yml');
            if (fs.existsSync(composeFile)) {
                const content = fs.readFileSync(composeFile, 'utf8');
                // Check if this compose file defines this container
                if (content.includes(`container_name: ${containerName}`) || 
                    content.includes(`container_name: "${containerName}"`) ||
                    content.includes(`container_name: '${containerName}'`)) {
                    return { name: dir, path: composeFile };
                }
                // Also check service name
                const serviceRegex = new RegExp(`^\\s*${containerName}:\\s*$`, 'm');
                if (serviceRegex.test(content)) {
                    return { name: dir, path: composeFile };
                }
            }
        }
    } catch (e) {
        console.error('Error finding compose for container:', e.message);
    }
    return null;
}

// Parse port mappings from container info
function parsePortMappings(ports) {
    if (!ports || !Array.isArray(ports)) return [];
    return ports.map(p => {
        if (p.PublicPort && p.PrivatePort) {
            return {
                public: p.PublicPort,
                private: p.PrivatePort,
                type: p.Type || 'tcp',
                ip: p.IP || '0.0.0.0'
            };
        } else if (p.PrivatePort) {
            return {
                public: null,
                private: p.PrivatePort,
                type: p.Type || 'tcp',
                ip: null
            };
        }
        return null;
    }).filter(Boolean);
}

// Load update cache
function loadUpdateCache() {
    try {
        if (fs.existsSync(UPDATE_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading update cache:', e.message);
    }
    return { lastCheck: null, updates: {} };
}

// Save update cache
function saveUpdateCache(cache) {
    try {
        fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('Error saving update cache:', e.message);
    }
}

// List containers with update status, ports, and notes
router.get('/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        const updateCache = loadUpdateCache();
        const containerNotes = loadContainerNotes();

        const result = await Promise.all(containers.map(async (c) => {
            const name = c.Names[0].replace('/', '');
            const image = c.Image;

            // Check if update is available from cache
            const hasUpdate = updateCache.updates[image] || false;

            // Get port mappings
            const ports = parsePortMappings(c.Ports);

            // Get notes for this container
            const notes = containerNotes[name] || containerNotes[c.Id] || '';

            // Find compose file if any
            const compose = findComposeForContainer(name);

            // Get container stats if running
            let cpu = '---';
            let ram = '---';

            if (c.State === 'running') {
                try {
                    const container = docker.getContainer(c.Id);
                    const stats = await container.stats({ stream: false });

                    // Calculate CPU percentage
                    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
                    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
                    const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;
                    cpu = cpuPercent.toFixed(1) + '%';

                    // Calculate memory usage
                    const memUsage = stats.memory_stats.usage / 1024 / 1024;
                    ram = memUsage.toFixed(0) + 'MB';
                } catch (e) {
                    // Stats not available
                }
            }

            return {
                id: c.Id,
                name,
                status: c.State,
                image,
                cpu,
                ram,
                ports,
                notes,
                compose,
                hasUpdate,
                created: c.Created
            };
        }));

        res.json(result);
    } catch (e) {
        console.warn('Docker check failed:', e.message);
        res.json([]);
    }
});

// Container action (start, stop, restart)
router.post('/action', requireAuth, async (req, res) => {
    const { id, action } = req.body;

    // SECURITY: Validate container ID format (hex string, 12-64 chars)
    if (!validateContainerId(id)) {
        return res.status(400).json({ error: 'Invalid container ID format' });
    }

    if (!validateDockerAction(action)) {
        return res.status(400).json({ error: 'Invalid action. Must be start, stop, or restart' });
    }

    try {
        const container = docker.getContainer(id);
        logSecurityEvent('DOCKER_ACTION', { containerId: id, action, user: req.user.username }, req.ip);

        if (action === 'start') await container.start();
        if (action === 'stop') await container.stop();
        if (action === 'restart') await container.restart();
        res.json({ success: true });
    } catch (e) {
        console.error('Docker action error:', e.message);
        res.status(500).json({ error: 'Docker action failed' });
    }
});

// Check for image updates
router.post('/check-updates', requireAuth, async (req, res) => {
    try {
        logSecurityEvent('DOCKER_CHECK_UPDATES', { user: req.user.username }, req.ip);

        const containers = await docker.listContainers({ all: true });
        const images = [...new Set(containers.map(c => c.Image))];
        const updates = {};
        const results = [];

        for (const imageName of images) {
            try {
                // Get current image ID
                const currentImage = await docker.getImage(imageName).inspect();
                const currentId = currentImage.Id;

                // Pull latest and check if ID changed
                results.push(`Checking ${imageName}...`);

                await new Promise((resolve, reject) => {
                    docker.pull(imageName, (err, stream) => {
                        if (err) {
                            results.push(`  Skip: ${err.message}`);
                            resolve();
                            return;
                        }

                        docker.modem.followProgress(stream, async (err, output) => {
                            if (err) {
                                results.push(`  Error: ${err.message}`);
                                resolve();
                                return;
                            }

                            try {
                                const newImage = await docker.getImage(imageName).inspect();
                                const newId = newImage.Id;

                                if (newId !== currentId) {
                                    updates[imageName] = true;
                                    results.push(`  UPDATE AVAILABLE!`);
                                } else {
                                    updates[imageName] = false;
                                    results.push(`  Up to date`);
                                }
                            } catch (e) {
                                results.push(`  Check failed: ${e.message}`);
                            }
                            resolve();
                        });
                    });
                });
            } catch (e) {
                results.push(`${imageName}: Error - ${e.message}`);
            }
        }

        // Save update cache
        const cache = {
            lastCheck: new Date().toISOString(),
            updates
        };
        saveUpdateCache(cache);

        const updatesAvailable = Object.values(updates).filter(v => v).length;

        res.json({
            success: true,
            lastCheck: cache.lastCheck,
            updatesAvailable,
            totalImages: images.length,
            updates,
            log: results
        });
    } catch (e) {
        console.error('Docker update check error:', e);
        res.status(500).json({ error: 'Failed to check for updates' });
    }
});

// Get update status (cached)
router.get('/update-status', async (req, res) => {
    const cache = loadUpdateCache();
    res.json({
        lastCheck: cache.lastCheck,
        updates: cache.updates,
        updatesAvailable: Object.values(cache.updates).filter(v => v).length
    });
});

// Update a specific container
router.post('/update', requireAuth, async (req, res) => {
    const { containerId } = req.body;

    // SECURITY: Validate container ID format
    if (!validateContainerId(containerId)) {
        return res.status(400).json({ error: 'Invalid container ID format' });
    }

    try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const imageName = info.Config.Image;
        const containerName = info.Name.replace('/', '');

        logSecurityEvent('DOCKER_UPDATE', { containerId, image: imageName, user: req.user.username }, req.ip);

        // Get container config for recreation
        const hostConfig = info.HostConfig;
        const config = info.Config;

        // Stop and remove old container
        try {
            await container.stop();
        } catch (e) {
            // Already stopped
        }
        await container.remove();

        // Pull latest image
        await new Promise((resolve, reject) => {
            docker.pull(imageName, (err, stream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });

        // Recreate container with same config
        const newContainer = await docker.createContainer({
            Image: imageName,
            name: containerName,
            Env: config.Env,
            ExposedPorts: config.ExposedPorts,
            HostConfig: hostConfig,
            Labels: config.Labels,
            Volumes: config.Volumes
        });

        // Start the new container
        await newContainer.start();

        // Update cache - mark as no update available
        const cache = loadUpdateCache();
        cache.updates[imageName] = false;
        saveUpdateCache(cache);

        res.json({
            success: true,
            message: `Container ${containerName} updated successfully`,
            newContainerId: newContainer.id
        });
    } catch (e) {
        console.error('Docker update error:', e);
        res.status(500).json({ error: `Update failed: ${e.message}` });
    }
});

// Import docker-compose.yml
router.post('/compose/import', requireAuth, async (req, res) => {
    const { name, content } = req.body;

    if (!name || !content) {
        return res.status(400).json({ error: 'Name and content required' });
    }

    // SECURITY: Sanitize name using dedicated function
    const safeName = sanitizeComposeName(name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name (alphanumeric, dashes, underscores only)' });
    }

    // SECURITY: Validate compose content
    const contentValidation = validateComposeContent(content);
    if (!contentValidation.valid) {
        return res.status(400).json({ error: contentValidation.error });
    }

    try {
        const composeDir = path.join(COMPOSE_DIR, safeName);
        const composeFile = path.join(composeDir, 'docker-compose.yml');

        // Create directory
        if (!fs.existsSync(composeDir)) {
            fs.mkdirSync(composeDir, { recursive: true });
        }

        // Save compose file
        fs.writeFileSync(composeFile, content, 'utf8');

        logSecurityEvent('DOCKER_COMPOSE_IMPORT', { name: safeName, user: req.user.username }, req.ip);

        res.json({
            success: true,
            message: `Compose file "${safeName}" saved`,
            path: composeFile
        });
    } catch (e) {
        console.error('Compose import error:', e);
        res.status(500).json({ error: 'Failed to save compose file' });
    }
});

// List saved compose files
router.get('/compose/list', async (req, res) => {
    try {
        const composes = [];

        if (fs.existsSync(COMPOSE_DIR)) {
            const dirs = fs.readdirSync(COMPOSE_DIR);
            for (const dir of dirs) {
                const composeFile = path.join(COMPOSE_DIR, dir, 'docker-compose.yml');
                if (fs.existsSync(composeFile)) {
                    const stat = fs.statSync(composeFile);
                    composes.push({
                        name: dir,
                        path: composeFile,
                        modified: stat.mtime
                    });
                }
            }
        }

        res.json(composes);
    } catch (e) {
        console.error('Compose list error:', e);
        res.status(500).json({ error: 'Failed to list compose files' });
    }
});

// Run docker-compose up
router.post('/compose/up', requireAuth, async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Compose name required' });
    }

    // SECURITY: Use dedicated sanitization function
    const safeName = sanitizeComposeName(name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name' });
    }

    const composeDir = path.join(COMPOSE_DIR, safeName);
    const composeFile = path.join(composeDir, 'docker-compose.yml');

    // SECURITY: Verify path doesn't escape COMPOSE_DIR
    const resolvedDir = path.resolve(composeDir);
    if (!resolvedDir.startsWith(path.resolve(COMPOSE_DIR))) {
        return res.status(400).json({ error: 'Invalid compose path' });
    }

    if (!fs.existsSync(composeFile)) {
        return res.status(404).json({ error: 'Compose file not found' });
    }

    try {
        logSecurityEvent('DOCKER_COMPOSE_UP', { name: safeName, user: req.user.username }, req.ip);

        // SECURITY: Use execFile with explicit arguments instead of shell interpolation
        const { execFileSync } = require('child_process');
        const output = execFileSync('docker', ['compose', 'up', '-d'], {
            cwd: composeDir,
            encoding: 'utf8',
            timeout: 300000 // 5 minutes
        });

        res.json({
            success: true,
            message: `Compose "${safeName}" started`,
            output
        });
    } catch (e) {
        console.error('Compose up error:', e);
        res.status(500).json({
            error: 'Failed to start compose',
            details: e.stderr || e.message
        });
    }
});

// Stop docker-compose
router.post('/compose/down', requireAuth, async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Compose name required' });
    }

    // SECURITY: Use dedicated sanitization function
    const safeName = sanitizeComposeName(name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name' });
    }

    const composeDir = path.join(COMPOSE_DIR, safeName);
    const composeFile = path.join(composeDir, 'docker-compose.yml');

    // SECURITY: Verify path doesn't escape COMPOSE_DIR
    const resolvedDir = path.resolve(composeDir);
    if (!resolvedDir.startsWith(path.resolve(COMPOSE_DIR))) {
        return res.status(400).json({ error: 'Invalid compose path' });
    }

    if (!fs.existsSync(composeFile)) {
        return res.status(404).json({ error: 'Compose file not found' });
    }

    try {
        logSecurityEvent('DOCKER_COMPOSE_DOWN', { name: safeName, user: req.user.username }, req.ip);

        // SECURITY: Use execFile with explicit arguments
        const { execFileSync } = require('child_process');
        const output = execFileSync('docker', ['compose', 'down'], {
            cwd: composeDir,
            encoding: 'utf8',
            timeout: 120000
        });

        res.json({
            success: true,
            message: `Compose "${safeName}" stopped`,
            output
        });
    } catch (e) {
        console.error('Compose down error:', e);
        res.status(500).json({ error: 'Failed to stop compose' });
    }
});

// Delete compose file
router.delete('/compose/:name', requireAuth, async (req, res) => {
    // SECURITY: Use dedicated sanitization function
    const safeName = sanitizeComposeName(req.params.name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name' });
    }

    const composeDir = path.join(COMPOSE_DIR, safeName);

    // SECURITY: Verify path doesn't escape COMPOSE_DIR
    const resolvedDir = path.resolve(composeDir);
    if (!resolvedDir.startsWith(path.resolve(COMPOSE_DIR))) {
        return res.status(400).json({ error: 'Invalid compose path' });
    }

    if (!fs.existsSync(composeDir)) {
        return res.status(404).json({ error: 'Compose not found' });
    }

    try {
        // Stop containers first
        try {
            const { execFileSync } = require('child_process');
            execFileSync('docker', ['compose', 'down'], {
                cwd: composeDir,
                encoding: 'utf8',
                timeout: 60000
            });
        } catch (e) {
            // Ignore errors - containers may not be running
        }

        // Remove directory
        fs.rmSync(composeDir, { recursive: true, force: true });

        logSecurityEvent('DOCKER_COMPOSE_DELETE', { name: safeName, user: req.user.username }, req.ip);

        res.json({ success: true, message: `Compose "${safeName}" deleted` });
    } catch (e) {
        console.error('Compose delete error:', e);
        res.status(500).json({ error: 'Failed to delete compose' });
    }
});

// Get compose file content
router.get('/compose/:name', async (req, res) => {
    // SECURITY: Use dedicated sanitization function
    const safeName = sanitizeComposeName(req.params.name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name' });
    }

    const composeFile = path.join(COMPOSE_DIR, safeName, 'docker-compose.yml');

    // SECURITY: Verify path doesn't escape COMPOSE_DIR
    const resolvedFile = path.resolve(composeFile);
    if (!resolvedFile.startsWith(path.resolve(COMPOSE_DIR))) {
        return res.status(400).json({ error: 'Invalid compose path' });
    }

    if (!fs.existsSync(composeFile)) {
        return res.status(404).json({ error: 'Compose not found' });
    }

    try {
        const content = fs.readFileSync(composeFile, 'utf8');
        res.json({ name: safeName, content });
    } catch (e) {
        res.status(500).json({ error: 'Failed to read compose file' });
    }
});

// Update compose file content
router.put('/compose/:name', requireAuth, async (req, res) => {
    const { content } = req.body;
    
    if (!content) {
        return res.status(400).json({ error: 'Content required' });
    }

    // SECURITY: Use dedicated sanitization function
    const safeName = sanitizeComposeName(req.params.name);
    if (!safeName) {
        return res.status(400).json({ error: 'Invalid compose name' });
    }

    // SECURITY: Validate compose content
    const contentValidation = validateComposeContent(content);
    if (!contentValidation.valid) {
        return res.status(400).json({ error: contentValidation.error });
    }

    const composeFile = path.join(COMPOSE_DIR, safeName, 'docker-compose.yml');

    // SECURITY: Verify path doesn't escape COMPOSE_DIR
    const resolvedFile = path.resolve(composeFile);
    if (!resolvedFile.startsWith(path.resolve(COMPOSE_DIR))) {
        return res.status(400).json({ error: 'Invalid compose path' });
    }

    if (!fs.existsSync(composeFile)) {
        return res.status(404).json({ error: 'Compose not found' });
    }

    try {
        fs.writeFileSync(composeFile, content, 'utf8');
        logSecurityEvent('DOCKER_COMPOSE_EDIT', { name: safeName, user: req.user.username }, req.ip);
        res.json({ success: true, message: `Compose "${safeName}" updated` });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update compose file' });
    }
});

// =============================================================================
// CONTAINER NOTES
// =============================================================================

// Get notes for a container
router.get('/notes/:containerId', requireAuth, async (req, res) => {
    const { containerId } = req.params;
    
    if (!validateContainerId(containerId)) {
        return res.status(400).json({ error: 'Invalid container ID' });
    }

    const notes = loadContainerNotes();
    res.json({ notes: notes[containerId] || '' });
});

// Save notes for a container
router.post('/notes/:containerId', requireAuth, async (req, res) => {
    const { containerId } = req.params;
    const { notes } = req.body;
    
    if (!validateContainerId(containerId)) {
        return res.status(400).json({ error: 'Invalid container ID' });
    }

    if (typeof notes !== 'string') {
        return res.status(400).json({ error: 'Notes must be a string' });
    }

    // Limit notes length
    const safeNotes = notes.substring(0, 5000);

    const allNotes = loadContainerNotes();
    
    if (safeNotes.trim()) {
        allNotes[containerId] = safeNotes;
    } else {
        delete allNotes[containerId];
    }

    if (saveContainerNotes(allNotes)) {
        logSecurityEvent('CONTAINER_NOTES_SAVED', { containerId, user: req.user.username }, req.ip);
        res.json({ success: true, message: 'Notes saved' });
    } else {
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

// =============================================================================
// CONTAINER LOGS
// =============================================================================

// Get container logs
router.get('/logs/:containerId', requireAuth, async (req, res) => {
    const { containerId } = req.params;
    const { tail = 100, since = '' } = req.query;
    
    if (!validateContainerId(containerId)) {
        return res.status(400).json({ error: 'Invalid container ID' });
    }

    try {
        const container = docker.getContainer(containerId);
        
        const opts = {
            stdout: true,
            stderr: true,
            tail: Math.min(parseInt(tail) || 100, 1000),
            timestamps: true
        };

        if (since) {
            opts.since = parseInt(since);
        }

        const logs = await container.logs(opts);
        
        // Parse logs (remove Docker stream header bytes)
        const logText = logs.toString('utf8');
        
        res.json({ 
            success: true, 
            logs: logText,
            containerId
        });
    } catch (e) {
        console.error('Container logs error:', e.message);
        res.status(500).json({ error: 'Failed to get container logs' });
    }
});

module.exports = router;
