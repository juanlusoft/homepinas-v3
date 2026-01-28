#!/bin/bash

# HomePiNAS - Premium Dashboard for Raspberry Pi CM5
# Professional One-Liner Installer
# Optimized for Raspberry Pi OS (ARM64)
# Version: 1.8.0 (Homelabs.club Edition)

set -e

# Version - CHANGE THIS FOR EACH RELEASE
VERSION="1.8.2"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   HomePiNAS v${VERSION} Secure Installer    ${NC}"
echo -e "${BLUE}   Homelabs.club Edition                ${NC}"
echo -e "${BLUE}=========================================${NC}"

# Check for root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (use sudo)${NC}"
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
FANCTL_SCRIPT="/usr/local/bin/homepinas-fanctl.sh"
FANCTL_CONF="/usr/local/bin/homepinas-fanctl.conf"
CONFIG_FILE="/boot/firmware/config.txt"
STORAGE_MOUNT_BASE="/mnt/disks"
POOL_MOUNT="/mnt/storage"
SNAPRAID_CONF="/etc/snapraid.conf"
MERGERFS_CONF="/etc/mergerfs.conf"

# 1. Environment Ready
echo -e "${BLUE}[1/7] Preparing environment...${NC}"

# APT options to suppress all interactive prompts
APT_OPTS="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

# Detect Debian version
DEBIAN_VERSION=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DEBIAN_VERSION="$VERSION_CODENAME"
fi

echo -e "${BLUE}Detected: $PRETTY_NAME${NC}"

apt-get update || true
apt-get install -f -y $APT_OPTS

# Install Docker from official repo for Trixie, or docker.io for stable releases
if [ "$DEBIAN_VERSION" = "trixie" ] || [ "$DEBIAN_VERSION" = "sid" ]; then
    echo -e "${YELLOW}Debian Trixie/Sid detected - using Docker official repository${NC}"

    # Remove conflicting packages
    for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
        apt-get purge -y $pkg 2>/dev/null || true
    done

    # Install prerequisites
    apt-get install -y $APT_OPTS ca-certificates curl gnupg

    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    # Add Docker repo (use bookworm for trixie since docker doesn't have trixie yet)
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list

    apt-get update

    # Install Docker CE
    apt-get install -y $APT_OPTS docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Install other packages (git, sensors, etc might have different names in trixie)
    apt-get install -y $APT_OPTS git curl sudo smartmontools parted samba samba-common-bin build-essential python3 || true

    # Try lm-sensors (might be lm-sensors or sensors package in trixie)
    apt-get install -y $APT_OPTS lm-sensors 2>/dev/null || apt-get install -y $APT_OPTS sensors 2>/dev/null || echo -e "${YELLOW}Warning: lm-sensors not available${NC}"

else
    # Standard Debian stable (bookworm, bullseye, etc)
    for pkg in docker.io docker-doc docker-compose podman-docker containerd runc containerd.io; do
        apt-get purge -y $pkg 2>/dev/null || true
    done
    apt-get autoremove -y $APT_OPTS
    apt-get clean
    apt-get install -y $APT_OPTS git curl sudo smartmontools lm-sensors docker.io parted samba samba-common-bin build-essential python3
fi

# 2. Install SnapRAID + MergerFS
echo -e "${BLUE}[2/7] Installing SnapRAID + MergerFS...${NC}"

