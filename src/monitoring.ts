import * as XLSX from 'xlsx'
import type { CustomerProfile, Flag, HistoricalInvestor, InvestorRecord, NoteMasterRow, PriorComplianceContext, RawRow, ReviewRecord, RuleConfig, StaffMember, Transaction } from './types'

const clean = (v: unknown) => (v == null ? '' : String(v).trim())
const norm = (v: unknown) => clean(v).toLowerCase().replace(/\s+/g, ' ')
const money = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(clean(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v)
    if (p) return new Date(p.y, p.m - 1, p.d, p.H || 0, p.M || 0, Math.floor(p.S || 0))
  }
  const s = clean(v)
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/)
  if (m) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    return new Date(Number(m[3]), months.indexOf(m[2].toLowerCase()), Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export const monthKey = (d: Date | null) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}` : 'Unknown'
export const monthLabel = (key: string) => {
  if (!key || key === 'Unknown') return key || '—'
  const [y,m] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-MY', { month: 'long', year: 'numeric' }).format(new Date(y,m-1,1))
}

function findHeaderIndex(rows: unknown[][]): number {
  const expected = ['name','amount(myr)','date','action']
  const idx = rows.findIndex(row => {
    const values = row.map(norm)
    return expected.every(h => values.includes(h))
  })
  if (idx >= 0) return idx
  throw new Error('Could not find the transaction header row. Expected Name, Amount(MYR), Date and Action columns.')
}

export async function parseWorkbook(file: File): Promise<Transaction[]> {
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
  const headerIndex = findHeaderIndex(matrix)
  const headers = matrix[headerIndex].map(clean)
  const rows = matrix.slice(headerIndex + 1)

  const get = (obj: RawRow, names: string[]) => {
    const key = Object.keys(obj).find(k => names.includes(norm(k)))
    return key ? obj[key] : ''
  }

  return rows.map((row, i) => {
    const obj: RawRow = {}
    headers.forEach((h, j) => { obj[h] = row[j] })
    return {
      sourceRow: headerIndex + i + 2,
      noteId: clean(get(obj, ['note id','noteid'])),
      name: clean(get(obj, ['name','investor name','staff name'])),
      userType: clean(get(obj, ['user type','usertype'])),
      bank: clean(get(obj, ['bank'])),
      accountNo: clean(get(obj, ['account no','account number','bank account'])),
      amount: money(get(obj, ['amount(myr)','amount (myr)','amount','amount rm'])),
      transactionNo: clean(get(obj, ['transaction no','transaction number'])),
      dateRaw: clean(get(obj, ['date','date / time','datetime'])),
      date: parseDate(get(obj, ['date','date / time','datetime'])),
      payVia: clean(get(obj, ['pay via','payment method'])),
      action: clean(get(obj, ['action','transaction type','type'])),
    }
  }).filter(r => r.name || r.action || r.amount)
}

export async function parseGenericTable(file: File): Promise<Record<string, unknown>[]> {
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
}

export function parseStaffRows(rows: Record<string, unknown>[]): StaffMember[] {
  return rows.map((r, i) => {
    const entries = Object.entries(r)
    const by = (...names: string[]) => entries.find(([k]) => names.includes(norm(k)))?.[1]
    const name = clean(by('staff name','name','employee name'))
    return {
      id: clean(by('staff id','employee id','id')) || `STAFF-${i+1}`,
      name,
      email: clean(by('email','email address')),
      identifier: clean(by('ic','ic/passport','nric','identifier')),
      active: !['inactive','resigned','no','false'].includes(norm(by('status','active'))),
    }
  }).filter(s => s.name)
}

export function parseNoteMaster(rows: Record<string, unknown>[]): NoteMasterRow[] {
  return rows.map(r => {
    const entries = Object.entries(r)
    const by = (...names: string[]) => entries.find(([k]) => names.includes(norm(k)))?.[1]
    return {
      noteId: clean(by('note id','noteid','id')),
      referenceId: clean(by('note reference id','note reference','reference id','note ref')),
      noteName: clean(by('note name','campaign name','issuer name','name')),
    }
  }).filter(n => n.noteId)
}

const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function yearFromSheet(name: string): number | null {
  const m = name.match(/'(\d{2})\s*$/)
  return m ? 2000 + Number(m[1]) : null
}
function monthMapFromRow(row: Record<string, unknown>, year: number): Record<string, number> {
  const out: Record<string, number> = {}
  monthNames.forEach((m, i) => {
    const v = money(row[m])
    if (v !== 0) out[`${year}-${String(i+1).padStart(2,'0')}`] = v
  })
  return out
}

export async function parseHistoricalWorkbook(file: File): Promise<HistoricalInvestor[]> {
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, { type:'array', cellDates:true })
  const map = new Map<string, HistoricalInvestor>()

  const ensure = (id: string, name: string) => {
    const key = id ? `id:${id}` : `name:${normalizeName(name)}`
    const byName = Array.from(map.values()).find(x => normalizeName(x.name) === normalizeName(name))
    if (byName) return byName
    if (!map.has(key)) map.set(key, { investorId:id, name, monthlyDeposits:{}, monthlyInvestments:{}, monthlyWithdrawals:{} })
    return map.get(key)!
  }

  for (const sheetName of wb.SheetNames) {
    const year = yearFromSheet(sheetName)
    if (!year) continue
    const kind = sheetName.toLowerCase().includes('monthly deposit') ? 'deposit'
      : sheetName.toLowerCase().includes('monthly investment') ? 'investment'
      : sheetName.toLowerCase().includes('monthly gross withdrawal') ? 'withdrawal' : ''
    if (!kind) continue
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval:'' })
    rows.forEach(r => {
      const id = clean(r['Investor ID'] ?? r['Inv ID'])
      const name = clean(r['Name'] ?? r['Name of Investors '] ?? r['Name '])
      if (!name) return
      const x = ensure(id, name)
      if (!x.investorId && id) x.investorId = id
      const risk = clean(r['New AML Risk 2025'] ?? r['2025 AML Risk'] ?? r['Risk Profile'])
      if (risk) x.riskProfile = risk
      const active = clean(r['Active/Inactive'])
      if (active) x.activeStatus = active
      const onboarded = clean(r['Date the investor was on-boarded'])
      if (onboarded) x.dateOnboarded = onboarded
      const mm = monthMapFromRow(r, year)
      if (kind === 'deposit') Object.assign(x.monthlyDeposits, mm)
      if (kind === 'investment') Object.assign(x.monthlyInvestments, mm)
      if (kind === 'withdrawal') Object.assign(x.monthlyWithdrawals, mm)
    })
  }

  const riskSheet = wb.SheetNames.find(n => n.toLowerCase().includes('risk profile'))
  if (riskSheet) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[riskSheet], {header:1, defval:''})
    const headerIx = matrix.findIndex(r => r.map(norm).includes('inv id') && r.map(norm).some(x=>x.includes('risk profile')))
    if (headerIx >= 0) {
      const headers = matrix[headerIx].map(clean)
      matrix.slice(headerIx+1).forEach(row => {
        const obj: Record<string,unknown>={}; headers.forEach((h,i)=>obj[h]=row[i])
        const id=clean(obj['Inv ID'] ?? obj['Investor ID']); const name=clean(obj['Name '] ?? obj['Name'])
        if (!name) return
        const x=ensure(id,name); x.riskProfile=clean(obj['Risk Profile']) || x.riskProfile
      })
    }
  }

  const balances = wb.SheetNames.find(n => n.toLowerCase().includes('account balances'))
  if (balances) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[balances], {header:1,defval:''})
    const headerIx = matrix.findIndex(r => r.map(norm).includes('investor id') && r.map(norm).some(x=>x.includes('balance account')))
    if (headerIx >= 0) {
      const headers=matrix[headerIx].map(clean)
      matrix.slice(headerIx+1).forEach(row => {
        const obj:Record<string,unknown>={};headers.forEach((h,i)=>obj[h]=row[i])
        const id=clean(obj['Investor ID']); const name=clean(obj['Investor'])
        if(!name)return
        const x=ensure(id,name); x.accountBalance=money(obj['Balance Account(RM)'])
      })
    }
  }

  return Array.from(map.values()).filter(x=>x.name)
}

export async function parsePriorMonitoringWorkbook(file: File): Promise<PriorComplianceContext[]> {
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, {type:'array', cellDates:true})
  const sheetName = wb.SheetNames.find(n=>n.toLowerCase().includes('flagged deposit')) || wb.SheetNames[0]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {header:1,defval:''})
  const headerIx = matrix.findIndex(r => r.map(norm).includes('compliance comments') && r.map(norm).includes('name'))
  if (headerIx < 0) return []
  const headers = matrix[headerIx].map(clean)
  const seen = new Map<string, PriorComplianceContext>()
  matrix.slice(headerIx+1).forEach(row=>{
    const obj:Record<string,unknown>={};headers.forEach((h,i)=>obj[h]=row[i])
    const name=clean(obj['Name']); const comments=clean(obj['Compliance Comments']); const investorId=clean(obj['Investor ID'])
    if(!name || !comments)return
    const key=investorId ? `id:${investorId}` : `name:${normalizeName(name)}`
    seen.set(key,{investorId,name,comments})
  })
  return Array.from(seen.values())
}

export function investorKey(t: Transaction) {
  if (t.accountNo) return `acct:${t.accountNo.replace(/\s|-/g,'')}`
  return `name:${normalizeName(t.name)}`
}
export function isDeposit(t: Transaction) { return norm(t.action) === 'deposit' }
// Rejected withdrawal requests ("Withdrawal  CONFIRM REJECT") never left the platform, so they are not withdrawals.
export function isWithdrawal(t: Transaction) { return norm(t.action).startsWith('withdrawal') && !norm(t.action).includes('reject') }

function buildHistoryLookup(history: HistoricalInvestor[]) {
  const byName = new Map(history.map(h=>[normalizeName(h.name),h]))
  return (name:string) => byName.get(normalizeName(name))
}
function buildContextLookup(context: PriorComplianceContext[]) {
  const byName = new Map(context.map(c=>[normalizeName(c.name),c]))
  return (name:string, investorId?:string) => context.find(c=>investorId && c.investorId===investorId) || byName.get(normalizeName(name))
}

export function runRules(transactions: Transaction[], rules: RuleConfig[], history: HistoricalInvestor[] = [], context: PriorComplianceContext[] = [], profileFor: (name: string) => CustomerProfile | undefined = () => undefined): Flag[] {
  const flags: Flag[] = []
  const deposits = transactions.filter(isDeposit)
  const groups = new Map<string, Transaction[]>()
  deposits.forEach(t => {
    const key = `${monthKey(t.date)}|${investorKey(t)}`
    groups.set(key, [...(groups.get(key) || []), t])
  })
  const byId = Object.fromEntries(rules.map(r => [r.id, r])) as Record<string, RuleConfig>
  const getHistory = buildHistoryLookup(history)
  const getContext = buildContextLookup(context)

  const enrich = (name:string) => {
    const h = getHistory(name)
    const positives = h ? Object.values(h.monthlyDeposits).filter(v=>v>0) : []
    const average = positives.length ? positives.reduce((a,b)=>a+b,0)/positives.length : undefined
    const max = positives.length ? Math.max(...positives) : undefined
    const p = profileFor(name)
    const c = getContext(name,h?.investorId || p?.investorId)
    return { h, average, max, c, p }
  }
  // The Customer Risk Profiling rating is the current one, so it wins over the historical workbook.
  const commonFor = (name: string) => {
    const {h,average,max,c,p}=enrich(name)
    return { investorId:h?.investorId || p?.investorId, riskProfile:p?.riskRating || h?.riskProfile, activeStatus:h?.activeStatus, historicalAverageDeposit:average, historicalMaxDeposit:max, priorComplianceContext:c?.comments,
      customerType:p?.customerType, kycStatus:p?.kycStatus, amlReviewDue:p?.nextReviewDate, sourceOfFunds:p?.sourceOfFunds, natureOfJob:p?.natureOfJob, netWorth:p?.netWorth, grossIncome:p?.grossIncome }
  }

  for (const [key, txs] of groups) {
    const [month] = key.split('|')
    const total = txs.reduce((s,t) => s+t.amount,0)
    const name = txs[0].name
    const inv = investorKey(txs[0])
    const common = commonFor(name)
    const average = common.historicalAverageDeposit

    const mandatory = byId['TM-001']
    if (mandatory && total > 30000) {
      flags.push({
        id: `${month}|${inv}|TM-001`, monthKey: month, investorKey: inv, investorName: name, ...common,
        ruleId:'TM-001', ruleName: mandatory.name, severity:'Routine', amount: total, transactionCount: txs.length,
        reason:`Aggregate deposits of RM${total.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})} exceed the mandatory RM30,000 monthly threshold.`,
        transactionRows: txs.map(t=>t.sourceRow)
      })
    }

    const single = byId['TM-002']
    if (single?.enabled) {
      const hits = txs.filter(t => t.amount > (single.threshold ?? 100000))
      if (hits.length) flags.push({
        id:`${month}|${inv}|TM-002`,monthKey:month,investorKey:inv,investorName:name,...common,ruleId:'TM-002',ruleName:single.name,severity:'Medium',
        amount:Math.max(...hits.map(t=>t.amount)),transactionCount:hits.length,
        reason:`${hits.length} deposit(s) exceeded RM${(single.threshold ?? 100000).toLocaleString('en-MY')} individually.`,transactionRows:hits.map(t=>t.sourceRow)
      })
    }

    const freq = byId['TM-003']
    if (freq?.enabled && txs.length >= (freq.threshold ?? 3)) flags.push({
      id:`${month}|${inv}|TM-003`,monthKey:month,investorKey:inv,investorName:name,...common,ruleId:'TM-003',ruleName:freq.name,severity:'Medium',amount:total,transactionCount:txs.length,
      reason:`${txs.length} deposits were made in the same month, meeting the configured frequency trigger of ${freq.threshold ?? 3}.`,transactionRows:txs.map(t=>t.sourceRow)
    })

    const highRisk = byId['TM-005']
    if (highRisk?.enabled && norm(common.riskProfile)==='high' && total > (highRisk.threshold ?? 10000)) flags.push({
      id:`${month}|${inv}|TM-005`,monthKey:month,investorKey:inv,investorName:name,...common,ruleId:'TM-005',ruleName:highRisk.name,severity:'High',amount:total,transactionCount:txs.length,
      reason:`Customer is recorded as High AML/CFT risk and monthly deposits exceed RM${(highRisk.threshold ?? 10000).toLocaleString('en-MY')}.`,transactionRows:txs.map(t=>t.sourceRow)
    })

    const spike = byId['TM-006']
    if (spike?.enabled && average && total > 30000 && total >= average * (spike.threshold ?? 3)) flags.push({
      id:`${month}|${inv}|TM-006`,monthKey:month,investorKey:inv,investorName:name,...common,ruleId:'TM-006',ruleName:spike.name,severity:'Medium',amount:total,transactionCount:txs.length,
      reason:`Current monthly deposits are ${(total/average).toFixed(1)}× the investor's average positive historical monthly deposits of RM${average.toLocaleString('en-MY',{maximumFractionDigits:2})}.`,transactionRows:txs.map(t=>t.sourceRow)
    })
  }

  const largeOut = byId['TM-007']
  if (largeOut?.enabled) {
    const out = new Map<string, Transaction[]>()
    for (const t of transactions.filter(isWithdrawal)) { const key = `${monthKey(t.date)}|${investorKey(t)}`; out.set(key, [...(out.get(key) || []), t]) }
    for (const [key, txs] of out) {
      const [month, ...rest] = key.split('|'), inv = rest.join('|'), total = txs.reduce((s, t) => s + t.amount, 0)
      if (total > (largeOut.threshold ?? 30000)) flags.push({
        id:`${month}|${inv}|TM-007`, monthKey:month, investorKey:inv, investorName:txs[0].name, ...commonFor(txs[0].name),
        ruleId:'TM-007', ruleName:largeOut.name, severity:'Medium', amount:total, transactionCount:txs.length,
        reason:`Aggregate withdrawals of RM${total.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})} exceed RM${(largeOut.threshold ?? 30000).toLocaleString('en-MY')} in the month.`,
        transactionRows:txs.map(t=>t.sourceRow)
      })
    }
  }

  const rapid = byId['TM-004']
  if (rapid?.enabled) {
    const withdrawals = transactions.filter(isWithdrawal).filter(t=>t.date)
    for (const d of deposits.filter(t=>t.date)) {
      const match = withdrawals.find(w => investorKey(w)===investorKey(d) && w.date && d.date && w.date >= d.date && (w.date.getTime()-d.date.getTime()) <= (rapid.threshold ?? 3)*86400000 && w.amount >= d.amount*0.8)
      if (match) {
        const m = monthKey(d.date); const inv = investorKey(d); const id = `${m}|${inv}|TM-004`
        if (!flags.some(f=>f.id===id)) flags.push({
          id, monthKey:m, investorKey:inv, investorName:d.name, ...commonFor(d.name),
          ruleId:'TM-004', ruleName:rapid.name, severity:'High', amount:match.amount, transactionCount:2,
          reason:`A withdrawal of RM${match.amount.toLocaleString('en-MY',{minimumFractionDigits:2})} occurred within ${rapid.threshold ?? 3} day(s) after a deposit of RM${d.amount.toLocaleString('en-MY',{minimumFractionDigits:2})}.`,
          transactionRows:[d.sourceRow,match.sourceRow]
        })
      }
    }
  }
  return flags.sort((a,b)=>b.amount-a.amount)
}

