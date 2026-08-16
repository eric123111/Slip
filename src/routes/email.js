import { Router } from 'express'
import { google } from 'googleapis'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const router = Router()

// Store state -> user_id for OAuth flow (in-memory, cleared after use)
const pendingStates = new Map()

// ── Gmail OAuth client ──
function getGmailClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.BASE_URL + '/email/callback/gmail'
  )
}

// ── Outlook OAuth helpers ──
const OUTLOOK_SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadBasic offline_access'
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MS_GRAPH = 'https://graph.microsoft.com/v1.0'

function getOutlookAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.BASE_URL + '/email/callback/outlook',
    response_mode: 'query',
    scope: OUTLOOK_SCOPES,
    state
  })
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`
}

async function exchangeOutlookCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.BASE_URL + '/email/callback/outlook',
    scope: OUTLOOK_SCOPES
  })
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description || data.error)
  return data
}

async function refreshOutlookToken(integration) {
  const body = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: integration.refresh_token,
    scope: OUTLOOK_SCOPES
  })
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description || data.error)

  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString()
  await supabase.from('email_integrations').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token || integration.refresh_token,
    token_expiry: expiry
  }).eq('id', integration.id)

  return { ...integration, access_token: data.access_token }
}

async function graphGet(path, integration) {
  // Refresh token if expired or within 5 min of expiry
  if (integration.token_expiry) {
    const expiresAt = new Date(integration.token_expiry).getTime()
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      integration = await refreshOutlookToken(integration)
    }
  }
  const res = await fetch(MS_GRAPH + path, {
    headers: { Authorization: 'Bearer ' + integration.access_token }
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Graph API error ${res.status}`)
  }
  return res.json()
}

// ── Receipt helpers ──
const RECEIPT_KEYWORDS = ['receipt', 'invoice', 'order confirmation', 'payment confirmation', 'your order', 'purchase confirmation']

function isReceiptSubject(subject) {
  const s = (subject || '').toLowerCase()
  return RECEIPT_KEYWORDS.some(kw => s.includes(kw))
}

function extractVendorFromSubject(subject) {
  if (!subject) return null
  const cleaned = subject
    .replace(/your receipt from /i, '')
    .replace(/receipt from /i, '')
    .replace(/invoice from /i, '')
    .replace(/order confirmation from /i, '')
    .replace(/order confirmation/i, '')
    .replace(/receipt/i, '')
    .replace(/invoice/i, '')
    .trim()
  return cleaned.length > 0 ? cleaned : subject
}

// Extract display name from email "From" header e.g. "Home Depot <no-reply@homedepot.com>" → "Home Depot"
function extractSenderName(fromHeader) {
  if (!fromHeader) return null
  const match = fromHeader.match(/^"?([^"<@\n]+)"?\s*</)
  if (match) {
    const name = match[1].trim().replace(/\s+/g, ' ')
    if (name.length > 1) return name
  }
  // Fall back to domain portion of email e.g. homedepot.com → Home Depot (best effort)
  const emailMatch = fromHeader.match(/@([^>.\s]+)/)
  if (emailMatch) {
    return emailMatch[1].charAt(0).toUpperCase() + emailMatch[1].slice(1)
  }
  return null
}

// ── AI receipt parsing (shared) ──
async function parseReceiptWithAI(buffer, mimeType) {
  try {
    const base64 = buffer.toString('base64')
    const isImage = mimeType.startsWith('image/')
    const isPDF = mimeType === 'application/pdf'
    if (!isImage && !isPDF) return null

    const contentItem = isImage
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          contentItem,
          {
            type: 'text',
            text: `Extract receipt data and return ONLY a JSON object:
{
  "vendor": "store or company name",
  "amount": total amount as number or null,
  "date": "YYYY-MM-DD" or null,
  "gst": GST amount as number or null,
  "hst": HST amount as number or null
}
Return only the JSON, no explanation.`
          }
        ]
      }]
    })

    return JSON.parse(message.content[0].text.trim())
  } catch (err) {
    console.warn('AI parse failed for email attachment:', err.message)
    return null
  }
}

