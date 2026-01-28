#!/bin/bash

# HomePiNAS - Universal Installer
# Compatible with: Raspberry Pi OS, Debian 11/12, Ubuntu 22.04/24.04
# Architectures: arm64, amd64
# Version: 1.8.1 (Homelabs.club Edition)

set -e

# Version - CHANGE THIS FOR EACH RELEASE
VERSION="1.8.1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Detect system
ARCH=$(dpkg --print-architecture)
DISTRO=$(lsb_release -is 2>/dev/null || echo "Unknown")
DISTRO_VERSION=$(lsb_release -rs 2>/dev/null || echo "Unknown")
DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")
IS_RASPBERRY_PI=0

# Check if running on Raspberry Pi
if [ -f /proc/device-tree/model ]; then
    MODEL=$(cat /proc/device-tree/model 2>/dev/null || echo "")
    if [[ "$MODEL" == *"Raspberry Pi"* ]]; then
        IS_RASPBERRY_PI=1
    fi
fi

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   HomePiNAS v${VERSION} Universal Installer  ${NC}"
echo -e "${BLUE}   Homelabs.club Edition                ${NC}"
echo -e "${BLUE}=========================================${NC}"
echo -e ""
echo -e "${CYAN}System detected:${NC}"
echo -e "  Distribution: ${GREEN}${DISTRO} ${DISTRO_VERSION}${NC}"
echo -e "  Architecture: ${GREEN}${ARCH}${NC}"
if [ "$IS_RASPBERRY_PI" -eq 1 ]; then
    echo -e "  Platform:     ${GREEN}Raspberry Pi${NC}"
else
    echo -e "  Platform:     ${GREEN}Generic Linux${NC}"
fi
echo -e ""

# Check for root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (use sudo)${NC}"
  exit 1
fi

# Validate architecture
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "amd64" ]; then
    echo -e "${RED}Unsupported architecture: $ARCH${NC}"
    echo -e "${YELLOW}Supported: arm64, amd64${NC}"
    exit 1
fi

# Prevent interactive prompts during apt operations
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Configure apt to not prompt for kernel updates or service restarts
mkdir -p /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/homepinas.conf <<'NREOF'
# HomePiNAS: Disable interactive restarts during installation
$nrconf{restart} = 'a';
$nrconf{kernelhints} = 0;
NREOF

TARGET_DIR="/opt/homepinas"
REPO_URL="https://github.com/juanlusoft/homepinas-v2.git"
BRANCH="ui-redesign-homelabs"
STORAGE_MOUNT_BASE="/mnt/disks"
POOL_MOUNT="/mnt/storage"
SNAPRAID_CONF="/etc/snapraid.conf"

# Raspberry Pi specific paths
FANCTL_SCRIPT="/usr/local/bin/homepinas-fanctl.sh"
FANCTL_CONF="/usr/local/bin/homepinas-fanctl.conf"
CONFIG_FILE="/boot/firmware/config.txt"

# 1. Environment Ready
echo -e "${BLUE}[1/7] Preparing environment...${NC}"

# APT options to suppress all interactive prompts
APT_OPTS="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

apt-get update || true
apt-get install -f -y $APT_OPTS

# Remove conflicting packages
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc containerd.io; do
    apt-get purge -y $pkg 2>/dev/null || true
done
apt-get autoremove -y $APT_OPTS
apt-get clean

# Install base packages
echo -e "${BLUE}Installing base packages...${NC}"
apt-get install -y $APT_OPTS git curl sudo smartmontools lm-sensors parted samba samba-common-bin build-essential python3

# Install Docker
if ! command -v docker &> /dev/null; then
    echo -e "${BLUE}Installing Docker...${NC}"
    if [ "$DISTRO" = "Ubuntu" ]; then
        # Ubuntu: Use official Docker repo
        apt-get install -y $APT_OPTS ca-certificates gnupg
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $DISTRO_CODENAME stable" > /etc/apt/sources.list.d/docker.list
        apt-get update
        apt-get install -y $APT_OPTS docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || apt-get install -y $APT_OPTS docker.io
    else
        # Debian/Raspberry Pi OS
        apt-get install -y $APT_OPTS docker.io
    fi
