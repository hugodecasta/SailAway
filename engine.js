const session_data = {}

function ensure_session(session_id) {
    if (!(session_id in session_data)) {
        session_data[session_id] = {
            image_blob: null,
            controls: null
        }
    }
}

export function post_image(session_id, blob) {
    ensure_session(session_id)
    session_data[session_id].image_blob = blob
}

export function post_controls(session_id, controls) {
    ensure_session(session_id)
    session_data[session_id].controls = controls
}

export function get_session_data(session_id) {
    ensure_session(session_id)
    return session_data[session_id]
}