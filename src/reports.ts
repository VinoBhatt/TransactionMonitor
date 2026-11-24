import type { jsPDF as JsPDF } from 'jspdf'
import type { Signoff } from '../shared/schema'
import type { Flag, InvestorRecord, NoteMasterRow, ReviewRecord, StaffMember, Transaction } from './types'
import { investorKey, isDeposit, isWithdrawal, monthLabel, staffInvestments } from './monitoring'

export type MonitoringReportInput = {
  month: string
  transactions: Transaction[]
  flags: Flag[]
  reviews: Record<string, ReviewRecord>
  signoff?: Signoff
  generatedBy: string
}

export type DepositReportInput = {
  month: string
  transactions: Transaction[]
  flags: Flag[]
  generatedBy: string
  investorIdFor?: (name: string) => string | undefined
}

export type StaffReportInput = {
  month: string
  staff: StaffMember
  transactions: Transaction[]
  notes: NoteMasterRow[]
  investor?: InvestorRecord
  generatedBy: string
}

const navy: [number, number, number] = [7, 27, 50]
const grey: [number, number, number] = [100, 112, 128]
const amount = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const stamp = (d: Date | null) => d ? new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : '-'
const safeName = (value: string) => value.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'Unnamed'

export const monitoringFileName = (month: string) => `${month} Transaction Monitoring Report.pdf`
export const depositFileName = (month: string) => `${month} Deposit Report.pdf`
export const staffFileName = (month: string, staff: StaffMember) => `${month} Staff Investment Report - ${safeName(staff.name)}.pdf`

async function load() {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  return { jsPDF, autoTable }
}

type Tools = Awaited<ReturnType<typeof load>>

function lastY(doc: JsPDF) {
  return (doc as JsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 0
}

function header(doc: JsPDF, kicker: string, title: string, generatedBy: string) {
  doc.setFillColor(...navy)
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 4, 'F')
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...grey).text(kicker.toUpperCase(), 14, 16)
  doc.setFontSize(16).setTextColor(...navy).text(title, 14, 25)
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...grey)
    .text(`Generated ${stamp(new Date())} by ${generatedBy} · Cofundr Compliance Unit`, 14, 31)
  return 38
}

function heading(doc: JsPDF, text: string, y: number) {
  if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 20 }
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...navy).text(text, 14, y)
  return y + 3
}

function paragraph(doc: JsPDF, text: string, y: number) {
  const width = doc.internal.pageSize.getWidth() - 28
  const lines = doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60, 70, 85).splitTextToSize(text, width)
  doc.text(lines, 14, y)
  return y + lines.length * 4.2
}

function footer(doc: JsPDF, label: string) {
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    const h = doc.internal.pageSize.getHeight(), w = doc.internal.pageSize.getWidth()
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...grey)
    doc.text(`${label} · Confidential`, 14, h - 8)
    doc.text(`Page ${page} of ${pages}`, w - 14, h - 8, { align: 'right' })
  }
}

function signatures(doc: JsPDF, y: number, blocks: { role: string, name?: string, detail?: string }[]) {
  if (y > doc.internal.pageSize.getHeight() - 55) { doc.addPage(); y = 25 }
  const width = (doc.internal.pageSize.getWidth() - 28 - 10 * (blocks.length - 1)) / blocks.length
  blocks.forEach((block, i) => {
    const x = 14 + i * (width + 10)
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...navy).text(block.role, x, y)
    doc.setDrawColor(150).line(x, y + 18, x + width, y + 18)
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(60, 70, 85)
    doc.text(`Name: ${block.name || ''}`, x, y + 24)
    doc.text(block.detail || 'Designation:', x, y + 29)
    doc.text('Date:', x, y + 34)
  })
  return y + 40
}

const table = (tools: Tools, doc: JsPDF, startY: number, head: string[], body: (string | number)[][], options: { rightAlign?: number[], foot?: (string | number)[] } = {}) => {
  tools.autoTable(doc, {
    startY, head: [head], body, foot: options.foot ? [options.foot] : undefined, showFoot: 'lastPage',
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 1.8, textColor: [40, 50, 65], lineColor: [226, 232, 240], lineWidth: 0.1 },
    headStyles: { fillColor: navy, textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [241, 245, 249], textColor: navy, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: Object.fromEntries((options.rightAlign || []).map(i => [i, { halign: 'right' as const }])),
  })
  return lastY(doc) + 8
}

const summaryTable = (tools: Tools, doc: JsPDF, startY: number, rows: [string, string][]) => {
  tools.autoTable(doc, {
    startY, body: rows, theme: 'plain', margin: { left: 14, right: 14 },
    styles: { fontSize: 9, cellPadding: 1.6, textColor: [40, 50, 65] },
    columnStyles: { 0: { cellWidth: 70, textColor: grey }, 1: { fontStyle: 'bold' } },
  })
  return lastY(doc) + 6
}

