#Requires -RunAsAdministrator
<#
.SYNOPSIS
    HomePiNAS Image Builder - Professional Windows Application
.DESCRIPTION
    Creates customized Raspberry Pi OS images with HomePiNAS pre-configured
    for automatic installation on first boot.
.NOTES
    Version: 2.0.0
    Author: Homelabs.club
    Website: https://homelabs.club
#>

param(
    [string]$ImagePath,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$script:Version = "2.0.0"

# ============================================================================
# GUI ASSEMBLY LOADING
# ============================================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationFramework

[System.Windows.Forms.Application]::EnableVisualStyles()

# ============================================================================
# THEME COLORS
# ============================================================================
$script:Colors = @{
    Primary      = [System.Drawing.Color]::FromArgb(41, 128, 185)    # Blue
    PrimaryDark  = [System.Drawing.Color]::FromArgb(31, 97, 141)     # Dark Blue
    Success      = [System.Drawing.Color]::FromArgb(39, 174, 96)     # Green
    Warning      = [System.Drawing.Color]::FromArgb(243, 156, 18)    # Orange
    Error        = [System.Drawing.Color]::FromArgb(231, 76, 60)     # Red
    Background   = [System.Drawing.Color]::FromArgb(236, 240, 241)   # Light Gray
    Surface      = [System.Drawing.Color]::White
    TextPrimary  = [System.Drawing.Color]::FromArgb(44, 62, 80)      # Dark
    TextSecondary= [System.Drawing.Color]::FromArgb(127, 140, 141)   # Gray
}

# ============================================================================
# EMBEDDED ICON (Base64)
# ============================================================================
$script:IconBase64 = @"
AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAABMLAAATCwAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAABuA1R8bgNW/G4DVvxuA1WAbjNUAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAG4DVHxuA1f8bgNX/G4DV/xuA1f8bgNX/G4zVAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAHIDVHxyA1f8cgNX/HIDV/xyA1f8cgNX/HIDV/xyM1QAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2A1R8dgNX/HYDV/x2A1f8dgNX/HYDV/x2A1f8dgNX/
HYzVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAegNUfHoDV/x6A1f8egNX/HoDV/x6A
1f8egNX/HoDV/x6A1f8ejNUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+A1R8f
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
AA0NDQ8NDQ3vDQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0NzwAAAAAAAA0N
DR8AAAAAAAAAAAAAAAA+htagPobW/z+H1/8/h9f/P4fX/z+H16BAjtkgQo3aoFKY4P9SmOD/Upjg
/1KY4P9SmOD/Upjg/1KY4P9SmOD/Upjg/1KY4P9Snd+gRo3cIA0NDU8NDQ3/DQ0N/w0NDf8NDQ3/
DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDe8NDQ1PDQ0NHw0NDQAAAAAAAAAAAEGJ2CBB
jNmgQIfX/0CI1/9AiNf/QIjX/0CI16BDjdkgQ47boFOZ4f9TmeH/U5nh/1OZ4f9TmeH/U5nh/1OZ
4f9TmeH/U5nh/1OZ4f9Tnt+gSI7dIA0NDa8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N
/w0NDf8NDQ3/DQ0N/w0NDf8NDQ2/DQ0NTw0NDQAAAAAAAAAAAAAAAABBAAAARJDZIEGL2aBBiNj/
QYjY/0GI2P9BiNj/QYjYoESO2iBEj9ugVJri/1Sa4v9UmuL/VJri/1Sa4v9UmuL/VJri/1Sa4v9U
muL/VJri/1Se4KBJjt0gDQ0N3w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0N
Df8NDQ3/DQ0N/w0NDd8NDQ1PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABFE9kgRZDaoEKJ2f9Cidn/
QonZ/0KJ2f9CidmgRY/aIEWQ3KBVm+P/VZvj/1Wb4/9Vm+P/VZvj/1Wb4/9Vm+P/VZvj/1Wb4/9V
m+P/VaDgoEqP3SANDQ3vDQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0N
Df8NDQ3/DQ0Nzw0NDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEUQ2SBGkdugQ4ra/0OK2v9Ditr/
Q4ra/0OK2qBGkNogRpHcoFac5P9WnOT/Vpzk/1ac5P9WnOT/Vpzk/1ac5P9WnOT/Vpzk/1ac5P9W
oeGgS5DeIA0NDd8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0N
Df8NDQ2PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEYR2SBHkdugRIvb/0SL2/9Ei9v/RIvb
/0SL26BHkNsgR5LdoFed5f9XneX/V53l/1ed5f9XneX/V53l/1ed5f9XneX/V53l/1ed5f9XouGg
TJDfIA0NDa8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDe8N
DQ0/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEYQ2SBHktugRYzc/0WM3P9FjNz/RYzc/0WM
3KBHkdsgSJPeoFie5v9Ynub/WJ7m/1ie5v9Ynub/WJ7m/1ie5v9Ynub/WJ7m/1ie5v9Yo+KgTZHf
IA0NDW8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDc8AAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHD9kgSJPcoEaN3f9Gjd3/Ro3d/0aN3f9G
jd2gSJLcIEiT36BZn+f/WZ/n/1mf5/9Zn+f/WZ/n/1mf5/9Zn+f/WZ/n/1mf5/9Zn+f/WaTjoE6S
4CANDQ0fDQ0N3w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ1fAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHD9kgSZTdoEeO3v9Hjt7/R47e
/0eO3v9Hjt6gSZPcIEmU4KBaoOj/WqDo/1qg6P9aoOj/WqDo/1qg6P9aoOj/WqDo/1qg6P9aoOj/
WqXkoE+S4QANDQ0ADQ0Njw0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDc8A
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASQ/ZIEmU3qBIj9//
SI/f/0iP3/9Ij9//SI/foEmU3SBJleGgW6Hp/1uh6f9boer/W6Hp/1uh6f9boen/W6Hp/1uh6f9b
oen/W6Hp/1um5aBQk+EgAAAAAAAAAAAADQ0NPw0NDe8NDQ3/DQ0N/w0NDf8NDQ3/DQ0N/w0NDf8N
DQ3/DQ0N/w0NDR8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AABKENkgSpXfoEmQ4P9JkOD/SZDg/0mQ4P9JkOCgSpXeIEuW4qBcoun/XKLq/1yi6v9cour/XKLq
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
/+AA///wAf//+Af///wf//////8=
"@

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

function Get-IconFromBase64 {
    param([string]$Base64)
    try {
        $bytes = [Convert]::FromBase64String($Base64)
        $stream = [System.IO.MemoryStream]::new($bytes)
        return [System.Drawing.Icon]::new($stream)
    } catch {
        return $null
    }
}

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("Info", "Success", "Warning", "Error")]
        [string]$Level = "Info"
    )

    $timestamp = Get-Date -Format "HH:mm:ss"
    $logMessage = "[$timestamp] $Message"

    if ($script:LogTextBox -and $script:LogTextBox.IsHandleCreated) {
        try {
            $script:LogTextBox.Invoke([Action]{
                $color = switch ($Level) {
                    "Success" { [System.Drawing.Color]::FromArgb(39, 174, 96) }
                    "Warning" { [System.Drawing.Color]::FromArgb(243, 156, 18) }
                    "Error"   { [System.Drawing.Color]::FromArgb(231, 76, 60) }
                    default   { [System.Drawing.Color]::FromArgb(44, 62, 80) }
                }

                $script:LogTextBox.SelectionStart = $script:LogTextBox.TextLength
                $script:LogTextBox.SelectionColor = $color
                $script:LogTextBox.AppendText("$logMessage`r`n")
                $script:LogTextBox.ScrollToCaret()
            })
        } catch {
            # Control not ready yet, ignore
        }
    }
}

