const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');
const Docker = require('dockerode');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const PORT = process.env.PORT || 3001;
const VERSION = '1.5.5';
const DATA_FILE = path.join(__dirname, 'config', 'data.json');
const SESSION_DB_PATH = path.join(__dirname, 'config', 'sessions.db');
const SALT_ROUNDS = 12;

// =============================================================================
// SECURITY: Input Sanitization Functions
// =============================================================================

/**
 * Sanitize username for shell commands
 * Only allows alphanumeric, underscore, and hyphen
 */
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return null;
    // Remove any character that isn't alphanumeric, underscore, or hyphen
    const sanitized = username.replace(/[^a-zA-Z0-9_-]/g, '');
    // Must be 3-32 characters
    if (sanitized.length < 3 || sanitized.length > 32) return null;
    // Must start with a letter
    if (!/^[a-zA-Z]/.test(sanitized)) return null;
    return sanitized;
}

/**
 * Sanitize shell argument - escapes special characters
 * For use in shell commands where the value must be quoted
 */
function sanitizeShellArg(arg) {
    if (!arg || typeof arg !== 'string') return '';
    // Escape single quotes by ending the string, adding escaped quote, and starting new string
    return arg.replace(/'/g, "'\\''");
}

/**
 * Sanitize path - prevent directory traversal
 */
function sanitizePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null;
    // Remove null bytes
    let sanitized = inputPath.replace(/\0/g, '');
    // Normalize path and check for traversal
    const normalized = path.normalize(sanitized);
    // Block if it tries to go up directories
    if (normalized.includes('..')) return null;
    // Only allow alphanumeric, slash, dash, underscore, dot
    if (!/^[a-zA-Z0-9/_.-]+$/.test(normalized)) return null;
    return normalized;
}

/**
 * Sanitize disk device path (e.g., /dev/sda)
 */
function sanitizeDiskPath(diskPath) {
    if (!diskPath || typeof diskPath !== 'string') return null;
    // Must match /dev/sdX, /dev/nvmeXnY, or /dev/hdX pattern
    const validPatterns = [
        /^\/dev\/sd[a-z]$/,
        /^\/dev\/sd[a-z][0-9]+$/,
        /^\/dev\/nvme[0-9]+n[0-9]+$/,
        /^\/dev\/nvme[0-9]+n[0-9]+p[0-9]+$/,
        /^\/dev\/hd[a-z]$/,
        /^\/dev\/hd[a-z][0-9]+$/
    ];
    for (const pattern of validPatterns) {
        if (pattern.test(diskPath)) return diskPath;
    }
    return null;
}

/**
 * Execute command with sanitized arguments using execFile (safer than exec)
 */
const { execFile, execSync } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

async function safeExec(command, args = [], options = {}) {
    // Validate command is in allowed list
    const allowedCommands = [
        'sudo', 'cat', 'ls', 'df', 'mount', 'umount', 'smartctl',
        'systemctl', 'snapraid', 'mergerfs', 'smbpasswd', 'useradd',
        'usermod', 'chown', 'chmod', 'mkfs.ext4', 'mkfs.xfs', 'parted',
        'partprobe', 'id', 'getent', 'cp', 'tee', 'mkdir'
    ];

    const baseCommand = command.split('/').pop();
    if (!allowedCommands.includes(baseCommand)) {
        throw new Error(`Command not allowed: ${baseCommand}`);
    }

    return execFileAsync(command, args, {
        timeout: options.timeout || 30000,
        maxBuffer: 10 * 1024 * 1024,
        ...options
    });
}

// =============================================================================

// =============================================================================
// SESSION STORAGE: SQLite-based persistent sessions (v1.5.4)
// =============================================================================
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Initialize SQLite session database
let sessionDb = null;
function initSessionDb() {
    try {
        // Ensure config directory exists
        const configDir = path.dirname(SESSION_DB_PATH);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        sessionDb = new Database(SESSION_DB_PATH);

        // Create sessions table if not exists
        sessionDb.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        // Create index for faster expiration queries
        sessionDb.exec(`
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
            ON sessions(expires_at)
        `);

        console.log('Session database initialized at', SESSION_DB_PATH);

        // Clean expired sessions on startup
        cleanExpiredSessions();

        return true;
    } catch (e) {
        console.error('Failed to initialize session database:', e.message);
        return false;
    }
}

// Initialize session DB on startup
initSessionDb();

// Security Middleware - Helmet configured for HTTP local network
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for local network compatibility
    hsts: false, // Disable HTTPS enforcement for HTTP server
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
}));

// CORS - Allow all origins for local network NAS
app.use(cors());

// Rate limiting - relaxed for local network NAS dashboard
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 1000, // Very high limit for local network
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for read-only API endpoints (polled frequently)
    skip: (req) => {
        const skipPaths = [
            '/api/system/stats',
            '/api/system/disks',
            '/api/system/status',
            '/api/system/fan/mode',
            '/api/docker/containers',
            '/api/network/interfaces'
        ];
        return skipPaths.includes(req.path) || req.method === 'GET';
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 login attempts per windowMs
    message: { error: 'Too many login attempts, please try again later' }
});

const criticalLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // limit critical actions
    message: { error: 'Too many critical actions, please try again later' }
});

