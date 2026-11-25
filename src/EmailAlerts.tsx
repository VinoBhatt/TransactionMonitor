import { useEffect, useState } from 'react'
import { readDataset, request, writeDataset } from './api'
import type { Dataset } from './api'
import type { NotificationSettings } from '../shared/schema'

const empty: NotificationSettings = { recipients: [], onFlags: true, onScreening: true }
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

// Admin-only card: who receives alert emails, which alerts are on, and a test send.
export function EmailAlerts() {
  const [status, setStatus] = useState<{ configured: boolean, from: string } | null>(null)
  const [settings, setSettings] = useState<NotificationSettings>(empty), [text, setText] = useState('')
  const [version, setVersion] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')

  async function load() {
    try {
      const [state, datasets] = await Promise.all([request<{ configured: boolean, from: string }>('/notifications/status'), request<Dataset[]>('/datasets')])
      setStatus(state)
      const dataset = datasets.find(d => d.name === 'notifications')
      const saved = dataset ? (await readDataset<NotificationSettings>(dataset))[0] : undefined
      setVersion(dataset?.version || ''); setSettings(saved || empty); setText((saved || empty).recipients.join('\n'))
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not load email settings.') }
  }
  useEffect(() => { void load() }, [])

  const recipients = text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const invalid = recipients.filter(r => !isEmail(r))
  async function run(task: () => Promise<string>) {
    setBusy(true); setMessage('')
    try { setMessage(await task()) } catch (e) { setMessage(e instanceof Error ? e.message : 'Something went wrong.') } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const next = { ...settings, recipients: [...new Set(recipients)] }
    const result = await writeDataset('notifications', version, [next], 'Email alert settings')
    setVersion(result.version); setSettings(next)
    return 'Email alert settings saved.'
  })
  const test = () => run(async () => {
    const result = await request<{ sent: boolean, recipients?: number }>('/notifications/send', 'POST', { event: 'test' })
    return result.sent ? `Test email sent to ${result.recipients} recipient(s). Check the inbox (and spam folder).` : 'The test email was not sent.'
  })

  return <div className="card">
    <div className="card-head"><div><h2>Email alerts</h2><p className="muted">Emails are sent from the notification mailbox when an upload raises flags or a sanctions screening finds possible matches. They contain counts and a link only, never investor details.</p></div></div>
    {status && <p className={`status-line ${status.configured ? 'ok' : 'warn'}`}>{status.configured ? `Sending from ${status.from}` : 'Email sending is not set up yet. The SMTP secrets must be added to the Worker before alerts can be sent.'}</p>}
    {message && <div className={`notice ${/saved|sent to/i.test(message) ? 'success' : 'error'}`} role="status">{message}</div>}
    <div className="email-settings">
      <label>Recipients (one email address per line)<textarea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder={'compliance@cofundr.com.my\nchief.compliance@cofundr.com.my'} /></label>
      {invalid.length > 0 && <p className="warning-text">Not a valid email address: {invalid.join(', ')}</p>}
      <label className="switch-row"><input type="checkbox" checked={settings.onFlags} onChange={e => setSettings({ ...settings, onFlags: e.target.checked })} />Alert when an uploaded month has flags (including investors above RM30,000)</label>
      <label className="switch-row"><input type="checkbox" checked={settings.onScreening} onChange={e => setSettings({ ...settings, onScreening: e.target.checked })} />Alert when sanctions screening finds possible matches</label>
      <div className="button-row"><button disabled={busy || invalid.length > 0 || recipients.length > 20} onClick={() => void save()}>Save alert settings</button><button className="secondary" disabled={busy || !status?.configured} onClick={() => void test()}>Send test email</button></div>
    </div>
  </div>
}
