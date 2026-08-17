import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import receiptRoutes from './routes/receipts.js'
import parseRoutes from './routes/parse.js'
import emailRoutes from './routes/email.js'
import jobRoutes from './routes/jobs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '25mb' }))

// Serve PWA assets (manifest, sw, icons)
app.use(express.static(join(ROOT, 'public')))

// API routes
app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.use('/auth', authRoutes)
app.use('/receipts', receiptRoutes)
app.use('/api', parseRoutes)
app.use('/email', emailRoutes)
app.use('/jobs', jobRoutes)

// Frontend — serve at /
app.get('/', (req, res) => res.sendFile(join(ROOT, 'slip_frontend.html')))

app.listen(PORT, () => {
  console.log(`Slip running → http://localhost:${PORT}`)
})