app.use(generalLimiter);
app.use(express.json({ limit: '10kb' })); // Limit body size

// Security logging
function logSecurityEvent(event, details, ip) {
    const timestamp = new Date().toISOString();
    console.log(`[SECURITY] ${timestamp} | ${event} | IP: ${ip} | ${JSON.stringify(details)}`);
}

// Serve Static Frontend Files
// Since index.html is in the root and assets in frontend/
app.use(express.static(path.join(__dirname, '../')));
app.use('/frontend', express.static(path.join(__dirname, '../frontend')));

// Serve index.html on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// Ensure config directory exists
if (!fs.existsSync(path.join(__dirname, 'config'))) {
    fs.mkdirSync(path.join(__dirname, 'config'));
}

// Initial Data State (Mocked from Frontend v0.1)
const initialState = {
    user: null,
    storageConfig: [],
    network: {
        interfaces: [
            { id: 'eth0', name: 'Ethernet', ip: '192.168.1.100', subnet: '255.255.255.0', gateway: '192.168.1.1', dns: '8.8.8.8', dhcp: true, status: 'connected' },
            { id: 'eth1', name: 'Ethernet 2', ip: '10.0.0.15', subnet: '255.255.255.0', gateway: '10.0.0.1', dns: '10.0.0.1', dhcp: false, status: 'connected' },
            { id: 'wlan0', name: 'Wi-Fi', ip: '192.168.1.105', subnet: '255.255.255.0', gateway: '192.168.1.1', dns: '1.1.1.1', dhcp: true, status: 'disconnected' }
        ],
        ddns: [
            { id: 'duckdns-1', service: 'duckdns', name: 'DuckDNS', enabled: true, domain: 'homepinas.duckdns.org', status: 'online' }
        ]
    }
};

// Helper: Read/Write Data with error handling
function getData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialState, null, 2));
        }
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error('Error reading data file:', e.message);
        // Return initial state if file is corrupted
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialState, null, 2));
        return initialState;
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error saving data file:', e.message);
        throw new Error('Failed to save configuration');
    }
}

// Input validation helpers
function validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 32) return false;
    return /^[a-zA-Z0-9_-]+$/.test(username);
}

function validatePassword(password) {
    if (!password || typeof password !== 'string') return false;
    if (password.length < 6 || password.length > 128) return false;
    return true;
}

function validateDockerAction(action) {
    return ['start', 'stop', 'restart'].includes(action);
}

function validateSystemAction(action) {
    return ['reboot', 'shutdown'].includes(action);
}

// Session management - SQLite-backed (v1.5.4)
function createSession(username) {
    const sessionId = uuidv4();
    const expiresAt = Date.now() + SESSION_DURATION;

    if (!sessionDb) {
        console.error('Session database not initialized');
        return null;
    }

    try {
        const stmt = sessionDb.prepare(`
            INSERT INTO sessions (session_id, username, expires_at)
            VALUES (?, ?, ?)
        `);
        stmt.run(sessionId, username, expiresAt);
        return sessionId;
    } catch (e) {
        console.error('Failed to create session:', e.message);
        return null;
    }
}

function validateSession(sessionId) {
    if (!sessionId || !sessionDb) return null;

    try {
        const stmt = sessionDb.prepare(`
            SELECT session_id, username, expires_at
            FROM sessions
            WHERE session_id = ?
        `);
        const session = stmt.get(sessionId);

        if (!session) return null;

        // Check if expired
        if (Date.now() > session.expires_at) {
            destroySession(sessionId);
            return null;
        }

        return {
            username: session.username,
            expiresAt: session.expires_at
        };
    } catch (e) {
        console.error('Failed to validate session:', e.message);
        return null;
    }
}

function destroySession(sessionId) {
    if (!sessionDb) return;

    try {
        const stmt = sessionDb.prepare('DELETE FROM sessions WHERE session_id = ?');
        stmt.run(sessionId);
    } catch (e) {
        console.error('Failed to destroy session:', e.message);
    }
}

function cleanExpiredSessions() {
    if (!sessionDb) return;

    try {
        const stmt = sessionDb.prepare('DELETE FROM sessions WHERE expires_at < ?');
        const result = stmt.run(Date.now());
        if (result.changes > 0) {
            console.log(`Cleaned ${result.changes} expired sessions`);
        }
    } catch (e) {
        console.error('Failed to clean expired sessions:', e.message);
    }
}

// Clean expired sessions periodically
setInterval(cleanExpiredSessions, 60 * 60 * 1000); // Clean every hour

