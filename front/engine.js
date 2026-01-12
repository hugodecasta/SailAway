import { get_stream_url, set_controls, set_server } from "./api.js"

const downKeys = []

function defer() {
    /** @type {(value: any) => void} */
    let resolve
    /** @type {(reason?: any) => void} */
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0
    if (value < 0) return 0
    if (value > 1) return 1
    return value
}

export function create_vizu_canvas(session_id) {
    const container = document.createElement("div")
    container.style.display = "flex"
    container.style.flexDirection = "column"
    container.style.gap = "8px"
    // Prevent children from stretching full width; we'll size the viewer explicitly.
    container.style.alignItems = "flex-start"

    const canvas = document.createElement("canvas")
    canvas.width = 1280
    canvas.height = 720
    canvas.tabIndex = 0
    canvas.style.alignSelf = "flex-start"
    canvas.style.display = "block"
    // Use natural image size by default; only shrink if needed.
    canvas.style.maxWidth = "min(100%, 1280px)"
    canvas.style.height = "auto"
    canvas.style.border = "1px solid #ddd"

    const ctx = canvas.getContext("2d")
    if (!ctx) {
        throw new Error("Could not get 2d canvas context")
    }

    // Stream source.
    const img = new Image()
    img.decoding = "async"
    img.loading = "eager"
    img.src = get_stream_url(session_id)

    const MAX_VIEW_WIDTH_PX = 1280
    let lastTarget = { w: canvas.width, h: canvas.height }

    function updateCanvasTargetSize() {
        const naturalW = img.naturalWidth
        const naturalH = img.naturalHeight
        if (!Number.isFinite(naturalW) || !Number.isFinite(naturalH) || naturalW <= 0 || naturalH <= 0) return

        const available = Math.max(
            1,
            Math.floor(
                container.getBoundingClientRect().width ||
                document.documentElement.clientWidth ||
                window.innerWidth ||
                MAX_VIEW_WIDTH_PX
            )
        )

        const targetW = Math.max(1, Math.floor(Math.min(naturalW, MAX_VIEW_WIDTH_PX, available)))
        const targetH = Math.max(1, Math.floor((naturalH * targetW) / naturalW))
        if (targetW === lastTarget.w && targetH === lastTarget.h) return

        lastTarget = { w: targetW, h: targetH }

        // Canvas buffer size: match the intended display size (no upscaling).
        canvas.width = targetW
        canvas.height = targetH

        // CSS size: natural (or max) width, responsive downscaling via max-width.
        canvas.style.width = `${targetW}px`
        canvas.style.aspectRatio = `${targetW} / ${targetH}`
    }

    img.addEventListener("load", () => {
        // Wait a tick so layout is stable before we read container width.
        window.requestAnimationFrame(updateCanvasTargetSize)
    })
    window.addEventListener("resize", updateCanvasTargetSize)

    // Input state.
    // Track held keys by KeyboardEvent.code (stable), but send KeyboardEvent.key (layout-dependent).
    // This avoids "stuck keys" when keyup reports a different .key (common with Shift+punctuation).
    /** @type {Map<string, string>} */
    const keysHeld = new Map()

    // One-shot typed text (layout-correct). This is the "alien keyboard" channel.
    // We accumulate characters between posts and clear after a successful send.
    let typedText = ""
    let lastMouse = { x: 0, y: 0 }
    let mouse = { x: 0, y: 0, buttons: 0 }
    // Wheel is transient; accumulate between sends, then clear after send.
    let wheelAccY = 0
    let wheelStepsPendingY = 0
    let dirty = true
    let closed = false
    let rafId = 0
    let postTimer = 0
    let wakeTimer = 0
    let lastSent = ""

    function getNormalizedMouseFromEvent(event) {
        const rect = canvas.getBoundingClientRect()
        const x = clamp01((event.clientX - rect.left) / Math.max(1, rect.width))
        const y = clamp01((event.clientY - rect.top) / Math.max(1, rect.height))
        return { x, y }
    }

    function snapshotControls() {
        return {
            mouse: {
                x: mouse.x,
                y: mouse.y,
                dx: mouse.x - lastMouse.x,
                dy: mouse.y - lastMouse.y,
                buttons: mouse.buttons,
                wheel: {
                    y: wheelStepsPendingY,
                },
            },
            keys: Array.from(downKeys)
        }
    }

    function snapshotNeutralControls() {
        return {
            mouse: {
                x: mouse.x,
                y: mouse.y,
                dx: 0,
                dy: 0,
                buttons: 0,
                wheel: {
                    y: 0,
                },
            },
            keys: {
                down: [],
            },
        }
    }

    async function postWakeSignal() {
        if (closed) return

        try {
            // Keep a stable wake marker so the client can detect it.
            // Also add a tick so this packet is unique over time.
            await set_controls(session_id, {
                ...snapshotControls(),
                wake: "please be awake",
                wake_tick: Date.now(),
            })
        } catch {
            // Keep UI responsive even if server is down.
        }
    }

    async function markDirty() {
        // post snapshot
        const controls = snapshotControls()
        await set_controls(session_id, controls)
    }

    async function maybePostControls() {
        if (closed) return
        if (!dirty) return

        const controls = snapshotControls()

        // De-dupe based on stable state only (wheel/typed text are one-shot).
        const stableControls = {
            ...controls,
            mouse: {
                ...controls.mouse,
                wheel: { y: 0 },
            },
            keys: {
                ...controls.keys,
                press: "",
            },
        }
        const serializedStable = JSON.stringify(stableControls)
        if (serializedStable === lastSent && !controls.keys.press && !(controls.mouse.wheel?.y)) {
            dirty = false
            return
        }

        lastSent = serializedStable
        dirty = false
        lastMouse = { x: mouse.x, y: mouse.y }
        // Wheel steps are one-shot.
        wheelStepsPendingY = 0
        typedText = ""

        try {
            // Fire-and-forget: server stores latest.
            await set_controls(session_id, controls)
        } catch {
            // Keep UI responsive even if server is down.
        }
    }

    function onMouseMove(event) {
        const pos = getNormalizedMouseFromEvent(event)
        mouse = { ...mouse, ...pos }
        markDirty()
    }

    function onMouseDown(event) {
        canvas.focus()
        const pos = getNormalizedMouseFromEvent(event)
        mouse.buttons = event.buttons ?? mouse.buttons
        markDirty()
        event.preventDefault()
    }

    function onMouseUp(event) {
        const pos = getNormalizedMouseFromEvent(event)
        mouse.buttons = -1
        markDirty()
        event.preventDefault()
    }

    function onWheel(event) {
        // Prevent page scrolling while controlling.
        canvas.focus()
        // Normalize wheel into integer "steps".
        // - deltaMode 0: pixels (typical), treat ~100px as one step
        // - deltaMode 1: lines, treat ~3 lines as one step
        // - deltaMode 2: pages, treat 1 page as one step
        const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100
        wheelAccY += Number(event.deltaY) || 0
        const steps = Math.trunc(wheelAccY / unit)
        if (steps !== 0) {
            wheelAccY -= steps * unit
            // Clamp burstiness a bit so we don't spam.
            wheelStepsPendingY = Math.max(-20, Math.min(20, wheelStepsPendingY + steps))
            markDirty()
        }

        event.preventDefault()
        event.stopPropagation()
    }

    function onKeyDown(event) {
        // Only capture keys when the viewer is focused.
        if (document.activeElement !== canvas) return

        const key_id = event.key + "||" + event.code
        console.log(key_id)
        if (!downKeys.includes(key_id)) {
            downKeys.push(key_id)
            markDirty()
        }


        // const rawKey = typeof event.key === "string" ? event.key : ""
        // if (!rawKey || rawKey === "Dead") return

        // // "Alien keyboard": if this key produces a character, send the produced character verbatim.
        // // Do NOT try to emulate Shift+<physical> for punctuation, because that easily double-applies modifiers.
        // if (!event.ctrlKey && !event.altKey && !event.metaKey && rawKey.length === 1) {
        //     typedText = (typedText + rawKey).slice(-128)
        //     markDirty()

        //     if (event.cancelable) event.preventDefault()
        //     event.stopPropagation()
        //     return
        // }

        // // Otherwise, treat as a held key (for shortcuts like Ctrl+A, arrows, etc.).
        // const code = typeof event.code === "string" ? event.code : ""
        // if (code) {
        //     // Normalize letters so Shift is represented by Shift key (for Ctrl+letter combos).
        //     let key = rawKey
        //     if (key.length === 1 && /[a-zA-Z]/.test(key)) key = key.toLowerCase()
        //     keysHeld.set(code, key)
        // }
        // markDirty()

        // // Avoid the controller (browser) interpreting key combos.
        // // Note: some browser/OS reserved shortcuts may still win.
        // if (event.cancelable) event.preventDefault()
        // event.stopPropagation()
    }

    function onKeyUp(event) {
        if (document.activeElement !== canvas) return

        const key_id = event.key + "||" + event.code
        const index = downKeys.indexOf(key_id)
        if (index !== -1) {
            downKeys.splice(index, 1)
            markDirty()
        }

        // const code = typeof event.code === "string" ? event.code : ""
        // if (code) keysHeld.delete(code)
        // markDirty()
        // if (event.cancelable) event.preventDefault()
        // event.stopPropagation()
    }

    canvas.addEventListener("mousemove", onMouseMove)
    canvas.addEventListener("mousedown", onMouseDown)
    canvas.addEventListener("mouseup", onMouseUp)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)

    function drawLoop() {
        if (closed) return

        updateCanvasTargetSize()

        // If the browser updates the image from multipart, drawImage will pick it up.
        if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        } else {
            ctx.fillStyle = "#f7f7f7"
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.fillStyle = "#555"
            ctx.font = "16px sans-serif"
            ctx.fillText("Waiting for stream…", 12, 24)
        }

        rafId = window.requestAnimationFrame(drawLoop)
    }

    rafId = window.requestAnimationFrame(drawLoop)
    // postTimer = window.setInterval(() => {
    //     void maybePostControls()
    // }, 50)

    // Periodic wake ping so the client knows a viewer is connected.
    // Fire immediately once, then every 30s.
    void postWakeSignal()
    wakeTimer = window.setInterval(() => {
        void postWakeSignal()
    }, 30_000)

    container.close = () => {
        closed = true
        if (rafId) window.cancelAnimationFrame(rafId)
        if (postTimer) window.clearInterval(postTimer)
        if (wakeTimer) window.clearInterval(wakeTimer)

        // Remove wake signal + clear any pressed inputs on the remote side.
        try {
            void set_controls(session_id, snapshotNeutralControls())
        } catch {
            // ignore
        }

        // Close the image stream (multipart fetch tied to Image.src).
        img.src = ""

        canvas.removeEventListener("mousemove", onMouseMove)
        canvas.removeEventListener("mousedown", onMouseDown)
        canvas.removeEventListener("mouseup", onMouseUp)
        canvas.removeEventListener("wheel", onWheel)
        window.removeEventListener("keydown", onKeyDown)
        window.removeEventListener("keyup", onKeyUp)
        window.removeEventListener("resize", updateCanvasTargetSize)
    }

    container.appendChild(canvas)
    return container
}