fi

# 2. Install SnapRAID + MergerFS
echo -e "${BLUE}[2/7] Installing SnapRAID + MergerFS...${NC}"

# Install MergerFS
if ! command -v mergerfs &> /dev/null; then
    echo -e "${BLUE}Installing MergerFS for ${ARCH}...${NC}"

    # Get latest mergerfs release
    MERGERFS_VERSION=$(curl -s https://api.github.com/repos/trapexit/mergerfs/releases/latest | grep -oP '"tag_name": "\K[^"]+')
    if [ -z "$MERGERFS_VERSION" ]; then
        MERGERFS_VERSION="2.40.2"
    fi

    # Select correct package based on architecture and distro
    case "$ARCH" in
        amd64)
            if [ "$DISTRO" = "Ubuntu" ]; then
                MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.ubuntu-${DISTRO_CODENAME}_amd64.deb"
            else
                MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.debian-${DISTRO_CODENAME}_amd64.deb"
            fi
            ;;
        arm64)
            MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.debian-${DISTRO_CODENAME}_arm64.deb"
            ;;
    esac

    echo -e "${CYAN}Downloading: ${MERGERFS_DEB}${NC}"
    curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${MERGERFS_DEB}" || {
        # Fallback: try bookworm package
        echo -e "${YELLOW}Primary download failed, trying bookworm fallback...${NC}"
        MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.debian-bookworm_${ARCH}.deb"
        curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${MERGERFS_DEB}" || {
            # Final fallback to apt
            echo -e "${YELLOW}GitHub download failed, using apt...${NC}"
            apt-get install -y $APT_OPTS mergerfs || echo -e "${YELLOW}MergerFS may need manual installation${NC}"
        }
    }

    if [ -f /tmp/mergerfs.deb ]; then
        dpkg -i /tmp/mergerfs.deb || apt-get install -f -y $APT_OPTS
        rm -f /tmp/mergerfs.deb
    fi
else
    echo -e "${GREEN}MergerFS already installed${NC}"
fi

# Install SnapRAID
if ! command -v snapraid &> /dev/null; then
    echo -e "${BLUE}Installing SnapRAID...${NC}"
    apt-get install -y $APT_OPTS snapraid || {
        # Build from source if not in repos
        echo -e "${YELLOW}Building SnapRAID from source...${NC}"
        apt-get install -y $APT_OPTS build-essential autoconf
        cd /tmp
        SNAPRAID_VERSION="12.3"
        curl -L -o snapraid.tar.gz "https://github.com/amadvance/snapraid/releases/download/v${SNAPRAID_VERSION}/snapraid-${SNAPRAID_VERSION}.tar.gz"
        tar xzf snapraid.tar.gz
        cd snapraid-${SNAPRAID_VERSION}
        ./configure
        make -j$(nproc)
        make install
        cd /tmp
        rm -rf snapraid-${SNAPRAID_VERSION} snapraid.tar.gz
    }
else
    echo -e "${GREEN}SnapRAID already installed${NC}"
fi

# Configure Samba for NAS sharing
echo -e "${BLUE}Configuring Samba...${NC}"

# Backup original smb.conf
if [ -f /etc/samba/smb.conf ] && [ ! -f /etc/samba/smb.conf.backup ]; then
    cp /etc/samba/smb.conf /etc/samba/smb.conf.backup
fi

# Create Samba configuration
cat > /etc/samba/smb.conf <<'SMBEOF'
[global]
   workgroup = WORKGROUP
   server string = HomePiNAS
   server role = standalone server
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   panic action = /usr/share/samba/panic-action %d
   obey pam restrictions = yes
   unix password sync = yes
   passwd program = /usr/bin/passwd %u
   passwd chat = *Enter\snew\s*\spassword:* %n\n *Retype\snew\s*\spassword:* %n\n *password\supdated\ssuccessfully* .
   pam password change = yes
   map to guest = bad user
   usershare allow guests = no

   # Security settings
   server min protocol = SMB2
   client min protocol = SMB2

   # Performance tuning
   socket options = TCP_NODELAY IPTOS_LOWDELAY
   read raw = yes
   write raw = yes
   use sendfile = yes
   aio read size = 16384
   aio write size = 16384