function Update-Progress {
    param(
        [int]$Percent,
        [string]$Status
    )

    if ($script:ProgressBar -and $script:StatusLabel -and $script:MainForm.IsHandleCreated) {
        try {
            $script:MainForm.Invoke([Action]{
                $script:ProgressBar.Value = [Math]::Min(100, [Math]::Max(0, $Percent))
                $script:StatusLabel.Text = $Status
            })
        } catch {
            # Control not ready yet, ignore
        }
    }
}

# ============================================================================
# CORE FUNCTIONS
# ============================================================================

function Get-7ZipPath {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = $PWD.Path }

    $paths = @(
        "$scriptDir\7za.exe",
        "$env:ProgramFiles\7-Zip\7z.exe",
        "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
    )

    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }

    return $null
}

function Install-7Zip {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = $PWD.Path }

    Write-Log "Descargando 7-Zip portable..." "Info"

    $7zUrl = "https://www.7-zip.org/a/7za920.zip"
    $7zZip = "$scriptDir\7za.zip"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $7zUrl -OutFile $7zZip -UseBasicParsing
        Expand-Archive -Path $7zZip -DestinationPath $scriptDir -Force
        Remove-Item $7zZip -Force -ErrorAction SilentlyContinue

        Write-Log "7-Zip instalado correctamente" "Success"
        return "$scriptDir\7za.exe"
    } catch {
        Write-Log "Error descargando 7-Zip: $_" "Error"
        return $null
    }
}

function Start-RpiOsDownload {
    $script:SelectButton.Enabled = $false
    $script:DownloadButton.Enabled = $false
    $script:ProcessButton.Enabled = $false

    Write-Log "Obteniendo URL de descarga..." "Info"
    Update-Progress -Percent 5 -Status "Conectando con raspberrypi.com..."

    $downloadJob = Start-Job -ScriptBlock {
        param($DownloadDir)

        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

            # URL for latest Raspberry Pi OS Lite 64-bit (compatible with CM5/Pi5)
            $baseUrl = "https://downloads.raspberrypi.com/raspios_lite_arm64/images/"

            # Get latest version folder
            $response = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing
            $folders = [regex]::Matches($response.Content, 'href="(raspios_lite_arm64-[^"]+)"') | ForEach-Object { $_.Groups[1].Value }
            $latestFolder = $folders | Sort-Object -Descending | Select-Object -First 1

            if (-not $latestFolder) {
                throw "No se pudo encontrar la version mas reciente"
            }

            # Get the .img.xz file from that folder
            $folderUrl = "$baseUrl$latestFolder"
            $folderResponse = Invoke-WebRequest -Uri $folderUrl -UseBasicParsing
            $imgFile = [regex]::Match($folderResponse.Content, 'href="([^"]+\.img\.xz)"').Groups[1].Value

            if (-not $imgFile) {
                throw "No se encontro archivo de imagen"
            }

            $downloadUrl = "$folderUrl$imgFile"
            $outputPath = Join-Path $DownloadDir $imgFile

            # Download with progress
            $webClient = New-Object System.Net.WebClient
            $webClient.DownloadFile($downloadUrl, $outputPath)

            return @{
                Success = $true
                FilePath = $outputPath
                FileName = $imgFile
            }
        } catch {
            return @{
                Success = $false
                Error = $_.Exception.Message
            }
        }
    } -ArgumentList "$env:USERPROFILE\Downloads"

    # Monitor download
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $script:downloadProgress = 10
    $timer.Add_Tick({
        if ($downloadJob.State -eq "Completed") {
            $timer.Stop()
            $result = Receive-Job -Job $downloadJob
            Remove-Job -Job $downloadJob

            if ($result.Success) {
                Update-Progress -Percent 100 -Status "Descarga completada"
                Write-Log "Imagen descargada: $($result.FileName)" "Success"
                Write-Log "Ubicacion: $($result.FilePath)" "Info"
                $script:FilePathTextBox.Text = $result.FilePath
                $script:ProcessButton.Enabled = $true

                [System.Windows.Forms.MessageBox]::Show(
                    "Imagen descargada correctamente!`n`n$($result.FileName)`n`nPulsa 'CREAR IMAGEN' para continuar.",
                    "Descarga Completada",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                )
            } else {
                Update-Progress -Percent 0 -Status "Error en descarga"
                Write-Log "Error: $($result.Error)" "Error"

                [System.Windows.Forms.MessageBox]::Show(
                    "Error descargando imagen:`n`n$($result.Error)`n`nDescargala manualmente desde raspberrypi.com",
                    "Error de Descarga",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Error
                )
            }

            $script:SelectButton.Enabled = $true
            $script:DownloadButton.Enabled = $true
        }
        elseif ($downloadJob.State -eq "Running") {
            # Animate progress while downloading
            $script:downloadProgress += 2
            if ($script:downloadProgress > 90) { $script:downloadProgress = 90 }
            Update-Progress -Percent $script:downloadProgress -Status "Descargando Raspberry Pi OS Lite (64-bit)..."
        }
        elseif ($downloadJob.State -eq "Failed") {
            $timer.Stop()
            Write-Log "Error en la descarga" "Error"
            $script:SelectButton.Enabled = $true
            $script:DownloadButton.Enabled = $true
        }
    })

    Write-Log "Descargando Raspberry Pi OS Lite para CM5/Pi5..." "Info"
    Update-Progress -Percent 10 -Status "Descargando..."
    $timer.Start()
}

