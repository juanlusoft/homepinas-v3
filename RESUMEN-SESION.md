# HomePiNAS v2 - Resumen de Sesion

**Fecha:** 28 Enero 2026

## Lo que se hizo hoy

### 1. Image Builder para Windows (Aplicacion Completa)

Se creo una aplicacion profesional de Windows para crear imagenes de Raspberry Pi OS con HomePiNAS preconfigurado.

**Ubicacion:** `image-builder/windows/`

**Archivos:**
- `HomePiNAS-ImageBuilder.ps1` - Aplicacion principal (~1300 lineas)
- `HomePiNAS-ImageBuilder-x64.exe` - Ejecutable para Windows 64-bit
- `HomePiNAS-ImageBuilder-x86.exe` - Ejecutable para Windows 32-bit
- `HomePiNAS-ImageBuilder.bat` - Lanzador alternativo
- `Build-Executable.ps1` - Script para recompilar el .exe
- `LEEME.txt` - Instrucciones en español

**Funcionalidades:**
1. **Descarga automatica** de Raspberry Pi OS Lite 64-bit (compatible CM5/Pi5/Pi4)
2. **Modificacion de imagen** - Añade instalador automatico de HomePiNAS
3. **Grabacion en SD/USB** - Detecta unidades y graba directamente
4. **Interfaz grafica** profesional con Windows Forms
5. **Barra de progreso** y log de actividad

### 2. Problemas resueltos

- **Error "Downloads" folder:** Cambiado `[Environment]::GetFolderPath("Downloads")` por `$env:USERPROFILE\Downloads`
- **Error threading GUI:** Añadido `IsHandleCreated` check y movido logs iniciales a `Form.Shown` event
- **SmartScreen bloqueando .exe:** Es normal (app no firmada), solucion: Propiedades → Desbloquear

### 3. Repositorio actualizado

**URL:** https://github.com/juanlusoft/homepinas-v2

**Branch:** main

**Ultima version del instalador:** Se actualiza automaticamente via GitHub Actions

## Pendiente / Posibles mejoras

1. **Firmar el ejecutable** - Requiere certificado de firma de codigo (~300€/año)
2. **Progreso real de grabacion** - Actualmente es estimado, podria mostrar MB/s
3. **Verificacion de imagen** - Checksum despues de grabar
4. **Soporte multi-idioma** - Actualmente solo español

## Como continuar mañana

### Para probar la aplicacion:
```
1. Descargar: https://github.com/juanlusoft/homepinas-v2/raw/main/image-builder/windows/HomePiNAS-ImageBuilder-x64.exe
2. Clic derecho → Propiedades → Desbloquear → Aceptar
3. Ejecutar (pedira permisos de Administrador)
4. Pulsar "Descargar RPi OS"
5. Pulsar "CREAR IMAGEN HOMEPINAS"
6. Insertar SD → Actualizar → Seleccionar → GRABAR
```

### Para modificar el codigo:
```powershell
cd C:\tmp\homepinas-v2-push\image-builder\windows

# Editar el script
notepad HomePiNAS-ImageBuilder.ps1

# Recompilar
powershell -ExecutionPolicy Bypass -File Build-Executable.ps1

# Subir cambios
cd C:\tmp\homepinas-v2-push
git add -A
git commit -m "Descripcion del cambio"
git pull --rebase origin main
git push origin main
```

### Directorios de trabajo:
- `C:\tmp\homepinas-v2` - Copia local principal
- `C:\tmp\homepinas-v2-push` - Copia para push a GitHub

## Arquitectura del Image Builder

```
Usuario ejecuta .exe
        ↓
    [GUI Windows Forms]
        ↓
    ┌─────────────────────────────────────┐
    │ 1. Descargar RPi OS                 │
    │    - Detecta ultima version         │
    │    - Descarga a Downloads/          │
    ├─────────────────────────────────────┤
    │ 2. Crear Imagen HomePiNAS           │
    │    - Descomprime .xz/.zip           │
    │    - Monta imagen como disco        │
    │    - Añade firstrun.sh              │
    │    - Modifica cmdline.txt           │
    │    - Habilita SSH                   │
    │    - Desmonta y renombra            │
    ├─────────────────────────────────────┤
    │ 3. Grabar en SD/USB                 │
    │    - Detecta unidades USB           │
    │    - Limpia disco                   │
    │    - Escribe imagen raw             │
    └─────────────────────────────────────┘
        ↓
    SD lista para Raspberry Pi
        ↓
    Boot → firstrun.sh → Instala HomePiNAS automaticamente
```

## Contacto

- **Web:** https://homelabs.club
- **GitHub:** https://github.com/juanlusoft/homepinas-v2