export function staffInvestments(transactions: Transaction[], staff: StaffMember[], noteMaster: NoteMasterRow[]) {
  const staffMap = new Map(staff.filter(s=>s.active).map(s=>[normalizeName(s.name),s]))
  const noteMap = new Map(noteMaster.map(n=>[String(n.noteId),n]))
  return transactions
    .filter(t => norm(t.action)==='investment committed' && staffMap.has(normalizeName(t.name)))
    .map(t => ({ transaction:t, staff:staffMap.get(normalizeName(t.name))!, note:noteMap.get(String(t.noteId)) }))
    .sort((a,b)=>(a.transaction.date?.getTime()||0)-(b.transaction.date?.getTime()||0))
}

// Sheet names must be unique and at most 31 characters, without :  / ? * [ ].
export function exportSheets(filename: string, sheets: { name: string, rows: Record<string, unknown>[] }[]) {
  const wb = XLSX.utils.book_new(), used = new Set<string>()
  for (const sheet of sheets) {
    const base = sheet.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 28).trim() || 'Sheet'
    let name = base.slice(0, 31), n = 2
    while (used.has(name.toLowerCase())) name = `${base} ${n++}`
    used.add(name.toLowerCase())
    XLSX.utils.book_append_sheet(wb, sheet.rows.length ? XLSX.utils.json_to_sheet(sheet.rows) : XLSX.utils.aoa_to_sheet([['Nil']]), name)
  }
  XLSX.writeFile(wb, filename)
}

