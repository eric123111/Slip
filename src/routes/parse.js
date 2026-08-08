import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

router.post('/parse-receipt', requireAuth, async (req, res) => {
  const { fileData, fileType } = req.body
  if (!fileData || !fileType) {
    return res.status(400).json({ error: 'fileData and fileType required' })
  }

  const isImage = fileType.startsWith('image/')
  const isPDF = fileType === 'application/pdf'
  if (!isImage && !isPDF) {
    return res.status(400).json({ error: 'File must be an image or PDF' })
  }

  try {
    const contentItem = isImage
      ? { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          contentItem,
          {
            type: 'text',
            text: `Extract receipt data and return ONLY a JSON object with these fields:
{
  "vendor": "store or company name",
  "amount": total amount as a number (no currency symbol),
  "date": "YYYY-MM-DD",
  "gst": GST amount as a number or null,
  "hst": HST amount as a number or null,
  "notes": any PO or reference info or null
}
If a field cannot be determined, use null. Return only the JSON, no explanation.`
          }
        ]
      }]
    })

    const parsed = JSON.parse(message.content[0].text.trim())
    res.json(parsed)
  } catch (err) {
    console.error('Parse error:', err.message)
    res.status(500).json({ error: 'Failed to parse receipt' })
  }
})

export default router
