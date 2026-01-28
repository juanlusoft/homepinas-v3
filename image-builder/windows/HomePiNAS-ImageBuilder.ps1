#Requires -RunAsAdministrator
# HomePiNAS Image Builder for Windows
# Portable version - No installation required

param(
    [string]$ImagePath
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "HomePiNAS Image Builder"

# Colors
function Write-Color($Text, $Color = "White") {
    Write-Host $Text -ForegroundColor $Color
}

function Write-Banner {
    Write-Host ""
    Write-Color "  ╔═══════════════════════════════════════════════════════════╗" Cyan
    Write-Color "  ║         HomePiNAS Image Builder v2.0                      ║" Cyan
    Write-Color "  ║         Homelabs.club Edition                             ║" Cyan
    Write-Color "  ╚═══════════════════════════════════════════════════════════╝" Cyan
    Write-Host ""
}

function Get-ImageFile {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Seleccionar imagen de Raspberry Pi OS"
    $dialog.Filter = "Imagenes (*.img;*.img.xz;*.zip)|*.img;*.img.xz;*.zip|Todos los archivos (*.*)|*.*"
    $dialog.InitialDirectory = [Environment]::GetFolderPath("Downloads")

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.FileName
    }
    return $null
}

function Expand-CompressedImage {
    param([string]$Path)

    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $scriptDir) { $scriptDir = $PWD }

    if ($Path -match '\.xz$') {
        Write-Color "  Descomprimiendo archivo .xz..." Yellow

        # Check for 7-Zip
        $7zPaths = @(
            "$scriptDir\7za.exe",
            "$env:ProgramFiles\7-Zip\7z.exe",
            "$env:ProgramFiles(x86)\7-Zip\7z.exe"
        )

        $7z = $null
        foreach ($p in $7zPaths) {
            if (Test-Path $p) { $7z = $p; break }
        }

        if (-not $7z) {
            Write-Color "  Descargando 7-Zip portable..." Yellow
            $7zUrl = "https://www.7-zip.org/a/7za920.zip"
            $7zZip = "$scriptDir\7za.zip"
            Invoke-WebRequest -Uri $7zUrl -OutFile $7zZip -UseBasicParsing
            Expand-Archive -Path $7zZip -DestinationPath $scriptDir -Force
            Remove-Item $7zZip -Force
            $7z = "$scriptDir\7za.exe"
        }

        $outputDir = Split-Path -Parent $Path
        & $7z x $Path -o"$outputDir" -y | Out-Null
        return $Path -replace '\.xz$', ''
    }
    elseif ($Path -match '\.zip$') {
        Write-Color "  Descomprimiendo archivo .zip..." Yellow
        $outputDir = Split-Path -Parent $Path
        Expand-Archive -Path $Path -DestinationPath $outputDir -Force
        $imgFile = Get-ChildItem -Path $outputDir -Filter "*.img" | Select-Object -First 1
        return $imgFile.FullName
    }

    return $Path
}

function Mount-BootPartition {
    param([string]$ImagePath)

    Write-Color "  Montando particion de arranque..." Yellow

    # Use diskpart to mount the image
    $mountPoint = "$env:TEMP\homepinas_boot"
    New-Item -ItemType Directory -Path $mountPoint -Force | Out-Null

    # Mount using Windows built-in tools
    $disk = Mount-DiskImage -ImagePath $ImagePath -PassThru
    $diskNumber = ($disk | Get-Disk).Number

    # Get the first partition (boot partition - FAT32)
    Start-Sleep -Seconds 2
    $partition = Get-Partition -DiskNumber $diskNumber | Where-Object { $_.Type -eq "FAT32" -or $_.Size -lt 1GB } | Select-Object -First 1

    if ($partition) {
        $driveLetter = $partition.DriveLetter
        if (-not $driveLetter) {
            $driveLetter = (Get-ChildItem function:[d-z]: -Name | Where-Object { -not (Test-Path $_) } | Select-Object -First 1) -replace ':'
            $partition | Set-Partition -NewDriveLetter $driveLetter
        }
        return @{
            DiskNumber = $diskNumber
            DriveLetter = $driveLetter
            Partition = $partition
        }
    }

    throw "No se pudo encontrar la particion de arranque"
}

