# HomePiNAS v3.0.0

Premium NAS Dashboard with Dual Storage Backend Support - Homelabs.club Edition

## New in v3.0.0: Choose Your Storage Backend

During installation, you can now choose between two storage backends:

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

- **Dual Storage Backend** - Choose SnapRAID+MergerFS or NonRAID
- **Samba Sharing** - Network file sharing with flexible share modes
- **Docker Management** - Container control from dashboard
- **Fan Control** - PWM control for EMC2305 (Silent/Balanced/Performance)
- **System Monitoring** - CPU, Memory, Disk, Network stats
- **DDNS Support** - Cloudflare, No-IP, DuckDNS
- **HTTPS** - Self-signed certificates
- **OTA Updates** - Update from dashboard

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

- **3.0.0** - Dual Storage Backend Support
  - Interactive backend selection during install
  - NonRAID kernel driver support
  - Flexible share modes for NonRAID
  - Kernel compatibility checking

- **2.0.14** - Previous stable release (SnapRAID + MergerFS only)

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
