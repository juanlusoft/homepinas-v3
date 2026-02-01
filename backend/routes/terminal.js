/**
 * HomePiNAS - Terminal Routes
 * v2.1.0 - Web Terminal with PTY support
 *
 * Features:
 * - WebSocket-based terminal sessions
 * - PTY spawning for real shell access
 * - Session management
 * - Support for htop, mc, and custom commands
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');

// Terminal sessions storage
const terminalSessions = new Map();

// Allowed commands for shortcuts (whitelist)
const ALLOWED_COMMANDS = [
    'bash', 'sh', 'htop', 'top', 'mc', 'nano', 'vim', 'vi',
    'less', 'more', 'cat', 'ls', 'cd', 'pwd', 'df', 'du',
    'free', 'ps', 'journalctl', 'systemctl', 'docker', 'tmux'
];

// Validate command is safe to execute
function validateCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    
    const baseCmd = cmd.split(' ')[0].split('/').pop();
    return ALLOWED_COMMANDS.includes(baseCmd);
}

// Get terminal sessions list
router.get('/sessions', requireAuth, (req, res) => {
    const sessions = [];
    for (const [id, session] of terminalSessions) {
        sessions.push({
            id,
            command: session.command,
            startTime: session.startTime,
            active: !session.process.killed
        });
    }
    res.json(sessions);
});

// Create new terminal session info (actual PTY handled via WebSocket)
router.post('/session', requireAuth, (req, res) => {
    const { command = 'bash' } = req.body;
    
    // Validate command
    if (!validateCommand(command)) {
        return res.status(400).json({ 
            error: 'Command not allowed. Use: ' + ALLOWED_COMMANDS.join(', ')
        });
    }
    
    const sessionId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    logSecurityEvent('TERMINAL_SESSION_CREATED', { 
        sessionId, 
        command,
        user: req.user.username 
    }, req.ip);
    
    res.json({
        sessionId,
        command,
        wsUrl: `/api/terminal/ws/${sessionId}`,
        message: 'Connect via WebSocket to start terminal'
    });
});

// Kill terminal session
router.delete('/session/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    
    if (!id || typeof id !== 'string' || !id.startsWith('term-')) {
        return res.status(400).json({ error: 'Invalid session ID' });
    }
    
    const session = terminalSessions.get(id);
    if (session) {
        if (session.process && !session.process.killed) {
            session.process.kill('SIGTERM');
        }
        terminalSessions.delete(id);
        
        logSecurityEvent('TERMINAL_SESSION_KILLED', { 
            sessionId: id,
            user: req.user.username 
        }, req.ip);
        
        res.json({ success: true, message: 'Session terminated' });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// Get available commands for shortcuts
router.get('/commands', requireAuth, (req, res) => {
    res.json({
        allowed: ALLOWED_COMMANDS,
        presets: [
            { name: 'Terminal', command: 'bash', icon: '💻', description: 'Interactive shell' },
            { name: 'System Monitor', command: 'htop', icon: '📊', description: 'Process viewer' },
            { name: 'File Manager', command: 'mc', icon: '📁', description: 'Midnight Commander' },
            { name: 'Text Editor', command: 'nano', icon: '📝', description: 'Nano editor' },
            { name: 'Docker Stats', command: 'docker stats', icon: '🐳', description: 'Container stats' },
            { name: 'System Logs', command: 'journalctl -f', icon: '📜', description: 'Follow system logs' },
            { name: 'Disk Usage', command: 'df -h', icon: '💾', description: 'Disk space' },
            { name: 'Memory Info', command: 'free -h', icon: '🧠', description: 'Memory usage' }
        ]
    });
});

// Export for WebSocket handler
router.terminalSessions = terminalSessions;
router.ALLOWED_COMMANDS = ALLOWED_COMMANDS;
router.validateCommand = validateCommand;

module.exports = router;
