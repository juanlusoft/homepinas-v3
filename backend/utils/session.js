/**
 * HomePiNAS - Session Management
 * v1.5.6 - Modular Architecture
 *
 * SQLite-backed persistent session storage
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const SESSION_DB_PATH = path.join(__dirname, '..', 'config', 'sessions.db');
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

let sessionDb = null;

/**
 * Initialize SQLite session database
 */
function initSessionDb() {
    try {
        const configDir = path.dirname(SESSION_DB_PATH);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }

        sessionDb = new Database(SESSION_DB_PATH);

        // SECURITY: Set restrictive permissions on database file (owner read/write only)
        try {
            fs.chmodSync(SESSION_DB_PATH, 0o600);
        } catch (e) {
            console.warn('Could not set restrictive permissions on session database');
        }

        sessionDb.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        sessionDb.exec(`
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
            ON sessions(expires_at)
        `);

        console.log('Session database initialized at', SESSION_DB_PATH);
        cleanExpiredSessions();

        return true;
    } catch (e) {
        console.error('Failed to initialize session database:', e.message);
        return false;
    }
}

/**
 * Create a new session
 */
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

/**
 * Validate a session
 */
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

/**
 * Destroy a session
 */
function destroySession(sessionId) {
    if (!sessionDb) return;

    try {
        const stmt = sessionDb.prepare('DELETE FROM sessions WHERE session_id = ?');
        stmt.run(sessionId);
    } catch (e) {
        console.error('Failed to destroy session:', e.message);
    }
}

/**
 * Clear all sessions
 */
function clearAllSessions() {
    if (!sessionDb) return;

    try {
        sessionDb.exec('DELETE FROM sessions');
    } catch (e) {
        console.error('Failed to clear sessions:', e.message);
    }
}

/**
 * Clean expired sessions
 */
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

/**
 * Start periodic cleanup
 */
function startSessionCleanup() {
    setInterval(cleanExpiredSessions, 60 * 60 * 1000); // Clean every hour
}

module.exports = {
    initSessionDb,
    createSession,
    validateSession,
    destroySession,
    clearAllSessions,
    cleanExpiredSessions,
    startSessionCleanup,
    SESSION_DURATION
};