function Add-FirstBootScript {
    param([string]$BootDrive)

    Write-Color "  Agregando script de instalacion automatica..." Yellow

    $bootPath = "${BootDrive}:\"

    # Create firstrun.sh script
    $firstRunScript = @'
#!/bin/bash

# HomePiNAS First Boot Installer
set +e

LOGFILE="/boot/firmware/homepinas-install.log"
MARKER="/boot/firmware/.homepinas-installed"

# Redirect output
exec > >(tee -a "$LOGFILE") 2>&1

echo "========================================"
echo "HomePiNAS Automatic Installer"
echo "Started: $(date)"
echo "========================================"

# Check if already installed
if [ -f "$MARKER" ]; then
    echo "HomePiNAS already installed"
    exit 0
fi

# Wait for network
echo "Waiting for network..."
for i in $(seq 1 60); do
    if ping -c 1 github.com &>/dev/null; then
        echo "Network available"
        break
    fi
    echo "Waiting... ($i/60)"
    sleep 2
done

# Install HomePiNAS
echo ""
echo "Starting HomePiNAS installation..."
echo "This may take 10-15 minutes..."
echo ""

if curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | bash; then
    echo ""
    echo "========================================"
    echo "Installation completed successfully!"
    echo "========================================"
    touch "$MARKER"

    # Remove firstrun from cmdline.txt
    mount -o remount,rw /boot/firmware
    sed -i 's| systemd.run=/boot/firmware/firstrun.sh||g' /boot/firmware/cmdline.txt
    sed -i 's| systemd.run_success_action=reboot||g' /boot/firmware/cmdline.txt
    sync

    echo "System will reboot in 10 seconds..."
    sleep 10
    reboot
else
    echo ""
    echo "Installation failed. Check logs at $LOGFILE"
    echo "You can retry manually with:"
    echo "curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | sudo bash"
fi
'@

    # Write firstrun.sh (Unix line endings)
    $firstRunScript = $firstRunScript -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText("$bootPath\firstrun.sh", $firstRunScript, [System.Text.UTF8Encoding]::new($false))

    # Modify cmdline.txt to run script on first boot
    $cmdlinePath = "$bootPath\cmdline.txt"
    if (Test-Path $cmdlinePath) {
        $cmdline = Get-Content $cmdlinePath -Raw
        $cmdline = $cmdline.Trim()

        if ($cmdline -notmatch "systemd.run=") {
            $cmdline += " systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot"
            [System.IO.File]::WriteAllText($cmdlinePath, $cmdline, [System.Text.UTF8Encoding]::new($false))
            Write-Color "  cmdline.txt modificado" Green
        }
    }

    # Enable SSH
    New-Item -ItemType File -Path "$bootPath\ssh" -Force | Out-Null
    Write-Color "  SSH habilitado" Green

    # Set hostname via config
    $configPath = "$bootPath\config.txt"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw
        if ($config -notmatch "hostname=") {
            Add-Content -Path $configPath -Value "`n# HomePiNAS`nhostname=homepinas"
        }
    }

    Write-Color "  Configuracion completada" Green
}

function Dismount-Image {
    param([int]$DiskNumber)

    Write-Color "  Desmontando imagen..." Yellow

    try {
        $disk = Get-Disk -Number $DiskNumber -ErrorAction SilentlyContinue
        if ($disk) {
            # Remove drive letters first
            Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.DriveLetter) {
                    Remove-PartitionAccessPath -DiskNumber $DiskNumber -PartitionNumber $_.PartitionNumber -AccessPath "$($_.DriveLetter):\" -ErrorAction SilentlyContinue
                }
            }
        }

        Get-DiskImage | Where-Object { $_.Number -eq $DiskNumber } | Dismount-DiskImage -ErrorAction SilentlyContinue
    } catch {
        # Try alternative method
        Get-DiskImage | Dismount-DiskImage -ErrorAction SilentlyContinue
    }
}

# Main execution
Clear-Host
Write-Banner

# Get image file
if (-not $ImagePath) {
    Write-Color "  Selecciona la imagen de Raspberry Pi OS..." White
    Write-Host ""
    $ImagePath = Get-ImageFile

    if (-not $ImagePath) {
        Write-Color "  [CANCELADO] No se selecciono ninguna imagen" Red
        exit 1
    }
}

Write-Color "  Imagen seleccionada:" White
Write-Color "  $ImagePath" Cyan
Write-Host ""

# Check file exists
if (-not (Test-Path $ImagePath)) {
    Write-Color "  [ERROR] Archivo no encontrado: $ImagePath" Red
    exit 1
}

try {
    # Decompress if needed
    if ($ImagePath -match '\.(xz|zip)$') {
        $ImagePath = Expand-CompressedImage -Path $ImagePath
        Write-Color "  Imagen descomprimida: $ImagePath" Green
    }

    # Mount boot partition
    Write-Host ""
    $mountInfo = Mount-BootPartition -ImagePath $ImagePath
    Write-Color "  Particion montada en $($mountInfo.DriveLetter):\" Green

    # Add first boot script
    Write-Host ""
    Add-FirstBootScript -BootDrive $mountInfo.DriveLetter

    # Dismount
    Write-Host ""
    Start-Sleep -Seconds 1
    Dismount-Image -DiskNumber $mountInfo.DiskNumber
    Write-Color "  Imagen desmontada" Green

    # Rename output file
    $outputPath = $ImagePath -replace '\.img$', '-homepinas.img'
    if ($ImagePath -ne $outputPath) {
        Move-Item -Path $ImagePath -Destination $outputPath -Force
    }

    Write-Host ""
    Write-Color "  ╔═══════════════════════════════════════════════════════════╗" Green
    Write-Color "  ║              IMAGEN CREADA EXITOSAMENTE                   ║" Green
    Write-Color "  ╚═══════════════════════════════════════════════════════════╝" Green
    Write-Host ""
    Write-Color "  Imagen lista: " White
    Write-Color "  $outputPath" Cyan
    Write-Host ""
    Write-Color "  Siguientes pasos:" Yellow
    Write-Color "  1. Graba la imagen en una SD con Raspberry Pi Imager o balenaEtcher" White
    Write-Color "  2. Inserta la SD en tu Raspberry Pi y enciendela" White
    Write-Color "  3. HomePiNAS se instalara automaticamente (5-15 min)" White
    Write-Color "  4. Accede al dashboard en: https://<ip-raspberry>:3001" White
    Write-Host ""

} catch {
    Write-Host ""
    Write-Color "  [ERROR] $($_.Exception.Message)" Red
    Write-Host ""

    # Try to cleanup
    try {
        Get-DiskImage | Dismount-DiskImage -ErrorAction SilentlyContinue
    } catch {}

    exit 1
}
