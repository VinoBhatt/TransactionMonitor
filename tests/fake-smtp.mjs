import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'

// Fake mail server for the integration tests. It accepts only the test account's login and keeps
// every message so the tests can read them at http://127.0.0.1:8790/messages.
export const smtpAccount = { user: 'notification@test.local', pass: 'test-smtp-password' }

export function startFakeSmtp() {
  const messages = []
  createServer(socket => {
    let buffer = '', data = false, auth = false, message = { from: '', to: [], body: '' }
    socket.write('220 test.local ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          message.body = buffer.slice(0, end); buffer = buffer.slice(end + 5); data = false
          messages.push(message); message = { from: '', to: [], body: '' }
          socket.write('250 OK queued\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (/^EHLO/i.test(line)) socket.write('250-test.local\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000')
          auth = user === smtpAccount.user && pass === smtpAccount.pass
          socket.write(auth ? '235 Authenticated\r\n' : '535 Bad credentials\r\n')
        }
        else if (/^MAIL FROM:/i.test(line)) { message.from = line.slice(10).replace(/[<>]/g, ''); socket.write(auth ? '250 OK\r\n' : '530 Authentication required\r\n') }
        else if (/^RCPT TO:/i.test(line)) { message.to.push(line.slice(8).replace(/[<>]/g, '')); socket.write('250 OK\r\n') }
        else if (/^DATA/i.test(line)) { data = true; socket.write('354 Go ahead\r\n') }
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
    socket.on('error', () => {})
  }).listen(2525, '127.0.0.1')
  createHttpServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(messages)) }).listen(8790, '127.0.0.1')
}
