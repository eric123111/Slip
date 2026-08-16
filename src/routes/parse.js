import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function extractJSON(text) {
  const trimmed = text.trim()
  // Strip markdown code fences if present
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonStr = fenced ? fenced[1].trim() : trimmed
  return JSON.parse(jsonStr)
}

const RECEIPT_PROMPT = `Extract receipt data and return ONLY a JSON object:
{
  "vendor": "store or company name",
  "amount": total as number or null,
  "date": "YYYY-MM-DD" or null,
  "gst": GST amount as number or null,
  "hst": HST amount as number or null,
  "notes": any PO or reference info or null
}
If a field cannot be determined, use null. Return only the JSON, no explanation.`

async function parseWithAI(buffer, mimeType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const base64 = buffer.toString('base64')
  const isImage = mimeType.startsWith('image/')
  const isPDF = mimeType === 'application/pdf'
  if (!isImage && !isPDF) return null
  const contentItem = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: [contentItem, { type: 'text', text: RECEIPT_PROMPT }] }]
  })
  return extractJSON(message.content[0].text)
}

router.post('/parse-receipt', requireAuth, async (req, res) => {
  const { fileData, fileType } = req.body
  if (!fileData || !fileType) return res.status(400).json({ error: 'fileData and fileType required' })
  const isImage = fileType.startsWith('image/')
  const isPDF = fileType === 'application/pdf'
  if (!isImage && !isPDF) return res.status(400).json({ error: 'File must be an image or PDF' })

  try {
    const buffer = Buffer.from(fileData, 'base64')
    const parsed = await parseWithAI(buffer, fileType)
    if (!parsed) return res.status(400).json({ error: 'Could not parse this file type' })
    res.json(parsed)
  } catch (err) {
    console.error('Parse error:', err.message)
    res.status(500).json({ error: err.message || 'Failed to parse receipt' })
  }
})

router.post('/refill', requireAuth, async (req, res) => {
  const { receiptId } = req.body
  if (!receiptId) return res.status(400).json({ error: 'receiptId required' })

  try {
    const { data: receipt, error: fetchErr } = await supabase
      .from('receipts')
      .select('file_url')
      .eq('id', receiptId)
      .eq('user_id', req.user.id)
      .single()

    if (fetchErr || !receipt) return res.status(404).json({ error: 'Receipt not found' })
    if (!receipt.file_url) return res.status(400).json({ error: 'No file attached to this receipt' })

    const fileRes = await fetch(receipt.file_url)
    if (!fileRes.ok) return res.status(500).json({ error: 'Failed to download receipt file' })

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    const urlLower = receipt.file_url.toLowerCase()
    const mimeType = urlLower.includes('.pdf') ? 'application/pdf'
      : urlLower.includes('.png') ? 'image/png'
      : urlLower.includes('.webp') ? 'image/webp'
      : fileRes.headers.get('content-type') || 'image/jpeg'

    const parsed = await parseWithAI(buffer, mimeType)
    if (!parsed) return res.status(400).json({ error: 'Could not parse this file type' })

    res.json(parsed)
  } catch (err) {
    console.error('Refill error:', err.message)
    res.status(500).json({ error: err.message || 'Failed to parse receipt' })
  }
})

export default router
