/**
 * HomePiNAS - Input Sanitization Utilities
 * v1.6.0 - Security Hardening
 *
 * Strict security functions to sanitize and validate all user inputs
 * CRITICAL: All user input MUST pass through these functions before use
 */

const path = require('path');

// ============================================================================
// USERNAME SANITIZATION
// ============================================================================

function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const sanitized = username.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized.length < 3 || sanitized.length > 32) return null;
    if (!/^[a-zA-Z]/.test(sanitized)) return null;
    const reserved = ['root', 'admin', 'daemon', 'bin', 'sys', 'nobody', 'www-data'];
    if (reserved.includes(sanitized.toLowerCase())) return null;
    return sanitized;
}

function validateUsername(username) {
    return sanitizeUsername(username) !== null;
}

function validatePassword(password) {
    if (!password || typeof password !== 'string') return false;
    if (password.length < 6 || password.length > 128) return false;
    return true;
}

// ============================================================================
// DISK AND PATH SANITIZATION
// ============================================================================

function sanitizeDiskId(diskId) {
    if (!diskId || typeof diskId !== 'string') return null;
    const id = diskId.replace(/^\/dev\//, '');
    const validPatterns = [
        /^sd[a-z]$/,
        /^sd[a-z][1-9][0-9]?$/,
        /^nvme[0-9]n[0-9]$/,
        /^nvme[0-9]n[0-9]p[0-9]+$/,
        /^hd[a-z]$/,
        /^vd[a-z]$/,
        /^xvd[a-z]$/,
        /^mmcblk[0-9]$/,
        /^mmcblk[0-9]p[0-9]+$/
    ];
    for (const pattern of validPatterns) {
        if (pattern.test(id)) return id;
    }
    return null;
}

function sanitizeDiskPath(diskPath) {
    if (!diskPath || typeof diskPath !== 'string') return null;
    if (!diskPath.startsWith('/dev/')) return null;
    const id = sanitizeDiskId(diskPath);
    if (!id) return null;
    return `/dev/${id}`;
}

function sanitizePathWithinBase(inputPath, baseDir) {
    if (!inputPath || typeof inputPath !== 'string') return null;
    if (!baseDir || typeof baseDir !== 'string') return null;
    const sanitized = inputPath.replace(/\0/g, '');
    const fullPath = path.resolve(baseDir, sanitized);
    const realBase = path.resolve(baseDir);
    if (!fullPath.startsWith(realBase + path.sep) && fullPath !== realBase) {
        return null;
    }
    return fullPath;
}

function sanitizePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null;
    let sanitized = inputPath.replace(/\0/g, '');
    const normalized = path.normalize(sanitized);
    if (normalized.includes('..')) return null;
    if (!/^[a-zA-Z0-9/_.-]+$/.test(normalized)) return null;
    return normalized;
}

function escapeShellArg(arg) {
    if (arg === null || arg === undefined) return "''";
    if (typeof arg !== 'string') return "''";
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function sanitizeShellArg(arg) {
    return escapeShellArg(arg);
}

// ============================================================================
// DOCKER VALIDATION
// ============================================================================

function validateDockerAction(action) {
    return ['start', 'stop', 'restart'].includes(action);
}

function validateContainerId(containerId) {
    if (!containerId || typeof containerId !== 'string') return false;
    return /^[a-f0-9]{12,64}$/i.test(containerId);
}

function sanitizeComposeName(name) {
    if (!name || typeof name !== 'string') return null;
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized.length === 0 || sanitized.length > 50) return null;
    if (!/^[a-zA-Z0-9]/.test(sanitized)) return null;
    return sanitized;
}

function validateComposeContent(content) {
    if (!content || typeof content !== 'string') {
        return { valid: false, error: 'Content must be a string' };
    }
    if (content.length === 0) {
        return { valid: false, error: 'Content cannot be empty' };
    }
    if (content.length > 100000) {
        return { valid: false, error: 'Content too large (max 100KB)' };
    }
    if (!content.includes('services') && !content.includes('version')) {
        return { valid: false, error: 'Invalid docker-compose format' };
    }
    return { valid: true };
}

