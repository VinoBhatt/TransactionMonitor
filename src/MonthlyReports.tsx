import { useState } from 'react'
import { request } from './api'
import type { Signoff } from '../shared/schema'
import type { Flag, InvestorRecord, NoteMasterRow, ReviewRecord, StaffMember, Transaction } from './types'
import { investorLookup, monthLabel, staffInvestments } from './monitoring'
import { downloadBlob, monitoringFileName, monitoringReport, staffFileName, staffReport, zipFiles } from './reports'

type Props = {
  month: string
  transactions: Transaction[]
  flags: Flag[]
  reviews: Record<string, ReviewRecord>
  signoff?: Signoff
  staff: StaffMember[]
  notes: NoteMasterRow[]
  investors: InvestorRecord[]
  generatedBy: string
}

export function MonthlyReports({ month, transactions, flags, reviews, signoff, staff, notes, investors, generatedBy }: Props) {
  const byName = investorLookup(investors)
  const findInvestor = (member: StaffMember) => (member.identifier && investors.find(i => i.investorId === member.identifier)) || byName(member.name)
  const [working, setWorking] = useState(''), [error, setError] = useState('')
  const activeStaff = staff.filter(s => s.active).sort((a, b) => a.name.localeCompare(b.name))
  const pending = flags.filter(f => (reviews[f.id]?.decision || 'Pending') === 'Pending').length

  async function run(key: string, task: () => Promise<void>) {
    if (working) return
    setWorking(key); setError('')
    try { await task() } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate the report.') }
    finally { setWorking('') }
  }
  // Logged before the file is handed over, so every downloaded report appears in the audit trail.
  const logReport = (kind: 'monitoring' | 'staff' | 'staff-all', subject?: string) => request('/report-log', 'POST', { kind, month, ...(subject ? { subject } : {}) })
  const monitoring = () => monitoringReport({ month, transactions, flags, reviews, signoff, generatedBy, investorIdFor: name => byName(name)?.investorId })
  const staffPdf = (member: StaffMember) => staffReport({ month, staff: member, transactions, notes, investor: findInvestor(member), generatedBy })

  return <section className="card full monthly-reports">
    <div className="card-head"><div><h2>Monthly reports · {monthLabel(month)}</h2><p className="muted">Download PDF reports to keep with your local compliance records. Each active staff member gets their own Staff Investment Report, including a nil report if they made no investments this month.</p></div></div>
    {error && <div className="notice" role="alert">{error}</div>}
    <div className="report-grid">
      <div className="report-block">
        <h3>Transaction Monitoring Report</h3>
        <p className="muted">Summary, flags by rule, flagged investors with review decisions, and the compliance sign-off for the month.</p>
        {(pending > 0 || signoff?.status !== 'Completed') && <p className="report-warning">{[pending ? `${pending} flag(s) still pending review` : '', signoff?.status !== 'Completed' ? 'monthly sign-off not completed' : ''].filter(Boolean).join(' · ')}. You can still generate the report, but it will show these as outstanding.</p>}
        <button disabled={!!working} onClick={() => void run('monitoring', async () => { const blob = await monitoring(); await logReport('monitoring'); downloadBlob(blob, monitoringFileName(month)) })}>{working === 'monitoring' ? 'Generating…' : 'Download Monitoring Report (PDF)'}</button>
      </div>
      <div className="report-block">
        <div className="card-head"><h3>Staff Investment Reports</h3>{activeStaff.length > 0 && <button className="secondary" disabled={!!working} onClick={() => void run('all', async () => {
          const files = []
          for (const member of activeStaff) files.push({ name: staffFileName(month, member), blob: await staffPdf(member) })
          const zip = await zipFiles(files)
          await logReport('staff-all', `${files.length} staff`)
          downloadBlob(zip, `${month} Staff Investment Reports.zip`)
        })}>{working === 'all' ? 'Generating…' : `Download all (${activeStaff.length}) as ZIP`}</button>}</div>
        {!activeStaff.length ? <p className="muted">No staff selected. Add staff in the Staff Register under Monthly Upload.</p> :
          <div className="table-wrap"><table><thead><tr><th>Staff</th><th>Investments</th><th>Total (RM)</th><th></th></tr></thead><tbody>{activeStaff.map(member => {
            const rows = staffInvestments(transactions, [member], notes)
            return <tr key={member.id}><td>{member.name}{findInvestor(member) && <small className="subline">ID {findInvestor(member)!.investorId}</small>}</td><td>{rows.length || 'Nil'}</td><td className="num">{rows.reduce((s, x) => s + x.transaction.amount, 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</td>
              <td className="num"><button className="secondary" aria-label={`Download staff report for ${member.name}`} disabled={!!working} onClick={() => void run(member.id, async () => { const blob = await staffPdf(member); await logReport('staff', member.name); downloadBlob(blob, staffFileName(month, member)) })}>{working === member.id ? 'Generating…' : 'PDF'}</button></td></tr>
          })}</tbody></table></div>}
      </div>
    </div>
  </section>
}
