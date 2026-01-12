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

        function detectImageContentType(buf) {
            if (!buf || buf.length < 12) return 'application/octet-stream'

            // JPEG: FF D8 FF
            if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'

            // PNG: 89 50 4E 47 0D 0A 1A 0A
            if (
                buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
                buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
            ) {
                return 'image/png'
            }

            // WebP: RIFF....WEBP
            if (
                buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
            ) {
                return 'image/webp'
            }

            return 'application/octet-stream'
        }

        const sendFrame = () => {
            const session_data = get_session_data(session_id)
            const image_blob = session_data.image_blob
            if (image_blob) {
                res.write(`--frame\r\n`)
                res.write(`Content-Type: ${detectImageContentType(image_blob)}\r\n`)
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