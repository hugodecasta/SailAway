import express from 'express'

import { post_image, post_controls, get_session_data } from './engine.js'
import { copyFile } from 'node:fs'

export default function generate_api() {

    const router = express.Router()

    // Example endpoint
    router.get('/status', (req, res) => {
        res.json({ status: 'API is running' })
    })

    // POST to post image in session
    // POST to /api/session/:session_id/image
    router.post('/session/:session_id/image',
        express.raw({ type: 'application/octet-stream', limit: '10mb' }),
        (req, res) => {
            const session_id = req.params.session_id
            const image_blob = req.body
            post_image(session_id, image_blob)
            res.json({ status: 'Image received' })
        })

    // POST to post controls in session
    // POST to /api/session/:session_id/controls
    router.post('/session/:session_id/controls', express.json(), (req, res) => {
        const session_id = req.params.session_id
        const controls = req.body
        const time = Date.now()
        controls.time = time
        post_controls(session_id, controls)
        res.json({ status: 'Controls received' })
    })

    // GET latest controls for session
    // GET to /api/session/:session_id/controls
    router.get('/session/:session_id/controls', (req, res) => {
        const session_id = req.params.session_id
        const session_data = get_session_data(session_id)
        res.json({ controls: session_data.controls })
    })

    // GET image stream for session
    // GET to /api/session/:session_id/stream
    router.get('/session/:session_id/stream', (req, res) => {
        const session_id = req.params.session_id
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        })

        const sendFrame = () => {
            const session_data = get_session_data(session_id)
            const image_blob = session_data.image_blob
            if (image_blob) {
                res.write(`--frame\r\n`)
                res.write(`Content-Type: image/png\r\n`)
                res.write(`Content-Length: ${image_blob.length}\r\n\r\n`)
                res.write(image_blob)
                res.write(`\r\n`)
            }
        }

        const intervalId = setInterval(sendFrame, 100)

        req.on('close', () => {
            clearInterval(intervalId)
        })
    })

    return router

}