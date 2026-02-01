# HomePiNAS v3.1.0

Premium NAS Dashboard with Dual Storage Backend Support - Homelabs.club Edition

## New in v3.1.0: Extended Features

- **Web Terminal** - Full PTY-based terminal with xterm.js
- **i18n Support** - English and Spanish translations
- **Docker Enhanced** - Ports, notes, logs, compose editor
- **Shortcuts** - Configurable program shortcuts (htop, mc, tmux)
- **PWA** - Progressive Web App support

## Storage Backend Options

During installation, you can choose between two storage backends:

| Feature | SnapRAID + MergerFS | NonRAID |
|---------|---------------------|---------|
| Type | Userspace | Kernel driver |
| Parity | Scheduled (daily 3 AM) | Real-time |
| Pool | Unified `/mnt/storage` | Individual `/mnt/disk[N]` |
| Cache | Supported | Not supported |
| Kernel | All kernels | Not 6.9 or 6.10 |

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v3/main/install.sh | sudo bash
```

The installer will prompt you to choose your storage backend.

## Features

### Core Features
- **Dual Storage Backend** - Choose SnapRAID+MergerFS or NonRAID
- **Samba Sharing** - Network file sharing with flexible share modes
- **Docker Management** - Full container control from dashboard
- **Fan Control** - PWM control for EMC2305 (Silent/Balanced/Performance)
- **System Monitoring** - CPU, Memory, Disk, Network stats
- **DDNS Support** - Cloudflare, No-IP, DuckDNS
- **HTTPS** - Self-signed certificates
- **OTA Updates** - Update from dashboard

### New in v3.1.0
- **Web Terminal** - PTY-based terminal with xterm.js (htop, mc, bash)
- **i18n** - Multi-language support (ES/EN)
- **Docker Ports** - See exposed ports for each container
- **Docker Notes** - Add notes/comments to containers
- **Docker Logs** - View container logs from dashboard
- **Compose Editor** - Edit docker-compose files in the UI
- **Program Shortcuts** - Quick access to htop, mc, tmux, etc.
- **PWA** - Install as Progressive Web App
- **Mobile Responsive** - Full mobile support with hamburger menu

## Storage Backend Details

### Option 1: SnapRAID + MergerFS (Recommended for beginners)

- Userspace solution - no kernel driver needed
- Scheduled parity sync (daily at 3 AM)
- All disks merged into single pool at `/mnt/storage`
- Supports cache disk (NVMe/SSD) for faster writes
- Works on all kernel versions

### Option 2: NonRAID (Advanced users)

- Kernel driver similar to unRAID
- Real-time parity protection (no scheduled syncs)
- Each disk mounted individually at `/mnt/disk[N]`
- Flexible share modes: Individual, Merged, or Categories
- **Not compatible with kernel 6.9 or 6.10**

## NonRAID Share Modes

When using NonRAID, you can choose how shares are configured:

1. **Individual** - Each disk as a separate share (`\\server\Disk1`, `\\server\Disk2`)
2. **Merged** - Unified pool using MergerFS (`\\server\Storage`)
3. **Categories** - Named by category (`\\server\Media`, `\\server\Documents`)

## Requirements

- Raspberry Pi CM5 / Debian / Ubuntu (ARM64 or AMD64)
- At least 2 disks (1 data + 1 parity)
- For NonRAID: Kernel version != 6.9, != 6.10

## Access

- Dashboard: `https://<IP>:3001`
- SMB Shares: Depends on backend and share mode

## Version History

- **3.1.0** - Extended Features
  - Web Terminal (PTY + xterm.js)
  - i18n (English/Spanish)
  - Docker ports, notes, logs, compose editor
  - Program shortcuts (htop, mc, tmux)
  - PWA support
  - Mobile responsive design

- **3.0.0** - Dual Storage Backend Support
  - Interactive backend selection during install
  - NonRAID kernel driver support
  - Flexible share modes for NonRAID
  - Kernel compatibility checking

## Security Features

- Bcrypt password hashing
- SQLite-backed persistent sessions
- Rate limiting protection
- Helmet security headers
- Input sanitization
- Restricted sudoers configuration
- HTTPS with self-signed certificates

## License

MIT
