/**
 * HomePiNAS - Premium NAS Dashboard for Raspberry Pi CM5
 * v1.6.0 - Security Hardening
 *
 * Homelabs.club Edition with:
 * - Bcrypt password hashing
 * - SQLite-backed persistent sessions
 * - Rate limiting protection
 * - Input sanitization
 * - Restricted sudoers
 * - HTTPS support
 * - Fan hysteresis
 * - Docker Compose management
 * - Container update detection
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const helmet = require('helmet');

// Import utilities
const { initSessionDb, startSessionCleanup } = require('./utils/session');

// Import middleware
const { generalLimiter } = require('./middleware/rateLimit');

// Import routes
const systemRoutes = require('./routes/system');
const storageRoutes = require('./routes/storage');
const dockerRoutes = require('./routes/docker');
const authRoutes = require('./routes/auth');
const networkRoutes = require('./routes/network');
const powerRoutes = require('./routes/power');
const updateRoutes = require('./routes/update');

// Configuration
const VERSION = '1.6.0';
const HTTPS_PORT = process.env.HTTPS_PORT || 3001;
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const SSL_CERT_PATH = path.join(__dirname, 'certs', 'server.crt');
const SSL_KEY_PATH = path.join(__dirname, 'certs', 'server.key');

// Initialize Express app
const app = express();

// Initialize session database
initSessionDb();
startSessionCleanup();

// Ensure config directory exists
const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security headers (configured for local network)
app.use(helmet({
    contentSecurityPolicy: false,
    hsts: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
}));

// CORS - Allow all origins for local network NAS
app.use(cors());

// Rate limiting
app.use(generalLimiter);

// Body parsing
app.use(express.json({ limit: '10kb' }));

// =============================================================================
// STATIC FILES
// =============================================================================

// Serve frontend files
app.use(express.static(path.join(__dirname, '../')));
app.use('/frontend', express.static(path.join(__dirname, '../frontend')));

// SPA catch-all route - serve index.html for all non-API routes
app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api')) return next();
    // Skip static files
    if (path.extname(req.path)) return next();
    // Serve SPA for all other routes
    res.sendFile(path.join(__dirname, '../index.html'));
});

// =============================================================================
// API ROUTES
// =============================================================================

// System routes (stats, fans, disks, status)
app.use('/api/system', systemRoutes);

// Storage routes (pool, snapraid)
app.use('/api/storage', storageRoutes);

// Docker routes
app.use('/api/docker', dockerRoutes);

// Authentication routes (setup, login, logout)
app.use('/api', authRoutes);

// Network routes
app.use('/api/network', networkRoutes);

// Power routes (reset, reboot, shutdown)
app.use('/api/system', powerRoutes);

// Update routes (check, apply)
app.use('/api/update', updateRoutes);

// =============================================================================
// SERVER STARTUP
// =============================================================================

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    HomePiNAS v${VERSION}                      ║
║           Premium NAS Dashboard for Raspberry Pi          ║
║                   Homelabs.club Edition                   ║
╚═══════════════════════════════════════════════════════════╝
`);

// Start HTTPS server if certificates exist
let httpsServer = null;
if (fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
    try {
        const sslOptions = {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH)
        };
        httpsServer = https.createServer(sslOptions, app);
        httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
            console.log(`[HTTPS] Secure server running on https://0.0.0.0:${HTTPS_PORT}`);
        });
    } catch (e) {
        console.error('[HTTPS] Failed to start:', e.message);
    }
}

// Always start HTTP server
const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[HTTP]  Server running on http://0.0.0.0:${HTTP_PORT}`);
    if (httpsServer) {
        console.log('\n[INFO]  Recommended: Use HTTPS on port ' + HTTPS_PORT + ' for secure access');
    } else {
        console.log('\n[WARN]  HTTPS not configured. Run install.sh to generate SSL certificates.');
    }
    console.log('\n[INFO]  Modular architecture loaded:');
    console.log('        - routes/system.js    (stats, fans, disks)');
    console.log('        - routes/storage.js   (pool, snapraid)');
    console.log('        - routes/docker.js    (containers)');
    console.log('        - routes/auth.js      (login, setup)');
    console.log('        - routes/network.js   (interfaces)');
    console.log('        - routes/power.js     (reboot, shutdown)');
    console.log('        - routes/update.js    (OTA updates)');
    console.log('');
});

module.exports = app;
