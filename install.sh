#!/bin/bash

# HomePiNAS - Premium Dashboard for Raspberry Pi / Debian / Ubuntu
# Universal Installer with automatic OS detection
# Version: 2.0.0 (Homelabs.club Edition)

set -e

# Version - CHANGE THIS FOR EACH RELEASE
VERSION="3.0.2"

# Storage backend (will be set by user selection)
STORAGE_BACKEND=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   HomePiNAS v${VERSION} Universal Installer  ${NC}"
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
REPO_URL="https://github.com/juanlusoft/homepinas-v3.git"
BRANCH="main"
FANCTL_SCRIPT="/usr/local/bin/homepinas-fanctl.sh"
FANCTL_CONF="/usr/local/bin/homepinas-fanctl.conf"
CONFIG_FILE="/boot/firmware/config.txt"
STORAGE_MOUNT_BASE="/mnt/disks"
POOL_MOUNT="/mnt/storage"
SNAPRAID_CONF="/etc/snapraid.conf"
MERGERFS_CONF="/etc/mergerfs.conf"

# APT options to suppress all interactive prompts
APT_OPTS="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

#######################################
# PHASE 1: OS DETECTION
#######################################
echo -e "${BLUE}[1/7] Detecting operating system...${NC}"

# Initialize detection variables
OS_ID=""
OS_VER=""
OS_CODENAME=""
OS_PRETTY=""
ARCH=""
IS_RASPBERRY_PI=false
IS_TESTING=false

# Detect architecture
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$ARCH" in
    aarch64) ARCH="arm64" ;;
    x86_64)  ARCH="amd64" ;;
esac

# Detect if running on Raspberry Pi
if [ -f /proc/device-tree/model ]; then
    if grep -qi "raspberry" /proc/device-tree/model 2>/dev/null; then
        IS_RASPBERRY_PI=true
    fi
fi

# Read OS information
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VER="$VERSION_ID"
    OS_CODENAME="$VERSION_CODENAME"
    OS_PRETTY="$PRETTY_NAME"
fi

# Detect if this is a testing/unstable release
case "$OS_CODENAME" in
    trixie|sid|testing|unstable|devel)
        IS_TESTING=true
        ;;
esac

# Display detected information
echo -e "${CYAN}┌─────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│ System Detection Results                │${NC}"
echo -e "${CYAN}├─────────────────────────────────────────┤${NC}"
echo -e "${CYAN}│${NC} OS:          ${GREEN}$OS_PRETTY${NC}"
echo -e "${CYAN}│${NC} ID:          ${GREEN}$OS_ID${NC}"
echo -e "${CYAN}│${NC} Codename:    ${GREEN}$OS_CODENAME${NC}"
echo -e "${CYAN}│${NC} Architecture:${GREEN}$ARCH${NC}"
echo -e "${CYAN}│${NC} Raspberry Pi:${GREEN}$IS_RASPBERRY_PI${NC}"
echo -e "${CYAN}│${NC} Testing/Dev: ${GREEN}$IS_TESTING${NC}"
echo -e "${CYAN}└─────────────────────────────────────────┘${NC}"

#######################################
# PHASE 1.5: STORAGE BACKEND SELECTION
#######################################
echo -e ""
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   Select Storage Backend               ${NC}"
echo -e "${BLUE}=========================================${NC}"
echo -e ""
echo -e "${CYAN}┌─────────────────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│ Option 1: SnapRAID + MergerFS (Recommended for beginners)  │${NC}"
echo -e "${CYAN}├─────────────────────────────────────────────────────────────┤${NC}"
echo -e "${CYAN}│${NC} - Userspace solution (no kernel driver)                     ${NC}"
echo -e "${CYAN}│${NC} - Scheduled parity sync (daily at 3 AM)                     ${NC}"
echo -e "${CYAN}│${NC} - Unified pool at /mnt/storage (MergerFS)                   ${NC}"
echo -e "${CYAN}│${NC} - Supports cache disk for faster writes                     ${NC}"
echo -e "${CYAN}│${NC} - Works on all kernels                                      ${NC}"
echo -e "${CYAN}└─────────────────────────────────────────────────────────────┘${NC}"
echo -e ""
echo -e "${CYAN}┌─────────────────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│ Option 2: NonRAID (Advanced - Real-time parity)            │${NC}"
echo -e "${CYAN}├─────────────────────────────────────────────────────────────┤${NC}"
echo -e "${CYAN}│${NC} - Kernel driver (like unRAID)                               ${NC}"
echo -e "${CYAN}│${NC} - Real-time parity (no scheduled syncs)                     ${NC}"
echo -e "${CYAN}│${NC} - Individual disk mounts at /mnt/disk[N]                    ${NC}"
echo -e "${CYAN}│${NC} - No cache disk support                                     ${NC}"
echo -e "${CYAN}│${NC} - ${YELLOW}NOT compatible with kernel 6.9 or 6.10${NC}                    ${NC}"
echo -e "${CYAN}└─────────────────────────────────────────────────────────────┘${NC}"
echo -e ""