function Get-RemovableDrives {
    $drives = @()

    try {
        # Get USB disks
        $usbDisks = Get-Disk | Where-Object {
            $_.BusType -eq 'USB' -and $_.Size -gt 0
        }

        foreach ($disk in $usbDisks) {
            $sizeGB = [math]::Round($disk.Size / 1GB, 1)
            $drives += @{
                Number = $disk.Number
                Name = $disk.FriendlyName
                Size = $disk.Size
                SizeText = "${sizeGB} GB"
                DisplayName = "[$($disk.Number)] $($disk.FriendlyName) - ${sizeGB} GB"
            }
        }
    } catch {
        Write-Log "Error detectando unidades: $_" "Error"
    }

    return $drives
}

function Update-DriveList {
    $script:DriveComboBox.Items.Clear()
    $script:RemovableDrives = Get-RemovableDrives

    if ($script:RemovableDrives.Count -eq 0) {
        $script:DriveComboBox.Items.Add("No se detectaron unidades USB")
        $script:DriveComboBox.SelectedIndex = 0
        $script:BurnButton.Enabled = $false
    } else {
        foreach ($drive in $script:RemovableDrives) {
            $script:DriveComboBox.Items.Add($drive.DisplayName)
        }
        $script:DriveComboBox.SelectedIndex = 0
        $script:BurnButton.Enabled = $script:ProcessedImagePath -ne $null
    }
}

function Write-ImageToDrive {
    param(
        [string]$ImagePath,
        [int]$DiskNumber
    )

    $script:BurnButton.Enabled = $false
    $script:RefreshButton.Enabled = $false
    $script:SelectButton.Enabled = $false
    $script:DownloadButton.Enabled = $false
    $script:ProcessButton.Enabled = $false

    # Confirm with user
    $disk = Get-Disk -Number $DiskNumber
    $sizeGB = [math]::Round($disk.Size / 1GB, 1)

    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "ATENCION: Se borraran TODOS los datos en:`n`n$($disk.FriendlyName) ($sizeGB GB)`n`nDisco numero: $DiskNumber`n`n¿Continuar?",
        "Confirmar grabacion",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )

    if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-Log "Grabacion cancelada por el usuario" "Warning"
        $script:BurnButton.Enabled = $true
        $script:RefreshButton.Enabled = $true
        $script:SelectButton.Enabled = $true
        $script:DownloadButton.Enabled = $true
        return
    }

    Write-Log "Iniciando grabacion en disco $DiskNumber..." "Info"
    Update-Progress -Percent 5 -Status "Preparando disco..."

    $burnJob = Start-Job -ScriptBlock {
        param($ImagePath, $DiskNumber)

        try {
            $result = @{ Success = $false; Error = "" }

            # Clear the disk
            Clear-Disk -Number $DiskNumber -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop

            # Get image size
            $imageSize = (Get-Item $ImagePath).Length
            $imageSizeGB = [math]::Round($imageSize / 1GB, 2)

            # Open source and destination
            $sourceStream = [System.IO.File]::OpenRead($ImagePath)
            $diskPath = "\\.\PhysicalDrive$DiskNumber"

            # Open disk for raw write
            $diskHandle = [System.IO.File]::Open(
                $diskPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )

            # Write in chunks
            $bufferSize = 4MB
            $buffer = New-Object byte[] $bufferSize
            $totalWritten = 0

            while (($bytesRead = $sourceStream.Read($buffer, 0, $bufferSize)) -gt 0) {
                $diskHandle.Write($buffer, 0, $bytesRead)
                $totalWritten += $bytesRead
            }

            # Cleanup
            $diskHandle.Flush()
            $diskHandle.Close()
            $sourceStream.Close()

            # Refresh disk
            Update-Disk -Number $DiskNumber -ErrorAction SilentlyContinue

            $result.Success = $true
            $result.TotalWritten = $totalWritten
            return $result

        } catch {
            return @{
                Success = $false
                Error = $_.Exception.Message
            }
        }
    } -ArgumentList $ImagePath, $DiskNumber

    # Monitor burn progress
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $script:burnProgress = 5

    $timer.Add_Tick({
        if ($burnJob.State -eq "Completed") {
            $timer.Stop()
            $result = Receive-Job -Job $burnJob
            Remove-Job -Job $burnJob

            if ($result.Success) {
                Update-Progress -Percent 100 -Status "Grabacion completada!"
                Write-Log "=" * 50 "Info"
                Write-Log "IMAGEN GRABADA EXITOSAMENTE" "Success"
                Write-Log "=" * 50 "Info"
                Write-Log "Bytes escritos: $($result.TotalWritten)" "Info"
                Write-Log "" "Info"
                Write-Log "Retira la SD e insertala en tu Raspberry Pi" "Success"

                [System.Windows.Forms.MessageBox]::Show(
                    "Imagen grabada correctamente!`n`nRetira la tarjeta SD e insertala en tu Raspberry Pi.`n`nHomePiNAS se instalara automaticamente en el primer arranque.",
                    "Grabacion Completada",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                )
            } else {
                Update-Progress -Percent 0 -Status "Error en grabacion"
                Write-Log "ERROR: $($result.Error)" "Error"

                [System.Windows.Forms.MessageBox]::Show(
                    "Error grabando imagen:`n`n$($result.Error)",
                    "Error de Grabacion",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Error
                )
            }

            $script:BurnButton.Enabled = $true
            $script:RefreshButton.Enabled = $true
            $script:SelectButton.Enabled = $true
            $script:DownloadButton.Enabled = $true
            Update-DriveList
        }
        elseif ($burnJob.State -eq "Running") {
            $script:burnProgress += 3
            if ($script:burnProgress > 95) { $script:burnProgress = 95 }
            Update-Progress -Percent $script:burnProgress -Status "Grabando imagen en SD/USB..."
        }
        elseif ($burnJob.State -eq "Failed") {
            $timer.Stop()
            Write-Log "Error en la grabacion" "Error"
            $script:BurnButton.Enabled = $true
            $script:RefreshButton.Enabled = $true
            $script:SelectButton.Enabled = $true
            $script:DownloadButton.Enabled = $true
        }
    })

    $timer.Start()
}

