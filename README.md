# HomePiNAS v1.5.5

Premium NAS Dashboard for Raspberry Pi CM5 - Security Hardened Edition

## Features

- **SnapRAID + MergerFS** - Disk pooling with parity protection
- **Samba Sharing** - Network file sharing with automatic user creation
- **Docker Management** - Container control from dashboard
- **Fan Control** - PWM control for EMC2305 (Silent/Balanced/Performance)
- **System Monitoring** - CPU, Memory, Disk, Network stats
- **DDNS Support** - Cloudflare, No-IP, DuckDNS

## Security Features (v1.5.5)

- Bcrypt password hashing (12 rounds)
- SQLite-backed persistent sessions with expiration
- Rate limiting protection
- Helmet security headers
- Input sanitization for shell commands
- Restricted sudoers configuration
- HTTPS support with self-signed certificates

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | sudo bash
```

## Requirements

- Raspberry Pi CM5 (or compatible ARM64 device)
- Raspberry Pi OS Bookworm (64-bit)
- At least 2 disks for SnapRAID (1 data + 1 parity)

## Access

- Dashboard: `https://<IP>:3001`
- SMB Share: `\\<IP>\Storage`

## Version History

- **1.5.5** - Fan hysteresis
  - Added temperature hysteresis to prevent fan speed oscillation
  - State file tracks previous PWM values
  - Configurable HYST_TEMP parameter per preset

- **1.5.4** - Persistent sessions
  - SQLite-backed session storage
  - Sessions survive server restarts

- **1.5.3** - HTTPS support
  - Self-signed certificate generation
  - Dual HTTP/HTTPS servers

- **1.5.2** - Restricted sudoers
  - Limited sudo commands to specific paths/arguments
  - Improved security for system commands

- **1.5.1** - Command injection fix
  - Input sanitization for shell commands
  - Secure Samba password handling via stdin

- **1.5.0** - Security hardened edition (base)
  - Bcrypt password hashing
  - Rate limiting
  - Helmet security headers

## License

MIT
