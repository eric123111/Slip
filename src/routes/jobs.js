import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// List jobs
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// Create job
router.post('/', requireAuth, async (req, res) => {
  const { name, job_number, budget, start_date } = req.body
  if (!name) return res.status(400).json({ error: 'Job name required' })
  const { data, error } = await supabase
    .from('jobs')
    .insert({ user_id: req.user.id, name, job_number: job_number || null, budget: budget ? parseFloat(budget) : null, start_date: start_date || null })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Update job
router.put('/:id', requireAuth, async (req, res) => {
  const { name, job_number, budget, start_date } = req.body
  const { data, error } = await supabase
    .from('jobs')
    .update({ name, job_number: job_number || null, budget: budget ? parseFloat(budget) : null, start_date: start_date || null })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Job not found' })
  res.json(data)
})

// Delete job
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('jobs')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

export default router
