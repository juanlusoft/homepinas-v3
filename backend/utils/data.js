/**
 * HomePiNAS - Data Storage Utilities
 * v1.5.6 - Modular Architecture
 *
 * JSON file-based configuration storage
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'config', 'data.json');

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
            
        ]
    }
};

/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
    const configDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
}

/**
 * Read data from JSON file
 */
function getData() {
    try {
        ensureConfigDir();
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialState, null, 2));
        }
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error('Error reading data file:', e.message);
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialState, null, 2));
        return initialState;
    }
}

/**
 * Save data to JSON file
 */
function saveData(data) {
    try {
        ensureConfigDir();
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error saving data file:', e.message);
        throw new Error('Failed to save configuration');
    }
}

module.exports = {
    getData,
    saveData,
    DATA_FILE,
    initialState
};