// ============================================================================
// SYSTEM VALIDATION
// ============================================================================

function validateSystemAction(action) {
    return ['reboot', 'shutdown'].includes(action);
}

function validateFanId(fanId) {
    const num = parseInt(fanId);
    if (isNaN(num) || num < 1 || num > 10) return null;
    return num;
}

function validateFanSpeed(speed) {
    const num = parseInt(speed);
    if (isNaN(num) || num < 0 || num > 100) return null;
    return num;
}

function validateFanMode(mode) {
    const validModes = ['silent', 'balanced', 'performance'];
    return validModes.includes(mode) ? mode : null;
}

// ============================================================================
// NETWORK VALIDATION
// ============================================================================

function validateInterfaceName(name) {
    if (!name || typeof name !== 'string') return false;
    return /^[a-z0-9:._-]{1,15}$/i.test(name);
}

function validateIPv4(ip) {
    if (!ip || typeof ip !== 'string') return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    for (const part of parts) {
        const num = parseInt(part);
        if (isNaN(num) || num < 0 || num > 255) return false;
        if (part !== num.toString()) return false;
    }
    return true;
}

function validateSubnetMask(mask) {
    if (!validateIPv4(mask)) return false;
    const validOctets = [0, 128, 192, 224, 240, 248, 252, 254, 255];
    const parts = mask.split('.').map(Number);
    let foundZero = false;
    for (const part of parts) {
        if (foundZero && part !== 0) return false;
        if (part === 0) foundZero = true;
        if (!validOctets.includes(part)) return false;
    }
    return true;
}

// ============================================================================
// STORAGE VALIDATION
// ============================================================================

function validateDiskRole(role) {
    const validRoles = ['data', 'parity', 'cache', 'none'];
    return validRoles.includes(role) ? role : null;
}

function validateDiskConfig(disks) {
    if (!Array.isArray(disks)) return null;
    if (disks.length === 0 || disks.length > 20) return null;
    const validated = [];
    for (const disk of disks) {
        if (!disk || typeof disk !== 'object') return null;
        const id = sanitizeDiskId(disk.id);
        if (!id) return null;
        const role = validateDiskRole(disk.role);
        if (!role) return null;
        const format = disk.format === true;
        validated.push({ id, role, format });
    }
    return validated;
}

function validatePositiveInt(value, max = Number.MAX_SAFE_INTEGER) {
    const num = parseInt(value);
    if (isNaN(num) || num < 1 || num > max) return null;
    return num;
}

function validateNonNegativeInt(value, max = Number.MAX_SAFE_INTEGER) {
    const num = parseInt(value);
    if (isNaN(num) || num < 0 || num > max) return null;
    return num;
}

function sanitizeForLog(str) {
    if (!str || typeof str !== 'string') return '[invalid]';
    return str
        .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
        .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]')
        .replace(/key[=:]\s*\S+/gi, 'key=[REDACTED]')
        .replace(/secret[=:]\s*\S+/gi, 'secret=[REDACTED]')
        .substring(0, 500);
}

module.exports = {
    sanitizeUsername,
    validateUsername,
    validatePassword,
    sanitizeDiskId,
    sanitizeDiskPath,
    sanitizePath,
    sanitizePathWithinBase,
    sanitizeShellArg,
    escapeShellArg,
    validateDockerAction,
    validateContainerId,
    sanitizeComposeName,
    validateComposeContent,
    validateSystemAction,
    validateFanId,
    validateFanSpeed,
    validateFanMode,
    validateInterfaceName,
    validateIPv4,
    validateSubnetMask,
    validateDiskRole,
    validateDiskConfig,
    validatePositiveInt,
    validateNonNegativeInt,
    sanitizeForLog
};
