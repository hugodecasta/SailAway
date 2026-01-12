import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import generate_api from "./api.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 8080

// API
app.use("/api", generate_api())

// Frontend (static)
const frontDir = path.join(__dirname, "front")
app.use("/", express.static(frontDir))

// Optional SPA fallback
app.get("/", (req, res) => {
    res.sendFile(path.join(frontDir, "index.html"))
})

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`)
})