# Install MergerFS
if ! command -v mergerfs &> /dev/null; then
    echo -e "${BLUE}Installing MergerFS...${NC}"
    # Get latest mergerfs release
    MERGERFS_VERSION=$(curl -s https://api.github.com/repos/trapexit/mergerfs/releases/latest | grep -oP '"tag_name": "\K[^"]+')
    if [ -z "$MERGERFS_VERSION" ]; then
        MERGERFS_VERSION="2.40.2"
    fi

    # Detect architecture
    ARCH=$(dpkg --print-architecture)
    echo -e "${BLUE}Architecture: $ARCH${NC}"

    # Determine correct package name based on distro and arch
    MERGERFS_DISTRO="debian-bookworm"
    if [ "$DEBIAN_VERSION" = "trixie" ] || [ "$DEBIAN_VERSION" = "sid" ]; then
        # Try trixie first, fall back to bookworm
        MERGERFS_DISTRO="debian-trixie"
    fi

    MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.${MERGERFS_DISTRO}_${ARCH}.deb"
    echo -e "${BLUE}Downloading MergerFS: $MERGERFS_DEB${NC}"

    curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${MERGERFS_DEB}" || {
        # If trixie package doesn't exist, try bookworm
        if [ "$MERGERFS_DISTRO" = "debian-trixie" ]; then
            echo -e "${YELLOW}Trixie package not found, trying bookworm...${NC}"
            MERGERFS_DEB="mergerfs_${MERGERFS_VERSION}.debian-bookworm_${ARCH}.deb"
            curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${MERGERFS_DEB}" || {
                # Fallback to apt if GitHub download fails
                apt-get install -y $APT_OPTS mergerfs || echo -e "${YELLOW}MergerFS installation from apt${NC}"
            }
        else
            # Fallback to apt if GitHub download fails
            apt-get install -y $APT_OPTS mergerfs || echo -e "${YELLOW}MergerFS installation from apt${NC}"
        fi
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
        apt-get install -y $APT_OPTS build-essential autoconf automake
        cd /tmp
        # Get latest snapraid version from GitHub
        SNAPRAID_VERSION=$(curl -s https://api.github.com/repos/amadvance/snapraid/releases/latest | grep -oP '"tag_name": "v\K[^"]+' || echo "12.3")
        echo -e "${BLUE}Building SnapRAID v${SNAPRAID_VERSION}...${NC}"
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
    echo -e "${BLUE}[4/7] Node.js already installed${NC}"
fi

# 5. App Setup
echo -e "${BLUE}[5/8] Building application...${NC}"
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

# 6. Fan Control Setup (for Raspberry Pi CM5 with EMC2305)
echo -e "${BLUE}[6/8] Configuring Fan Control...${NC}"

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

# Create fan control script (custom for EMC2305) with hysteresis
echo -e "${BLUE}Creating fan control script with hysteresis...${NC}"
cat > "$FANCTL_SCRIPT" <<'FANEOF'
#!/bin/bash
# HomePiNAS Fan Control Script for EMC2305
# Controls PWM fans based on CPU and disk temperatures
# Version 1.5.5: Added hysteresis to prevent fan speed oscillation

CONFIG_FILE="/usr/local/bin/homepinas-fanctl.conf"
STATE_FILE="/tmp/homepinas-fanctl.state"

# Default values (BALANCED)
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

# Hysteresis settings (degrees Celsius)
# Fan speed only decreases when temp drops below threshold minus hysteresis
HYST_TEMP=3

# Load config if exists (use . instead of source for POSIX compatibility)
if [ -f "$CONFIG_FILE" ]; then
    . "$CONFIG_FILE"
fi

# Load previous state (last PWM values and temps)
LAST_PWM1=0
LAST_PWM2=0
LAST_TEMP1=0
LAST_CPU_TEMP=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi

# Find EMC2305 hwmon path
HWMON=""
for hw in /sys/class/hwmon/hwmon*; do
    name=$(cat "$hw/name" 2>/dev/null)
    if [ "$name" = "emc2305" ]; then
        HWMON=$hw
        break
    fi
done

if [ -z "$HWMON" ]; then
    echo "EMC2305 not found"
    exit 0
fi

# Get CPU temperature (millidegrees to degrees)
CPU_TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)
CPU_TEMP=$((CPU_TEMP / 1000))

# Get max disk temperature from SMART data
DISK_TEMP=0
for disk in /dev/sd[a-z] /dev/nvme[0-9]n1; do
    if [ -b "$disk" ]; then
        # Parse SMART attribute 194 (Temperature_Celsius) - value is in column 10
        t=$(smartctl -A "$disk" 2>/dev/null | grep -E "^194|Temperature_Celsius" | awk '{print $10}')
        if [ -n "$t" ] && [ "$t" -gt 0 ] && [ "$t" -lt 100 ] 2>/dev/null; then
            if [ "$t" -gt "$DISK_TEMP" ]; then
                DISK_TEMP=$t
            fi
        fi
    fi
done

# Use higher of CPU or DISK temp for PWM1 (disk fans)
TEMP1=$DISK_TEMP
if [ "$CPU_TEMP" -gt "$TEMP1" ]; then
    TEMP1=$CPU_TEMP
fi

# Function to calculate PWM1 based on temperature
calc_pwm1() {
    local temp=$1
    if [ "$temp" -ge 45 ]; then
        echo $PWM1_TMAX
    elif [ "$temp" -ge 40 ]; then
        echo $PWM1_T45
    elif [ "$temp" -ge 35 ]; then
        echo $PWM1_T40
    elif [ "$temp" -ge 30 ]; then
        echo $PWM1_T35
    else
        echo $PWM1_T30
    fi
}