export function exportRowsToXlsx(filename: string, sheetName: string, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, filename)
}

async function sheetMatrix(file: File) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
}

// Admin Panel exports put a "Cofundr Admin Panel" title row above the real headers.
function tableFrom(matrix: unknown[][], required: string[]) {
  const index = matrix.findIndex(row => required.every(h => row.map(norm).includes(h)))
  if (index < 0) return null
  const headers = matrix[index].map(norm)
  return matrix.slice(index + 1).map(row => (...names: string[]) => {
    const col = headers.findIndex(h => names.includes(h))
    return col >= 0 ? row[col] : ''
  })
}

// Admin Panel note lists pack ID, name and reference into one cell:
// "Note ID 2155   Note Reference ID  Parcel Sorting Express 14 IIF2155-13112026"
export function parseNoteCell(value: unknown) {
  const text = clean(value).replace(/\s+/g, ' ')
  // References look like IIF2155-13112026 or, for older Working Capital notes, WC2200068.
  const m = text.match(/^Note ID (\S+) Note Reference ID (.*?)\s*([A-Z]{2,5}\d{4,}(?:-\d{8})?)?$/)
  return m ? { noteId: m[1], noteName: m[2].trim(), referenceId: m[3] || '' } : null
}

export async function parseNoteWorkbook(file: File): Promise<NoteMasterRow[]> {
  const matrix = await sheetMatrix(file)
  const table = tableFrom(matrix, ['id', 'note details'])
  if (!table) return parseNoteMaster(await parseGenericTable(file))
  return table.map(get => {
    const cell = parseNoteCell(get('id'))
    if (!cell) return null
    const issuer = clean(get('issuer (issuer id)'))
    return {
      ...cell,
      noteName: cell.noteName || clean(get('note type')) || cell.referenceId,
      noteType: clean(get('note type')) || undefined,
      issuer: issuer || undefined,
      financingAmount: clean(get('financing amount(rm)')) ? money(get('financing amount(rm)')) : undefined,
      status: clean(get('status')) || undefined,
    }
  }).filter((n): n is NonNullable<typeof n> => !!n)
}