export async function monitoringReport(input: MonitoringReportInput) {
  const tools = await load()
  const doc = new tools.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const label = monthLabel(input.month)
  const deposits = input.transactions.filter(isDeposit)
  const withdrawals = input.transactions.filter(isWithdrawal)
  const decision = (f: Flag) => input.reviews[f.id]?.decision || 'Pending'
  const count = (value: string) => input.flags.filter(f => decision(f) === value).length
  const mandatory = input.flags.filter(f => f.ruleId === 'TM-001')

  let y = header(doc, 'Monthly Transaction Monitoring Report', `TRANSACTION MONITORING REPORT - ${label.toUpperCase()}`, input.generatedBy)
  y = heading(doc, '1. Summary', y + 2)
  y = summaryTable(tools, doc, y, [
    ['Review month', label],
    ['Transactions analysed', input.transactions.length.toLocaleString()],
    ['Deposits', `${deposits.length} transaction(s), RM ${amount(deposits.reduce((s, t) => s + t.amount, 0))}`],
    ['Withdrawals', `${withdrawals.length} transaction(s), RM ${amount(withdrawals.reduce((s, t) => s + t.amount, 0))}`],
    ['Investors above RM30,000 (TM-001)', `${mandatory.length} investor(s), RM ${amount(mandatory.reduce((s, f) => s + f.amount, 0))}`],
    ['Total flags raised', String(input.flags.length)],
    ['Review outcome', `Cleared ${count('Cleared')} · Request Information ${count('Request Information')} · Escalated ${count('Escalated')} · Pending ${count('Pending')}`],
  ])

  const byRule = new Map<string, Flag[]>()
  for (const f of input.flags) byRule.set(`${f.ruleId} ${f.ruleName}`, [...(byRule.get(`${f.ruleId} ${f.ruleName}`) || []), f])
  y = heading(doc, '2. Flags by rule', y)
  y = table(tools, doc, y, ['Rule', 'Flags', 'Total amount (RM)', 'Pending'],
    [...byRule].sort(([a], [b]) => a.localeCompare(b)).map(([rule, list]) => [rule, list.length, amount(list.reduce((s, f) => s + f.amount, 0)), list.filter(f => decision(f) === 'Pending').length]),
    { rightAlign: [1, 2, 3] })
  if (!input.flags.length) y = paragraph(doc, 'No transactions met the criteria of any enabled monitoring rule for this month.', y - 4) + 4

  y = heading(doc, '3. Flagged investors and compliance review', y)
  y = table(tools, doc, y,
    ['No.', 'Rule', 'Investor', 'Investor ID', 'Risk', 'Amount (RM)', 'Remarks', 'Decision', 'Compliance comments', 'Reviewed by / at'],
    input.flags.map((f, i) => {
      const r = input.reviews[f.id]
      return [i + 1, f.ruleId, f.investorName, f.investorId || '-', f.riskProfile || '-', amount(f.amount),
        [f.reason, f.priorComplianceContext ? `Prior context: ${f.priorComplianceContext}` : ''].filter(Boolean).join('\n'),
        decision(f), r?.comments || '-', r?.reviewedBy ? `${r.reviewedBy}\n${stamp(new Date(r.reviewedAt))}` : '-']
    }),
    { rightAlign: [5] })
  if (!input.flags.length) y = paragraph(doc, 'Nil.', y - 4) + 4

  y = heading(doc, '4. Compliance sign-off', y)
  const s = input.signoff
  y = summaryTable(tools, doc, y, [
    ['Sign-off status', s?.status || 'Not signed off'],
    ['Reviewed by', s?.reviewedBy || '-'],
    ['Designation', s?.designation || '-'],
    ['Recorded', s ? stamp(new Date(s.updatedAt)) : '-'],
    ['Review comments', s?.comments || '-'],
  ])
  signatures(doc, y + 4, [
    { role: 'Prepared by (Compliance Officer)' },
    { role: 'Reviewed by (Chief Compliance Officer)', name: s?.reviewedBy, detail: s?.designation ? `Designation: ${s.designation}` : undefined },
  ])
  footer(doc, `Transaction Monitoring Report · ${label}`)
  return doc.output('blob')
}