[Storage]
   comment = HomePiNAS Storage Pool
   path = /mnt/storage
   browseable = yes
   read only = no
   create mask = 0775
   directory mask = 0775
   valid users = @sambashare
   force group = sambashare
   inherit permissions = yes
SMBEOF

# Create sambashare group if it doesn't exist
getent group sambashare > /dev/null || groupadd sambashare

# Enable and start Samba services
systemctl enable smbd nmbd
systemctl restart smbd nmbd || true

echo -e "${GREEN}Samba configured${NC}"

# Create mount directories
echo -e "${BLUE}Creating storage directories...${NC}"
mkdir -p "$STORAGE_MOUNT_BASE"
mkdir -p "$POOL_MOUNT"
mkdir -p /mnt/parity1
mkdir -p /mnt/parity2

# Create disk mount points for up to 6 data disks
for i in 1 2 3 4 5 6; do
    mkdir -p "${STORAGE_MOUNT_BASE}/disk${i}"
done

# Create cache mount point for NVMe
mkdir -p "${STORAGE_MOUNT_BASE}/cache1"
mkdir -p "${STORAGE_MOUNT_BASE}/cache2"

# 3. Project Deployment
cd /tmp

if [ -d "$TARGET_DIR" ]; then
    echo -e "${BLUE}Cleaning up old installation...${NC}"
    rm -rf "$TARGET_DIR"
fi

echo -e "${BLUE}[3/7] Cloning repository (branch: $BRANCH)...${NC}"
git clone -b $BRANCH $REPO_URL $TARGET_DIR

cd $TARGET_DIR

# Update package.json version to match installer
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json

# CRITICAL CHECK: Verify structure
if [ ! -d "backend" ]; then
    echo -e "${RED}FATAL: Repository cloned but 'backend' folder is missing!${NC}"
    echo -e "Files found in $TARGET_DIR:"
    ls -R
    exit 1
fi

# 4. Node.js Check/Install
if ! command -v node &> /dev/null; then
    echo -e "${BLUE}[4/7] Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y $APT_OPTS nodejs
else
    echo -e "${BLUE}[4/7] Node.js already installed ($(node -v))${NC}"
fi

# 5. App Setup
echo -e "${BLUE}[5/7] Building application...${NC}"
npm install

# Generate self-signed SSL certificates for HTTPS
echo -e "${BLUE}Generating SSL certificates...${NC}"
mkdir -p $TARGET_DIR/backend/certs
if [ ! -f "$TARGET_DIR/backend/certs/server.key" ]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout $TARGET_DIR/backend/certs/server.key \
        -out $TARGET_DIR/backend/certs/server.crt \
        -subj "/C=ES/ST=Local/L=HomeLab/O=HomePiNAS/OU=NAS/CN=$(hostname)" \
        2>/dev/null
    echo -e "${GREEN}SSL certificates generated (valid for 10 years)${NC}"
else
    echo -e "${GREEN}SSL certificates already exist${NC}"
fi

REAL_USER=${SUDO_USER:-$USER}
chown -R $REAL_USER:$REAL_USER $TARGET_DIR
chmod -R 755 $TARGET_DIR
chmod 600 $TARGET_DIR/backend/certs/server.key