function Expand-CompressedImage {
    param([string]$Path)

    if ($Path -match '\.xz$') {
        Write-Log "Descomprimiendo archivo .xz..." "Info"
        Update-Progress -Percent 15 -Status "Descomprimiendo imagen..."

        $7z = Get-7ZipPath
        if (-not $7z) {
            $7z = Install-7Zip
            if (-not $7z) {
                throw "No se pudo obtener 7-Zip para descomprimir"
            }
        }

        $outputDir = Split-Path -Parent $Path
        $result = & $7z x $Path -o"$outputDir" -y 2>&1

        if ($LASTEXITCODE -ne 0) {
            throw "Error descomprimiendo: $result"
        }

        Write-Log "Imagen descomprimida" "Success"
        return $Path -replace '\.xz$', ''
    }
    elseif ($Path -match '\.zip$') {
        Write-Log "Descomprimiendo archivo .zip..." "Info"
        Update-Progress -Percent 15 -Status "Descomprimiendo imagen..."

        $outputDir = Split-Path -Parent $Path
        Expand-Archive -Path $Path -DestinationPath $outputDir -Force

        $imgFile = Get-ChildItem -Path $outputDir -Filter "*.img" | Select-Object -First 1
        if (-not $imgFile) {
            throw "No se encontro archivo .img en el ZIP"
        }

        Write-Log "Imagen descomprimida" "Success"
        return $imgFile.FullName
    }

    return $Path
}

function Mount-BootPartition {
    param([string]$ImagePath)

    Write-Log "Montando imagen de disco..." "Info"
    Update-Progress -Percent 30 -Status "Montando particion de arranque..."

    # Mount the image
    $disk = Mount-DiskImage -ImagePath $ImagePath -PassThru
    Start-Sleep -Seconds 2

    $diskNumber = ($disk | Get-Disk).Number
    Write-Log "Imagen montada como disco #$diskNumber" "Info"

    # Find boot partition (FAT32, usually first partition < 1GB)
    $partitions = Get-Partition -DiskNumber $diskNumber -ErrorAction SilentlyContinue
    $bootPartition = $partitions | Where-Object {
        $_.Type -eq "FAT32" -or $_.Size -lt 1GB
    } | Select-Object -First 1

    if (-not $bootPartition) {
        throw "No se encontro la particion de arranque (FAT32)"
    }

    # Assign drive letter if needed
    $driveLetter = $bootPartition.DriveLetter
    if (-not $driveLetter) {
        $available = [char[]](68..90) | Where-Object { -not (Test-Path "$_`:") } | Select-Object -First 1
        $bootPartition | Set-Partition -NewDriveLetter $available
        $driveLetter = $available
    }

    Write-Log "Particion montada en $driveLetter`:\" "Success"

    return @{
        DiskNumber = $diskNumber
        DriveLetter = $driveLetter
    }
}

function Add-FirstBootScript {
    param([string]$BootDrive)

    Write-Log "Configurando instalacion automatica..." "Info"
    Update-Progress -Percent 50 -Status "Agregando scripts de instalacion..."

    $bootPath = "${BootDrive}:\"

    # Create firstrun.sh
    $firstRunScript = @'
#!/bin/bash
# HomePiNAS First Boot Installer
set +e

LOGFILE="/boot/firmware/homepinas-install.log"
MARKER="/boot/firmware/.homepinas-installed"

exec > >(tee -a "$LOGFILE") 2>&1

echo "========================================"
echo "HomePiNAS Automatic Installer"
echo "Started: $(date)"
echo "========================================"

if [ -f "$MARKER" ]; then
    echo "HomePiNAS already installed"
    exit 0
fi

echo "Waiting for network..."
for i in $(seq 1 60); do
    if ping -c 1 github.com &>/dev/null; then
        echo "Network available"
        break
    fi
    echo "Waiting... ($i/60)"
    sleep 2
done

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

    # Write with Unix line endings
    $firstRunScript = $firstRunScript -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText("$bootPath\firstrun.sh", $firstRunScript, [System.Text.UTF8Encoding]::new($false))
    Write-Log "Script de instalacion creado" "Success"

    # Modify cmdline.txt
    $cmdlinePath = "$bootPath\cmdline.txt"
    if (Test-Path $cmdlinePath) {
        $cmdline = (Get-Content $cmdlinePath -Raw).Trim()

        if ($cmdline -notmatch "systemd.run=") {
            $cmdline += " systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot"
            [System.IO.File]::WriteAllText($cmdlinePath, $cmdline, [System.Text.UTF8Encoding]::new($false))
            Write-Log "cmdline.txt modificado para auto-instalacion" "Success"
        }
    }

    # Enable SSH
    New-Item -ItemType File -Path "$bootPath\ssh" -Force | Out-Null
    Write-Log "SSH habilitado" "Success"

    Update-Progress -Percent 70 -Status "Configuracion completada"
}