// ════════════════════════════════════════════
// GMAIL ROUTES
// ════════════════════════════════════════════

router.get('/connect/gmail', async (req, res) => {
  if (!req.user) {
    const token = req.query._auth
    if (!token) return res.status(401).send('Unauthorized')
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).send('Unauthorized')
    req.user = user
  }
  const state = Math.random().toString(36).substring(2, 15)
  pendingStates.set(state, { userId: req.user.id, provider: 'gmail' })
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000)

  const oauth2Client = getGmailClient()
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state
  })
  res.redirect(url)
})

router.get('/callback/gmail', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.send('<script>window.close()</script>')

  const pending = pendingStates.get(state)
  const userId = pending?.userId || pendingStates.get(state) // back-compat
  if (!userId) return res.status(400).send('Invalid or expired state. Please try again.')
  pendingStates.delete(state)

  try {
    const oauth2Client = getGmailClient()
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const profile = await gmail.users.getProfile({ userId: 'me' })

    await supabase.from('email_integrations').upsert({
      user_id: userId,
      provider: 'gmail',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      email_address: profile.data.emailAddress,
      active: true
    }, { onConflict: 'user_id,provider' })

    res.send(`<script>
      window.opener && window.opener.postMessage({ type: 'email_connected', provider: 'gmail' }, '*');
      document.write('<p style="font-family:sans-serif;text-align:center;margin-top:60px">Gmail connected! You can close this window.</p>');
      setTimeout(() => window.close(), 2000);
    </script>`)
  } catch (err) {
    console.error('Gmail OAuth error:', err.message)
    res.status(500).send('Gmail connection failed: ' + err.message)
  }
})

// ════════════════════════════════════════════
// OUTLOOK ROUTES
// ════════════════════════════════════════════

router.get('/connect/outlook', async (req, res) => {
  if (!process.env.OUTLOOK_CLIENT_ID) {
    return res.status(500).send('Outlook integration not configured. Add OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET to .env')
  }
  // Token can come from header OR query param (popup flow)
  let userId
  if (req.user) {
    userId = req.user.id
  } else {
    const token = req.query._auth
    if (!token) return res.status(401).send('Unauthorized')
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).send('Unauthorized')
    userId = user.id
  }

  const state = Math.random().toString(36).substring(2, 15)
  pendingStates.set(state, { userId, provider: 'outlook' })
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000)

  res.redirect(getOutlookAuthUrl(state))
})

router.get('/callback/outlook', async (req, res) => {
  const { code, state, error } = req.query
  if (error) {
    return res.send(`<script>
      document.write('<p style="font-family:sans-serif;text-align:center;margin-top:60px;color:red">Connection cancelled.</p>');
      setTimeout(() => window.close(), 2000);
    </script>`)
  }

  const pending = pendingStates.get(state)
  if (!pending) return res.status(400).send('Invalid or expired state. Please try again.')
  pendingStates.delete(state)
  const { userId } = pending

  try {
    const tokens = await exchangeOutlookCode(code)
    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Get user's email address from Graph
    const profileRes = await fetch(MS_GRAPH + '/me?$select=mail,userPrincipalName,otherMails', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    })
    const profile = profileRes.ok ? await profileRes.json() : {}
    const emailAddress = profile.mail || profile.userPrincipalName || (profile.otherMails && profile.otherMails[0]) || null

    await supabase.from('email_integrations').upsert({
      user_id: userId,
      provider: 'outlook',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry: expiry,
      email_address: emailAddress,
      active: true
    }, { onConflict: 'user_id,provider' })

    res.send(`<script>
      window.opener && window.opener.postMessage({ type: 'email_connected', provider: 'outlook' }, '*');
      document.write('<p style="font-family:sans-serif;text-align:center;margin-top:60px">Outlook connected! You can close this window.</p>');
      setTimeout(() => window.close(), 2000);
    </script>`)
  } catch (err) {
    console.error('Outlook OAuth error:', err.message)
    res.status(500).send('Outlook connection failed: ' + err.message)
  }
})

// ════════════════════════════════════════════
// SHARED ROUTES
// ════════════════════════════════════════════