export async function parseInvestorDirectory(file: File): Promise<InvestorRecord[]> {
  const table = tableFrom(await sheetMatrix(file), ['investor id', 'investor'])
  if (!table) throw new Error('Could not find the investor header row. Expected Investor ID and Investor columns.')
  const out = new Map<string, InvestorRecord>()
  for (const get of table) {
    const investorId = clean(get('investor id')), name = clean(get('investor'))
    if (!investorId || !name) continue
    const date = parseDate(get('date registered'))
    out.set(investorId, {
      investorId, name,
      refId: clean(get('ref id')) || undefined,
      dateRegistered: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : clean(get('date registered')) || undefined,
      email: clean(get('email')) || undefined,
      balance: clean(get('balance account(rm)')) ? money(get('balance account(rm)')) : undefined,
      status: clean(get('status')) || undefined,
    })
  }
  return [...out.values()]
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const kycLabel = (v: unknown) => {
  const s = clean(v)
  if (!s || norm(s) === 'n/a') return undefined
  return s === '1' ? 'OK' : `Not OK (${s})`
}
const optional = (v: unknown) => { const s = clean(v); return s && norm(s) !== 'n/a' && !s.startsWith('#') ? s : undefined }

// Reads the Retail Investors and Corporate Investors sheets of the Customer Risk Profiling workbook.
export async function parseCustomerProfiles(file: File): Promise<CustomerProfile[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const out = new Map<string, CustomerProfile>()
  for (const sheet of wb.SheetNames) {
    const table = tableFrom(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, defval: '' }), ['investor id', 'investor name', 'aml risk rating'])
    if (!table) continue
    const corporate = sheet.toLowerCase().includes('corporate')
    for (const get of table) {
      const investorId = clean(get('investor id')), name = clean(get('investor name'))
      if (!investorId || !name) continue
      const rating = optional(get('aml risk rating'))
      const review = optional(get('next review date')) ? parseDate(get('next review date')) : null
      out.set(investorId, {
        investorId, name,
        customerType: corporate ? 'Corporate' : 'Retail',
        businessName: optional(get('business name')),
        nationality: optional(get('nationality')),
        sourceOfFunds: optional(get('personal source of funds', 'corporate source of funds')),
        natureOfJob: optional(get('personal nature of job', 'legal form')),
        netWorth: optional(get('personal total networth', 'corporate total networth')),
        grossIncome: optional(get('personal gross income')),
        kycStatus: kycLabel(get('kyc ok')),
        riskRating: rating ? rating[0].toUpperCase() + rating.slice(1).toLowerCase() : undefined,
        nextReviewDate: review ? isoDay(review) : undefined,
      })
    }
  }
  return [...out.values()]
}

