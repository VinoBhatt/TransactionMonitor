import { useState } from 'react'
import { request } from './api'
import type { Signoff } from '../shared/schema'
import type { Flag, InvestorRecord, NoteMasterRow, ReviewRecord, StaffMember, Transaction } from './types'
import { exportSheets, investorKey, investorLookup, monthLabel, staffInvestments } from './monitoring'
import type { ActivityKind } from './reports'
import { activityFileName, activityKinds, activityReport, activityRows, downloadBlob, monitoringFileName, monitoringReport, staffFileName, staffReport, zipFiles } from './reports'

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
  const logReport = (kind: 'monitoring' | ActivityKind | 'staff' | 'staff-all' | 'pack', subject?: string) => request('/report-log', 'POST', { kind, month, ...(subject ? { subject } : {}) })
  const monitoring = () => monitoringReport({ month, transactions, flags, reviews, signoff, generatedBy })
  const activityPdf = (kind: ActivityKind) => activityReport(kind, { month, transactions, flags, notes, generatedBy, investorIdFor: name => byName(name)?.investorId })
  const depositCount = activityRows('deposits', transactions).length
  const noteFor = new Map(notes.map(n => [String(n.noteId), n]))
  const stamp = (d: Date | null) => d ? d.toISOString().replace('T', ' ').slice(0, 16) : ''

  // Excel copies of the three reports, for sorting and filtering.
  const monitoringExcel = () => exportSheets(`${month} Transaction Monitoring Report.xlsx`, [
    { name: 'Summary', rows: [{ 'Month': monthLabel(month), 'Transactions': transactions.length, 'Deposits': depositCount, 'Flags': flags.length, 'Pending': pending, 'Sign-off': signoff?.status || 'Not signed off', 'Signed off by': signoff?.reviewedBy || '' }] },
    { name: 'Flags', rows: flags.map((f, i) => ({ 'No.': i + 1, 'Rule': `${f.ruleId} ${f.ruleName}`, 'Investor': f.investorName, 'Investor ID': f.investorId || '', 'AML Risk': f.riskProfile || '', 'KYC': f.kycStatus || '', 'Amount (RM)': f.amount, 'Remarks': f.reason, 'Decision': reviews[f.id]?.decision || 'Pending', 'Comments': reviews[f.id]?.comments || '', 'Reviewed By': reviews[f.id]?.reviewedBy || '', 'Reviewed At': reviews[f.id]?.reviewedAt || '' })) },
  ])
  const activityExcel = (kind: ActivityKind) => {
    const config = activityKinds[kind], rows = activityRows(kind, transactions)
    const flagged = new Set(config.rule ? flags.filter(f => f.ruleId === config.rule!.id).map(f => f.investorKey) : [])
    const groups = new Map<string, Transaction[]>()
    for (const t of rows) groups.set(investorKey(t), [...(groups.get(investorKey(t)) || []), t])
    exportSheets(`${month} ${config.title}.xlsx`, [
      { name: 'By Investor', rows: [...groups].map(([key, list]) => ({ 'Investor': list[0].name, 'Investor ID': byName(list[0].name)?.investorId || '', 'Account No.': list[0].accountNo, [config.plural]: list.length, 'Total (RM)': list.reduce((s, t) => s + t.amount, 0), ...(config.rule ? { [config.rule.label]: flagged.has(key) ? 'Flagged' : '' } : {}) })).sort((a, b) => b['Total (RM)'] - a['Total (RM)']) },
      { name: 'Transactions', rows: [...rows].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)).map((t, i) => ({ 'No.': i + 1, 'Date / Time': stamp(t.date), 'Investor': t.name, 'Investor ID': byName(t.name)?.investorId || '',
        ...(kind === 'investments' ? { 'Note Reference ID': noteFor.get(String(t.noteId))?.referenceId || t.noteId, 'Note Name': noteFor.get(String(t.noteId))?.noteName || '' } : { 'Bank': t.bank, 'Account No.': t.accountNo, 'Pay via': t.payVia, 'Transaction No.': t.transactionNo }),
        'Amount (RM)': t.amount })) },
    ])
  }
  const staffExcel = () => exportSheets(`${month} Staff Investment Reports.xlsx`, activeStaff.map(member => ({
    name: member.name,
    rows: staffInvestments(transactions, [member], notes).map((x, i) => ({ 'No.': i + 1, 'Staff': member.name, 'Investor ID': findInvestor(member)?.investorId || '', 'Note Reference ID': x.note?.referenceId || x.transaction.noteId, 'Note Name': x.note?.noteName || '', 'Amount (RM)': x.transaction.amount, 'Date / Time': stamp(x.transaction.date) })),
  })))
  const pack = async () => {
    const files = [{ name: monitoringFileName(month), blob: await monitoring() }]
    for (const kind of ['deposits', 'investments', 'withdrawals'] as const) files.push({ name: activityFileName(kind, month), blob: await activityPdf(kind) })
    for (const member of activeStaff) files.push({ name: `Staff Investment Reports/${staffFileName(month, member)}`, blob: await staffPdf(member) })
    const zip = await zipFiles(files)
    await logReport('pack', `${files.length} files`)
    downloadBlob(zip, `${month} Monthly Report Pack.zip`)
  }
  const staffPdf = (member: StaffMember) => staffReport({ month, staff: member, transactions, notes, investor: findInvestor(member), generatedBy })

  return <section className="card full monthly-reports">
    <div className="card-head"><div><h2>Monthly reports · {monthLabel(month)}</h2><p className="muted">Download PDF reports to keep with your local compliance records. Each active staff member gets their own Staff Investment Report, including a nil report if they made no investments this month.</p></div><button disabled={!!working} onClick={() => void run('pack', pack)}>{working === 'pack' ? 'Generating…' : 'Download month pack (ZIP)'}</button></div>
    {error && <div className="notice" role="alert">{error}</div>}
    <div className="report-grid">
      <div className="report-block">
        <h3>Transaction Monitoring Report</h3>
        <p className="muted">Summary, flags by rule, flagged investors with review decisions, and the compliance sign-off for the month.</p>
        {(pending > 0 || signoff?.status !== 'Completed') && <p className="report-warning">{[pending ? `${pending} flag(s) still pending review` : '', signoff?.status !== 'Completed' ? 'monthly sign-off not completed' : ''].filter(Boolean).join(' · ')}. You can still generate the report, but it will show these as outstanding.</p>}
        <div className="button-row"><button aria-label="Download Monitoring Report (PDF)" disabled={!!working} onClick={() => void run('monitoring', async () => { const blob = await monitoring(); await logReport('monitoring'); downloadBlob(blob, monitoringFileName(month)) })}>{working === 'monitoring' ? 'Generating…' : 'Download PDF'}</button>
        <button className="secondary" disabled={!!working} onClick={() => void run('monitoring-x', async () => { await logReport('monitoring', 'Excel'); monitoringExcel() })}>Excel</button></div>
      </div>
      {(['deposits', 'investments', 'withdrawals'] as const).map(kind => {
        const config = activityKinds[kind], count = activityRows(kind, transactions).length
        const text = kind === 'deposits' ? 'with investors above RM30,000 marked' : kind === 'withdrawals' ? 'with investors flagged by TM-007 marked; rejected withdrawals are left out' : 'with the note reference and name for each investment'
        return <div className="report-block" key={kind}>
          <h3>{config.title}</h3>
          <p className="muted">Every {config.noun} for the month ({count}), totalled by investor and listed by transaction, {text}.</p>
          <div className="button-row"><button aria-label={`Download ${config.title} (PDF)`} disabled={!!working} onClick={() => void run(kind, async () => { const blob = await activityPdf(kind); await logReport(kind); downloadBlob(blob, activityFileName(kind, month)) })}>{working === kind ? 'Generating…' : 'Download PDF'}</button>
            <button className="secondary" aria-label={`Download ${config.title} (Excel)`} disabled={!!working} onClick={() => void run(`${kind}-x`, async () => { await logReport(kind, 'Excel'); activityExcel(kind) })}>Excel</button></div>
        </div>
      })}
      <div className="report-block">
        <div className="card-head"><h3>Staff Investment Reports</h3>{activeStaff.length > 0 && <button className="secondary" disabled={!!working} onClick={() => void run('all', async () => {
          const files = []
          for (const member of activeStaff) files.push({ name: staffFileName(month, member), blob: await staffPdf(member) })
          const zip = await zipFiles(files)
          await logReport('staff-all', `${files.length} staff`)
          downloadBlob(zip, `${month} Staff Investment Reports.zip`)
        })}>{working === 'all' ? 'Generating…' : `Download all (${activeStaff.length}) as ZIP`}</button>}{activeStaff.length > 0 && <button className="secondary" disabled={!!working} onClick={() => void run('staff-x', async () => { await logReport('staff-all', 'Excel'); staffExcel() })}>Excel</button>}</div>
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
