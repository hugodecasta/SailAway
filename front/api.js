let server = localStorage.getItem('sailaway_server') ?? 'http://localhost:3232'

export function set_server(url) {
    server = url
    localStorage.setItem('sailaway_server', url)
}

export function set_controls(session_id, controls) {
    return fetch(`${server}/api/session/${session_id}/controls`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(controls)
    })
}

export function get_stream_url(session_id) {
    return `${server}/api/session/${session_id}/stream`
}