export function create_session_div(session_id) {
    const root = document.createElement("div")
    root.style.display = "flex"
    root.style.flexDirection = "column"
    root.style.gap = "12px"
    root.style.padding = "12px"

    const header = document.createElement("div")
    header.style.display = "flex"
    header.style.alignItems = "center"
    header.style.justifyContent = "space-between"
    header.style.gap = "12px"

    const title = document.createElement("div")
    title.textContent = `session: ${session_id}`

    const closeBtn = document.createElement("button")
    closeBtn.textContent = "Close"

    header.appendChild(title)
    header.appendChild(closeBtn)

    const vizu = create_vizu_canvas(session_id)

    const closeDeferred = defer()
    let closed = false

    function doClose() {
        if (closed) return
        closed = true
        if (typeof vizu.close === "function") vizu.close()
        closeDeferred.resolve(true)
    }

    closeBtn.addEventListener("click", doClose)

    root.wait_for_close = () => closeDeferred.promise
    root.close = doClose

    root.appendChild(header)
    root.appendChild(vizu)
    return root
}

const KNOWN_SESSIONS_KEY = "sailaway_known_sessions"

function load_known_sessions() {
    try {
        const raw = localStorage.getItem(KNOWN_SESSIONS_KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
        return parsed
    } catch {
        return {}
    }
}

function save_known_sessions(known_sessions) {
    localStorage.setItem(KNOWN_SESSIONS_KEY, JSON.stringify(known_sessions ?? {}))
}

export function create_connection_div() {
    const root = document.createElement("div")
    root.style.display = "flex"
    root.style.flexDirection = "column"
    root.style.gap = "12px"
    root.style.padding = "12px"
    root.style.maxWidth = "480px"

    const serverLabel = document.createElement("div")
    serverLabel.textContent = "Server URL:"

    const serverRow = document.createElement("div")
    serverRow.style.display = "flex"
    serverRow.style.gap = "8px"

    const serverInput = document.createElement("input")
    serverInput.type = "text"
    serverInput.placeholder = "http://localhost:3232"
    serverInput.style.flex = "1"
    serverInput.value = localStorage.getItem("sailaway_server") ?? "http://localhost:3232"

    serverRow.appendChild(serverInput)

    const label = document.createElement("div")
    label.textContent = "Enter a session id to connect:"

    const row = document.createElement("div")
    row.style.display = "flex"
    row.style.gap = "8px"

    const input = document.createElement("input")
    input.type = "text"
    input.placeholder = "session id"
    input.style.flex = "1"

    const button = document.createElement("button")
    button.textContent = "Connect"

    row.appendChild(input)
    row.appendChild(button)

    const connectDeferred = defer()

    const knownTitle = document.createElement("div")
    knownTitle.textContent = "Known sessions:"

    const knownList = document.createElement("div")
    knownList.style.display = "flex"
    knownList.style.flexDirection = "column"
    knownList.style.gap = "6px"

    function renderKnownSessions() {
        knownList.replaceChildren()

        const sessions = load_known_sessions()
        const names = Object.keys(sessions)
        if (names.length === 0) {
            const empty = document.createElement("div")
            empty.style.opacity = "0.7"
            empty.textContent = "(none)"
            knownList.appendChild(empty)
            return
        }

        for (const name of names) {
            const sessionId = String(sessions[name] ?? "").trim()
            if (!sessionId) continue

            const line = document.createElement("div")
            line.style.display = "flex"
            line.style.alignItems = "center"
            line.style.gap = "8px"

            const label = document.createElement("button")
            label.type = "button"
            label.textContent = name
            label.style.flex = "1"
            label.style.textAlign = "left"
            label.title = sessionId
            label.addEventListener("click", () => {
                connectToSessionId(sessionId)
            })

            const editBtn = document.createElement("button")
            editBtn.type = "button"
            editBtn.textContent = "Edit"
            editBtn.addEventListener("click", () => {
                const newName = window.prompt("Rename session", name)
                if (newName == null) return
                const trimmed = newName.trim()
                if (!trimmed) return

                const next = load_known_sessions()
                const existing = next[trimmed]
                if (existing != null && String(existing) !== sessionId) {
                    const ok = window.confirm("That name already exists. Overwrite?")
                    if (!ok) return
                }
                delete next[name]
                next[trimmed] = sessionId
                save_known_sessions(next)
                renderKnownSessions()
            })

            const delBtn = document.createElement("button")
            delBtn.type = "button"
            delBtn.textContent = "Delete"
            delBtn.addEventListener("click", () => {
                const next = load_known_sessions()
                delete next[name]
                save_known_sessions(next)
                renderKnownSessions()
            })

            line.appendChild(label)
            line.appendChild(editBtn)
            line.appendChild(delBtn)
            knownList.appendChild(line)
        }
    }

    function applyServerFromInput() {
        const url = serverInput.value.trim()
        if (!url) return
        set_server(url)
    }

    function connectToSessionId(sessionId) {
        applyServerFromInput()
        const value = String(sessionId ?? "").trim()
        if (!value) return

        const sessions = load_known_sessions()
        const alreadyKnown = Object.values(sessions).some((id) => String(id) === value)
        if (!alreadyKnown) {
            sessions[value] = value
            save_known_sessions(sessions)
        }

        connectDeferred.resolve(value)
    }

    function tryConnect() {
        connectToSessionId(input.value)
    }

    button.addEventListener("click", tryConnect)
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryConnect()
    })

    serverInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryConnect()
    })

    root.wait_for_connect = () => connectDeferred.promise

    renderKnownSessions()

    root.appendChild(serverLabel)
    root.appendChild(serverRow)
    root.appendChild(label)
    root.appendChild(row)
    root.appendChild(knownTitle)
    root.appendChild(knownList)
    return root
}

export async function system() {
    // Simple loop: connect -> session -> close -> connect again.
    while (true) {
        const conn_div = create_connection_div()
        document.body.appendChild(conn_div)
        const connect_id = await conn_div.wait_for_connect()
        document.body.removeChild(conn_div)

        const session_div = create_session_div(connect_id)
        document.body.appendChild(session_div)
        await session_div.wait_for_close()
        document.body.removeChild(session_div)
    }
}