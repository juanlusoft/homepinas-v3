/**
 * HomePiNAS - System Routes
 * v1.5.6 - Modular Architecture
 *
 * System monitoring: stats, fans, disks
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const si = require('systeminformation');
const { exec, execSync } = require('child_process');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const { getData } = require('../utils/data');

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

// System Hardware Telemetry
router.get('/stats', async (req, res) => {
    try {
        const [cpu, cpuInfo, mem, temp, osInfo, graphics] = await Promise.all([
            si.currentLoad(),
            si.cpu(),
            si.mem(),
            si.cpuTemperature(),
            si.osInfo(),
            si.graphics()
        ]);

        // Try to get fan speeds
        let fans = [];
        try {
            const fanData = await new Promise((resolve) => {
                const cmd = `
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
            fans = [];
        }

        const coreTemps = temp.cores && temp.cores.length > 0
            ? temp.cores.map((t, i) => ({ core: i, temp: Math.round(t) }))
            : [];

        const coreLoads = cpu.cpus
            ? cpu.cpus.map((c, i) => ({ core: i, load: Math.round(c.load) }))
            : [];

        res.json({
            cpuModel: cpuInfo.manufacturer + ' ' + cpuInfo.brand,
            cpuCores: cpuInfo.cores,
            cpuPhysicalCores: cpuInfo.physicalCores,
            cpuSpeed: cpuInfo.speed,
            cpuSpeedMax: cpuInfo.speedMax,
            cpuLoad: Math.round(cpu.currentLoad),
            coreLoads,
            cpuTemp: Math.round(temp.main || 0),
            cpuTempMax: Math.round(temp.max || 0),
            coreTemps,
            gpuTemp: graphics.controllers && graphics.controllers[0]
                ? Math.round(graphics.controllers[0].temperatureGpu || 0)
                : null,
            ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(1),
            ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(1),
            ramFree: (mem.free / 1024 / 1024 / 1024).toFixed(1),
            ramUsedPercent: Math.round((mem.active / mem.total) * 100),
            swapUsed: (mem.swapused / 1024 / 1024 / 1024).toFixed(1),
            swapTotal: (mem.swaptotal / 1024 / 1024 / 1024).toFixed(1),
            fans,
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

// Fan control endpoint
router.post('/fan', requireAuth, (req, res) => {
    const { fanId, speed } = req.body;

    if (typeof speed !== 'number' || speed < 0 || speed > 100) {
        return res.status(400).json({ error: 'Invalid fan speed (0-100)' });
    }

    const pwmValue = Math.round((speed / 100) * 255);
    const fanNum = fanId || 1;

    try {
        const cmd = `
            for hwmon in /sys/class/hwmon/hwmon*; do
                if [ -f "$hwmon/pwm${fanNum}" ]; then
                    echo ${pwmValue} | sudo tee "$hwmon/pwm${fanNum}" > /dev/null 2>&1
                    echo "success"
                    exit 0
                fi
            done
            if [ -f /sys/devices/platform/cooling_fan/hwmon/hwmon*/pwm1 ]; then
                echo ${pwmValue} | sudo tee /sys/devices/platform/cooling_fan/hwmon/hwmon*/pwm1 > /dev/null 2>&1
                echo "success"
                exit 0
            fi
            if [ -d /sys/class/thermal/cooling_device0 ]; then
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