# 6. Fan Control Setup (Raspberry Pi only)
if [ "$IS_RASPBERRY_PI" -eq 1 ]; then
    echo -e "${BLUE}[6/7] Configuring Raspberry Pi Fan Control...${NC}"

    # Check and add I2C configuration
    NEEDS_REBOOT=0
    I2C_LINE="dtparam=i2c_arm=on"
    OVERLAY_LINE="dtoverlay=i2c-fan,emc2301,addr=0x2e,i2c_csi_dsi0"

    if [ -f "$CONFIG_FILE" ]; then
        if ! grep -q "^${I2C_LINE}$" "$CONFIG_FILE" 2>/dev/null; then
            echo -e "${YELLOW}Adding I2C support to config.txt...${NC}"
            echo "" >> "$CONFIG_FILE"
            echo "# HomePinas fan controller" >> "$CONFIG_FILE"
            echo "$I2C_LINE" >> "$CONFIG_FILE"
            NEEDS_REBOOT=1
        fi

        if ! grep -q "^${OVERLAY_LINE}$" "$CONFIG_FILE" 2>/dev/null; then
            echo -e "${YELLOW}Adding fan controller overlay to config.txt...${NC}"
            if ! grep -q "# HomePinas fan controller" "$CONFIG_FILE"; then
                echo "" >> "$CONFIG_FILE"
                echo "# HomePinas fan controller" >> "$CONFIG_FILE"
            fi
            echo "$OVERLAY_LINE" >> "$CONFIG_FILE"
            NEEDS_REBOOT=1
        fi
    fi

    # Create fan control script
    cat > "$FANCTL_SCRIPT" <<'FANEOF'
#!/bin/bash
# HomePiNAS Fan Control Script for EMC2305
CONFIG_FILE="/usr/local/bin/homepinas-fanctl.conf"
STATE_FILE="/tmp/homepinas-fanctl.state"

MIN_PWM1=65
MIN_PWM2=80
PWM1_T30=65
PWM1_T35=90
PWM1_T40=130
PWM1_T45=180
PWM1_TMAX=230
PWM2_T40=80
PWM2_T50=120
PWM2_T60=170
PWM2_TMAX=255
HYST_TEMP=3

if [ -f "$CONFIG_FILE" ]; then
    . "$CONFIG_FILE"
fi

LAST_PWM1=0
LAST_PWM2=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi

HWMON=""
for hw in /sys/class/hwmon/hwmon*; do
    name=$(cat "$hw/name" 2>/dev/null)
    if [ "$name" = "emc2305" ]; then
        HWMON=$hw
        break
    fi
done

if [ -z "$HWMON" ]; then
    exit 0
fi

CPU_TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)
CPU_TEMP=$((CPU_TEMP / 1000))

DISK_TEMP=0
for disk in /dev/sd[a-z] /dev/nvme[0-9]n1; do
    if [ -b "$disk" ]; then
        t=$(smartctl -A "$disk" 2>/dev/null | grep -E "^194|Temperature_Celsius" | awk '{print $10}')
        if [ -n "$t" ] && [ "$t" -gt 0 ] && [ "$t" -lt 100 ] 2>/dev/null; then
            if [ "$t" -gt "$DISK_TEMP" ]; then
                DISK_TEMP=$t
            fi
        fi
    fi
done

TEMP1=$DISK_TEMP
[ "$CPU_TEMP" -gt "$TEMP1" ] && TEMP1=$CPU_TEMP

calc_pwm1() {
    local temp=$1
    if [ "$temp" -ge 45 ]; then echo $PWM1_TMAX
    elif [ "$temp" -ge 40 ]; then echo $PWM1_T45
    elif [ "$temp" -ge 35 ]; then echo $PWM1_T40
    elif [ "$temp" -ge 30 ]; then echo $PWM1_T35
    else echo $PWM1_T30
    fi
}

calc_pwm2() {
    local temp=$1
    if [ "$temp" -ge 70 ]; then echo $PWM2_TMAX
    elif [ "$temp" -ge 60 ]; then echo $PWM2_T60
    elif [ "$temp" -ge 50 ]; then echo $PWM2_T50
    elif [ "$temp" -ge 40 ]; then echo $PWM2_T40
    else echo $MIN_PWM2
    fi
}

PWM1=$(calc_pwm1 $TEMP1)
PWM2=$(calc_pwm2 $CPU_TEMP)

[ "$PWM1" -lt "$MIN_PWM1" ] && PWM1=$MIN_PWM1
[ "$PWM2" -lt "$MIN_PWM2" ] && PWM2=$MIN_PWM2

