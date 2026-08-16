import { Router } from 'express'
import multer from 'multer'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

// Upload receipt file + save fields to DB (AI parsing is done separately via /api/parse-receipt)
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  const { vendor, amount, gst, hst, date, category, reference, job_number, po_number, card, job_id } = req.body

  let file_url = null

  if (req.file) {
    const file = req.file
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'File must be an image (JPEG, PNG, WebP) or PDF' })
    }

    const ext = file.originalname.split('.').pop()
    const filename = `${req.user.id}/${Date.now()}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(filename, file.buffer, { contentType: file.mimetype })

    if (uploadError) return res.status(500).json({ error: 'Failed to upload file' })

    const { data: { publicUrl } } = supabase.storage.from('receipts').getPublicUrl(filename)
    file_url = publicUrl
  }

  const { data: receipt, error: dbError } = await supabase
    .from('receipts')
    .insert({
      user_id: req.user.id,
      file_url,
      vendor: vendor || null,
      amount: amount ? parseFloat(amount) : null,
      date: date || null,
      gst: gst ? parseFloat(gst) : null,
      hst: hst ? parseFloat(hst) : null,
      category: category || null,
      reference: reference || null,
      job_number: job_number || null,
      po_number: po_number || null,
      card: card || null,
      job_id: job_id || null,
      source: 'manual',
    })
    .select()
    .single()

  if (dbError) return res.status(500).json({ error: 'Failed to save receipt' })

  res.json(receipt)
})

// List receipts with optional filters
router.get('/', requireAuth, async (req, res) => {
  const { vendor, category, reference, job_number, po_number, card, date_from, date_to } = req.query

  let query = supabase
    .from('receipts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('date', { ascending: false })

  if (vendor) query = query.ilike('vendor', `%${vendor}%`)
  if (category) query = query.eq('category', category)
  if (reference) query = query.ilike('reference', `%${reference}%`)
  if (job_number) query = query.ilike('job_number', `%${job_number}%`)
  if (po_number) query = query.ilike('po_number', `%${po_number}%`)
  if (card) query = query.ilike('card', `%${card}%`)
  if (date_from) query = query.gte('date', date_from)
  if (date_to) query = query.lte('date', date_to)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  res.json(data)
})

// Update a receipt
router.put('/:id', requireAuth, async (req, res) => {
  const { vendor, amount, gst, hst, date, category, reference, job_number, po_number, card, job_id, needs_review } = req.body

  const updates = { vendor, amount, gst, hst, date, category, reference, job_number, po_number, card, job_id: job_id !== undefined ? (job_id || null) : undefined }
  if (needs_review !== undefined) updates.needs_review = needs_review

  const { data, error } = await supabase
    .from('receipts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Receipt not found' })

  res.json(data)
})

// Rename a PO across all receipts
router.post('/rename-po', requireAuth, async (req, res) => {
  const { oldPO, newPO } = req.body
  if (!oldPO || !newPO) return res.status(400).json({ error: 'oldPO and newPO required' })
  const { error } = await supabase
    .from('receipts')
    .update({ po_number: newPO })
    .eq('user_id', req.user.id)
    .eq('po_number', oldPO)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Renamed' })
})

// Delete a receipt
router.delete('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('receipts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Receipt not found' })

  res.json({ message: 'Deleted' })
})

// Export receipts as CSV
router.get('/export', requireAuth, async (req, res) => {
  const { vendor, category, job_number, po_number, card, date_from, date_to } = req.query

  let query = supabase
    .from('receipts')
    .select('date, vendor, amount, gst, hst, category, job_number, po_number, card, reference, source')
    .eq('user_id', req.user.id)
    .order('date', { ascending: false })

  if (vendor) query = query.ilike('vendor', `%${vendor}%`)
  if (category) query = query.eq('category', category)
  if (job_number) query = query.ilike('job_number', `%${job_number}%`)
  if (po_number) query = query.ilike('po_number', `%${po_number}%`)
  if (card) query = query.ilike('card', `%${card}%`)
  if (date_from) query = query.gte('date', date_from)
  if (date_to) query = query.lte('date', date_to)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  const header = 'Date,Vendor,Amount,GST,HST,Category,Job #,PO #,Card,Notes,Source'
  const rows = data.map(r =>
    [r.date, r.vendor, r.amount, r.gst, r.hst, r.category, r.job_number, r.po_number, r.card, r.reference, r.source]
      .map(v => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`))
      .join(',')
  )

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="slip-export.csv"')
  res.send([header, ...rows].join('\n'))
})

export default router