function Dismount-Image {
    param([int]$DiskNumber)

    Write-Log "Desmontando imagen..." "Info"
    Update-Progress -Percent 85 -Status "Desmontando imagen..."

    try {
        # Remove drive letters
        Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.DriveLetter) {
                Remove-PartitionAccessPath -DiskNumber $DiskNumber -PartitionNumber $_.PartitionNumber -AccessPath "$($_.DriveLetter):\" -ErrorAction SilentlyContinue
            }
        }

        # Dismount all disk images
        Get-DiskImage | Where-Object { $_.Number -eq $DiskNumber } | Dismount-DiskImage -ErrorAction SilentlyContinue

        Write-Log "Imagen desmontada correctamente" "Success"
    } catch {
        Get-DiskImage | Dismount-DiskImage -ErrorAction SilentlyContinue
    }
}

function Start-ImageProcessing {
    param([string]$ImageFile)

    $script:ProcessButton.Enabled = $false
    $script:SelectButton.Enabled = $false
    $script:DownloadButton.Enabled = $false
    $script:BurnButton.Enabled = $false
    $script:LogTextBox.Clear()

    Write-Log "Iniciando procesamiento de imagen..." "Info"
    Write-Log "Archivo: $ImageFile" "Info"

    $job = Start-Job -ScriptBlock {
        param($ImagePath, $ScriptRoot)

        try {
            # Import functions (simplified for job context)
            $result = @{
                Success = $false
                OutputPath = ""
                Error = ""
            }

            # Process image
            $workingImage = $ImagePath

            # Decompress if needed
            if ($ImagePath -match '\.(xz|zip)$') {
                if ($ImagePath -match '\.xz$') {
                    $7zPaths = @(
                        "$ScriptRoot\7za.exe",
                        "$env:ProgramFiles\7-Zip\7z.exe",
                        "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
                    )
                    $7z = $7zPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

                    if (-not $7z) {
                        # Download 7-Zip
                        $7zUrl = "https://www.7-zip.org/a/7za920.zip"
                        $7zZip = "$ScriptRoot\7za.zip"
                        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                        Invoke-WebRequest -Uri $7zUrl -OutFile $7zZip -UseBasicParsing
                        Expand-Archive -Path $7zZip -DestinationPath $ScriptRoot -Force
                        Remove-Item $7zZip -Force
                        $7z = "$ScriptRoot\7za.exe"
                    }

                    $outputDir = Split-Path -Parent $ImagePath
                    & $7z x $ImagePath -o"$outputDir" -y | Out-Null
                    $workingImage = $ImagePath -replace '\.xz$', ''
                }
                elseif ($ImagePath -match '\.zip$') {
                    $outputDir = Split-Path -Parent $ImagePath
                    Expand-Archive -Path $ImagePath -DestinationPath $outputDir -Force
                    $workingImage = (Get-ChildItem -Path $outputDir -Filter "*.img" | Select-Object -First 1).FullName
                }
            }

            # Mount image
            $disk = Mount-DiskImage -ImagePath $workingImage -PassThru
            Start-Sleep -Seconds 3
            $diskNumber = ($disk | Get-Disk).Number

            # Find boot partition
            $bootPartition = Get-Partition -DiskNumber $diskNumber | Where-Object { $_.Type -eq "FAT32" -or $_.Size -lt 1GB } | Select-Object -First 1

            $driveLetter = $bootPartition.DriveLetter
            if (-not $driveLetter) {
                $available = [char[]](68..90) | Where-Object { -not (Test-Path "$_`:") } | Select-Object -First 1
                $bootPartition | Set-Partition -NewDriveLetter $available
                $driveLetter = $available
                Start-Sleep -Seconds 1
            }

            $bootPath = "${driveLetter}:\"

            # Create firstrun.sh
            $firstRunScript = @'
#!/bin/bash
set +e
LOGFILE="/boot/firmware/homepinas-install.log"
MARKER="/boot/firmware/.homepinas-installed"
exec > >(tee -a "$LOGFILE") 2>&1
echo "HomePiNAS Automatic Installer - $(date)"
if [ -f "$MARKER" ]; then exit 0; fi
for i in $(seq 1 60); do ping -c 1 github.com &>/dev/null && break; sleep 2; done
if curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | bash; then
    touch "$MARKER"
    mount -o remount,rw /boot/firmware
    sed -i 's| systemd.run=/boot/firmware/firstrun.sh||g' /boot/firmware/cmdline.txt
    sed -i 's| systemd.run_success_action=reboot||g' /boot/firmware/cmdline.txt
    sync; sleep 10; reboot
fi
'@
            $firstRunScript = $firstRunScript -replace "`r`n", "`n"
            [System.IO.File]::WriteAllText("$bootPath\firstrun.sh", $firstRunScript, [System.Text.UTF8Encoding]::new($false))

            # Modify cmdline.txt
            $cmdlinePath = "$bootPath\cmdline.txt"
            if (Test-Path $cmdlinePath) {
                $cmdline = (Get-Content $cmdlinePath -Raw).Trim()
                if ($cmdline -notmatch "systemd.run=") {
                    $cmdline += " systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot"
                    [System.IO.File]::WriteAllText($cmdlinePath, $cmdline, [System.Text.UTF8Encoding]::new($false))
                }
            }

            # Enable SSH
            New-Item -ItemType File -Path "$bootPath\ssh" -Force | Out-Null

            # Dismount
            Start-Sleep -Seconds 1
            Get-Partition -DiskNumber $diskNumber | ForEach-Object {
                if ($_.DriveLetter) {
                    Remove-PartitionAccessPath -DiskNumber $diskNumber -PartitionNumber $_.PartitionNumber -AccessPath "$($_.DriveLetter):\" -ErrorAction SilentlyContinue
                }
            }
            Get-DiskImage | Where-Object { $_.Number -eq $diskNumber } | Dismount-DiskImage

            # Rename output
            $outputPath = $workingImage -replace '\.img$', '-homepinas.img'
            if ($workingImage -ne $outputPath) {
                Move-Item -Path $workingImage -Destination $outputPath -Force
            }

            $result.Success = $true
            $result.OutputPath = $outputPath

        } catch {
            $result.Success = $false
            $result.Error = $_.Exception.Message

            # Cleanup on error
            try { Get-DiskImage | Dismount-DiskImage -ErrorAction SilentlyContinue } catch {}
        }

        return $result

    } -ArgumentList $ImageFile, $PSScriptRoot

    # Monitor job progress
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
        if ($job.State -eq "Completed") {
            $timer.Stop()
            $result = Receive-Job -Job $job
            Remove-Job -Job $job

            if ($result.Success) {
                Update-Progress -Percent 100 -Status "Completado!"
                Write-Log "=" * 50 "Info"
                Write-Log "IMAGEN CREADA EXITOSAMENTE" "Success"
                Write-Log "=" * 50 "Info"
                Write-Log "Archivo: $($result.OutputPath)" "Success"
                Write-Log "" "Info"
                Write-Log "Ahora puedes grabar la imagen en una SD/USB (paso 4)" "Info"

                # Save processed image path for burning
                $script:ProcessedImagePath = $result.OutputPath

                # Enable burn button if drives available
                if ($script:RemovableDrives.Count -gt 0) {
                    $script:BurnButton.Enabled = $true
                }

                [System.Windows.Forms.MessageBox]::Show(
                    "Imagen creada exitosamente!`n`nArchivo:`n$($result.OutputPath)`n`nAhora puedes grabarla en una SD/USB usando el paso 4.",
                    "HomePiNAS Image Builder",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                )
            } else {
                Update-Progress -Percent 0 -Status "Error"
                Write-Log "ERROR: $($result.Error)" "Error"

                [System.Windows.Forms.MessageBox]::Show(
                    "Error procesando la imagen:`n`n$($result.Error)",
                    "HomePiNAS Image Builder",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Error
                )
            }

            $script:ProcessButton.Enabled = $true
            $script:SelectButton.Enabled = $true
            $script:DownloadButton.Enabled = $true
        }
        elseif ($job.State -eq "Failed") {
            $timer.Stop()
            Write-Log "Error en el proceso" "Error"
            $script:ProcessButton.Enabled = $true
            $script:SelectButton.Enabled = $true
        }
    })

    Update-Progress -Percent 10 -Status "Procesando..."
    $timer.Start()
}

