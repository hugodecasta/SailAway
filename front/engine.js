import { get_stream_url, set_controls } from "./api.js"

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

    const canvas = document.createElement("canvas")
    canvas.width = 1280
    canvas.height = 720
    canvas.tabIndex = 0
    canvas.style.maxWidth = "100%"
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

    // Input state.
    const keysDown = new Set()
    let lastMouse = { x: 0, y: 0 }
    let mouse = { x: 0, y: 0, buttons: 0 }
    let dirty = true
    let closed = false
    let rafId = 0
    let postTimer = 0
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
            },
            keys: {
                down: Array.from(keysDown),
            },
        }
    }

    function markDirty() {
        dirty = true
    }

    async function maybePostControls() {
        if (closed) return
        if (!dirty) return

        const controls = snapshotControls()
        const serialized = JSON.stringify(controls)
        if (serialized === lastSent) {
            dirty = false
            return
        }

        lastSent = serialized
        dirty = false
        lastMouse = { x: mouse.x, y: mouse.y }

        try {
            // Fire-and-forget: server stores latest.
            await set_controls(session_id, controls)
        } catch {
            // Keep UI responsive even if server is down.
        }
    }

    function onMouseMove(event) {
        const pos = getNormalizedMouseFromEvent(event)
        mouse = { ...mouse, ...pos, buttons: event.buttons ?? mouse.buttons }
        markDirty()
    }

    function onMouseDown(event) {
        canvas.focus()
        const pos = getNormalizedMouseFromEvent(event)
        mouse = { ...mouse, ...pos, buttons: event.buttons ?? mouse.buttons }
        markDirty()
        event.preventDefault()
    }

    function onMouseUp(event) {
        const pos = getNormalizedMouseFromEvent(event)
        mouse = { ...mouse, ...pos, buttons: event.buttons ?? 0 }
        markDirty()
        event.preventDefault()
    }

    function onKeyDown(event) {
        // Keep it simple: send KeyboardEvent.code.
        keysDown.add(event.code)
        markDirty()
        // Prevent scrolling with arrows/space while controlling.
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
            event.preventDefault()
        }
    }

    function onKeyUp(event) {
        keysDown.delete(event.code)
        markDirty()
    }

    canvas.addEventListener("mousemove", onMouseMove)
    canvas.addEventListener("mousedown", onMouseDown)
    canvas.addEventListener("mouseup", onMouseUp)
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)

    function drawLoop() {
        if (closed) return

        // Resize to match element size for crisp display.
        const rect = canvas.getBoundingClientRect()
        const targetW = Math.max(1, Math.floor(rect.width))
        const targetH = Math.max(1, Math.floor(rect.height))
        if (targetW !== canvas.width || targetH !== canvas.height) {
            canvas.width = targetW
            canvas.height = targetH
        }

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
    postTimer = window.setInterval(() => {
        void maybePostControls()
    }, 50)

    container.close = () => {
        closed = true
        if (rafId) window.cancelAnimationFrame(rafId)
        if (postTimer) window.clearInterval(postTimer)

        canvas.removeEventListener("mousemove", onMouseMove)
        canvas.removeEventListener("mousedown", onMouseDown)
        canvas.removeEventListener("mouseup", onMouseUp)
        window.removeEventListener("keydown", onKeyDown)
        window.removeEventListener("keyup", onKeyUp)
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

export function create_connection_div() {
    const root = document.createElement("div")
    root.style.display = "flex"
    root.style.flexDirection = "column"
    root.style.gap = "12px"
    root.style.padding = "12px"
    root.style.maxWidth = "480px"

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

    function tryConnect() {
        const value = input.value.trim()
        if (!value) return
        connectDeferred.resolve(value)
    }

    button.addEventListener("click", tryConnect)
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryConnect()
    })

    root.wait_for_connect = () => connectDeferred.promise

    root.appendChild(label)
    root.appendChild(row)
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