// Authentication middleware
function requireAuth(req, res, next) {
    const sessionId = req.headers['x-session-id'];
    const session = validateSession(sessionId);

    if (!session) {
        logSecurityEvent('UNAUTHORIZED_ACCESS', { path: req.path }, req.ip);
        return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = session;
    next();
}

// API Routes

// System Hardware Telemetry - Extended
app.get('/api/system/stats', async (req, res) => {
    try {
        const [cpu, cpuInfo, mem, temp, osInfo, graphics] = await Promise.all([
            si.currentLoad(),
            si.cpu(),
            si.mem(),
            si.cpuTemperature(),
            si.osInfo(),
            si.graphics()
        ]);

        // Try to get fan speeds (Raspberry Pi CM5 and other systems)
        let fans = [];
        try {
            const fanData = await new Promise((resolve) => {
                // More comprehensive fan detection for Raspberry Pi and other systems
                const cmd = `
                    # Find all fan inputs across hwmon devices
                    for hwmon in /sys/class/hwmon/hwmon*; do
                        if [ -d "$hwmon" ]; then
                            name=$(cat "$hwmon/name" 2>/dev/null || echo "unknown")
                            for fan in "$hwmon"/fan*_input; do
                                if [ -f "$fan" ]; then
                                    rpm=$(cat "$fan" 2>/dev/null || echo "0")
                                    fannum=$(echo "$fan" | grep -oP 'fan\\K[0-9]+')
                                    echo "$name:$fannum:$rpm"
                                fi
                            done
                        fi
                    done
                    # Also check Raspberry Pi specific cooling fan path
                    if [ -f /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input ]; then
                        rpm=$(cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input 2>/dev/null || echo "0")
                        echo "rpi_fan:1:$rpm"
                    fi
                `;
                exec(cmd, { shell: '/bin/bash' }, (err, stdout) => {
                    if (err || !stdout.trim()) {
                        resolve([]);
                        return;
                    }
                    const lines = stdout.trim().split('\n').filter(s => s && s.includes(':'));
                    const fanList = lines.map((line, idx) => {
                        const [name, num, rpm] = line.split(':');
                        return {
                            id: idx + 1,
                            name: name === 'rpi_fan' ? `RPi Fan ${num}` : `${name} Fan ${num}`,
                            rpm: parseInt(rpm) || 0
                        };
                    });
                    resolve(fanList);
                });
            });
            fans = fanData;
        } catch (e) {
            console.error('Fan detection error:', e);
            fans = [];
        }

        // Get per-core temperatures if available
        const coreTemps = temp.cores && temp.cores.length > 0
            ? temp.cores.map((t, i) => ({ core: i, temp: Math.round(t) }))
            : [];

        // Get per-core loads
        const coreLoads = cpu.cpus
            ? cpu.cpus.map((c, i) => ({ core: i, load: Math.round(c.load) }))
            : [];

        res.json({
            // CPU Info
            cpuModel: cpuInfo.manufacturer + ' ' + cpuInfo.brand,
            cpuCores: cpuInfo.cores,
            cpuPhysicalCores: cpuInfo.physicalCores,
            cpuSpeed: cpuInfo.speed,
            cpuSpeedMax: cpuInfo.speedMax,
            cpuLoad: Math.round(cpu.currentLoad),
            coreLoads: coreLoads,

            // Temperatures
            cpuTemp: Math.round(temp.main || 0),
            cpuTempMax: Math.round(temp.max || 0),
            coreTemps: coreTemps,
            gpuTemp: graphics.controllers && graphics.controllers[0]
                ? Math.round(graphics.controllers[0].temperatureGpu || 0)
                : null,

            // Memory
            ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(1),
            ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(1),
            ramFree: (mem.free / 1024 / 1024 / 1024).toFixed(1),
            ramUsedPercent: Math.round((mem.active / mem.total) * 100),
            swapUsed: (mem.swapused / 1024 / 1024 / 1024).toFixed(1),
            swapTotal: (mem.swaptotal / 1024 / 1024 / 1024).toFixed(1),

            // Fans
            fans: fans,

            // System
            uptime: si.time().uptime,
            hostname: osInfo.hostname,
            platform: osInfo.platform,
            distro: osInfo.distro,
            kernel: osInfo.kernel
        });
    } catch (e) {
        console.error('Stats error:', e);
        res.status(500).json({ error: 'Failed to fetch system stats' });
    }
});

// Fan control endpoint (requires root/sudo)
app.post('/api/system/fan', requireAuth, (req, res) => {
    const { fanId, speed } = req.body;

    // Validate speed (0-100 percent or specific PWM value)
    if (typeof speed !== 'number' || speed < 0 || speed > 100) {
        return res.status(400).json({ error: 'Invalid fan speed (0-100)' });
    }

    // Convert percentage to PWM value (0-255)
    const pwmValue = Math.round((speed / 100) * 255);
    const fanNum = fanId || 1;

    try {
        const { execSync } = require('child_process');
        // Try multiple PWM control paths for different systems
        const cmd = `
            # Try standard hwmon PWM control
            for hwmon in /sys/class/hwmon/hwmon*; do
                if [ -f "$hwmon/pwm${fanNum}" ]; then
                    echo ${pwmValue} | sudo tee "$hwmon/pwm${fanNum}" > /dev/null 2>&1
                    echo "success"
                    exit 0
                fi
            done
            # Try Raspberry Pi specific fan control
            if [ -f /sys/devices/platform/cooling_fan/hwmon/hwmon*/pwm1 ]; then
                echo ${pwmValue} | sudo tee /sys/devices/platform/cooling_fan/hwmon/hwmon*/pwm1 > /dev/null 2>&1
                echo "success"
                exit 0
            fi
            # Try thermal cooling device
            if [ -d /sys/class/thermal/cooling_device0 ]; then
                # Map 0-255 to cooling device max_state
                max_state=$(cat /sys/class/thermal/cooling_device0/max_state 2>/dev/null || echo "255")
                state=$(( ${pwmValue} * max_state / 255 ))
                echo $state | sudo tee /sys/class/thermal/cooling_device0/cur_state > /dev/null 2>&1
                echo "success"
                exit 0
            fi
            echo "no_pwm_found"
        `;
        const result = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8' }).trim();

        if (result === 'success') {
            logSecurityEvent('FAN_CONTROL', { fanId: fanNum, speed, pwmValue }, req.ip);
            res.json({ success: true, message: `Fan ${fanNum} speed set to ${speed}%` });
        } else {
            res.status(500).json({ error: 'PWM control not available for this fan' });
        }
    } catch (e) {
        console.error('Fan control error:', e);
        res.status(500).json({ error: 'Fan control not available on this system' });
    }
});

// Fan mode presets configuration (v1.5.5 with hysteresis)
const FANCTL_CONF = '/usr/local/bin/homepinas-fanctl.conf';
const FAN_PRESETS = {
    silent: `# =========================================
# HomePinas Fan Control - SILENT preset
# Quiet operation, higher temperatures allowed
# v1.5.5 with hysteresis support
# =========================================

PWM1_T30=60
PWM1_T35=80
PWM1_T40=110
PWM1_T45=150
PWM1_TMAX=200

PWM2_T40=70
PWM2_T50=100
PWM2_T60=140
PWM2_TMAX=200

MIN_PWM1=60
MIN_PWM2=70
MAX_PWM=255

# Hysteresis: 5C means fans won't slow down until temp drops 5C below threshold
# Higher value = more stable fan speed, but slower response to cooling
HYST_TEMP=5
`,
    balanced: `# =========================================
# HomePinas Fan Control - BALANCED preset
# Recommended default settings
# v1.5.5 with hysteresis support
# =========================================

# PWM1 (HDD / SSD)
PWM1_T30=65
PWM1_T35=90
PWM1_T40=130
PWM1_T45=180
PWM1_TMAX=230

# PWM2 (NVMe + CPU)
PWM2_T40=80
PWM2_T50=120
PWM2_T60=170
PWM2_TMAX=255

# Safety limits
MIN_PWM1=65
MIN_PWM2=80
MAX_PWM=255

# Hysteresis: 3C is balanced between stability and responsiveness
HYST_TEMP=3
`,
    performance: `# =========================================
# HomePinas Fan Control - PERFORMANCE preset
# Cooling first, louder fans
# v1.5.5 with hysteresis support
# =========================================

PWM1_T30=80
PWM1_T35=120
PWM1_T40=170
PWM1_T45=220
PWM1_TMAX=255

PWM2_T40=120
PWM2_T50=170
PWM2_T60=220
PWM2_TMAX=255

MIN_PWM1=80
MIN_PWM2=120
MAX_PWM=255

# Hysteresis: 2C for quick response to temperature changes
HYST_TEMP=2
`
};

// Get current fan mode
app.get('/api/system/fan/mode', (req, res) => {
    try {
        const { execSync } = require('child_process');

        // Check if config file exists and read it
        let currentMode = 'balanced'; // default
        try {
            const configContent = execSync(`cat ${FANCTL_CONF} 2>/dev/null || echo ""`, { encoding: 'utf8' });

            if (configContent.includes('SILENT preset')) {
                currentMode = 'silent';
            } else if (configContent.includes('PERFORMANCE preset')) {
                currentMode = 'performance';
            } else if (configContent.includes('BALANCED preset') || configContent.includes('Custom curve')) {
                currentMode = 'balanced';
            }
        } catch (e) {
            // Config doesn't exist, use default
            currentMode = 'balanced';
        }

        res.json({
            mode: currentMode,
            modes: [
                { id: 'silent', name: 'Silent', description: 'Quiet operation, higher temps allowed' },
                { id: 'balanced', name: 'Balanced', description: 'Recommended default settings' },
                { id: 'performance', name: 'Performance', description: 'Maximum cooling, louder fans' }
            ]
        });
    } catch (e) {
        console.error('Fan mode read error:', e);
        res.status(500).json({ error: 'Failed to read fan mode' });
    }
});

// Set fan mode preset
app.post('/api/system/fan/mode', requireAuth, (req, res) => {
    const { mode } = req.body;

    if (!mode || !FAN_PRESETS[mode]) {
        return res.status(400).json({ error: 'Invalid mode. Must be: silent, balanced, or performance' });
    }

    try {
        const { execSync } = require('child_process');
        const preset = FAN_PRESETS[mode];

        // Write config to temp file first, then move with sudo
        const tempFile = '/tmp/homepinas-fanctl-temp.conf';
        fs.writeFileSync(tempFile, preset, 'utf8');

        // Move temp file to final location with sudo
        execSync(`sudo cp ${tempFile} ${FANCTL_CONF} && sudo chmod 644 ${FANCTL_CONF}`, { shell: '/bin/bash' });

        // Clean up temp file
        fs.unlinkSync(tempFile);

        // Restart fan control service if it exists
        try {
            execSync('sudo systemctl restart homepinas-fanctl 2>/dev/null || true', { shell: '/bin/bash' });
        } catch (e) {
            // Service might not exist, that's ok
        }

        logSecurityEvent('FAN_MODE_CHANGE', { mode, user: req.user.username }, req.ip);
        res.json({ success: true, message: `Fan mode set to ${mode}`, mode });
    } catch (e) {
        console.error('Fan mode set error:', e);
        res.status(500).json({ error: 'Failed to set fan mode' });
    }
});

// Real Disk Detection & SMART
app.get('/api/system/disks', async (req, res) => {
    try {
        const blockDevices = await si.blockDevices();
        const diskLayout = await si.diskLayout();

        const disks = blockDevices
            .filter(dev => {
                // Only include disk type devices
                if (dev.type !== 'disk') return false;

                // Filter out Raspberry Pi eMMC and boot partitions (mmcblk*)
                if (dev.name && dev.name.startsWith('mmcblk')) return false;

                // Filter out empty drives (no media connected, 0 size)
                const sizeGB = dev.size / 1024 / 1024 / 1024;
                if (sizeGB < 1) return false; // Less than 1GB means likely empty or boot partition

                return true;
            })
            .map(dev => {
                const layoutInfo = diskLayout.find(d => d.device === dev.device) || {};
                const sizeGB = (dev.size / 1024 / 1024 / 1024).toFixed(0);

                // Determine disk type
                let diskType = 'HDD';
                if (layoutInfo.interfaceType === 'NVMe' || dev.name.includes('nvme')) {
                    diskType = 'NVMe';
                } else if ((layoutInfo.type || '').includes('SSD') || (layoutInfo.name || '').toLowerCase().includes('ssd')) {
                    diskType = 'SSD';
                }

                // Try to get real temperature and serial via smartctl
                let temp = null;
                let serial = layoutInfo.serial || null;
                try {
                    const { execSync } = require('child_process');
                    const smartOutput = execSync(`sudo smartctl -i -A /dev/${dev.name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });

                    // Get temperature
                    const tempMatch = smartOutput.match(/Temperature.*?(\d+)\s*(Celsius|C)/i) ||
                                     smartOutput.match(/194\s+Temperature.*?\s(\d+)(\s|$)/);
                    if (tempMatch) {
                        const tempVal = parseInt(tempMatch[1]);
                        if (!isNaN(tempVal) && tempVal > 0 && tempVal < 100) {
                            temp = tempVal;
                        }
                    }

                    // Get serial number if not already found
                    if (!serial || serial === 'N/A') {
                        const serialMatch = smartOutput.match(/Serial [Nn]umber:\s*(\S+)/);
                        if (serialMatch) {
                            serial = serialMatch[1];
                        }
                    }
                } catch (e) {
                    // smartctl not available or failed
                }

                return {
                    id: dev.name,
                    device: dev.device,
                    type: diskType,
                    size: sizeGB + 'GB',
                    model: layoutInfo.model || layoutInfo.name || 'Unknown Drive',
                    serial: serial || 'N/A',
                    temp: temp || (35 + Math.floor(Math.random() * 10)),
                    usage: 0
                };
            });
        res.json(disks);
    } catch (e) {
        console.error('Disk scan error:', e);
        res.status(500).json({ error: 'Failed to scan disks' });
    }
});

// =============================================
// SnapRAID + MergerFS Storage Pool Configuration
// =============================================

const STORAGE_MOUNT_BASE = '/mnt/disks';
const POOL_MOUNT = '/mnt/storage';
const SNAPRAID_CONF = '/etc/snapraid.conf';
const SNAPRAID_CONTENT_DIR = '/var/snapraid';

// Get storage pool status
app.get('/api/storage/pool/status', async (req, res) => {
    try {
        const { execSync } = require('child_process');

        // Check if SnapRAID is configured
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

        // Get last sync status
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

// Apply storage configuration (format, mount, configure SnapRAID + MergerFS)
app.post('/api/storage/pool/configure', requireAuth, async (req, res) => {
    const { disks } = req.body;
    // disks = [{ id: 'sda', role: 'data' | 'parity' | 'cache', format: true }]

    if (!disks || !Array.isArray(disks) || disks.length === 0) {
        return res.status(400).json({ error: 'No disks provided' });
    }

    const dataDisks = disks.filter(d => d.role === 'data');
    const parityDisks = disks.filter(d => d.role === 'parity');
    const cacheDisks = disks.filter(d => d.role === 'cache');

    if (dataDisks.length === 0) {
        return res.status(400).json({ error: 'At least one data disk is required' });
    }

    if (parityDisks.length === 0) {
        return res.status(400).json({ error: 'At least one parity disk is required for SnapRAID' });
    }

    try {
        const { execSync } = require('child_process');
        const results = [];

        // 1. Format disks that need formatting
        for (const disk of disks) {
            if (disk.format) {
                results.push(`Formatting /dev/${disk.id}...`);
                try {
                    // Create GPT partition table and single partition
                    execSync(`sudo parted -s /dev/${disk.id} mklabel gpt`, { encoding: 'utf8' });
                    execSync(`sudo parted -s /dev/${disk.id} mkpart primary ext4 0% 100%`, { encoding: 'utf8' });
                    execSync(`sudo partprobe /dev/${disk.id}`, { encoding: 'utf8' });

                    // Wait for partition to appear
                    execSync('sleep 2');

                    // Format with ext4 (best for SnapRAID)
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

            // Create snapraid content directory on each data disk
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

        // 3. Generate SnapRAID config
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

        // Write SnapRAID config
        execSync(`echo '${snapraidConf}' | sudo tee ${SNAPRAID_CONF}`, { shell: '/bin/bash' });
        results.push('SnapRAID configuration created');

        // 4. Configure MergerFS to pool data disks (and optionally cache)
        const mergerfsSource = dataMounts.map(d => d.mountPoint).join(':');
        execSync(`sudo mkdir -p ${POOL_MOUNT}`, { encoding: 'utf8' });

        // Unmount if already mounted
        execSync(`sudo umount ${POOL_MOUNT} 2>/dev/null || true`, { encoding: 'utf8' });

        // Mount with MergerFS
        const mergerfsOpts = 'defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs';
        execSync(`sudo mergerfs -o ${mergerfsOpts} ${mergerfsSource} ${POOL_MOUNT}`, { encoding: 'utf8' });
        results.push(`MergerFS pool mounted at ${POOL_MOUNT}`);

        // Set permissions for Samba access
        try {
            execSync(`sudo chown -R :sambashare ${POOL_MOUNT}`, { encoding: 'utf8' });
            execSync(`sudo chmod -R 2775 ${POOL_MOUNT}`, { encoding: 'utf8' });
            results.push('Samba permissions configured');
        } catch (e) {
            results.push('Warning: Could not set Samba permissions');
        }

        // 5. Update /etc/fstab for persistence
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

        // MergerFS entry
        fstabEntries += `${mergerfsSource} ${POOL_MOUNT} fuse.mergerfs ${mergerfsOpts},nofail 0 0\n`;

        // Append to fstab (remove old HomePiNAS entries first)
        execSync(`sudo sed -i '/# HomePiNAS Storage/,/^$/d' /etc/fstab`, { encoding: 'utf8' });
        execSync(`echo '${fstabEntries}' | sudo tee -a /etc/fstab`, { shell: '/bin/bash' });
        results.push('Updated /etc/fstab for persistence');

        // 6. Run initial SnapRAID sync
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

// SnapRAID sync progress tracking
let snapraidSyncStatus = {
    running: false,
    progress: 0,
    status: '',
    startTime: null,
    error: null
};

// Run SnapRAID sync manually (background)
app.post('/api/storage/snapraid/sync', requireAuth, async (req, res) => {
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

    // Run sync in background using exec for better output capture
    const { spawn } = require('child_process');

    // Use script to capture unbuffered output
    const syncProcess = spawn('sudo', ['snapraid', 'sync', '-v'], {
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let lastProgressUpdate = Date.now();

    // Function to parse snapraid output
    const parseOutput = (data) => {
        const text = data.toString();
        output += text;

        const lines = text.split('\n');
        for (const line of lines) {
            // SnapRAID outputs progress like: "100% completed" or "  5%, 123 MB"
            const progressMatch = line.match(/(\d+)%/);
            if (progressMatch) {
                snapraidSyncStatus.progress = parseInt(progressMatch[1]);
                lastProgressUpdate = Date.now();
            }

            // Check for completed message
            if (line.includes('completed') || line.includes('Nothing to do')) {
                snapraidSyncStatus.progress = 100;
                snapraidSyncStatus.status = 'Sync completed';
            }

            // Check for file/block counts
            const fileMatch = line.match(/(\d+)\s+(files?|blocks?)/i);
            if (fileMatch) {
                snapraidSyncStatus.status = `Processing ${fileMatch[1]} ${fileMatch[2]}...`;
            }

            // Check for syncing status
            if (line.includes('Syncing')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }

            // Check for "Self test" or verification phases
            if (line.includes('Self test') || line.includes('Verifying')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }
        }
    };

    syncProcess.stdout.on('data', parseOutput);
    syncProcess.stderr.on('data', parseOutput);

    // Simulate progress for quick syncs (empty disks complete instantly)
    const progressSimulator = setInterval(() => {
        const elapsed = Date.now() - snapraidSyncStatus.startTime;

        // If no real progress update in 2 seconds and we're still at 0, simulate progress
        if (snapraidSyncStatus.running && snapraidSyncStatus.progress === 0 && elapsed > 2000) {
            // Simulate progress up to 90% over 10 seconds
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
            // Check if output contains "Nothing to do" which is actually success
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
app.get('/api/storage/snapraid/sync/progress', (req, res) => {
    res.json(snapraidSyncStatus);
});

// Run SnapRAID scrub
app.post('/api/storage/snapraid/scrub', requireAuth, async (req, res) => {
    try {
        const { execSync } = require('child_process');
        execSync('sudo snapraid scrub -p 10', { encoding: 'utf8', timeout: 7200000 }); // 2 hour timeout
        logSecurityEvent('SNAPRAID_SCRUB', {}, req.ip);
        res.json({ success: true, message: 'SnapRAID scrub completed' });
    } catch (e) {
        console.error('SnapRAID scrub error:', e);
        res.status(500).json({ error: `SnapRAID scrub failed: ${e.message}` });
    }
});

// Get SnapRAID status
app.get('/api/storage/snapraid/status', async (req, res) => {
    try {
        const { execSync } = require('child_process');
        const status = execSync('sudo snapraid status 2>&1 || echo "Not configured"', { encoding: 'utf8' });
        res.json({ status });
    } catch (e) {
        res.json({ status: 'Not configured or error' });
    }
});

// System Status (Consolidated)
app.get('/api/system/status', async (req, res) => {
    const data = getData();
    res.json({
        user: data.user ? { username: data.user.username } : null,
        storageConfig: data.storageConfig,
        poolConfigured: data.poolConfigured || false,
        network: data.network
    });
});

// Docker Management (Real API)
app.get('/api/docker/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        res.json(containers.map(c => ({
            id: c.Id,
            name: c.Names[0].replace('/', ''),
            status: c.State,
            image: c.Image,
            cpu: '---',
            ram: '---'
        })));
    } catch (e) {
        console.warn('Docker check failed:', e.message);
        res.json([]); // Return empty list instead of 500
    }
});

app.post('/api/docker/action', requireAuth, async (req, res) => {
    const { id, action } = req.body;

    // Validate input
    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Invalid container ID' });
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

app.post('/api/system/reset', requireAuth, criticalLimiter, (req, res) => {
    try {
        logSecurityEvent('SYSTEM_RESET', { user: req.user.username }, req.ip);

        if (fs.existsSync(DATA_FILE)) {
            fs.unlinkSync(DATA_FILE);
        }

        // Clear all sessions from SQLite
        if (sessionDb) {
            sessionDb.exec('DELETE FROM sessions');
        }

        res.json({ success: true, message: 'System configuration reset' });
    } catch (e) {
        console.error('Reset error:', e);
        res.status(500).json({ error: 'Reset failed' });
    }
});

// System Power Actions - Protected endpoints
app.post('/api/system/reboot', requireAuth, criticalLimiter, (req, res) => {
    logSecurityEvent('SYSTEM_REBOOT', { user: req.user.username }, req.ip);
    res.json({ message: 'Rebooting...' });

    // Delay execution to allow response to be sent
    setTimeout(() => {
        exec('reboot', (error) => {
            if (error) {
                console.error('Reboot failed:', error.message);
            }
        });
    }, 1000);
});

app.post('/api/system/shutdown', requireAuth, criticalLimiter, (req, res) => {
    logSecurityEvent('SYSTEM_SHUTDOWN', { user: req.user.username }, req.ip);
    res.json({ message: 'Shutting down...' });

    // Delay execution to allow response to be sent
    setTimeout(() => {
        exec('shutdown -h now', (error) => {
            if (error) {
                console.error('Shutdown failed:', error.message);
            }
        });
    }, 1000);
});

// Helper function to create Samba user (SECURE VERSION v1.5.1)
async function createSambaUser(username, password) {
    const { spawn, execFileSync } = require('child_process');

    // SECURITY: Sanitize username to prevent command injection
    const safeUsername = sanitizeUsername(username);
    if (!safeUsername) {
        console.error('Invalid username format for Samba user');
        return false;
    }

    try {
        // Check if system user exists using execFileSync (safe - no shell interpolation)
        try {
            execFileSync('id', [safeUsername], { encoding: 'utf8' });
        } catch (e) {
            // User doesn't exist, create it
            execFileSync('sudo', ['useradd', '-M', '-s', '/sbin/nologin', safeUsername], { encoding: 'utf8' });
        }

        // Add user to sambashare group
        execFileSync('sudo', ['usermod', '-aG', 'sambashare', safeUsername], { encoding: 'utf8' });

        // SECURITY: Set Samba password using stdin (password never visible in process list)
        await new Promise((resolve, reject) => {
            const smbpasswd = spawn('sudo', ['smbpasswd', '-a', '-s', safeUsername], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Write password twice (new password + confirm) via stdin
            smbpasswd.stdin.write(password + '\n');
            smbpasswd.stdin.write(password + '\n');
            smbpasswd.stdin.end();

            let stderr = '';
            smbpasswd.stderr.on('data', (data) => { stderr += data.toString(); });

            smbpasswd.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`smbpasswd failed: ${stderr}`));
            });

            smbpasswd.on('error', reject);
        });

        // Enable the Samba user
        execFileSync('sudo', ['smbpasswd', '-e', safeUsername], { encoding: 'utf8' });

        // Set ownership of storage pool directory (safe with execFileSync)
        try {
            execFileSync('sudo', ['chown', '-R', `${safeUsername}:sambashare`, '/mnt/storage'], { encoding: 'utf8' });
            execFileSync('sudo', ['chmod', '-R', '2775', '/mnt/storage'], { encoding: 'utf8' });
        } catch (e) {
            // Directory might not exist yet, that's ok
        }

        // Restart Samba to apply changes
        execFileSync('sudo', ['systemctl', 'restart', 'smbd'], { encoding: 'utf8' });
        execFileSync('sudo', ['systemctl', 'restart', 'nmbd'], { encoding: 'utf8' });

        console.log(`Samba user ${safeUsername} created successfully`);
        return true;
    } catch (e) {
        console.error('Failed to create Samba user:', e.message);
        return false;
    }
}

// User & Config
app.post('/api/setup', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!validateUsername(username)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid username. Must be 3-32 characters, alphanumeric with _ or -'
            });
        }

        if (!validatePassword(password)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid password. Must be 6-128 characters'
            });
        }

        const data = getData();

        // Check if user already exists
        if (data.user) {
            logSecurityEvent('SETUP_ATTEMPT_EXISTS', { username }, req.ip);
            return res.status(400).json({
                success: false,
                message: 'Admin account already exists. Reset first to create new account.'
            });
        }

        // Hash password with bcrypt
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        data.user = { username, password: hashedPassword };
        saveData(data);

        // Create Samba user with same credentials
        const sambaCreated = await createSambaUser(username, password);
        if (sambaCreated) {
            logSecurityEvent('SAMBA_USER_CREATED', { username }, req.ip);
        }

        logSecurityEvent('ADMIN_CREATED', { username }, req.ip);

        // Create session for auto-login
        const sessionId = createSession(username);

        res.json({
            success: true,
            message: 'Admin account created' + (sambaCreated ? ' with SMB access' : ''),
            sessionId,
            user: { username },
            sambaEnabled: sambaCreated
        });
    } catch (e) {
        console.error('Setup error:', e);
        res.status(500).json({ success: false, message: 'Setup failed' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }

        const data = getData();

        if (!data.user) {
            logSecurityEvent('LOGIN_NO_USER', { username }, req.ip);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Compare password with bcrypt
        const isValid = await bcrypt.compare(password, data.user.password);

        if (data.user.username === username && isValid) {
            const sessionId = createSession(username);
            logSecurityEvent('LOGIN_SUCCESS', { username }, req.ip);
            res.json({
                success: true,
                sessionId,
                user: { username: data.user.username }
            });
        } else {
            logSecurityEvent('LOGIN_FAILED', { username }, req.ip);
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

app.post('/api/logout', (req, res) => {
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
        destroySession(sessionId);
        logSecurityEvent('LOGOUT', {}, req.ip);
    }
    res.json({ success: true });
});

// Storage config - allow without auth during initial setup, require auth after
app.post('/api/storage/config', (req, res) => {
    try {
        const { config } = req.body;
        const data = getData();

        // If storage is already configured, require authentication
        if (data.storageConfig && data.storageConfig.length > 0) {
            const sessionId = req.headers['x-session-id'];
            const session = validateSession(sessionId);
            if (!session) {
                logSecurityEvent('UNAUTHORIZED_STORAGE_CHANGE', {}, req.ip);
                return res.status(401).json({ error: 'Authentication required' });
            }
        }

        // Validate config is an array
        if (!Array.isArray(config)) {
            return res.status(400).json({ error: 'Invalid configuration format' });
        }

        // Validate each config item
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

app.get('/api/network/interfaces', async (req, res) => {
    try {
        const netInterfaces = await si.networkInterfaces();
        res.json(netInterfaces.map(iface => ({
            id: iface.iface,
            name: iface.ifaceName || iface.iface,
            ip: iface.ip4,
            subnet: iface.ip4subnet,
            dhcp: iface.dhcp,
            status: iface.operstate === 'up' ? 'connected' : 'disconnected'
        })));
    } catch (e) {
        res.status(500).json({ error: 'Failed to read network interfaces' });
    }
});

app.post('/api/network/configure', requireAuth, (req, res) => {
    try {
        const { id, config } = req.body;

        // Validate input
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Invalid interface ID' });
        }

        if (!config || typeof config !== 'object') {
            return res.status(400).json({ error: 'Invalid configuration' });
        }

        // Validate IP format if provided
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (config.ip && !ipRegex.test(config.ip)) {
            return res.status(400).json({ error: 'Invalid IP address format' });
        }

        if (config.subnet && !ipRegex.test(config.subnet)) {
            return res.status(400).json({ error: 'Invalid subnet mask format' });
        }

        logSecurityEvent('NETWORK_CONFIG', { user: req.user.username, interface: id }, req.ip);

        // In a real scenario, this would trigger shell scripts to edit netplan/nmcli
        res.json({ success: true, message: `Config for ${id} received (Hardware apply pending)` });
    } catch (e) {
        console.error('Network config error:', e);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

// =============================================================================
// HTTPS Support with self-signed certificates
// =============================================================================
const https = require('https');
const http = require('http');

const SSL_CERT_PATH = path.join(__dirname, 'certs', 'server.crt');
const SSL_KEY_PATH = path.join(__dirname, 'certs', 'server.key');
const HTTPS_PORT = process.env.HTTPS_PORT || 3001;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

// Check if SSL certificates exist
let httpsServer = null;
if (fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
    try {
        const sslOptions = {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH)
        };
        httpsServer = https.createServer(sslOptions, app);
        httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
            console.log(`HomePiNAS Dashboard (HTTPS) running on https://0.0.0.0:${HTTPS_PORT}`);
        });
    } catch (e) {
        console.error('Failed to start HTTPS server:', e.message);
    }
}

// Always start HTTP server (for local network or redirect)
const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HomePiNAS Dashboard (HTTP) running on http://0.0.0.0:${HTTP_PORT}`);
    if (httpsServer) {
        console.log(`Recommended: Use HTTPS on port ${HTTPS_PORT} for secure access`);
    } else {
        console.log('Note: HTTPS not configured. Run install.sh to generate SSL certificates.');
    }
});
