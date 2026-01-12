import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

import screenshot from 'screenshot-desktop'

const server = process.env.SAILAWAY_SERVER ?? 'http://localhost:8080'
const update_time_ms = Number(process.env.SAILAWAY_UPDATE_MS ?? 100) // ms
const apply_controls = (process.env.SAILAWAY_APPLY_CONTROLS ?? '1') !== '0'

function execFileAsync(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout
                err.stderr = stderr
                reject(err)
                return
            }
            resolve({ stdout, stderr })
        })
    })
}

function generate_session_id() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return crypto.randomBytes(16).toString('hex')
}

async function get_or_create_session_id() {
    // Explicit override always wins.
    const fromEnv = process.env.SAILAWAY_SESSION_ID
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
        return fromEnv.trim()
    }

    // Persisted id for convenience so reconnecting doesn't require copying a new id.
    // Use a stable per-user location.
    const dir = path.join(os.homedir(), '.sailaway')
    const file = path.join(dir, 'session_id.txt')

    try {
        const existing = await fs.readFile(file, 'utf8')
        const id = existing.trim()
        if (id) return id
    } catch {
        // ignore
    }

    const session_id = generate_session_id()
    try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(file, `${session_id}\n`, { encoding: 'utf8' })
    } catch {
        // ignore: still return generated id even if we can't persist
    }
    return session_id
}

async function post_image(session_id, image_buffer) {
    if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available. Use Node.js 18+ or add a fetch polyfill.')
    }

    const res = await fetch(`${server}/api/session/${session_id}/image`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream'
        },
        body: image_buffer
    })

    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Upload failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`)
    }
}

async function get_controls(session_id) {
    if (typeof fetch !== 'function') {
        return null
    }

    try {
        const res = await fetch(`${server}/api/session/${session_id}/controls`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        })

        if (!res.ok) {
            return null
        }

        const json = await res.json().catch(() => null)
        return json?.controls ?? null
    } catch {
        return null
    }
}

function codeToWindowsVk(code) {
    if (typeof code !== 'string' || !code) return null

    if (code.startsWith('Key') && code.length === 4) {
        const letter = code.slice(3).toUpperCase()
        const vk = letter.charCodeAt(0)
        if (vk >= 0x41 && vk <= 0x5A) return vk
    }
    if (code.startsWith('Digit') && code.length === 6) {
        const digit = code.slice(5)
        const vk = digit.charCodeAt(0)
        if (vk >= 0x30 && vk <= 0x39) return vk
    }
    if (code.startsWith('F')) {
        const n = Number(code.slice(1))
        if (Number.isFinite(n) && n >= 1 && n <= 24) return 0x70 + (n - 1) // VK_F1..VK_F24
    }

    switch (code) {
        case 'ArrowUp': return 0x26 // VK_UP
        case 'ArrowDown': return 0x28 // VK_DOWN
        case 'ArrowLeft': return 0x25 // VK_LEFT
        case 'ArrowRight': return 0x27 // VK_RIGHT
        case 'Space': return 0x20 // VK_SPACE
        case 'Enter': return 0x0D // VK_RETURN
        case 'Escape': return 0x1B // VK_ESCAPE
        case 'Tab': return 0x09 // VK_TAB
        case 'Backspace': return 0x08 // VK_BACK
        case 'CapsLock': return 0x14 // VK_CAPITAL
        case 'ShiftLeft':
        case 'ShiftRight': return 0x10 // VK_SHIFT
        case 'ControlLeft':
        case 'ControlRight': return 0x11 // VK_CONTROL
        case 'AltLeft':
        case 'AltRight': return 0x12 // VK_MENU
        case 'MetaLeft':
        case 'MetaRight': return 0x5B // VK_LWIN
        default: return null
    }
}

function codeToXdotoolKey(code) {
    if (typeof code !== 'string' || !code) return null

    if (code.startsWith('Key') && code.length === 4) {
        return code.slice(3).toLowerCase()
    }
    if (code.startsWith('Digit') && code.length === 6) {
        return code.slice(5)
    }
    if (code.startsWith('F')) {
        // F1..F24
        const n = Number(code.slice(1))
        if (Number.isFinite(n) && n >= 1 && n <= 24) return `F${n}`
    }

    switch (code) {
        case 'ArrowUp': return 'Up'
        case 'ArrowDown': return 'Down'
        case 'ArrowLeft': return 'Left'
        case 'ArrowRight': return 'Right'
        case 'Space': return 'space'
        case 'Enter': return 'Return'
        case 'Escape': return 'Escape'
        case 'Tab': return 'Tab'
        case 'Backspace': return 'BackSpace'
        case 'CapsLock': return 'Caps_Lock'
        case 'ShiftLeft': return 'Shift_L'
        case 'ShiftRight': return 'Shift_R'
        case 'ControlLeft': return 'Control_L'
        case 'ControlRight': return 'Control_R'
        case 'AltLeft': return 'Alt_L'
        case 'AltRight': return 'Alt_R'
        case 'MetaLeft': return 'Super_L'
        case 'MetaRight': return 'Super_R'
        default: return null
    }
}

function buttonMaskToXdotoolButtons(mask) {
    // DOM MouseEvent.buttons bitmask.
    // left=1, right=2, middle=4, back=8, forward=16
    const mapping = [
        { bit: 1, button: 1 },
        { bit: 2, button: 3 },
        { bit: 4, button: 2 },
        { bit: 8, button: 8 },
        { bit: 16, button: 9 },
    ]
    const buttons = []
    for (const m of mapping) {
        if ((mask & m.bit) !== 0) buttons.push(m.button)
    }
    return buttons
}

async function getDisplayGeometry() {
    // xdotool prints "<width> <height>".
    const { stdout } = await execFileAsync('xdotool', ['getdisplaygeometry'])
    const parts = String(stdout).trim().split(/\s+/)
    const width = Number(parts[0])
    const height = Number(parts[1])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid geometry from xdotool: ${stdout}`)
    }
    return { width, height }
}