# Check kernel compatibility for NonRAID
KERNEL_VERSION=$(uname -r | cut -d. -f1,2)
KERNEL_MAJOR=$(echo $KERNEL_VERSION | cut -d. -f1)
KERNEL_MINOR=$(echo $KERNEL_VERSION | cut -d. -f2)
NONRAID_COMPATIBLE=true

if [ "$KERNEL_MAJOR" -eq 6 ] && [ "$KERNEL_MINOR" -ge 9 ] && [ "$KERNEL_MINOR" -le 10 ]; then
    NONRAID_COMPATIBLE=false
    echo -e "${RED}WARNING: Your kernel $(uname -r) is NOT compatible with NonRAID${NC}"
    echo -e "${YELLOW}NonRAID option will be disabled.${NC}"
    echo -e ""
fi

while true; do
    echo -e "${YELLOW}Select storage backend:${NC}"
    if [ "$NONRAID_COMPATIBLE" = true ]; then
        echo -e "  ${GREEN}1${NC}) SnapRAID + MergerFS"
        echo -e "  ${GREEN}2${NC}) NonRAID"
        read -p "Enter choice [1-2]: " storage_choice
    else
        echo -e "  ${GREEN}1${NC}) SnapRAID + MergerFS"
        echo -e "  ${RED}2${NC}) NonRAID (unavailable - kernel incompatible)"
        read -p "Enter choice [1]: " storage_choice
        storage_choice=${storage_choice:-1}
    fi

    case $storage_choice in
        1)
            STORAGE_BACKEND="snapraid"
            echo -e "${GREEN}Selected: SnapRAID + MergerFS${NC}"
            break
            ;;
        2)
            if [ "$NONRAID_COMPATIBLE" = true ]; then
                STORAGE_BACKEND="nonraid"
                echo -e "${GREEN}Selected: NonRAID${NC}"
                break
            else
                echo -e "${RED}NonRAID is not available on your kernel. Please select option 1.${NC}"
            fi
            ;;
        *)
            echo -e "${RED}Invalid choice. Please enter 1 or 2.${NC}"
            ;;
    esac
done

# Save storage backend choice for the application (secure temp file)
TEMP_STORAGE_FILE=$(mktemp /tmp/homepinas-storage-XXXXXX)
chmod 600 "$TEMP_STORAGE_FILE"
echo "STORAGE_BACKEND=$STORAGE_BACKEND" > "$TEMP_STORAGE_FILE"

echo -e ""

#######################################
# PHASE 2: REPOSITORY CONFIGURATION
#######################################
echo -e "${BLUE}[2/7] Configuring repositories...${NC}"

# Clean up any problematic repository files
echo -e "${BLUE}Cleaning old repository configurations...${NC}"
rm -f /etc/apt/sources.list.d/docker.list 2>/dev/null || true
rm -f /etc/apt/keyrings/docker.asc 2>/dev/null || true