router.get('/status', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('email_integrations')
    .select('provider, email_address, active, updated_at')
    .eq('user_id', req.user.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

router.delete('/disconnect/:provider', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('email_integrations')
    .delete()
    .eq('user_id', req.user.id)
    .eq('provider', req.params.provider)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Disconnected' })
})

router.post('/sync', requireAuth, async (req, res) => {
  const { data: integrations, error } = await supabase
    .from('email_integrations')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('active', true)

  if (error) return res.status(500).json({ error: error.message })
  if (!integrations.length) return res.json({ imported: 0, message: 'No email accounts connected' })

  let totalImported = 0
  const results = []

  for (const integration of integrations) {
    try {
      let imported = 0
      if (integration.provider === 'gmail') {
        imported = await syncGmail(req.user.id, integration)
      } else if (integration.provider === 'outlook') {
        imported = await syncOutlook(req.user.id, integration)
      }
      totalImported += imported
      results.push({ provider: integration.provider, email: integration.email_address, imported })
    } catch (err) {
      console.error(`Sync error for ${integration.provider}:`, err.message)
      results.push({ provider: integration.provider, email: integration.email_address, error: err.message })
    }
  }

  res.json({ imported: totalImported, results })
})

// ════════════════════════════════════════════
// GMAIL SYNC LOGIC
// ════════════════════════════════════════════

async function syncGmail(userId, integration) {
  const oauth2Client = getGmailClient()
  oauth2Client.setCredentials({
    access_token: integration.access_token,
    refresh_token: integration.refresh_token,
    expiry_date: integration.token_expiry ? new Date(integration.token_expiry).getTime() : null
  })

  oauth2Client.on('tokens', async (tokens) => {
    await supabase.from('email_integrations').update({
      access_token: tokens.access_token,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    }).eq('id', integration.id)
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
  const query = 'subject:(receipt OR invoice OR "order confirmation" OR "payment confirmation") has:attachment newer_than:30d'
  const searchRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 })

  const messages = searchRes.data.messages || []
  let imported = 0

  for (const msg of messages) {
    const { data: existing } = await supabase
      .from('receipts').select('id')
      .eq('user_id', userId).eq('email_message_id', 'gmail:' + msg.id).maybeSingle()
    if (existing) continue

    const msgRes = await gmail.users.messages.get({ userId: 'me', id: msg.id })
    const msgData = msgRes.data
    const headers = msgData.payload.headers || []
    const subject = headers.find(h => h.name === 'Subject')?.value || ''
    const fromHeader = headers.find(h => h.name === 'From')?.value || ''
    const dateHeader = headers.find(h => h.name === 'Date')?.value
    const emailDate = dateHeader ? new Date(dateHeader).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]

    if (!isReceiptSubject(subject)) continue

    const attachments = findAttachments(msgData.payload)
    if (!attachments.length) continue

    const attachment = attachments[0]
    let attachmentData = attachment.data

    if (!attachmentData && attachment.attachmentId) {
      const attRes = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: attachment.attachmentId })
      attachmentData = attRes.data.data
    }
    if (!attachmentData) continue

    const buffer = Buffer.from(attachmentData.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const ext = attachment.mimeType === 'application/pdf' ? 'pdf' : 'jpg'
    const filename = `${userId}/${Date.now()}_gmail.${ext}`

    const { error: uploadError } = await supabase.storage.from('receipts').upload(filename, buffer, { contentType: attachment.mimeType })
    if (uploadError) continue

    const { data: { publicUrl } } = supabase.storage.from('receipts').getPublicUrl(filename)

    // AI parse the attachment for accurate vendor/amount/date/tax
    const ai = await parseReceiptWithAI(buffer, attachment.mimeType)
    const senderName = extractSenderName(fromHeader)

    await supabase.from('receipts').insert({
      user_id: userId,
      file_url: publicUrl,
      vendor: ai?.vendor || senderName || extractVendorFromSubject(subject),
      amount: ai?.amount || null,
      date: ai?.date || emailDate,
      gst: ai?.gst || null,
      hst: ai?.hst || null,
      email_message_id: 'gmail:' + msg.id,
      source: 'email_gmail',
      needs_review: true
    })
    imported++
  }

  return imported
}

