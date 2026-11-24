import { useMemo, useState } from 'react'
import type { AmlReviewRecord, CustomerProfile } from './types'
import { exportSheets } from './monitoring'

type Props = {
  profiles: CustomerProfile[]
  completions: Record<string, AmlReviewRecord>
  onComplete: (record: Omit<AmlReviewRecord, 'completedBy' | 'completedAt'>) => Promise<void>
  canEdit: boolean
}

type Filter = 'overdue' | 'due30' | 'all'
const today = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
// Review cycle by rating, matching the dates already in the Customer Risk Profiling workbook.
const cycleYears = (rating?: string) => rating === 'Low' ? 3 : rating === 'Medium' ? 2 : 1
const nextFrom = (rating?: string) => { const d = new Date(); d.setFullYear(d.getFullYear() + cycleYears(rating)); return d.toISOString().slice(0, 10) }

export function AmlReviews({ profiles, completions, onComplete, canEdit }: Props) {
  const [filter, setFilter] = useState<Filter>('overdue'), [search, setSearch] = useState('')
  const [editing, setEditing] = useState(''), [nextDate, setNextDate] = useState(''), [comments, setComments] = useState('')
  const now = today(), soon = addDays(now, 30)

  const rows = useMemo(() => profiles.map(p => {
    const done = completions[p.investorId]
    // A later date in a re-uploaded profiling workbook wins over an earlier in-app completion.
    const due = [p.nextReviewDate, done?.nextReviewDate].filter((d): d is string => !!d).sort().pop()
    const status = !due ? 'No date' : due < now ? 'Overdue' : due <= soon ? 'Due in 30 days' : 'Up to date'
    return { p, done, due, status }
  }).sort((a, b) => (a.due || '0000').localeCompare(b.due || '0000') || a.p.name.localeCompare(b.p.name)), [profiles, completions, now, soon])

  const counts = { overdue: rows.filter(r => r.status === 'Overdue').length, due30: rows.filter(r => r.status === 'Due in 30 days').length, none: rows.filter(r => r.status === 'No date').length }
  const q = search.trim().toLowerCase()
  const shown = rows.filter(r => filter === 'all' || (filter === 'overdue' ? r.status === 'Overdue' || r.status === 'No date' : r.status === 'Due in 30 days'))
    .filter(r => !q || r.p.name.toLowerCase().includes(q) || r.p.investorId.includes(q) || (r.p.businessName || '').toLowerCase().includes(q))

  function open(r: typeof rows[number]) { setEditing(r.p.investorId); setNextDate(nextFrom(r.p.riskRating)); setComments(r.done?.comments || '') }
  async function save(r: typeof rows[number]) {
    await onComplete({ investorId: r.p.investorId, name: r.p.name, nextReviewDate: nextDate, comments })
    setEditing('')
  }
  const exportRows = () => exportSheets(`AML Periodic Reviews - ${now}.xlsx`, [{ name: 'AML Reviews', rows: rows.map(r => ({
    'Investor ID': r.p.investorId, 'Name': r.p.name, 'Business Name': r.p.businessName || '', 'Type': r.p.customerType, 'AML Risk': r.p.riskRating || 'No rating', 'KYC': r.p.kycStatus || '',
    'Next Review Due': r.due || '', 'Status': r.status, 'Last Reviewed By': r.done?.completedBy || '', 'Last Reviewed At': r.done?.completedAt || '', 'Comments': r.done?.comments || '',
  })) }])

  if (!profiles.length) return <section className="card full"><h2>AML periodic reviews</h2><p className="muted">Upload the Customer Risk Profiling workbook under Monthly Upload (card 7) to track each investor's next AML review date.</p></section>
  return <section className="card full">
    <div className="card-head"><div><h2>AML periodic reviews</h2><p className="muted">Next review dates from the Customer Risk Profiling workbook. Marking a review complete sets the next date (High 1 year, Medium 2 years, Low 3 years by default) and records who did it.</p></div><button className="secondary" onClick={exportRows}>Export Excel</button></div>
    <div className="toolbar">
      <label>Show<select value={filter} onChange={e => setFilter(e.target.value as Filter)}><option value="overdue">Overdue or no date ({counts.overdue + counts.none})</option><option value="due30">Due in the next 30 days ({counts.due30})</option><option value="all">All investors ({rows.length})</option></select></label>
      <label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or Investor ID" /></label>
    </div>
    <div className="table-wrap"><table><thead><tr><th>Investor</th><th>Type</th><th>AML Risk</th><th>KYC</th><th>Next review</th><th>Last reviewed</th><th></th></tr></thead><tbody>
      {shown.slice(0, 300).map(r => <tr key={r.p.investorId}>
        <td>{r.p.name}<small className="subline">ID {r.p.investorId}{r.p.businessName ? ` · ${r.p.businessName}` : ''}</small></td>
        <td>{r.p.customerType}</td><td><span className={`badge risk-${(r.p.riskRating || 'unknown').toLowerCase()}`}>{r.p.riskRating || 'No rating'}</span></td><td>{r.p.kycStatus || '—'}</td>
        <td>{r.due || '—'}<small className={`subline ${r.status === 'Overdue' ? 'warning-text' : ''}`}>{r.status}</small></td>
        <td>{r.done ? <>{r.done.completedBy}<small className="subline">{r.done.completedAt.slice(0, 10)}{r.done.comments ? ` · ${r.done.comments}` : ''}</small></> : '—'}</td>
        <td className="num">{editing === r.p.investorId
          ? <div className="inline-form"><label>Next review<input type="date" value={nextDate} onChange={e => setNextDate(e.target.value)} /></label><label>Comments<input value={comments} onChange={e => setComments(e.target.value)} placeholder="What was reviewed" /></label><div className="inline-actions"><button disabled={!nextDate} onClick={() => void save(r)}>Save</button><button className="secondary" onClick={() => setEditing('')}>Cancel</button></div></div>
          : canEdit && <button className="secondary" aria-label={`Mark AML review complete for ${r.p.name}`} onClick={() => open(r)}>{r.done ? 'Edit' : 'Mark reviewed'}</button>}</td>
      </tr>)}
    </tbody></table></div>
    {shown.length > 300 && <p className="muted">Showing the first 300 of {shown.length}. Use search or export to Excel for the full list.</p>}
    {!shown.length && <div className="empty-small">Nothing to show for this filter.</div>}
  </section>
}
