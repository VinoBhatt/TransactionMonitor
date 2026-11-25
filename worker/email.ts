import { connect } from 'cloudflare:sockets'

// Sends mail through the notification mailbox's own SMTP server (cPanel), configured with secrets:
// SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER (the full address) and SMTP_PASS.
export type MailEnv = { SMTP_HOST?: string, SMTP_PORT?: string, SMTP_USER?: string, SMTP_PASS?: string, SMTP_TLS?: string }
type Mode = 'on' | 'starttls' | 'off'
export type MailConfig = { host: string, port: number, user: string, pass: string, mode: Mode }

export function mailConfig(env: MailEnv): MailConfig | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null
  const port = Number(env.SMTP_PORT || 465)
  const requested = (env.SMTP_TLS || (port === 465 ? 'on' : 'starttls')).toLowerCase() as Mode
  // Plain-text connections are only allowed to a mail server on this machine (local testing).
  const local = env.SMTP_HOST === '127.0.0.1' || env.SMTP_HOST === 'localhost'
  const mode: Mode = requested === 'off' && !local ? 'starttls' : requested
  return { host: env.SMTP_HOST, port, user: env.SMTP_USER, pass: env.SMTP_PASS, mode }
}

class SmtpError extends Error {}
const encoder = new TextEncoder(), decoder = new TextDecoder()
const b64 = (text: string) => { let s = ''; for (const byte of encoder.encode(text)) s += String.fromCharCode(byte); return btoa(s) }
const header = (text: string) => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`
const wrap = (text: string) => b64(text).replace(/.{1,76}/g, line => `${line}\r\n`)

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmtpError(`Mail server timed out (${what}).`)), ms) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function sendMail(config: MailConfig, message: { to: string[], subject: string, text: string, html: string }) {
  let socket = connect({ hostname: config.host, port: config.port }, { secureTransport: config.mode, allowHalfOpen: false })
  let reader = socket.readable.getReader(), writer = socket.writable.getWriter(), buffer = ''

  async function reply(expect: number[], step: string) {
    for (;;) {
      const lines = buffer.split('\r\n')
      const last = lines.findIndex(line => /^\d{3} /.test(line))
      if (last >= 0) {
        buffer = lines.slice(last + 1).join('\r\n')
        const code = Number(lines[last].slice(0, 3))
        if (!expect.includes(code)) throw new SmtpError(`Mail server rejected ${step}: ${lines.slice(0, last + 1).join(' ').slice(0, 300)}`)
        return lines.slice(0, last + 1)
      }
      const { value, done } = await withTimeout(reader.read(), 20000, step)
      if (done) throw new SmtpError(`Mail server closed the connection during ${step}.`)
      buffer += decoder.decode(value, { stream: true })
    }
  }
  const send = (line: string) => writer.write(encoder.encode(`${line}\r\n`))
  const domain = config.user.split('@')[1] || 'localhost'

  try {
    await reply([220], 'greeting')
    await send(`EHLO ${domain}`); await reply([250], 'EHLO')
    if (config.mode === 'starttls') {
      await send('STARTTLS'); await reply([220], 'STARTTLS')
      reader.releaseLock(); writer.releaseLock()
      socket = socket.startTls()
      reader = socket.readable.getReader(); writer = socket.writable.getWriter(); buffer = ''
      await send(`EHLO ${domain}`); await reply([250], 'EHLO')
    }
    await send(`AUTH PLAIN ${b64(`\u0000${config.user}\u0000${config.pass}`)}`); await reply([235], 'the login (check SMTP_USER and SMTP_PASS)')
    await send(`MAIL FROM:<${config.user}>`); await reply([250], 'the sender')
    for (const to of message.to) { await send(`RCPT TO:<${to}>`); await reply([250, 251], `recipient ${to}`) }
    await send('DATA'); await reply([354], 'DATA')
    const boundary = `tm-${crypto.randomUUID()}`
    const body = [
      `From: ${header('Cofundr Transaction Monitoring')} <${config.user}>`,
      `To: ${message.to.join(', ')}`,
      `Subject: ${header(message.subject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(message.text),
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(message.html),
      `--${boundary}--`, '',
    ].join('\r\n')
    await writer.write(encoder.encode(`${body}\r\n.\r\n`)); await reply([250], 'the message')
    await send('QUIT').catch(() => undefined)
  } finally {
    try { reader.releaseLock(); writer.releaseLock() } catch { /* already released */ }
    await socket.close().catch(() => undefined)
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// Alerts carry counts and a link only; investor details stay inside the signed-in workspace.
export function alertEmail(title: string, intro: string, lines: string[], link: string, action: string) {
  const text = [title, '', intro, '', ...lines.map(l => `- ${l}`), '', `${action}: ${link}`, '', 'This alert contains counts only. Sign in to see investor details.'].join('\n')
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#152235;max-width:560px">
<div style="background:#071b32;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0"><strong>Cofundr Transaction Monitoring</strong></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:20px;border-radius:0 0 10px 10px">
<h2 style="margin:0 0 10px;font-size:18px">${escape(title)}</h2><p style="color:#566679">${escape(intro)}</p>
<ul style="padding-left:18px;line-height:1.7">${lines.map(l => `<li>${escape(l)}</li>`).join('')}</ul>
<p><a href="${escape(link)}" style="display:inline-block;background:#2694d2;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${escape(action)}</a></p>
<p style="color:#8794a2;font-size:12px">This alert contains counts only. Sign in to see investor details.</p></div></div>`
  return { text, html }
}