echo $PWM1 > "$HWMON/pwm1" 2>/dev/null
echo $PWM2 > "$HWMON/pwm2" 2>/dev/null

cat > "$STATE_FILE" <<EOF
LAST_PWM1=$PWM1
LAST_PWM2=$PWM2
EOF

echo "CPU: ${CPU_TEMP}C, Disk: ${DISK_TEMP}C -> PWM1: ${PWM1}, PWM2: ${PWM2}"
FANEOF

    chmod +x "$FANCTL_SCRIPT"

    # Create default config
    if [ ! -f "$FANCTL_CONF" ]; then
        cat > "$FANCTL_CONF" <<EOF
# HomePinas Fan Control - BALANCED preset
PWM1_T30=65
PWM1_T35=90
PWM1_T40=130
PWM1_T45=180
PWM1_TMAX=230
PWM2_T40=80
PWM2_T50=120
PWM2_T60=170
PWM2_TMAX=255
MIN_PWM1=65
MIN_PWM2=80
HYST_TEMP=3
EOF
    fi

    # Create systemd service and timer for fan control
    cat > /etc/systemd/system/homepinas-fanctl.service <<EOF
[Unit]
Description=HomePinas Fan Control
After=multi-user.target

[Service]
Type=oneshot
ExecStart=$FANCTL_SCRIPT
User=root
EOF

    cat > /etc/systemd/system/homepinas-fanctl.timer <<EOF
[Unit]
Description=Run HomePinas Fan Control periodically

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
EOF

    systemctl enable homepinas-fanctl.timer
    systemctl start homepinas-fanctl.timer || true
    echo -e "${GREEN}Fan control configured${NC}"
else
    echo -e "${BLUE}[6/7] Skipping fan control (not Raspberry Pi)${NC}"
    NEEDS_REBOOT=0
fi

# 7. Permissions & Services
echo -e "${BLUE}[7/7] Configuring Systemd services...${NC}"
usermod -aG docker $REAL_USER