# Temporarily disable any third-party repos that might cause issues
for f in /etc/apt/sources.list.d/*.list; do
    if [ -f "$f" ] && [ "$f" != "/etc/apt/sources.list.d/raspi.list" ]; then
        echo -e "${YELLOW}Temporarily disabling: $f${NC}"
        mv "$f" "${f}.disabled" 2>/dev/null || true
    fi
done

# Function to ensure repositories are properly configured
configure_repositories() {
    local sources_file="/etc/apt/sources.list"
    local sources_dir="/etc/apt/sources.list.d"
    local need_update=false

    echo -e "${BLUE}Checking repository configuration...${NC}"

    # First, clean apt cache to ensure fresh data
    apt-get clean
    rm -rf /var/lib/apt/lists/*

    # Quick update to test repos
    apt-get update -qq 2>/dev/null || true

    # Check if essential packages are actually installable (not just in cache)
    if ! apt-get install --dry-run git &>/dev/null; then
        echo -e "${YELLOW}Essential packages not available - fixing repositories...${NC}"
        echo -e "${YELLOW}Current sources.list before fix:${NC}"
        cat "$sources_file" 2>/dev/null || echo "(empty or missing)"
        echo -e ""
        need_update=true

        # Backup current sources.list
        cp "$sources_file" "${sources_file}.backup.$(date +%Y%m%d)" 2>/dev/null || true

        # Create proper sources.list based on detected OS
        case "$OS_CODENAME" in
            trixie|sid)
                echo -e "${BLUE}Configuring Debian Trixie repositories...${NC}"
                cat > "$sources_file" <<EOF
# Debian Trixie (Testing) - Configured by HomePiNAS
deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware
deb-src http://deb.debian.org/debian trixie main contrib non-free non-free-firmware

deb http://deb.debian.org/debian trixie-updates main contrib non-free non-free-firmware
deb-src http://deb.debian.org/debian trixie-updates main contrib non-free non-free-firmware

deb http://deb.debian.org/debian-security trixie-security main contrib non-free-firmware
deb-src http://deb.debian.org/debian-security trixie-security main contrib non-free-firmware
EOF
                ;;
            bookworm)
                echo -e "${BLUE}Configuring Debian Bookworm repositories...${NC}"
                cat > "$sources_file" <<EOF
# Debian Bookworm (Stable) - Configured by HomePiNAS
deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware
deb-src http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware

deb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware
deb-src http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware

deb http://deb.debian.org/debian-security bookworm-security main contrib non-free-firmware
deb-src http://deb.debian.org/debian-security bookworm-security main contrib non-free-firmware
EOF
                ;;
            bullseye)
                echo -e "${BLUE}Configuring Debian Bullseye repositories...${NC}"
                cat > "$sources_file" <<EOF
# Debian Bullseye (Oldstable) - Configured by HomePiNAS
deb http://deb.debian.org/debian bullseye main contrib non-free
deb-src http://deb.debian.org/debian bullseye main contrib non-free

deb http://deb.debian.org/debian bullseye-updates main contrib non-free
deb-src http://deb.debian.org/debian bullseye-updates main contrib non-free

deb http://deb.debian.org/debian-security bullseye-security main contrib non-free
deb-src http://deb.debian.org/debian-security bullseye-security main contrib non-free
EOF
                ;;
            *)
                # For Ubuntu or unknown
                if [ "$OS_ID" = "ubuntu" ]; then
                    echo -e "${BLUE}Ubuntu detected, using default repos${NC}"
                else
                    echo -e "${YELLOW}Unknown OS codename: $OS_CODENAME${NC}"
                fi
                ;;
        esac

        # Keep Raspberry Pi repos if they exist
        if [ "$IS_RASPBERRY_PI" = true ]; then
            if ! grep -q "archive.raspberrypi" "$sources_file" 2>/dev/null; then
                echo "" >> "$sources_file"
                echo "# Raspberry Pi Archive" >> "$sources_file"
                echo "deb http://archive.raspberrypi.com/debian $OS_CODENAME main" >> "$sources_file"
            fi
        fi
    fi

    # For Ubuntu, ensure universe is enabled
    if [ "$OS_ID" = "ubuntu" ]; then
        add-apt-repository -y universe 2>/dev/null || true
        need_update=true
    fi

    # Return whether update is needed
    if [ "$need_update" = true ]; then
        return 0
    else
        return 1
    fi
}

# Configure repositories
if configure_repositories; then
    echo -e "${BLUE}Repositories were updated, refreshing package lists...${NC}"
fi

# Update package lists
echo -e "${BLUE}Updating package lists...${NC}"
apt-get update

# Verify packages are now available
echo -e "${BLUE}Verifying package availability...${NC}"
if ! apt-get install --dry-run git &>/dev/null; then
    echo -e "${RED}=========================================${NC}"
    echo -e "${RED}ERROR: Package repositories not working!${NC}"
    echo -e "${RED}=========================================${NC}"
    echo -e "${YELLOW}Git package is not installable.${NC}"
    echo -e "${YELLOW}Current sources.list:${NC}"
    echo -e "${CYAN}---${NC}"
    cat /etc/apt/sources.list
    echo -e "${CYAN}---${NC}"
    echo -e ""
    echo -e "${YELLOW}Please verify your internet connection and try:${NC}"
    echo -e "  sudo apt-get update"
    echo -e "  sudo apt-get install git"
    echo -e ""
    exit 1
fi
echo -e "${GREEN}✓ Repository configuration verified${NC}"

#######################################
# PHASE 3: INSTALL PACKAGES
#######################################
echo -e "${BLUE}[3/7] Installing required packages...${NC}"

# Define packages based on OS
declare -a BASE_PACKAGES
declare -a DOCKER_PACKAGES

# Common packages for all systems
BASE_PACKAGES=(
    "curl"
    "ca-certificates"
    "gnupg"
    "sudo"
    "parted"
    "python3"
)

# Packages that might have different names
install_package_safe() {
    local pkg="$1"
    local alt="$2"

    if apt-get install -y $APT_OPTS "$pkg" 2>/dev/null; then
        echo -e "${GREEN}✓ $pkg${NC}"
        return 0
    elif [ -n "$alt" ] && apt-get install -y $APT_OPTS "$alt" 2>/dev/null; then
        echo -e "${GREEN}✓ $alt (alternative)${NC}"
        return 0
    else
        echo -e "${YELLOW}✗ $pkg not available${NC}"
        return 1
    fi
}

# Install base packages
echo -e "${BLUE}Installing base packages...${NC}"
for pkg in "${BASE_PACKAGES[@]}"; do
    install_package_safe "$pkg"
done

# Install packages with possible alternatives
echo -e "${BLUE}Installing system packages...${NC}"
install_package_safe "git" ""
install_package_safe "build-essential" "base-devel"
install_package_safe "smartmontools" ""
install_package_safe "lm-sensors" "sensors"
install_package_safe "pigz" ""
install_package_safe "samba" ""
install_package_safe "samba-common-bin" ""

# Install Docker based on OS type
echo -e "${BLUE}Installing Docker...${NC}"

install_docker() {
    # Check if already installed
    if command -v docker &> /dev/null; then
        echo -e "${GREEN}Docker already installed${NC}"
        return 0
    fi

    # For testing releases (Trixie, Sid), use convenience script
    if [ "$IS_TESTING" = true ]; then
        echo -e "${YELLOW}Testing release detected - using Docker convenience script${NC}"
        curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
        if sh /tmp/get-docker.sh; then
            echo -e "${GREEN}Docker installed successfully${NC}"
            rm -f /tmp/get-docker.sh
            return 0
        else
            echo -e "${YELLOW}Docker installation failed (common on testing releases)${NC}"
            echo -e "${YELLOW}You can try installing manually later${NC}"
            rm -f /tmp/get-docker.sh
            return 1
        fi
    fi

    # For stable releases, try docker.io first
    if apt-get install -y $APT_OPTS docker.io 2>/dev/null; then
        echo -e "${GREEN}Docker installed from system repos${NC}"
        return 0
    fi

    # Fallback to Docker official repo
    echo -e "${YELLOW}Trying Docker official repository...${NC}"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$OS_ID/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null || \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    # Determine repo codename (use stable codename for testing)
    local docker_codename="$OS_CODENAME"
    case "$OS_CODENAME" in
        trixie|sid) docker_codename="bookworm" ;;
    esac

    local docker_url="https://download.docker.com/linux/$OS_ID"
    if [ "$OS_ID" = "raspbian" ]; then
        docker_url="https://download.docker.com/linux/debian"
    fi

    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] $docker_url $docker_codename stable" > /etc/apt/sources.list.d/docker.list

    apt-get update
    if apt-get install -y $APT_OPTS docker-ce docker-ce-cli containerd.io 2>/dev/null; then
        echo -e "${GREEN}Docker installed from official repo${NC}"
        return 0
    fi

    echo -e "${RED}Docker installation failed${NC}"
    return 1
}

install_docker || echo -e "${YELLOW}Continuing without Docker...${NC}"

# Fix any broken packages
apt-get install -f -y $APT_OPTS 2>/dev/null || true

#######################################
# PHASE 4: INSTALL STORAGE BACKEND
#######################################
echo -e "${BLUE}[4/7] Installing storage backend ($STORAGE_BACKEND)...${NC}"

if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    echo -e "${BLUE}Installing SnapRAID + MergerFS...${NC}"

# Install MergerFS
install_mergerfs() {
    if command -v mergerfs &> /dev/null; then
        echo -e "${GREEN}MergerFS already installed${NC}"
        return 0
    fi

    echo -e "${BLUE}Installing MergerFS...${NC}"

    # Get latest mergerfs release
    MERGERFS_VERSION=$(curl -s https://api.github.com/repos/trapexit/mergerfs/releases/latest | grep -oP '"tag_name": "\K[^"]+' || echo "2.40.2")

    # Determine correct package name based on distro
    local mergerfs_distro="debian-bookworm"
    case "$OS_CODENAME" in
        trixie|sid) mergerfs_distro="debian-trixie" ;;
        bookworm)   mergerfs_distro="debian-bookworm" ;;
        bullseye)   mergerfs_distro="debian-bullseye" ;;
        jammy|noble) mergerfs_distro="ubuntu-jammy" ;;
        focal)      mergerfs_distro="ubuntu-focal" ;;
    esac

    local mergerfs_deb="mergerfs_${MERGERFS_VERSION}.${mergerfs_distro}_${ARCH}.deb"
    echo -e "${BLUE}Downloading: $mergerfs_deb${NC}"

    if curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${mergerfs_deb}" 2>/dev/null; then
        dpkg -i /tmp/mergerfs.deb || apt-get install -f -y $APT_OPTS
        rm -f /tmp/mergerfs.deb
        echo -e "${GREEN}MergerFS installed${NC}"
    else
        # Try bookworm as fallback
        echo -e "${YELLOW}Trying bookworm package as fallback...${NC}"
        mergerfs_deb="mergerfs_${MERGERFS_VERSION}.debian-bookworm_${ARCH}.deb"
        if curl -L -o /tmp/mergerfs.deb "https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VERSION}/${mergerfs_deb}" 2>/dev/null; then
            dpkg -i /tmp/mergerfs.deb || apt-get install -f -y $APT_OPTS
            rm -f /tmp/mergerfs.deb
            echo -e "${GREEN}MergerFS installed${NC}"
        else
            # Last resort: apt
            apt-get install -y $APT_OPTS mergerfs || echo -e "${RED}MergerFS installation failed${NC}"
        fi
    fi
}

install_mergerfs

# Install SnapRAID
install_snapraid() {
    if command -v snapraid &> /dev/null; then
        echo -e "${GREEN}SnapRAID already installed${NC}"
        return 0
    fi

    echo -e "${BLUE}Installing SnapRAID...${NC}"

    # Try apt first
    if apt-get install -y $APT_OPTS snapraid 2>/dev/null; then
        echo -e "${GREEN}SnapRAID installed from repos${NC}"
        return 0
    fi

    # Build from source
    echo -e "${YELLOW}Building SnapRAID from source...${NC}"

    # Get version
    local snapraid_version=$(curl -s https://api.github.com/repos/amadvance/snapraid/releases/latest | grep -oP '"tag_name": "v\K[^"]+' || echo "12.3")
    echo -e "${BLUE}Building SnapRAID v${snapraid_version}...${NC}"

    cd /tmp
    curl -L -o snapraid.tar.gz "https://github.com/amadvance/snapraid/releases/download/v${snapraid_version}/snapraid-${snapraid_version}.tar.gz"
    tar xzf snapraid.tar.gz
    cd "snapraid-${snapraid_version}"

    # Configure and build (releases include pre-generated configure)
    if [ -f configure ]; then
        ./configure
        make -j$(nproc)
        make install
        echo -e "${GREEN}SnapRAID installed${NC}"
    else
        echo -e "${RED}SnapRAID build failed${NC}"
    fi

    cd /tmp
    rm -rf "snapraid-${snapraid_version}" snapraid.tar.gz
}

install_snapraid

fi  # End SnapRAID section

# NonRAID Installation
if [ "$STORAGE_BACKEND" = "nonraid" ]; then
    echo -e "${BLUE}Installing NonRAID...${NC}"

    # Install dependencies
    apt-get install -y $APT_OPTS linux-headers-$(uname -r) dkms gdisk xfsprogs

    # Add NonRAID PPA and install
    echo -e "${BLUE}Adding NonRAID repository...${NC}"
    curl -fsSL https://qvr.github.io/nonraid/KEY.gpg | gpg --dearmor -o /usr/share/keyrings/nonraid-archive-keyring.gpg 2>/dev/null || true
    echo "deb [signed-by=/usr/share/keyrings/nonraid-archive-keyring.gpg] https://qvr.github.io/nonraid/apt stable main" > /etc/apt/sources.list.d/nonraid.list

    apt-get update -qq
    if apt-get install -y $APT_OPTS nonraid-dkms nonraid-tools 2>/dev/null; then
        echo -e "${GREEN}NonRAID installed from repository${NC}"
    else
        echo -e "${YELLOW}Repository install failed, building from source...${NC}"
        cd /tmp
        git clone https://github.com/qvr/nonraid.git
        cd nonraid
        make && make install
        cd /tmp
        rm -rf nonraid
    fi

    # Verify installation
    if command -v nmdctl &> /dev/null; then
        echo -e "${GREEN}NonRAID installed successfully${NC}"
    else
        echo -e "${RED}NonRAID installation failed${NC}"
    fi
fi  # End NonRAID section

#######################################
# PHASE 5: CONFIGURE SAMBA
#######################################
echo -e "${BLUE}[5/7] Configuring Samba...${NC}"

# Only configure Samba if it's installed
if command -v smbd &> /dev/null; then
    echo -e "${BLUE}Setting up Samba file sharing...${NC}"
    # Create /etc/samba directory if it doesn't exist
    mkdir -p /etc/samba

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
else
    echo -e "${YELLOW}Skipping Samba configuration (not installed)${NC}"
    # Still create sambashare group for later use
    getent group sambashare > /dev/null || groupadd sambashare
fi

# Create mount directories based on storage backend
echo -e "${BLUE}Creating storage directories...${NC}"

if [ "$STORAGE_BACKEND" = "snapraid" ]; then
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
else
    # NonRAID: simpler structure
    for i in 1 2 3 4 5 6; do
        mkdir -p "/mnt/disk${i}"
    done
fi

#######################################
# PHASE 6: DEPLOY APPLICATION
#######################################
echo -e "${BLUE}[6/7] Deploying HomePiNAS application...${NC}"

cd /tmp

if [ -d "$TARGET_DIR" ]; then
    echo -e "${BLUE}Cleaning up old installation...${NC}"
    rm -rf "$TARGET_DIR"
fi

# Check if git is available
if ! command -v git &> /dev/null; then
    echo -e "${RED}Git is not installed. Cannot clone repository.${NC}"
    exit 1
fi

echo -e "${BLUE}Cloning repository (branch: $BRANCH)...${NC}"
git clone -b $BRANCH $REPO_URL $TARGET_DIR

cd $TARGET_DIR

# Update package.json version to match installer
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json 2>/dev/null || true

# CRITICAL CHECK: Verify structure
if [ ! -d "backend" ]; then
    echo -e "${RED}FATAL: Repository cloned but 'backend' folder is missing!${NC}"
    echo -e "Files found in $TARGET_DIR:"
    ls -la
    exit 1
fi

# Install Node.js if needed
if ! command -v node &> /dev/null; then
    echo -e "${BLUE}Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y $APT_OPTS nodejs
else
    echo -e "${GREEN}Node.js already installed${NC}"
fi

# Build application
echo -e "${BLUE}Installing npm dependencies...${NC}"
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

#######################################
# PHASE 7: CONFIGURE SERVICES
#######################################
echo -e "${BLUE}[7/7] Configuring system services...${NC}"

# Fan Control Setup (only for Raspberry Pi)
NEEDS_REBOOT=0

if [ "$IS_RASPBERRY_PI" = true ]; then
    echo -e "${BLUE}Configuring Raspberry Pi fan control...${NC}"

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

else
    echo -e "${YELLOW}Skipping fan control (not a Raspberry Pi)${NC}"
fi  # End IS_RASPBERRY_PI check

# Configure user permissions
echo -e "${BLUE}Configuring user permissions...${NC}"
usermod -aG docker $REAL_USER 2>/dev/null || true

# Sudoers for system control, fan PWM, storage and Samba management
cat > /etc/sudoers.d/homepinas <<EOF
# HomePiNAS Sudoers - SECURITY HARDENED v3.0.2
# Only allows specific commands with restricted arguments
# Wildcards restricted to prevent command injection

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

# SnapRAID (restricted to safe subcommands only)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid sync
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid sync -v
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid scrub
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid scrub -p [0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid scrub -p [0-9]* -o [0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid status
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid diff
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/snapraid smart

# MergerFS (restricted to specific mount points)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/mergerfs /mnt/disks/* /mnt/storage -o *
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/mergerfs /mnt/disk[0-9]\:/mnt/disk[0-9]* /mnt/storage -o *

# NonRAID (restricted to safe subcommands only)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl status
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl status -o json
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl start
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl stop
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl mount
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl unmount
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl check
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl create -p /dev/sd[a-z][0-9] /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl create -p /dev/nvme[0-9]n[0-9]p[0-9] /dev/sd[a-z][0-9]*
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/nmdctl create -p /dev/nvme[0-9]n[0-9]p[0-9] /dev/nvme[0-9]n[0-9]p[0-9]*

# sgdisk (restricted to /dev/sd* and /dev/nvme* only)
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/sgdisk -o -a 8 -n 1\:32K\:0 /dev/sd[a-z]
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/sgdisk -o -a 8 -n 1\:32K\:0 /dev/nvme[0-9]n[0-9]

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

# Save storage backend configuration for the application
echo -e "${BLUE}Saving storage backend configuration...${NC}"
cat > $TARGET_DIR/backend/storage-backend.conf <<EOF
# HomePiNAS Storage Backend Configuration
# Generated by installer v${VERSION}
STORAGE_BACKEND=$STORAGE_BACKEND
EOF
chown $REAL_USER:$REAL_USER $TARGET_DIR/backend/storage-backend.conf

# Main HomePiNAS service
if [ "$STORAGE_BACKEND" = "nonraid" ]; then
    SERVICE_AFTER="network.target docker.service nonraid.service"
else
    SERVICE_AFTER="network.target docker.service"
fi

cat > /etc/systemd/system/homepinas.service <<EOF
[Unit]
Description=HomePiNAS Backend Service
After=$SERVICE_AFTER
Wants=homepinas-fanctl.timer

[Service]
Type=simple
User=$REAL_USER
Group=$REAL_USER
WorkingDirectory=$TARGET_DIR
ExecStart=$(which node) $TARGET_DIR/backend/index.js
Restart=always
Environment=NODE_ENV=production
Environment=STORAGE_BACKEND=$STORAGE_BACKEND

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

# Enable snapraid sync timer only for SnapRAID backend
if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    systemctl enable homepinas-snapraid-sync.timer || true
fi

# Enable NonRAID service if selected
if [ "$STORAGE_BACKEND" = "nonraid" ]; then
    systemctl enable nonraid || true
fi

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
if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    echo -e "  - ${GREEN}SnapRAID${NC} parity protection (scheduled)"
    echo -e "  - ${GREEN}MergerFS${NC} disk pooling"
else
    echo -e "  - ${GREEN}NonRAID${NC} real-time parity protection"
fi
echo -e "  - ${GREEN}Samba${NC} network file sharing"
echo -e ""
echo -e "${YELLOW}Storage Backend: ${GREEN}$STORAGE_BACKEND${NC}"
if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    echo -e "  - Data disks mount: ${STORAGE_MOUNT_BASE}/disk[1-6]"
    echo -e "  - Parity disks mount: /mnt/parity[1-2]"
    echo -e "  - Cache (NVMe) mount: ${STORAGE_MOUNT_BASE}/cache[1-2]"
    echo -e "  - Merged pool: ${POOL_MOUNT}"
    echo -e "  - SnapRAID sync: Daily at 3:00 AM"
else
    echo -e "  - Data disks mount: /mnt/disk[1-6]"
    echo -e "  - Parity: Real-time (no scheduled sync)"
    echo -e "  - No cache disk support"
fi
echo -e ""
echo -e "${YELLOW}Network Share (SMB):${NC}"
if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    echo -e "  - Share name: ${GREEN}Storage${NC}"
    echo -e "  - Path: ${POOL_MOUNT}"
    echo -e "  - Access: \\\\\\\\$(hostname -I | awk '{print \$1}')\\\\Storage"
else
    echo -e "  - Shares configured per disk or unified (your choice)"
    echo -e "  - Access: \\\\\\\\$(hostname -I | awk '{print \$1}')\\\\Disk[N]"
fi
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
if [ "$STORAGE_BACKEND" = "snapraid" ]; then
    echo -e "  SnapRAID:    tail -f /var/log/snapraid-sync.log"
else
    echo -e "  NonRAID:     sudo nmdctl status"
fi
echo -e "${GREEN}=========================================${NC}"