// Matches a transaction name to a profile through the investor directory's ID first, then by name.
export function profileLookup(profiles: CustomerProfile[], findInvestor: (name: string) => InvestorRecord | undefined) {
  const byId = new Map(profiles.map(p => [p.investorId, p]))
  const byName = new Map<string, CustomerProfile>()
  for (const p of profiles) for (const n of [p.name, p.businessName]) { const key = normalizeName(n || ''); if (key && !byName.has(key)) byName.set(key, p) }
  return (name: string) => { const id = findInvestor(name)?.investorId; return (id && byId.get(id)) || byName.get(normalizeName(name)) }
}

export function investorLookup(investors: InvestorRecord[]) {
  const byName = new Map<string, InvestorRecord>()
  for (const investor of investors) { const key = normalizeName(investor.name); if (key && !byName.has(key)) byName.set(key, investor) }
  return (name: string) => byName.get(normalizeName(name))
}

export const nextMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

// Row numbers shift whenever the Admin Panel export grows, so they are ignored when
// deciding whether a month's transactions actually changed.
export function transactionFingerprint(rows: Transaction[]) {
  return rows.map(t => JSON.stringify([t.noteId, t.name, t.userType, t.bank, t.accountNo, t.amount, t.transactionNo, t.dateRaw, t.payVia, t.action])).sort().join('\n')
}

export type PreviousClearance = { month: string, ruleId: string, review: ReviewRecord }

// Most recent earlier-month clearance for the same investor, preferring the same rule.
export function previousClearance(flag: Flag, reviews: Record<string, ReviewRecord>): PreviousClearance | undefined {
  let best: PreviousClearance | undefined
  for (const review of Object.values(reviews)) {
    if (review.decision !== 'Cleared') continue
    const [month, key, ruleId] = review.flagId.split('|')
    if (!month || !ruleId || month >= flag.monthKey) continue
    const sameInvestor = key === flag.investorKey
      || (!!review.investorId && review.investorId === flag.investorId)
      || (!!review.investorName && normalizeName(review.investorName) === normalizeName(flag.investorName))
    if (!sameInvestor) continue
    const better = !best || month > best.month || (month === best.month && ruleId === flag.ruleId && best.ruleId !== flag.ruleId)
    if (better) best = { month, ruleId, review }
  }
  return best
}

export const sameReasonComment = (previous: PreviousClearance) =>
  `Cleared for the same reason as ${monthLabel(previous.month)} (${previous.ruleId}, reviewed by ${previous.review.reviewedBy}): ${previous.review.comments || 'no comment recorded'}`
