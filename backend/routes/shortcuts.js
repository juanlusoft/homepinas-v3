/**
 * HomePiNAS - Shortcuts Routes
 * v2.1.0 - Configurable program shortcuts
 *
 * Features:
 * - CRUD for custom shortcuts
 * - Default shortcuts
 * - Validation of commands
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');

const SHORTCUTS_FILE = path.join(__dirname, '..', 'config', 'shortcuts.json');

// Allowed commands (same as terminal)
const ALLOWED_COMMANDS = [
    'bash', 'sh', 'htop', 'top', 'mc', 'nano', 'vim', 'vi',
    'less', 'more', 'cat', 'ls', 'cd', 'pwd', 'df', 'du',
    'free', 'ps', 'journalctl', 'systemctl', 'docker', 'tmux'
];

// Default shortcuts
const DEFAULT_SHORTCUTS = [
    { id: 'default-terminal', name: 'Terminal', command: 'bash', icon: '💻', description: 'Interactive shell', isDefault: true },
    { id: 'default-htop', name: 'System Monitor', command: 'htop', icon: '📊', description: 'Process viewer (htop)', isDefault: true },
    { id: 'default-mc', name: 'File Manager', command: 'mc', icon: '📁', description: 'Midnight Commander', isDefault: true },
    { id: 'default-docker-logs', name: 'Docker Stats', command: 'docker stats', icon: '🐳', description: 'Container statistics', isDefault: true }
];

// Available icons for shortcuts
const AVAILABLE_ICONS = [
    '💻', '📊', '📁', '📝', '🐳', '📜', '💾', '🧠', '⚙️', '🔧', 
    '📦', '🌐', '🔒', '📡', '⏱️', '🎯', '🚀', '💡', '🔍', '📈'
];

// Load shortcuts from file
function loadShortcuts() {
    try {
        if (fs.existsSync(SHORTCUTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SHORTCUTS_FILE, 'utf8'));
            return data.shortcuts || [];
        }
    } catch (e) {
        console.error('Error loading shortcuts:', e.message);
    }
    return [];
}

// Save shortcuts to file
function saveShortcuts(shortcuts) {
    try {
        const configDir = path.dirname(SHORTCUTS_FILE);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify({ shortcuts }, null, 2));
        return true;
    } catch (e) {
        console.error('Error saving shortcuts:', e.message);
        return false;
    }
}

// Validate command
function validateCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const baseCmd = cmd.split(' ')[0].split('/').pop();
    return ALLOWED_COMMANDS.includes(baseCmd);
}

// Sanitize shortcut data
function sanitizeShortcut(data) {
    const name = (data.name || '').trim().substring(0, 50);
    const command = (data.command || '').trim().substring(0, 200);
    const icon = AVAILABLE_ICONS.includes(data.icon) ? data.icon : '💻';
    const description = (data.description || '').trim().substring(0, 200);
    
    if (!name || !command) return null;
    if (!validateCommand(command)) return null;
    
    return { name, command, icon, description };
}

// Get all shortcuts (defaults + custom)
router.get('/', requireAuth, (req, res) => {
    const customShortcuts = loadShortcuts();
    res.json({
        defaults: DEFAULT_SHORTCUTS,
        custom: customShortcuts,
        icons: AVAILABLE_ICONS,
        allowedCommands: ALLOWED_COMMANDS
    });
});

// Create new shortcut
router.post('/', requireAuth, (req, res) => {
    const sanitized = sanitizeShortcut(req.body);
    
    if (!sanitized) {
        return res.status(400).json({ 
            error: 'Invalid shortcut data. Command must be one of: ' + ALLOWED_COMMANDS.join(', ')
        });
    }
    
    const shortcuts = loadShortcuts();
    const newShortcut = {
        id: `custom-${Date.now()}`,
        ...sanitized,
        isDefault: false,
        createdAt: new Date().toISOString()
    };
    
    shortcuts.push(newShortcut);
    
    if (saveShortcuts(shortcuts)) {
        logSecurityEvent('SHORTCUT_CREATED', { 
            shortcut: newShortcut.name,
            command: newShortcut.command,
            user: req.user.username 
        }, req.ip);
        
        res.json({ success: true, shortcut: newShortcut });
    } else {
        res.status(500).json({ error: 'Failed to save shortcut' });
    }
});

// Update shortcut
router.put('/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    
    // Cannot edit default shortcuts
    if (id.startsWith('default-')) {
        return res.status(400).json({ error: 'Cannot edit default shortcuts' });
    }
    
    const sanitized = sanitizeShortcut(req.body);
    if (!sanitized) {
        return res.status(400).json({ error: 'Invalid shortcut data' });
    }
    
    const shortcuts = loadShortcuts();
    const index = shortcuts.findIndex(s => s.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Shortcut not found' });
    }
    
    shortcuts[index] = {
        ...shortcuts[index],
        ...sanitized,
        updatedAt: new Date().toISOString()
    };
    
    if (saveShortcuts(shortcuts)) {
        logSecurityEvent('SHORTCUT_UPDATED', { 
            shortcutId: id,
            user: req.user.username 
        }, req.ip);
        
        res.json({ success: true, shortcut: shortcuts[index] });
    } else {
        res.status(500).json({ error: 'Failed to update shortcut' });
    }
});

// Delete shortcut
router.delete('/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    
    // Cannot delete default shortcuts
    if (id.startsWith('default-')) {
        return res.status(400).json({ error: 'Cannot delete default shortcuts' });
    }
    
    const shortcuts = loadShortcuts();
    const index = shortcuts.findIndex(s => s.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Shortcut not found' });
    }
    
    const deleted = shortcuts.splice(index, 1)[0];
    
    if (saveShortcuts(shortcuts)) {
        logSecurityEvent('SHORTCUT_DELETED', { 
            shortcutId: id,
            shortcutName: deleted.name,
            user: req.user.username 
        }, req.ip);
        
        res.json({ success: true, message: 'Shortcut deleted' });
    } else {
        res.status(500).json({ error: 'Failed to delete shortcut' });
    }
});

module.exports = router;