// Get current fan mode
router.get('/fan/mode', (req, res) => {
    try {
        let currentMode = 'balanced';
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
router.post('/fan/mode', requireAuth, (req, res) => {
    const { mode } = req.body;

    if (!mode || !FAN_PRESETS[mode]) {
        return res.status(400).json({ error: 'Invalid mode. Must be: silent, balanced, or performance' });
    }

    try {
        const preset = FAN_PRESETS[mode];
        const tempFile = '/tmp/homepinas-fanctl-temp.conf';
        fs.writeFileSync(tempFile, preset, 'utf8');

        execSync(`sudo cp ${tempFile} ${FANCTL_CONF} && sudo chmod 644 ${FANCTL_CONF}`, { shell: '/bin/bash' });
        fs.unlinkSync(tempFile);

        try {
            execSync('sudo systemctl restart homepinas-fanctl 2>/dev/null || true', { shell: '/bin/bash' });
        } catch (e) {}

        logSecurityEvent('FAN_MODE_CHANGE', { mode, user: req.user.username }, req.ip);
        res.json({ success: true, message: `Fan mode set to ${mode}`, mode });
    } catch (e) {
        console.error('Fan mode set error:', e);
        res.status(500).json({ error: 'Failed to set fan mode' });
    }
});

// Real Disk Detection & SMART
router.get('/disks', async (req, res) => {
    try {
        const blockDevices = await si.blockDevices();
        const diskLayout = await si.diskLayout();

        const disks = blockDevices
            .filter(dev => {
                if (dev.type !== 'disk') return false;
                // Exclude virtual/system devices
                if (dev.name && dev.name.startsWith('mmcblk')) return false;  // SD card
                if (dev.name && dev.name.startsWith('zram')) return false;    // Compressed RAM swap
                if (dev.name && dev.name.startsWith('loop')) return false;    // Loop devices
                if (dev.name && dev.name.startsWith('ram')) return false;     // RAM disks
                if (dev.name && dev.name.startsWith('dm-')) return false;     // Device mapper
                const sizeGB = dev.size / 1024 / 1024 / 1024;
                if (sizeGB < 1) return false;
                return true;
            })
            .map(dev => {
                const layoutInfo = diskLayout.find(d => d.device === dev.device) || {};
                const sizeGB = (dev.size / 1024 / 1024 / 1024).toFixed(0);

                let diskType = 'HDD';
                let temp = null;
                let serial = layoutInfo.serial || null;
                let model = layoutInfo.model || layoutInfo.name || null;
                
                // Use smartctl to get accurate model, serial, temp and detect NVMe via USB
                try {
                    const smartOutput = execSync(`sudo smartctl -i -A /dev/${dev.name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });

                    // Get model from smartctl (more reliable than lsblk for USB-connected drives)
                    const modelMatch = smartOutput.match(/Model Number:\s*(.+)/i) || 
                                      smartOutput.match(/Device Model:\s*(.+)/i) ||
                                      smartOutput.match(/Product:\s*(.+)/i);
                    if (modelMatch) {
                        model = modelMatch[1].trim();
                    }
                    
                    // Detect NVMe from model name (for USB-connected NVMe drives)
                    if (model && model.toLowerCase().includes('nvme')) {
                        diskType = 'NVMe';
                    }

                    const tempMatch = smartOutput.match(/Temperature.*?(\d+)\s*(Celsius|C)/i) ||
                                     smartOutput.match(/194\s+Temperature.*?\s(\d+)(\s|$)/);
                    if (tempMatch) {
                        const tempVal = parseInt(tempMatch[1]);
                        if (!isNaN(tempVal) && tempVal > 0 && tempVal < 100) {
                            temp = tempVal;
                        }
                    }

                    if (!serial || serial === 'N/A') {
                        const serialMatch = smartOutput.match(/Serial [Nn]umber:\s*(\S+)/);
                        if (serialMatch) {
                            serial = serialMatch[1];
                        }
                    }
                } catch (e) {}
                
                // Fallback disk type detection if not already detected as NVMe
                if (diskType === 'HDD') {
                    if (layoutInfo.interfaceType === 'NVMe' || dev.name.includes('nvme')) {
                        diskType = 'NVMe';
                    } else if ((layoutInfo.type || '').includes('SSD') || (model || '').toLowerCase().includes('ssd')) {
                        diskType = 'SSD';
                    }
                }

                return {
                    id: dev.name,
                    device: dev.device,
                    type: diskType,
                    size: sizeGB + 'GB',
                    model: model || 'Unknown Drive',
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

// System Status
router.get('/status', async (req, res) => {
    const data = getData();
    res.json({
        user: data.user ? { username: data.user.username } : null,
        storageConfig: data.storageConfig,
        poolConfigured: data.poolConfigured || false,
        network: data.network
    });
});

module.exports = router;