// Every deposit in the month, not only the investors above the TM-001 threshold.
export async function depositReport(input: DepositReportInput) {
  const tools = await load()
  const doc = new tools.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const label = monthLabel(input.month)
  const deposits = input.transactions.filter(isDeposit)
  const mandatory = input.flags.filter(f => f.ruleId === 'TM-001')
  const depositTotal = deposits.reduce((s, t) => s + t.amount, 0)
  const flaggedKeys = new Set(mandatory.map(f => f.investorKey))
  const idFor = (t: Transaction) => mandatory.find(f => f.investorKey === investorKey(t))?.investorId || input.investorIdFor?.(t.name) || '-'
  const byInvestor = new Map<string, Transaction[]>()
  for (const t of deposits) byInvestor.set(investorKey(t), [...(byInvestor.get(investorKey(t)) || []), t])
  const investorRows = [...byInvestor].map(([key, list]) => ({ key, list, total: list.reduce((s, t) => s + t.amount, 0) })).sort((a, b) => b.total - a.total)

  let y = header(doc, 'Monthly Deposit Report', `DEPOSIT REPORT - ${label.toUpperCase()}`, input.generatedBy)
  y = heading(doc, '1. Summary', y + 2)
  y = summaryTable(tools, doc, y, [
    ['Review month', label],
    ['Deposits', `${deposits.length} transaction(s)`],
    ['Investors depositing', String(investorRows.length)],
    ['Total deposited', `RM ${amount(depositTotal)}`],
    ['Investors above RM30,000 (TM-001)', `${mandatory.length} investor(s), RM ${amount(mandatory.reduce((s, f) => s + f.amount, 0))}`],
  ])
  y = heading(doc, '2. Deposits by investor', y)
  y = table(tools, doc, y, ['No.', 'Investor', 'Investor ID', 'Account No.', 'Deposits', 'Total (RM)', 'TM-001'],
    investorRows.map((row, i) => [i + 1, row.list[0].name, idFor(row.list[0]), row.list[0].accountNo || '-', row.list.length, amount(row.total), flaggedKeys.has(row.key) ? 'Above RM30,000' : '-']),
    { rightAlign: [4, 5], foot: deposits.length ? ['', 'Total', '', '', deposits.length, amount(depositTotal), ''] : undefined })
  if (!deposits.length) y = paragraph(doc, 'Nil. No deposits were recorded for this month.', y - 4) + 4
  if (deposits.length) {
    y = heading(doc, '3. Deposit transactions', y)
    const sorted = [...deposits].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))
    y = table(tools, doc, y, ['No.', 'Date / Time', 'Investor', 'Investor ID', 'Bank', 'Pay via', 'Transaction No.', 'Amount (RM)'],
      sorted.map((t, i) => [i + 1, stamp(t.date), t.name, idFor(t), t.bank || '-', t.payVia || '-', t.transactionNo || '-', amount(t.amount)]),
      { rightAlign: [7], foot: ['', '', 'Total', '', '', '', '', amount(depositTotal)] })
  }
  signatures(doc, y + 4, [{ role: 'Prepared by (Compliance Officer)' }, { role: 'Reviewed by (Chief Compliance Officer)' }])
  footer(doc, `Deposit Report · ${label}`)
  return doc.output('blob')
}

export async function staffReport(input: StaffReportInput) {
  const tools = await load()
  const doc = new tools.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const label = monthLabel(input.month)
  const rows = staffInvestments(input.transactions, [{ ...input.staff, active: true }], input.notes)
  const total = rows.reduce((s, x) => s + x.transaction.amount, 0)

  let y = header(doc, 'Appendix II - Staff Investment Report', `STAFF INVESTMENT REPORT - ${label.toUpperCase()}`, input.generatedBy)
  y = paragraph(doc, 'Report generated by the Compliance Unit from the platform pursuant to Clause 7.1.3, for review of possible conflicts of interest at the monthly Senior Management Team meeting.', y + 2) + 3
  y = heading(doc, '1. Staff member', y)
  y = summaryTable(tools, doc, y, [
    ['Name', input.staff.name],
    ...(input.investor ? [['Investor ID', input.investor.investorId] as [string, string]] : []),
    ...(input.investor?.dateRegistered ? [['Registered on platform', input.investor.dateRegistered] as [string, string]] : []),
    ...(input.staff.identifier ? [['Staff identifier', input.staff.identifier] as [string, string]] : []),
    ...(input.staff.email || input.investor?.email ? [['Email', (input.staff.email || input.investor?.email)!] as [string, string]] : []),
    ['Reporting month', label],
    ['Investments recorded', `${rows.length} transaction(s)`],
    ['Total invested', `RM ${amount(total)}`],
  ])
  y = heading(doc, '2. Investment transactions', y)
  y = table(tools, doc, y, ['No.', 'Note Reference ID', 'Note Name', 'Amount (RM)', 'Status', 'Date / Time'],
    rows.map((x, i) => [i + 1, x.note?.referenceId || x.transaction.noteId, x.note?.noteName || 'Note master required', amount(x.transaction.amount), 'Successful', stamp(x.transaction.date)]),
    { rightAlign: [3], foot: rows.length ? ['', '', 'Total', amount(total), '', ''] : undefined })
  if (!rows.length) y = paragraph(doc, `Nil. No investment transactions were recorded on the platform for ${input.staff.name} during ${label}.`, y - 4) + 6

  y = heading(doc, '3. Review', y)
  y = paragraph(doc, 'Senior Management Team review of possible conflicts of interest:  [  ] No conflict identified     [  ] Further action required', y + 3) + 8
  signatures(doc, y, [{ role: 'Prepared by (Compliance Unit)' }, { role: 'Reviewed by' }])
  footer(doc, `Staff Investment Report · ${input.staff.name} · ${label}`)
  return doc.output('blob')
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function zipFiles(files: { name: string, blob: Blob }[]) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const file of files) zip.file(file.name, file.blob)
  return zip.generateAsync({ type: 'blob' })
}