function findAttachments(payload) {
  const attachments = []
  function scan(part) {
    if (!part) return
    if (part.filename && part.filename.length > 0) {
      const mime = part.mimeType || ''
      if (mime === 'application/pdf' || mime.startsWith('image/')) {
        attachments.push({ filename: part.filename, mimeType: mime, attachmentId: part.body?.attachmentId, data: part.body?.data })
      }
    }
    if (part.parts) part.parts.forEach(scan)
  }
  scan(payload)
  return attachments
}

// ════════════════════════════════════════════
// OUTLOOK SYNC LOGIC
// ════════════════════════════════════════════

async function syncOutlook(userId, integration) {
  // Search for receipt-like emails with attachments in last 30 days
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Search for messages matching receipt keywords that have attachments
  const searchTerms = ['receipt', 'invoice', 'order confirmation', 'payment confirmation']
  const filterClauses = searchTerms.map(t => `contains(subject,'${t}')`).join(' or ')
  const filter = `(${filterClauses}) and hasAttachments eq true and receivedDateTime ge ${since}`
  const url = `/me/messages?$filter=${encodeURIComponent(filter)}&$top=25&$select=id,subject,receivedDateTime,hasAttachments,sender&$orderby=receivedDateTime desc`

  let messages
  try {
    const data = await graphGet(url, integration)
    messages = data.value || []
  } catch (err) {
    // Some tenants don't support $filter on subject — fall back to $search
    console.warn('Outlook filter failed, trying $search:', err.message)
    const searchUrl = `/me/messages?$search="receipt"&$top=25&$select=id,subject,receivedDateTime,hasAttachments`
    const data = await graphGet(searchUrl, integration)
    messages = (data.value || []).filter(m => m.hasAttachments && isReceiptSubject(m.subject))
  }

  let imported = 0

  for (const msg of messages) {
    if (!msg.hasAttachments) continue
    if (!isReceiptSubject(msg.subject)) continue

    // Check for duplicate
    const { data: existing } = await supabase
      .from('receipts').select('id')
      .eq('user_id', userId).eq('email_message_id', 'outlook:' + msg.id).maybeSingle()
    if (existing) continue

    // Get attachments
    let attachmentsData
    try {
      attachmentsData = await graphGet(`/me/messages/${msg.id}/attachments?$filter=size gt 1000`, integration)
    } catch {
      attachmentsData = await graphGet(`/me/messages/${msg.id}/attachments`, integration)
    }

    const attachments = (attachmentsData.value || []).filter(a => {
      const mime = a.contentType || ''
      return mime === 'application/pdf' || mime.startsWith('image/')
    })

    if (!attachments.length) continue

    const attachment = attachments[0]
    const contentBytes = attachment.contentBytes
    if (!contentBytes) continue

    const buffer = Buffer.from(contentBytes, 'base64')
    const ext = attachment.contentType === 'application/pdf' ? 'pdf' : 'jpg'
    const filename = `${userId}/${Date.now()}_outlook.${ext}`

    const { error: uploadError } = await supabase.storage
      .from('receipts').upload(filename, buffer, { contentType: attachment.contentType })
    if (uploadError) {
      console.error('Outlook upload error:', uploadError.message)
      continue
    }

    const { data: { publicUrl } } = supabase.storage.from('receipts').getPublicUrl(filename)

    const emailDate = msg.receivedDateTime
      ? new Date(msg.receivedDateTime).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0]

    // AI parse the attachment for accurate vendor/amount/date/tax
    const ai = await parseReceiptWithAI(buffer, attachment.contentType)
    const senderName = msg.sender?.emailAddress?.name || null

    await supabase.from('receipts').insert({
      user_id: userId,
      file_url: publicUrl,
      vendor: ai?.vendor || senderName || extractVendorFromSubject(msg.subject),
      amount: ai?.amount || null,
      date: ai?.date || emailDate,
      gst: ai?.gst || null,
      hst: ai?.hst || null,
      email_message_id: 'outlook:' + msg.id,
      source: 'email_outlook',
      needs_review: true
    })

    imported++
  }

  return imported
}

export default router