# Function to calculate PWM2 based on CPU temperature
calc_pwm2() {
    local temp=$1
    if [ "$temp" -ge 70 ]; then
        echo $PWM2_TMAX
    elif [ "$temp" -ge 60 ]; then
        echo $PWM2_T60
    elif [ "$temp" -ge 50 ]; then
        echo $PWM2_T50
    elif [ "$temp" -ge 40 ]; then
        echo $PWM2_T40
    else
        echo $MIN_PWM2
    fi
}

# Calculate target PWM values
TARGET_PWM1=$(calc_pwm1 $TEMP1)
TARGET_PWM2=$(calc_pwm2 $CPU_TEMP)

# Apply hysteresis: only allow decrease if temperature dropped significantly
# For PWM1 (disk/general fan)
if [ "$TARGET_PWM1" -lt "$LAST_PWM1" ]; then
    # Temperature is suggesting lower speed - check hysteresis
    TEMP1_WITH_HYST=$((TEMP1 + HYST_TEMP))
    HYST_PWM1=$(calc_pwm1 $TEMP1_WITH_HYST)
    if [ "$HYST_PWM1" -ge "$LAST_PWM1" ]; then
        # Temperature hasn't dropped enough, keep current speed
        TARGET_PWM1=$LAST_PWM1
    fi
fi

# For PWM2 (CPU fan)
if [ "$TARGET_PWM2" -lt "$LAST_PWM2" ]; then
    # Temperature is suggesting lower speed - check hysteresis
    CPU_TEMP_WITH_HYST=$((CPU_TEMP + HYST_TEMP))
    HYST_PWM2=$(calc_pwm2 $CPU_TEMP_WITH_HYST)
    if [ "$HYST_PWM2" -ge "$LAST_PWM2" ]; then
        # Temperature hasn't dropped enough, keep current speed
        TARGET_PWM2=$LAST_PWM2
    fi
fi

# Ensure minimum values
PWM1=$TARGET_PWM1
PWM2=$TARGET_PWM2
if [ "$PWM1" -lt "$MIN_PWM1" ]; then
    PWM1=$MIN_PWM1
fi
if [ "$PWM2" -lt "$MIN_PWM2" ]; then
    PWM2=$MIN_PWM2
fi

# Apply PWM values to hardware
echo $PWM1 > "$HWMON/pwm1" 2>/dev/null
echo $PWM2 > "$HWMON/pwm2" 2>/dev/null

# Save state for next iteration
cat > "$STATE_FILE" <<EOF
LAST_PWM1=$PWM1
LAST_PWM2=$PWM2
LAST_TEMP1=$TEMP1
LAST_CPU_TEMP=$CPU_TEMP
EOF

# Log output (with hysteresis indicator if applied)
HYST_IND1=""
HYST_IND2=""
[ "$PWM1" -eq "$LAST_PWM1" ] && [ "$TARGET_PWM1" -ne "$LAST_PWM1" ] 2>/dev/null && HYST_IND1=" [H]"
[ "$PWM2" -eq "$LAST_PWM2" ] && [ "$TARGET_PWM2" -ne "$LAST_PWM2" ] 2>/dev/null && HYST_IND2=" [H]"

echo "CPU: ${CPU_TEMP}C, Disk: ${DISK_TEMP}C -> PWM1: ${PWM1}${HYST_IND1}, PWM2: ${PWM2}${HYST_IND2}"
FANEOF

if [ -f "$FANCTL_SCRIPT" ]; then
    chmod +x "$FANCTL_SCRIPT"

    # Create default balanced config
    if [ ! -f "$FANCTL_CONF" ]; then
        cat > "$FANCTL_CONF" <<EOF
# =========================================
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
# Fans won't slow down until temperature drops 3C below threshold
HYST_TEMP=3
EOF
    fi

    # Create systemd service
    cat > /etc/systemd/system/homepinas-fanctl.service <<EOF
[Unit]
Description=HomePinas Fan Control (HDD/SSD + NVMe/CPU)
After=multi-user.target
Wants=multi-user.target

[Service]
Type=oneshot
ExecStart=$FANCTL_SCRIPT
Restart=on-failure
RestartSec=5s
User=root
Group=root
StandardOutput=journal
StandardError=journal
EOF

    # Create systemd timer (runs every 30 seconds)
    cat > /etc/systemd/system/homepinas-fanctl.timer <<EOF