async function getDisplayGeometryWindows() {
    // Uses .NET to read primary screen bounds.
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
        'Write-Output "$($b.Width) $($b.Height)";'
    ].join(' ')
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    const parts = String(stdout).trim().split(/\s+/)
    const width = Number(parts[0])
    const height = Number(parts[1])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid geometry from powershell: ${stdout}`)
    }
    return { width, height }
}

function createWindowsInputDriver() {
    // Persistent PowerShell process that reads JSON commands on stdin and applies them via user32.dll.
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    })

    const bootstrap = String.raw`
$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Runtime.InteropServices;
public static class WinInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $signature -Language CSharp

function MouseDown([int]$button) {
    switch ($button) {
        1 { [WinInput]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero) } # LEFTDOWN
        2 { [WinInput]::mouse_event(0x0020,0,0,0,[UIntPtr]::Zero) } # MIDDLEDOWN
        3 { [WinInput]::mouse_event(0x0008,0,0,0,[UIntPtr]::Zero) } # RIGHTDOWN
        8 { [WinInput]::mouse_event(0x0080,0,0,1,[UIntPtr]::Zero) } # XDOWN XBUTTON1
        9 { [WinInput]::mouse_event(0x0080,0,0,2,[UIntPtr]::Zero) } # XDOWN XBUTTON2
    }
}
function MouseUp([int]$button) {
    switch ($button) {
        1 { [WinInput]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero) } # LEFTUP
        2 { [WinInput]::mouse_event(0x0040,0,0,0,[UIntPtr]::Zero) } # MIDDLEUP
        3 { [WinInput]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero) } # RIGHTUP
        8 { [WinInput]::mouse_event(0x0100,0,0,1,[UIntPtr]::Zero) } # XUP XBUTTON1
        9 { [WinInput]::mouse_event(0x0100,0,0,2,[UIntPtr]::Zero) } # XUP XBUTTON2
    }
}
function KeyDown([int]$vk) {
    [WinInput]::keybd_event([byte]$vk, 0, 0x0000, [UIntPtr]::Zero)
}
function KeyUp([int]$vk) {
    [WinInput]::keybd_event([byte]$vk, 0, 0x0002, [UIntPtr]::Zero)
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $msg = $line | ConvertFrom-Json
    $type = $msg.type
    if ($type -eq 'mousemove') {
        [WinInput]::SetCursorPos([int]$msg.x, [int]$msg.y) | Out-Null
    } elseif ($type -eq 'mousedown') {
        MouseDown([int]$msg.button)
    } elseif ($type -eq 'mouseup') {
        MouseUp([int]$msg.button)
    } elseif ($type -eq 'keydown') {
        KeyDown([int]$msg.vk)
    } elseif ($type -eq 'keyup') {
        KeyUp([int]$msg.vk)
    }
}
`

    ps.stdin.write(bootstrap)
    ps.stdin.write('\n')

    async function send(msg) {
        if (ps.killed) throw new Error('powershell input driver exited')
        const line = JSON.stringify(msg) + '\n'
        if (!ps.stdin.write(line)) {
            await new Promise((resolve) => ps.stdin.once('drain', resolve))
        }
    }

    return {
        send,
        process: ps,
    }
}

async function applyControlsWithWindows(state, controls, geometry, driver) {
    if (!controls) return state

    const time = Number(controls.time ?? 0)
    if (Number.isFinite(time) && time > 0 && time <= state.lastAppliedTime) {
        return state
    }

    const mouse = controls.mouse ?? null
    if (mouse && typeof mouse.x === 'number' && typeof mouse.y === 'number') {
        const x = Math.max(0, Math.min(geometry.width - 1, Math.round(mouse.x * (geometry.width - 1))))
        const y = Math.max(0, Math.min(geometry.height - 1, Math.round(mouse.y * (geometry.height - 1))))
        if (x !== state.lastMouseX || y !== state.lastMouseY) {
            await driver.send({ type: 'mousemove', x, y })
            state.lastMouseX = x
            state.lastMouseY = y
        }

        const nextMask = Number(mouse.buttons ?? 0) | 0
        const prevMask = state.lastButtonsMask | 0
        if (nextMask !== prevMask) {
            const nextButtons = new Set(buttonMaskToXdotoolButtons(nextMask))
            const prevButtons = new Set(buttonMaskToXdotoolButtons(prevMask))

            for (const b of prevButtons) {
                if (!nextButtons.has(b)) {
                    await driver.send({ type: 'mouseup', button: b })
                }
            }
            for (const b of nextButtons) {
                if (!prevButtons.has(b)) {
                    await driver.send({ type: 'mousedown', button: b })
                }
            }
            state.lastButtonsMask = nextMask
        }
    }

    const keysDown = controls.keys?.down
    if (Array.isArray(keysDown)) {
        const nextKeys = new Set()
        for (const code of keysDown) {
            const vk = codeToWindowsVk(code)
            if (vk != null) nextKeys.add(vk)
        }

        for (const vk of state.lastKeysDown) {
            if (!nextKeys.has(vk)) {
                await driver.send({ type: 'keyup', vk })
            }
        }
        for (const vk of nextKeys) {
            if (!state.lastKeysDown.has(vk)) {
                await driver.send({ type: 'keydown', vk })
            }
        }
        state.lastKeysDown = nextKeys
    }

    if (Number.isFinite(time) && time > 0) {
        state.lastAppliedTime = time
    }
    return state
}

async function applyControlsWithXdotool(state, controls, geometry) {
    if (!controls) return state

    const time = Number(controls.time ?? 0)
    if (Number.isFinite(time) && time > 0 && time <= state.lastAppliedTime) {
        return state
    }

    // Mouse
    const mouse = controls.mouse ?? null
    if (mouse && typeof mouse.x === 'number' && typeof mouse.y === 'number') {
        const x = Math.max(0, Math.min(geometry.width - 1, Math.round(mouse.x * (geometry.width - 1))))
        const y = Math.max(0, Math.min(geometry.height - 1, Math.round(mouse.y * (geometry.height - 1))))
        if (x !== state.lastMouseX || y !== state.lastMouseY) {
            await execFileAsync('xdotool', ['mousemove', '--sync', String(x), String(y)])
            state.lastMouseX = x
            state.lastMouseY = y
        }

        const nextMask = Number(mouse.buttons ?? 0) | 0
        const prevMask = state.lastButtonsMask | 0
        if (nextMask !== prevMask) {
            const nextButtons = new Set(buttonMaskToXdotoolButtons(nextMask))
            const prevButtons = new Set(buttonMaskToXdotoolButtons(prevMask))

            for (const b of prevButtons) {
                if (!nextButtons.has(b)) {
                    await execFileAsync('xdotool', ['mouseup', String(b)])
                }
            }
            for (const b of nextButtons) {
                if (!prevButtons.has(b)) {
                    await execFileAsync('xdotool', ['mousedown', String(b)])
                }
            }
            state.lastButtonsMask = nextMask
        }
    }

    // Keyboard
    const keysDown = controls.keys?.down
    if (Array.isArray(keysDown)) {
        const nextKeys = new Set()
        for (const code of keysDown) {
            const key = codeToXdotoolKey(code)
            if (key) nextKeys.add(key)
        }

        for (const key of state.lastKeysDown) {
            if (!nextKeys.has(key)) {
                await execFileAsync('xdotool', ['keyup', key])
            }
        }
        for (const key of nextKeys) {
            if (!state.lastKeysDown.has(key)) {
                await execFileAsync('xdotool', ['keydown', key])
            }
        }
        state.lastKeysDown = nextKeys
    }

    if (Number.isFinite(time) && time > 0) {
        state.lastAppliedTime = time
    }
    return state
}

async function main() {
    const session_id = await get_or_create_session_id()
    console.log(`session_id=${session_id}`)
    console.log(`server=${server}`)
    console.log(`interval_ms=${update_time_ms}`)
    console.log(`apply_controls=${apply_controls}`)

    const platform = process.platform
    let geometry = null
    let canApplyControls = false
    let windowsDriver = null
    if (apply_controls) {
        try {
            if (platform === 'win32') {
                geometry = await getDisplayGeometryWindows()
                windowsDriver = createWindowsInputDriver()
                canApplyControls = true
                console.log(`[client] windows display geometry: ${geometry.width}x${geometry.height}`)
            } else {
                geometry = await getDisplayGeometry()
                canApplyControls = true
                console.log(`[client] xdotool display geometry: ${geometry.width}x${geometry.height}`)
            }
        } catch (err) {
            canApplyControls = false
            console.warn(`[client] controls disabled (input backend failed): ${err?.message ?? err}`)
        }
    }

    /** @type {{ lastAppliedTime: number, lastKeysDown: Set<any>, lastButtonsMask: number, lastMouseX: number, lastMouseY: number }} */
    let controlState = {
        lastAppliedTime: 0,
        lastKeysDown: new Set(),
        lastButtonsMask: 0,
        lastMouseX: -1,
        lastMouseY: -1,
    }

    // Viewer-driven sending: at start timer is 0 -> no images.
    let hasWakeSignal = false

    const tick = async () => {
        if (!hasWakeSignal) return

        try {
            // screenshot-desktop returns a PNG buffer by default.
            const image_buffer = await screenshot({ format: 'jpg' })
            await post_image(session_id, image_buffer)
            // console.log('posted')
        } catch (err) {
            console.error(`[client] frame upload error: ${err?.message ?? err}`)
        }
    }

    const controlTick = async () => {
        if (!canApplyControls || !geometry) return

        try {
            const controls = await get_controls(session_id)
            if (!controls) return

            // Wake protocol:
            // - Client only sends images after seeing the wake marker.
            // - Once woken, any received control packet resets the 60s send window.
            if (Date.now() - controls.time < 30_000) {
                hasWakeSignal = true
            }
            else {
                hasWakeSignal = false
            }

            if (platform === 'win32') {
                if (!windowsDriver) return
                controlState = await applyControlsWithWindows(controlState, controls, geometry, windowsDriver)
            } else {
                controlState = await applyControlsWithXdotool(controlState, controls, geometry)
            }
        } catch {
            // No-op: controls are optional and may not be available yet.
        }
    }

    setInterval(() => {
        void tick()
    }, update_time_ms)

    // Poll controls at the same cadence as streaming.
    if (apply_controls) {
        await controlTick()
        setInterval(() => {
            void controlTick()
        }, update_time_ms)
    }
}

main().catch((err) => {
    console.error(err)
    process.exitCode = 1
})