# ============================================================================
# GUI CONSTRUCTION
# ============================================================================

function Show-MainForm {
    # Main Form
    $script:MainForm = New-Object System.Windows.Forms.Form
    $script:MainForm.Text = "HomePiNAS Image Builder v$script:Version"
    $script:MainForm.Size = New-Object System.Drawing.Size(700, 720)
    $script:MainForm.StartPosition = "CenterScreen"
    $script:MainForm.FormBorderStyle = "FixedSingle"
    $script:MainForm.MaximizeBox = $false
    $script:MainForm.BackColor = $script:Colors.Background

    # Set icon
    $icon = Get-IconFromBase64 -Base64 $script:IconBase64
    if ($icon) { $script:MainForm.Icon = $icon }

    # Header Panel
    $headerPanel = New-Object System.Windows.Forms.Panel
    $headerPanel.Size = New-Object System.Drawing.Size(700, 100)
    $headerPanel.Location = New-Object System.Drawing.Point(0, 0)
    $headerPanel.BackColor = $script:Colors.Primary
    $script:MainForm.Controls.Add($headerPanel)

    # Title Label
    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = "HomePiNAS Image Builder"
    $titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
    $titleLabel.ForeColor = [System.Drawing.Color]::White
    $titleLabel.AutoSize = $true
    $titleLabel.Location = New-Object System.Drawing.Point(30, 20)
    $headerPanel.Controls.Add($titleLabel)

    # Subtitle Label
    $subtitleLabel = New-Object System.Windows.Forms.Label
    $subtitleLabel.Text = "Homelabs.club Edition - Crea imagenes personalizadas de Raspberry Pi OS"
    $subtitleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $subtitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(200, 255, 255, 255)
    $subtitleLabel.AutoSize = $true
    $subtitleLabel.Location = New-Object System.Drawing.Point(30, 58)
    $headerPanel.Controls.Add($subtitleLabel)

    # Content Panel
    $contentPanel = New-Object System.Windows.Forms.Panel
    $contentPanel.Size = New-Object System.Drawing.Size(660, 555)
    $contentPanel.Location = New-Object System.Drawing.Point(20, 120)
    $contentPanel.BackColor = $script:Colors.Surface
    $script:MainForm.Controls.Add($contentPanel)

    # Add rounded corners effect (border)
    $contentPanel.BorderStyle = "FixedSingle"

    # Step 1: Select Image
    $step1Label = New-Object System.Windows.Forms.Label
    $step1Label.Text = "1. Seleccionar imagen de Raspberry Pi OS"
    $step1Label.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
    $step1Label.ForeColor = $script:Colors.TextPrimary
    $step1Label.Location = New-Object System.Drawing.Point(20, 20)
    $step1Label.AutoSize = $true
    $contentPanel.Controls.Add($step1Label)

    # File path textbox
    $script:FilePathTextBox = New-Object System.Windows.Forms.TextBox
    $script:FilePathTextBox.Size = New-Object System.Drawing.Size(390, 30)
    $script:FilePathTextBox.Location = New-Object System.Drawing.Point(20, 50)
    $script:FilePathTextBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $script:FilePathTextBox.ReadOnly = $true
    $script:FilePathTextBox.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
    $script:FilePathTextBox.Text = "Ninguna imagen seleccionada..."
    $contentPanel.Controls.Add($script:FilePathTextBox)

    # Download button (new)
    $script:DownloadButton = New-Object System.Windows.Forms.Button
    $script:DownloadButton.Text = "Descargar RPi OS"
    $script:DownloadButton.Size = New-Object System.Drawing.Size(115, 30)
    $script:DownloadButton.Location = New-Object System.Drawing.Point(420, 50)
    $script:DownloadButton.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $script:DownloadButton.BackColor = $script:Colors.Success
    $script:DownloadButton.ForeColor = [System.Drawing.Color]::White
    $script:DownloadButton.FlatStyle = "Flat"
    $script:DownloadButton.FlatAppearance.BorderSize = 0
    $script:DownloadButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $contentPanel.Controls.Add($script:DownloadButton)

    $script:DownloadButton.Add_Click({
        Start-RpiOsDownload
    })

    # Select button
    $script:SelectButton = New-Object System.Windows.Forms.Button
    $script:SelectButton.Text = "Examinar..."
    $script:SelectButton.Size = New-Object System.Drawing.Size(95, 30)
    $script:SelectButton.Location = New-Object System.Drawing.Point(545, 50)
    $script:SelectButton.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $script:SelectButton.BackColor = $script:Colors.Primary
    $script:SelectButton.ForeColor = [System.Drawing.Color]::White
    $script:SelectButton.FlatStyle = "Flat"
    $script:SelectButton.FlatAppearance.BorderSize = 0
    $script:SelectButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $contentPanel.Controls.Add($script:SelectButton)

    $script:SelectButton.Add_Click({
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "Seleccionar imagen de Raspberry Pi OS"
        $dialog.Filter = "Imagenes (*.img;*.img.xz;*.zip)|*.img;*.img.xz;*.zip|Todos los archivos (*.*)|*.*"
        $dialog.InitialDirectory = "$env:USERPROFILE\Downloads"

        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $script:FilePathTextBox.Text = $dialog.FileName
            $script:ProcessButton.Enabled = $true
        }
    })

    # Supported formats info
    $formatLabel = New-Object System.Windows.Forms.Label
    $formatLabel.Text = "Compatible con CM5, Pi5, Pi4 (64-bit) | Formatos: .img, .img.xz, .zip"
    $formatLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $formatLabel.ForeColor = $script:Colors.TextSecondary
    $formatLabel.Location = New-Object System.Drawing.Point(20, 85)
    $formatLabel.AutoSize = $true
    $contentPanel.Controls.Add($formatLabel)

    # Download link
    $downloadLink = New-Object System.Windows.Forms.LinkLabel
    $downloadLink.Text = "O descarga manualmente desde raspberrypi.com"
    $downloadLink.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $downloadLink.Location = New-Object System.Drawing.Point(20, 105)
    $downloadLink.AutoSize = $true
    $downloadLink.LinkColor = $script:Colors.Primary
    $contentPanel.Controls.Add($downloadLink)

    $downloadLink.Add_Click({
        Start-Process "https://www.raspberrypi.com/software/operating-systems/"
    })

    # Progress section
    $progressLabel = New-Object System.Windows.Forms.Label
    $progressLabel.Text = "2. Progreso"
    $progressLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
    $progressLabel.ForeColor = $script:Colors.TextPrimary
    $progressLabel.Location = New-Object System.Drawing.Point(20, 140)
    $progressLabel.AutoSize = $true
    $contentPanel.Controls.Add($progressLabel)

    # Progress bar
    $script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
    $script:ProgressBar.Size = New-Object System.Drawing.Size(620, 25)
    $script:ProgressBar.Location = New-Object System.Drawing.Point(20, 170)
    $script:ProgressBar.Style = "Continuous"
    $contentPanel.Controls.Add($script:ProgressBar)

    # Status label
    $script:StatusLabel = New-Object System.Windows.Forms.Label
    $script:StatusLabel.Text = "Esperando..."
    $script:StatusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $script:StatusLabel.ForeColor = $script:Colors.TextSecondary
    $script:StatusLabel.Location = New-Object System.Drawing.Point(20, 200)
    $script:StatusLabel.AutoSize = $true
    $contentPanel.Controls.Add($script:StatusLabel)

    # Log section
    $logLabel = New-Object System.Windows.Forms.Label
    $logLabel.Text = "3. Registro de actividad"
    $logLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
    $logLabel.ForeColor = $script:Colors.TextPrimary
    $logLabel.Location = New-Object System.Drawing.Point(20, 230)
    $logLabel.AutoSize = $true
    $contentPanel.Controls.Add($logLabel)

    # Log textbox
    $script:LogTextBox = New-Object System.Windows.Forms.RichTextBox
    $script:LogTextBox.Size = New-Object System.Drawing.Size(620, 90)
    $script:LogTextBox.Location = New-Object System.Drawing.Point(20, 260)
    $script:LogTextBox.Font = New-Object System.Drawing.Font("Consolas", 9)
    $script:LogTextBox.ReadOnly = $true
    $script:LogTextBox.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
    $script:LogTextBox.ForeColor = [System.Drawing.Color]::White
    $script:LogTextBox.BorderStyle = "None"
    $contentPanel.Controls.Add($script:LogTextBox)

    # Process button
    $script:ProcessButton = New-Object System.Windows.Forms.Button
    $script:ProcessButton.Text = "CREAR IMAGEN HOMEPINAS"
    $script:ProcessButton.Size = New-Object System.Drawing.Size(620, 40)
    $script:ProcessButton.Location = New-Object System.Drawing.Point(20, 360)
    $script:ProcessButton.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $script:ProcessButton.BackColor = $script:Colors.Success
    $script:ProcessButton.ForeColor = [System.Drawing.Color]::White
    $script:ProcessButton.FlatStyle = "Flat"
    $script:ProcessButton.FlatAppearance.BorderSize = 0
    $script:ProcessButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $script:ProcessButton.Enabled = $false
    $contentPanel.Controls.Add($script:ProcessButton)

    $script:ProcessButton.Add_Click({
        $imagePath = $script:FilePathTextBox.Text
        if ($imagePath -and (Test-Path $imagePath)) {
            Start-ImageProcessing -ImageFile $imagePath
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                "Por favor, selecciona una imagen valida primero.",
                "HomePiNAS Image Builder",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
        }
    })

    # ============================================================================
    # USB/SD BURN SECTION
    # ============================================================================

    # Separator line
    $separatorPanel = New-Object System.Windows.Forms.Panel
    $separatorPanel.Size = New-Object System.Drawing.Size(620, 1)
    $separatorPanel.Location = New-Object System.Drawing.Point(20, 415)
    $separatorPanel.BackColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
    $contentPanel.Controls.Add($separatorPanel)

    # Step 4: Burn to USB
    $step4Label = New-Object System.Windows.Forms.Label
    $step4Label.Text = "4. Grabar en tarjeta SD / USB"
    $step4Label.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
    $step4Label.ForeColor = $script:Colors.TextPrimary
    $step4Label.Location = New-Object System.Drawing.Point(20, 425)
    $step4Label.AutoSize = $true
    $contentPanel.Controls.Add($step4Label)

    # Drive combo box
    $script:DriveComboBox = New-Object System.Windows.Forms.ComboBox
    $script:DriveComboBox.Size = New-Object System.Drawing.Size(420, 30)
    $script:DriveComboBox.Location = New-Object System.Drawing.Point(20, 455)
    $script:DriveComboBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $script:DriveComboBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $contentPanel.Controls.Add($script:DriveComboBox)

    # Refresh button
    $script:RefreshButton = New-Object System.Windows.Forms.Button
    $script:RefreshButton.Text = "Actualizar"
    $script:RefreshButton.Size = New-Object System.Drawing.Size(90, 30)
    $script:RefreshButton.Location = New-Object System.Drawing.Point(450, 455)
    $script:RefreshButton.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $script:RefreshButton.BackColor = $script:Colors.Primary
    $script:RefreshButton.ForeColor = [System.Drawing.Color]::White
    $script:RefreshButton.FlatStyle = "Flat"
    $script:RefreshButton.FlatAppearance.BorderSize = 0
    $script:RefreshButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $contentPanel.Controls.Add($script:RefreshButton)

    $script:RefreshButton.Add_Click({
        Update-DriveList
        Write-Log "Lista de unidades actualizada" "Info"
    })

    # Burn button
    $script:BurnButton = New-Object System.Windows.Forms.Button
    $script:BurnButton.Text = "GRABAR"
    $script:BurnButton.Size = New-Object System.Drawing.Size(90, 30)
    $script:BurnButton.Location = New-Object System.Drawing.Point(550, 455)
    $script:BurnButton.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $script:BurnButton.BackColor = $script:Colors.Warning
    $script:BurnButton.ForeColor = [System.Drawing.Color]::White
    $script:BurnButton.FlatStyle = "Flat"
    $script:BurnButton.FlatAppearance.BorderSize = 0
    $script:BurnButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $script:BurnButton.Enabled = $false
    $contentPanel.Controls.Add($script:BurnButton)

    $script:BurnButton.Add_Click({
        if ($script:RemovableDrives.Count -gt 0 -and $script:ProcessedImagePath) {
            $selectedIndex = $script:DriveComboBox.SelectedIndex
            if ($selectedIndex -ge 0 -and $selectedIndex -lt $script:RemovableDrives.Count) {
                $selectedDrive = $script:RemovableDrives[$selectedIndex]
                Write-ImageToDrive -ImagePath $script:ProcessedImagePath -DiskNumber $selectedDrive.Number
            }
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                "Primero debes crear la imagen HomePiNAS (paso anterior).",
                "HomePiNAS Image Builder",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
        }
    })

    # USB info label
    $usbInfoLabel = New-Object System.Windows.Forms.Label
    $usbInfoLabel.Text = "Inserta una tarjeta SD o USB y pulsa 'Actualizar' para detectarla"
    $usbInfoLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $usbInfoLabel.ForeColor = $script:Colors.TextSecondary
    $usbInfoLabel.Location = New-Object System.Drawing.Point(20, 490)
    $usbInfoLabel.AutoSize = $true
    $contentPanel.Controls.Add($usbInfoLabel)

    # Warning label
    $warningLabel = New-Object System.Windows.Forms.Label
    $warningLabel.Text = "⚠ ATENCION: Grabar borrara TODOS los datos de la unidad seleccionada"
    $warningLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $warningLabel.ForeColor = $script:Colors.Error
    $warningLabel.Location = New-Object System.Drawing.Point(20, 510)
    $warningLabel.AutoSize = $true
    $contentPanel.Controls.Add($warningLabel)

    # Initialize variables
    $script:ProcessedImagePath = $null
    $script:RemovableDrives = @()

    # Footer
    $footerLabel = New-Object System.Windows.Forms.Label
    $footerLabel.Text = "homelabs.club - github.com/juanlusoft/homepinas-v2"
    $footerLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8)
    $footerLabel.ForeColor = $script:Colors.TextSecondary
    $footerLabel.Location = New-Object System.Drawing.Point(20, 685)
    $footerLabel.AutoSize = $true
    $script:MainForm.Controls.Add($footerLabel)

    # Form Shown event - write initial log after form is ready
    $script:MainForm.Add_Shown({
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            Write-Log "ADVERTENCIA: Esta aplicacion requiere permisos de Administrador" "Warning"
            Write-Log "Reinicia como Administrador para continuar" "Warning"
            $script:SelectButton.Enabled = $false
            $script:DownloadButton.Enabled = $false
            $script:ProcessButton.Enabled = $false
            $script:RefreshButton.Enabled = $false
        } else {
            Write-Log "Aplicacion iniciada correctamente" "Success"
            Write-Log "Descarga o selecciona una imagen de Raspberry Pi OS" "Info"
            Update-DriveList
        }
    })

    # Show form
    [void]$script:MainForm.ShowDialog()
}

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if ($Silent -and $ImagePath) {
    # Silent mode for command-line usage
    Write-Host "HomePiNAS Image Builder v$script:Version" -ForegroundColor Cyan
    Write-Host "Procesando: $ImagePath" -ForegroundColor White
    # Add silent processing logic here
} else {
    # GUI mode
    Show-MainForm
}
