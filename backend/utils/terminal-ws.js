/**
 * HomePiNAS - Terminal WebSocket Handler
 * v2.1.0 - PTY WebSocket integration
 *
 * Handles WebSocket connections for web terminal
 */

const WebSocket = require('ws');
const pty = require('node-pty');
const { validateSession } = require('./session');
const { logSecurityEvent } = require('./security');

// Active terminal sessions
const terminalSessions = new Map();

// Allowed commands (whitelist)
const ALLOWED_COMMANDS = [
    'bash', 'sh', 'htop', 'top', 'mc', 'nano', 'vim', 'vi',
    'less', 'more', 'cat', 'ls', 'cd', 'pwd', 'df', 'du',
    'free', 'ps', 'journalctl', 'systemctl', 'docker', 'tmux'
];

function validateCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const baseCmd = cmd.split(' ')[0].split('/').pop();
    return ALLOWED_COMMANDS.includes(baseCmd);
}

function setupTerminalWebSocket(server) {
    const wss = new WebSocket.Server({ 
        server,
        path: '/api/terminal/ws'
    });

    wss.on('connection', (ws, req) => {
        // Extract session ID and command from URL
        const urlParts = req.url.split('?');
        const params = new URLSearchParams(urlParts[1] || '');
        const sessionId = params.get('sessionId');
        const command = params.get('command') || 'bash';
        const authToken = params.get('token');

        // Validate authentication
        const session = validateSession(authToken);
        if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
            ws.close(1008, 'Authentication required');
            return;
        }

        // Validate command
        if (!validateCommand(command)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Command not allowed' }));
            ws.close(1008, 'Command not allowed');
            return;
        }

        console.log(`[Terminal] New session: ${sessionId}, command: ${command}, user: ${session.username}`);

        // Create PTY process
        let ptyProcess;
        try {
            const shell = command.includes(' ') ? 'bash' : command;
            const args = command.includes(' ') ? ['-c', command] : [];
            
            ptyProcess = pty.spawn(shell, args, {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: process.env.HOME || '/root',
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    LANG: 'en_US.UTF-8'
                }
            });
        } catch (err) {
            console.error('[Terminal] Failed to spawn PTY:', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to start terminal' }));
            ws.close(1011, 'Failed to start terminal');
            return;
        }

        // Store session
        const termSession = {
            id: sessionId,
            process: ptyProcess,
            ws: ws,
            command: command,
            user: session.username,
            startTime: Date.now()
        };
        terminalSessions.set(sessionId, termSession);

        logSecurityEvent('TERMINAL_PTY_STARTED', { 
            sessionId, 
            command, 
            user: session.username 
        }, req.socket.remoteAddress);

        // Send ready message
        ws.send(JSON.stringify({ type: 'ready', sessionId }));

        // Forward PTY output to WebSocket
        ptyProcess.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data }));
            }
        });

        // Handle PTY exit
        ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`[Terminal] PTY exited: ${sessionId}, code: ${exitCode}, signal: ${signal}`);
            terminalSessions.delete(sessionId);
            
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'exit', 
                    exitCode, 
                    signal,
                    message: `Process exited with code ${exitCode}`
                }));
                ws.close(1000, 'Process terminated');
            }
        });

        // Handle WebSocket messages (input from client)
        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message.toString());
                
                switch (msg.type) {
                    case 'input':
                        if (msg.data && ptyProcess) {
                            ptyProcess.write(msg.data);
                        }
                        break;
                    
                    case 'resize':
                        if (msg.cols && msg.rows && ptyProcess) {
                            ptyProcess.resize(
                                Math.min(Math.max(msg.cols, 10), 500),
                                Math.min(Math.max(msg.rows, 5), 200)
                            );
                        }
                        break;
                    
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong' }));
                        break;
                }
            } catch (err) {
                console.error('[Terminal] Message parse error:', err);
            }
        });

        // Handle WebSocket close
        ws.on('close', () => {
            console.log(`[Terminal] WebSocket closed: ${sessionId}`);
            
            if (ptyProcess && !ptyProcess.killed) {
                ptyProcess.kill();
            }
            terminalSessions.delete(sessionId);
            
            logSecurityEvent('TERMINAL_SESSION_CLOSED', { 
                sessionId,
                user: session.username
            }, '');
        });

        // Handle WebSocket error
        ws.on('error', (err) => {
            console.error(`[Terminal] WebSocket error: ${sessionId}`, err);
            
            if (ptyProcess && !ptyProcess.killed) {
                ptyProcess.kill();
            }
            terminalSessions.delete(sessionId);
        });
    });

    console.log('[Terminal] WebSocket server initialized at /api/terminal/ws');
    return wss;
}

// Get active sessions
function getActiveSessions() {
    const sessions = [];
    for (const [id, session] of terminalSessions) {
        sessions.push({
            id,
            command: session.command,
            user: session.user,
            startTime: session.startTime,
            active: !session.process.killed
        });
    }
    return sessions;
}

// Kill a specific session
function killSession(sessionId) {
    const session = terminalSessions.get(sessionId);
    if (session) {
        if (session.process && !session.process.killed) {
            session.process.kill('SIGTERM');
        }
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.close(1000, 'Session killed by request');
        }
        terminalSessions.delete(sessionId);
        return true;
    }
    return false;
}

module.exports = {
    setupTerminalWebSocket,
    getActiveSessions,
    killSession,
    terminalSessions
};