# Sudoers configuration
cat > /etc/sudoers.d/homepinas <<EOF
# HomePiNAS Sudoers - Universal Edition
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/reboot
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/shutdown
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/snapraid.conf
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/fstab
$REAL_USER ALL=(ALL) NOPASSWD: /bin/mount /mnt/*
$REAL_USER ALL=(ALL) NOPASSWD: /bin/mount -a
$REAL_USER ALL=(ALL) NOPASSWD: /bin/umount /mnt/*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.ext4 /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.ext4 /dev/nvme[0-9]n[0-9]p[0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.xfs /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.xfs /dev/nvme[0-9]n[0-9]p[0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid *
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/mergerfs *
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl daemon-reload
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart nmbd
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart homepinas
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/parted /dev/sd[a-z] *
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/parted /dev/nvme[0-9]n[0-9] *
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/partprobe /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/partprobe /dev/nvme[0-9]n[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/useradd -M -s /sbin/nologin [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/usermod -aG sambashare [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/smbpasswd -a -s [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/smbpasswd -e [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/pdbedit -L
$REAL_USER ALL=(ALL) NOPASSWD: /bin/chown -R *\:sambashare /mnt/storage
$REAL_USER ALL=(ALL) NOPASSWD: /bin/chmod -R 2775 /mnt/storage
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -i /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -i /dev/nvme[0-9]n[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -A /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -A /dev/nvme[0-9]n[0-9]
EOF

# Add fan control sudoers only for Raspberry Pi
if [ "$IS_RASPBERRY_PI" -eq 1 ]; then
    cat >> /etc/sudoers.d/homepinas <<EOF
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /sys/class/hwmon/hwmon[0-9]/pwm[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /sys/class/hwmon/hwmon[0-9][0-9]/pwm[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /usr/local/bin/homepinas-fanctl.conf
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart homepinas-fanctl
EOF
fi

# Create SnapRAID sync script
cat > /usr/local/bin/homepinas-snapraid-sync.sh <<'SYNCEOF'
#!/bin/bash
LOGFILE="/var/log/snapraid-sync.log"
CONF="/etc/snapraid.conf"

echo "=== SnapRAID Sync Started: $(date) ===" >> "$LOGFILE"

if [ ! -f "$CONF" ]; then
    echo "ERROR: SnapRAID not configured yet" >> "$LOGFILE"
    exit 1
fi

snapraid sync >> "$LOGFILE" 2>&1
if [ $? -eq 0 ]; then
    echo "Sync completed successfully" >> "$LOGFILE"
    snapraid scrub -p 5 -o 30 >> "$LOGFILE" 2>&1
else
    echo "ERROR: Sync failed" >> "$LOGFILE"
fi

echo "=== SnapRAID Sync Finished: $(date) ===" >> "$LOGFILE"
SYNCEOF
chmod +x /usr/local/bin/homepinas-snapraid-sync.sh

# Create SnapRAID sync timer
cat > /etc/systemd/system/homepinas-snapraid-sync.service <<EOF
[Unit]
Description=HomePiNAS SnapRAID Sync
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/homepinas-snapraid-sync.sh
User=root
EOF

cat > /etc/systemd/system/homepinas-snapraid-sync.timer <<EOF
[Unit]
Description=Run SnapRAID sync daily

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Main HomePiNAS service
WANTS_LINE=""
[ "$IS_RASPBERRY_PI" -eq 1 ] && WANTS_LINE="Wants=homepinas-fanctl.timer"

cat > /etc/systemd/system/homepinas.service <<EOF
[Unit]
Description=HomePiNAS Backend Service
After=network.target docker.service
$WANTS_LINE

[Service]
Type=simple
User=$REAL_USER
Group=$REAL_USER
WorkingDirectory=$TARGET_DIR
ExecStart=$(which node) $TARGET_DIR/backend/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Reload and enable services
systemctl daemon-reload
systemctl enable homepinas
systemctl restart homepinas
systemctl enable homepinas-snapraid-sync.timer || true

# Final output
echo -e ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}    INSTALLATION COMPLETE!              ${NC}"
echo -e "${GREEN}    HomePiNAS v${VERSION}                    ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e ""
IP_ADDR=$(hostname -I | awk '{print $1}')
echo -e "${CYAN}System:${NC} ${DISTRO} ${DISTRO_VERSION} (${ARCH})"
if [ "$IS_RASPBERRY_PI" -eq 1 ]; then
    echo -e "${CYAN}Platform:${NC} Raspberry Pi"
fi
echo -e ""
echo -e "${YELLOW}Dashboard Access:${NC}"
echo -e "  HTTPS: ${GREEN}https://${IP_ADDR}:3001${NC}"
echo -e "  HTTP:  ${BLUE}http://${IP_ADDR}:3000${NC}"
echo -e ""
echo -e "${YELLOW}Network Share (SMB):${NC}"
echo -e "  Windows: ${GREEN}\\\\\\\\${IP_ADDR}\\\\Storage${NC}"
echo -e "  Linux:   ${GREEN}smb://${IP_ADDR}/Storage${NC}"
echo -e ""
echo -e "${YELLOW}Features:${NC}"
echo -e "  - HTTPS with self-signed certificates"
echo -e "  - SnapRAID parity protection"
echo -e "  - MergerFS disk pooling"
echo -e "  - Samba network sharing"
echo -e "  - Docker container management"
if [ "$IS_RASPBERRY_PI" -eq 1 ]; then
    echo -e "  - PWM fan control with hysteresis"
fi
echo -e ""

if [ "$IS_RASPBERRY_PI" -eq 1 ] && [ "${NEEDS_REBOOT:-0}" -eq 1 ]; then
    echo -e "${RED}REBOOT REQUIRED for fan control hardware${NC}"
    echo -e "Run: ${YELLOW}sudo reboot${NC}"
    echo -e ""
fi

echo -e "Next steps:"
echo -e "1. Logout and login for Docker permissions"
echo -e "2. Access the dashboard and configure storage"
echo -e ""
echo -e "${GREEN}=========================================${NC}"
