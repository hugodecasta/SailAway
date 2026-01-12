const session_data = {}

function ensure_session(session_id) {
    if (!(session_id in session_data)) {
        session_data[session_id] = {
            image_blob: null,
            controls: []
        }
    }
}

export function post_image(session_id, blob) {
    ensure_session(session_id)
    session_data[session_id].image_blob = blob
}

export function post_controls(session_id, control) {
    ensure_session(session_id)
    session_data[session_id].controls.push(control)
    while (session_data[session_id].controls.length > 50) {
        session_data[session_id].controls.shift()
    }
    // const to_remove = []
    // const now = Date.now()
    // for (const control of session_data[session_id].controls) {
    //     if (control.time + 2000 < now) {
    //         to_remove.push(control)
    //     }
    // }
    // for (const control of to_remove) {
    //     const index = session_data[session_id].controls.indexOf(control)
    //     if (index > -1) {
    //         session_data[session_id].controls.splice(index, 1)
    //     }
    // }
}

export function get_session_data(session_id) {
    ensure_session(session_id)
    return session_data[session_id]
}