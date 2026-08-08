import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Anon client used only for recovery token exchange (avoids polluting service-role session)
function anonClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

// ── Sign Up ──
router.post('/signup', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ user: data.user, session: data.session })
})

// ── Sign In ──
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ user: data.user, session: data.session })
})

// ── Sign Out ──
router.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) await supabase.auth.admin.signOut(token)
  res.json({ message: 'Logged out' })
})

// ── Forgot Password — sends reset email ──
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })
  const redirectTo = (process.env.BASE_URL || 'http://localhost:3000') + '/?recovery=1'
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  // Always return success to avoid leaking whether email exists
  if (error) console.error('Reset email error:', error.message)
  res.json({ message: 'If that email exists, a reset link has been sent.' })
})

// ── Set Password — called after clicking email reset link ──
// Uses the recovery access_token from the URL hash
router.post('/set-password', async (req, res) => {
  const { access_token, refresh_token, password } = req.body
  if (!access_token || !password) return res.status(400).json({ error: 'access_token and password required' })
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

  try {
    // Exchange the recovery token for a session using the anon client
    const client = anonClient()
    const { data: sessionData, error: sessionErr } = await client.auth.setSession({
      access_token,
      refresh_token: refresh_token || access_token
    })
    if (sessionErr || !sessionData?.user) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' })
    }

    // Update the password using service-role admin API
    const { error: updateErr } = await supabase.auth.admin.updateUserById(
      sessionData.user.id,
      { password }
    )
    if (updateErr) return res.status(400).json({ error: updateErr.message })

    res.json({ message: 'Password updated successfully. You can now sign in.' })
  } catch (err) {
    console.error('Set password error:', err.message)
    res.status(500).json({ error: 'Failed to update password. Please try again.' })
  }
})

// ── Change Password — for logged-in users ──
router.post('/change-password', requireAuth, async (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'New password required' })
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
  const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ message: 'Password changed successfully' })
})

export default router
