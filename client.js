import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

import screenshot from 'screenshot-desktop'

const server = process.env.SAILAWAY_SERVER ?? 'http://localhost:8080'
const update_time_ms = Number(process.env.SAILAWAY_UPDATE_MS ?? 100) // ms
const apply_controls = (process.env.SAILAWAY_APPLY_CONTROLS ?? '1') !== '0'

const compress_images = (process.env.SAILAWAY_COMPRESS_IMAGES ?? '1') !== '0'
const image_format = String(process.env.SAILAWAY_IMAGE_FORMAT ?? 'jpeg').toLowerCase() // jpeg|webp|png
const image_quality = Number(process.env.SAILAWAY_IMAGE_QUALITY ?? 60) // 1..100
const image_max_dim = Number(process.env.SAILAWAY_IMAGE_MAX_DIM ?? 1280) // px (largest edge)

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

async function compress_image_buffer(image_buffer) {
    if (!compress_images) return image_buffer

    let sharp
    try {
        ; ({ default: sharp } = await import('sharp'))
    } catch {
        // If sharp isn't available for some reason, fall back to raw frames.
        return image_buffer
    }

    // Avoid re-encoding tiny/empty buffers.
    if (!image_buffer || image_buffer.length < 32) return image_buffer

    const quality = Number.isFinite(image_quality) ? Math.min(100, Math.max(1, Math.round(image_quality))) : 60
    const maxDim = Number.isFinite(image_max_dim) ? Math.max(1, Math.round(image_max_dim)) : 1280

    try {
        let pipeline = sharp(image_buffer, { failOnError: false })

        if (maxDim > 0) {
            pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        }

        switch (image_format) {
            case 'jpg':
            case 'jpeg':
                return await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
            case 'webp':
                return await pipeline.webp({ quality }).toBuffer()
            case 'png':
                // PNG is usually larger for desktop frames, but keep as an option.
                return await pipeline.png({ compressionLevel: 9 }).toBuffer()
            default:
                return await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
        }
    } catch {
        return image_buffer
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

function keyToWindowsVk(key) {
    if (typeof key !== 'string' || !key) return null

    // Prefer layout-dependent meaning from KeyboardEvent.key.
    if (key.length === 1) {
        const ch = key
        // Letters.
        if (/[a-zA-Z]/.test(ch)) {
            const up = ch.toUpperCase()
            const vk = up.charCodeAt(0)
            if (vk >= 0x41 && vk <= 0x5A) return vk
        }
        // Digits.
        if (/[0-9]/.test(ch)) {
            const vk = ch.charCodeAt(0)
            if (vk >= 0x30 && vk <= 0x39) return vk
        }
        if (ch === ' ') return 0x20 // VK_SPACE
    }

    // Named keys.
    switch (key) {
        case 'ArrowUp': return 0x26
        case 'ArrowDown': return 0x28
        case 'ArrowLeft': return 0x25
        case 'ArrowRight': return 0x27
        case 'Enter': return 0x0D
        case 'Escape': return 0x1B
        case 'Tab': return 0x09
        case 'Backspace': return 0x08
        case 'CapsLock': return 0x14
        case 'Shift': return 0x10
        case 'Control': return 0x11
        case 'Alt': return 0x12
        case 'Meta': return 0x5B
        case ' ': return 0x20
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

function keyToXdotoolKey(key) {
    if (typeof key !== 'string' || !key) return null

    if (key.length === 1) {
        const ch = key
        if (ch === ' ') return 'space'
        if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase()
        if (/[0-9]/.test(ch)) return ch
        // Punctuation/symbols: map to X11 keysym names understood by xdotool.
        // This is key for AZERTY where e.g. Shift+',' yields '?' (event.key='?').
        const punct = {
            '!': 'exclam',
            '"': 'quotedbl',
            '#': 'numbersign',
            '$': 'dollar',
            '%': 'percent',
            '&': 'ampersand',
            "'": 'apostrophe',
            '(': 'parenleft',
            ')': 'parenright',
            '*': 'asterisk',
            '+': 'plus',
            ',': 'comma',
            '-': 'minus',
            '.': 'period',
            '/': 'slash',
            ':': 'colon',
            ';': 'semicolon',
            '<': 'less',
            '=': 'equal',
            '>': 'greater',
            '?': 'question',
            '@': 'at',
            '[': 'bracketleft',
            '\\': 'backslash',
            ']': 'bracketright',
            '^': 'asciicircum',
            '_': 'underscore',
            '`': 'grave',
            '{': 'braceleft',
            '|': 'bar',
            '}': 'braceright',
            '~': 'asciitilde',
            '€': 'EuroSign',
        }

        return punct[ch] ?? null
    }

    switch (key) {
        case 'ArrowUp': return 'Up'
        case 'ArrowDown': return 'Down'
        case 'ArrowLeft': return 'Left'
        case 'ArrowRight': return 'Right'
        case 'Enter': return 'Return'
        case 'Escape': return 'Escape'
        case 'Tab': return 'Tab'
        case 'Backspace': return 'BackSpace'
        case 'CapsLock': return 'Caps_Lock'
        case 'Shift': return 'Shift_L'
        case 'Control': return 'Control_L'
        case 'Alt': return 'Alt_L'
        case 'Meta': return 'Super_L'
        case 'Space': return 'space'
        default: return null
    }
}

function normalizeKeyEntry(entry) {
    if (typeof entry === 'string') {
        return { code: entry, key: '' }
    }
    if (entry && typeof entry === 'object') {
        const code = typeof entry.code === 'string' ? entry.code : ''
        const key = typeof entry.key === 'string' ? entry.key : ''
        return { code, key }
    }
    return { code: '', key: '' }
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

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
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
function Wheel([int]$delta) {
    # MOUSEEVENTF_WHEEL = 0x0800
    [WinInput]::mouse_event(0x0800, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
}

function TypeText([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    # KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_KEYUP = 0x0002
    foreach ($ch in $text.ToCharArray()) {
        $inputs = @(
            New-Object WinInput+INPUT,
            New-Object WinInput+INPUT
        )
        $inputs[0].type = 1
        $inputs[0].U.ki.wVk = 0
        $inputs[0].U.ki.wScan = [uint16][int][char]$ch
        $inputs[0].U.ki.dwFlags = 0x0004
        $inputs[1].type = 1
        $inputs[1].U.ki.wVk = 0
        $inputs[1].U.ki.wScan = [uint16][int][char]$ch
        $inputs[1].U.ki.dwFlags = 0x0004 -bor 0x0002
        [WinInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type]WinInput+INPUT)) | Out-Null
    }
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
    } elseif ($type -eq 'wheel') {
        Wheel([int]$msg.delta)
    } elseif ($type -eq 'text') {
        TypeText([string]$msg.text)
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

let old_keys = {}
let old_mouse_btn = null
async function applyControlsWithWindows(state, controls, geometry, driver) {
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
            await driver.send({ type: 'mousemove', x, y })
            state.lastMouseX = x
            state.lastMouseY = y
        }

        const mouse_button = mouse.buttons
        if (old_mouse_btn != mouse_button) {

            await driver.send({ type: 'mouseup', button: old_mouse_btn })
            await driver.send({ type: 'mousedown', button: mouse_button })
            old_mouse_btn = mouse_button
        }

        // Wheel (one-shot, expressed in steps; positive = scroll down)
        const wheelY = Number(mouse.wheel?.y ?? 0)
        if (Number.isFinite(wheelY) && wheelY !== 0) {
            const steps = Math.max(-20, Math.min(20, Math.trunc(wheelY)))
            // Windows wheel delta: positive is typically scroll up; we use positive=down.
            const delta = -steps * 120
            if (delta !== 0) {
                await driver.send({ type: 'wheel', delta })
            }
        }
    }

    function toWindowsVkFromBrowserKeyCode(keyIntCode) {
        // Browser `KeyboardEvent.keyCode` is historically based on Windows Virtual-Key codes.
        const vk = Number(keyIntCode)
        if (!Number.isFinite(vk)) return null
        const int = vk | 0
        if (int < 0 || int > 255) return null
        return int
    }

    function sim_keydown(keyIntCode) {
        const vk = toWindowsVkFromBrowserKeyCode(keyIntCode)
        if (vk != null) {
            return driver.send({ type: 'keydown', vk })
        }
    }
    function sim_keyup(keyIntCode) {
        const vk = toWindowsVkFromBrowserKeyCode(keyIntCode)
        if (vk != null) {
            return driver.send({ type: 'keyup', vk })
        }
    }
    function sim_hold(keyIntCode) {
        // Held keys remain down until we send a keyup.
        // (We intentionally don't auto-repeat here.)
        void keyIntCode
    }

    const keysDown = controls.keys
    if (Array.isArray(keysDown)) {
        for (const keyIntCode of keysDown) {
            if (old_keys[keyIntCode]) await sim_hold(keyIntCode)
            else await sim_keydown(keyIntCode)
            old_keys[keyIntCode] = true
        }
        for (const keyIntCode in old_keys) {
            if (!keysDown.includes(keyIntCode)) {
                await sim_keyup(keyIntCode)
                delete old_keys[keyIntCode]
            }
        }
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

        // Wheel (one-shot, expressed in steps; positive = scroll down)
        const wheelY = Number(mouse.wheel?.y ?? 0)
        if (Number.isFinite(wheelY) && wheelY !== 0) {
            const steps = Math.max(-20, Math.min(20, Math.trunc(wheelY)))
            const button = steps > 0 ? 5 : 4 // X11: 4=up, 5=down
            for (let i = 0; i < Math.abs(steps); i++) {
                await execFileAsync('xdotool', ['click', String(button)])
            }
        }
    }

    // Type produced text ("alien keyboard").
    const pressText = typeof controls.keys?.press === 'string' ? controls.keys.press : ''
    if (pressText) {
        // Clears modifiers so Shift/Ctrl being held doesn't mutate the typed characters.
        await execFileAsync('xdotool', ['type', '--clearmodifiers', '--delay', '0', pressText])
    }

    // Keyboard (held shortcuts/controls)
    const keysDown = controls.keys?.down
    if (Array.isArray(keysDown)) {
        const nextKeys = new Set()
        for (const entry of keysDown) {
            const { code, key: keyValue } = normalizeKeyEntry(entry)
            const key = keyToXdotoolKey(keyValue) ?? codeToXdotoolKey(code)
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
            const message = err?.message ?? String(err)
            const code = err?.code
            const path = err?.path
            if (platform !== 'win32' && code === 'ENOENT' && (path === 'xdotool' || /\bxdotool\b/i.test(message))) {
                console.warn('[client] controls disabled (input backend failed): xdotool not found')
                console.warn('[client] install on Ubuntu/Debian: sudo apt update && sudo apt install -y xdotool')
                console.warn('[client] or disable controls: SAILAWAY_APPLY_CONTROLS=0 node .')
            } else {
                console.warn(`[client] controls disabled (input backend failed): ${message}`)
            }
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
            // Compress before upload to reduce bandwidth.
            const raw_buffer = await screenshot()
            const image_buffer = await compress_image_buffer(raw_buffer)
            await post_image(session_id, image_buffer)
            // console.log('posted')
        } catch (err) {
            console.error(`[client] frame upload error: ${err?.message ?? err}`)
        }
    }

    let lasttime = 0
    const controlTick = async () => {
        if (!canApplyControls || !geometry) return

        try {
            const controls = await get_controls(session_id)
            if (!Array.isArray(controls) || controls.length === 0) {
                hasWakeSignal = false
                return
            }
            const used_controls = controls.filter(c => {
                return c.time > lasttime
            })
            hasWakeSignal = controls[controls.length - 1].time + 30_000 > Date.now()
            if (!used_controls.length) return

            for (const control of used_controls) {
                if (platform === 'win32') {
                    if (!windowsDriver) return
                    controlState = await applyControlsWithWindows(controlState, control, geometry, windowsDriver)
                } else {
                    controlState = await applyControlsWithXdotool(controlState, control, geometry)
                }
            }
            lasttime = used_controls[used_controls.length - 1].time
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