[Unit]
Description=Run HomePinas Fan Control periodically

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
EOF

    echo -e "${GREEN}Fan control service configured${NC}"
fi

# 7. Permissions & Services
echo -e "${BLUE}[7/8] Configuring Systemd services...${NC}"
usermod -aG docker $REAL_USER

# Sudoers for system control, fan PWM, storage and Samba management
cat > /etc/sudoers.d/homepinas <<EOF
# HomePiNAS Sudoers - SECURITY HARDENED v1.5.2
# Only allows specific commands with restricted arguments

# System control (safe - no arguments needed)
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/reboot
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/shutdown

# Fan control (restricted to specific paths)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /sys/class/hwmon/hwmon[0-9]/pwm[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /sys/class/hwmon/hwmon[0-9][0-9]/pwm[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /usr/local/bin/homepinas-fanctl.conf
$REAL_USER ALL=(ALL) NOPASSWD: /bin/cp /tmp/homepinas-fanctl-temp.conf /usr/local/bin/homepinas-fanctl.conf
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart homepinas-fanctl

# Storage configuration (restricted to specific config files)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/snapraid.conf
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/fstab

# Mount/Umount (restricted to /mnt paths only)
$REAL_USER ALL=(ALL) NOPASSWD: /bin/mount /mnt/*
$REAL_USER ALL=(ALL) NOPASSWD: /bin/mount -a
$REAL_USER ALL=(ALL) NOPASSWD: /bin/umount /mnt/*

# Filesystem creation (restricted to /dev/sd* and /dev/nvme* only)
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.ext4 /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.ext4 /dev/nvme[0-9]n[0-9]p[0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.xfs /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/mkfs.xfs /dev/nvme[0-9]n[0-9]p[0-9]*

# SnapRAID and MergerFS
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid *
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/mergerfs *

# Systemctl (only specific services)
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl daemon-reload
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart nmbd
$REAL_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart homepinas

# Disk management (restricted to /dev/sd* and /dev/nvme*)
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/parted /dev/sd[a-z] *
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/parted /dev/nvme[0-9]n[0-9] *
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/partprobe /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/partprobe /dev/nvme[0-9]n[0-9]

# Samba user management (restricted arguments)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/useradd -M -s /sbin/nologin [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/usermod -aG sambashare [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/smbpasswd -a -s [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/smbpasswd -e [a-zA-Z]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/pdbedit -L

# File permissions (RESTRICTED to /mnt/storage only)
$REAL_USER ALL=(ALL) NOPASSWD: /bin/chown -R *\:sambashare /mnt/storage
$REAL_USER ALL=(ALL) NOPASSWD: /bin/chmod -R 2775 /mnt/storage

# SMART monitoring
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -i /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -i /dev/nvme[0-9]n[0-9]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -A /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl -A /dev/nvme[0-9]n[0-9]
EOF

# Create SnapRAID sync script
cat > /usr/local/bin/homepinas-snapraid-sync.sh <<'SYNCEOF'
#!/bin/bash
# HomePiNAS SnapRAID Sync Script
# Runs daily to sync parity

LOGFILE="/var/log/snapraid-sync.log"
CONF="/etc/snapraid.conf"

echo "=== SnapRAID Sync Started: $(date) ===" >> "$LOGFILE"

if [ ! -f "$CONF" ]; then
    echo "ERROR: SnapRAID not configured yet" >> "$LOGFILE"
    exit 1
fi

# Run sync
snapraid sync >> "$LOGFILE" 2>&1
SYNC_STATUS=$?

if [ $SYNC_STATUS -eq 0 ]; then
    echo "Sync completed successfully" >> "$LOGFILE"
    # Run scrub on 5% of data after successful sync
    snapraid scrub -p 5 -o 30 >> "$LOGFILE" 2>&1
else
    echo "ERROR: Sync failed with status $SYNC_STATUS" >> "$LOGFILE"
fi

echo "=== SnapRAID Sync Finished: $(date) ===" >> "$LOGFILE"
SYNCEOF
chmod +x /usr/local/bin/homepinas-snapraid-sync.sh

# Create SnapRAID sync timer (runs daily at 3 AM)
cat > /etc/systemd/system/homepinas-snapraid-sync.service <<EOF
[Unit]
Description=HomePiNAS SnapRAID Sync
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/homepinas-snapraid-sync.sh
User=root
Group=root
StandardOutput=journal
StandardError=journal
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
cat > /etc/systemd/system/homepinas.service <<EOF
[Unit]
Description=HomePiNAS Backend Service
After=network.target docker.service
Wants=homepinas-fanctl.timer

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

# Enable fan control timer if script exists
if [ -f "$FANCTL_SCRIPT" ]; then
    systemctl enable homepinas-fanctl.timer
    systemctl start homepinas-fanctl.timer || true
fi

# Enable snapraid sync timer (will only work after storage is configured)
systemctl enable homepinas-snapraid-sync.timer || true

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}    SECURE INSTALLATION COMPLETE!       ${NC}"
echo -e "${GREEN}      HomePiNAS v${VERSION}                  ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e ""
IP_ADDR=$(hostname -I | awk '{print $1}')
echo -e "${YELLOW}Dashboard Access:${NC}"
echo -e "  HTTPS (Recommended): ${GREEN}https://${IP_ADDR}:3001${NC}"
echo -e "  HTTP  (Fallback):    ${BLUE}http://${IP_ADDR}:3000${NC}"
echo -e ""
echo -e "${YELLOW}Note:${NC} Your browser will show a certificate warning for HTTPS."
echo -e "      This is normal for self-signed certificates. Click 'Advanced'"
echo -e "      and 'Proceed' to access the dashboard securely."
echo -e ""
echo -e "${YELLOW}Features enabled:${NC}"
echo -e "  - ${GREEN}HTTPS${NC} with self-signed certificates"
echo -e "  - Bcrypt password hashing"
echo -e "  - ${GREEN}Persistent sessions${NC} (SQLite-backed)"
echo -e "  - Rate limiting protection"
echo -e "  - Input sanitization (command injection protection)"
echo -e "  - Restricted sudoers permissions"
echo -e "  - Fan control with PWM curves and ${GREEN}hysteresis${NC}"
echo -e "  - ${GREEN}OTA updates${NC} from dashboard"
echo -e "  - ${GREEN}SnapRAID${NC} parity protection"
echo -e "  - ${GREEN}MergerFS${NC} disk pooling"
echo -e "  - ${GREEN}Samba${NC} network file sharing"
echo -e ""
echo -e "${YELLOW}Storage:${NC}"
echo -e "  - Data disks mount: ${STORAGE_MOUNT_BASE}/disk[1-6]"
echo -e "  - Parity disks mount: /mnt/parity[1-2]"
echo -e "  - Cache (NVMe) mount: ${STORAGE_MOUNT_BASE}/cache[1-2]"
echo -e "  - Merged pool: ${POOL_MOUNT}"
echo -e "  - SnapRAID sync: Daily at 3:00 AM"
echo -e ""
echo -e "${YELLOW}Network Share (SMB):${NC}"
echo -e "  - Share name: ${GREEN}Storage${NC}"
echo -e "  - Path: ${POOL_MOUNT}"
echo -e "  - Access: \\\\\\\\$(hostname -I | awk '{print \$1}')\\\\Storage"
echo -e "  - User/Pass: Same as dashboard credentials"
echo -e ""
echo -e "${YELLOW}Fan control modes:${NC}"
echo -e "  - Silent: Quiet operation"
echo -e "  - Balanced: Default (recommended)"
echo -e "  - Performance: Maximum cooling"
echo -e ""

if [ "$NEEDS_REBOOT" -eq 1 ]; then
    echo -e "${RED}=========================================${NC}"
    echo -e "${RED}    REBOOT REQUIRED FOR FAN CONTROL     ${NC}"
    echo -e "${RED}=========================================${NC}"
    echo -e ""
    echo -e "${YELLOW}I2C configuration was added to config.txt${NC}"
    echo -e "${YELLOW}Please reboot to enable fan controller:${NC}"
    echo -e "  sudo reboot"
    echo -e ""
fi

echo -e "Next steps:"
echo -e "1. Logout and Login again for Docker permissions"
if [ "$NEEDS_REBOOT" -eq 1 ]; then
    echo -e "2. ${RED}REBOOT${NC} to enable fan controller hardware"
    echo -e "3. Access the dashboard and configure your storage pool"
else
    echo -e "2. Access the dashboard and configure your storage pool"
fi
echo -e ""
echo -e "${BLUE}Logs:${NC}"
echo -e "  Fan control: journalctl -u homepinas-fanctl -f"
echo -e "  SnapRAID:    tail -f /var/log/snapraid-sync.log"
echo -e "${GREEN}=========================================${NC}"
