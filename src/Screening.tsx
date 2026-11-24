import { useState } from 'react'
import type { ScreeningDecision, ScreeningMatch } from './types'
import { exportSheets } from './monitoring'
import { parseMohaPdf, parseUnscXml, screenNames } from './sanctions'
import type { ScreenedName, ScreeningList } from './sanctions'

type Props = {
  names: ScreenedName[]
  matches: ScreeningMatch[]
  lastRun: string
  decisions: Record<string, ScreeningDecision>
  canEdit: boolean
  onRun: (matches: ScreeningMatch[], summary: string) => Promise<void>
  onDecide: (key: string, decision: ScreeningDecision['decision'], comments: string) => Promise<void>
}

export function Screening({ names, matches, lastRun, decisions, canEdit, onRun, onDecide }: Props) {
  const [lists, setLists] = useState<Partial<Record<'UNSC' | 'MOHA', ScreeningList>>>({})
  const [working, setWorking] = useState(''), [error, setError] = useState('')
  const [editing, setEditing] = useState<string[]>([])
  const [showDone, setShowDone] = useState(false)

  async function run(label: string, task: () => Promise<void>) {
    if (working) return
    setWorking(label); setError('')
    try { await task() } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.') } finally { setWorking('') }
  }
  const fetchUn = () => run('un', async () => {
    const response = await fetch('/api/screening/unsc', { credentials: 'same-origin' })
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The UN list could not be downloaded. Upload the XML file instead.')
    const list = parseUnscXml(await response.text()); setLists(l => ({ ...l, UNSC: list }))
  })
  const uploadUn = (file?: File) => file && run('un', async () => { const list = parseUnscXml(await file.text()); setLists(l => ({ ...l, UNSC: list })) })
  const uploadMoha = (file?: File) => file && run('moha', async () => { const list = await parseMohaPdf(file); setLists(l => ({ ...l, MOHA: list })) })
  const screen = () => run('screen', async () => {
    const loaded = Object.values(lists).filter((l): l is ScreeningList => !!l)
    const found = screenNames(names, loaded)
    await onRun(found, `Screened ${names.length} names against ${loaded.map(l => l.label).join(' and ')} on ${new Date().toISOString().slice(0, 10)}; ${found.length} possible match(es).`)
  })

  const pending = matches.filter(m => !decisions[m.key])
  const shown = showDone ? matches : pending
  const exportRows = () => exportSheets(`Sanctions Screening - ${new Date().toISOString().slice(0, 10)}.xlsx`, [
    { name: 'Summary', rows: [{ 'Last run': lastRun || 'Not run', 'Possible matches': matches.length, 'Pending': pending.length, 'True matches': matches.filter(m => decisions[m.key]?.decision === 'True match').length }] },
    { name: 'Possible Matches', rows: matches.map(m => ({ 'List': m.list, 'Investor ID': m.investorId, 'Investor': m.investorName, 'List entry': m.entryName, 'Reference': m.entryRef, 'Details': m.entryDetail, 'Score': m.score, 'Decision': decisions[m.key]?.decision || 'Pending', 'Comments': decisions[m.key]?.comments || '', 'Reviewed By': decisions[m.key]?.reviewedBy || '', 'Reviewed At': decisions[m.key]?.reviewedAt || '' })) },
  ])

  return <section className="stack">
    <div className="card full">
      <h2>Sanctions screening</h2>
      <p className="muted">Compares every investor in the Investor Directory and Customer Risk Profiling workbook ({names.length} names) against the UN Security Council Consolidated List and the MOHA domestic list. Lists are compared in your browser; investor names are never sent anywhere. Every possible match must be reviewed and marked as a false positive or a true match.</p>
      {error && <div className="notice" role="alert">{error}</div>}
      <div className="report-grid">
        <div className="report-block">
          <h3>UNSC Consolidated List</h3>
          <p className="muted">{lists.UNSC?.label || 'Not loaded. Download the latest list from the UN, or upload the XML from scsanctions.un.org.'}</p>
          <div className="inline-actions"><button disabled={!!working} onClick={() => void fetchUn()}>{working === 'un' ? 'Loading…' : 'Download latest UNSC list'}</button>
            <label className="file-button secondary">Upload XML<input type="file" accept=".xml" aria-label="Upload UNSC list XML" onChange={e => { void uploadUn(e.target.files?.[0]); e.target.value = '' }} /></label></div>
        </div>
        <div className="report-block">
          <h3>MOHA domestic list</h3>
          <p className="muted">{lists.MOHA?.label || 'Not loaded. Download the latest list PDF from the MOHA website (Countering Financing of Terrorism → List of Ministry of Home Affairs) and upload it here.'}</p>
          <label className="file-button">{working === 'moha' ? 'Reading PDF…' : 'Upload MOHA list (PDF)'}<input type="file" accept=".pdf" aria-label="Upload MOHA list PDF" onChange={e => { void uploadMoha(e.target.files?.[0]); e.target.value = '' }} /></label>
        </div>
      </div>
      <div className="inline-actions"><button disabled={!!working || !canEdit || !names.length || !Object.keys(lists).length} onClick={() => void screen()}>{working === 'screen' ? 'Screening…' : 'Run screening'}</button>{!names.length && <span className="muted">Upload the Investor Directory first.</span>}</div>
      {lastRun && <p className="muted">Last run: {lastRun}</p>}
    </div>

    <div className="card full">
      <div className="card-head"><h2>Possible matches ({pending.length} pending)</h2><div className="inline-actions"><label className="switch-row"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Show reviewed</label><button className="secondary" disabled={!matches.length} onClick={exportRows}>Export Excel</button></div></div>
      {!shown.length ? <div className="empty-small">{matches.length ? 'All possible matches have been reviewed.' : lastRun ? 'No possible matches were found.' : 'Run a screening to see results.'}</div> :
        shown.map(m => {
          const d = decisions[m.key]
          if (d && !editing.includes(m.key)) return <div className="collapsed-item" key={m.key}>
            <span className={`badge ${d.decision === 'True match' ? 'risk-high' : 'risk-low'}`}>Complete · {d.decision}</span>
            <strong>{m.investorName}</strong><span className="muted">{m.list} {m.entryRef} · {d.reviewedBy}, {d.reviewedAt.slice(0, 10)}</span>
            {canEdit && <button className="secondary" aria-label={`Edit screening decision for ${m.investorName}`} onClick={() => setEditing(e => [...e, m.key])}>Edit</button>}
          </div>
          return <MatchCard key={m.key} match={m} decision={d} canEdit={canEdit} onSave={async (decision, comments) => { await onDecide(m.key, decision, comments); setEditing(e => e.filter(k => k !== m.key)) }} onCancel={d ? () => setEditing(e => e.filter(k => k !== m.key)) : undefined} />
        })}
    </div>
  </section>
}

function MatchCard({ match, decision, canEdit, onSave, onCancel }: { match: ScreeningMatch, decision?: ScreeningDecision, canEdit: boolean, onSave: (d: ScreeningDecision['decision'], c: string) => Promise<void>, onCancel?: () => void }) {
  const [choice, setChoice] = useState<ScreeningDecision['decision']>(decision?.decision || 'False positive'), [comments, setComments] = useState(decision?.comments || '')
  return <article className="review-card">
    <div className="review-main">
      <div className="rule-line"><span className="severity high">{match.list}</span><strong>Match score {Math.round(match.score * 100)}%</strong></div>
      <h3>{match.investorName}</h3>
      <div className="context-grid"><div><span>Investor ID</span><strong>{match.investorId || '—'}</strong></div><div><span>List entry</span><strong>{match.entryName}</strong></div><div><span>Reference</span><strong>{match.entryRef}</strong></div></div>
      <p>{match.entryDetail}</p>
    </div>
    <div className="review-form">
      <label>Decision<select value={choice} disabled={!canEdit} onChange={e => setChoice(e.target.value as ScreeningDecision['decision'])}><option>False positive</option><option>True match</option></select></label>
      <label>Comments<textarea rows={3} value={comments} disabled={!canEdit} onChange={e => setComments(e.target.value)} placeholder="e.g. different date of birth and nationality" /></label>
      {canEdit && <div className="inline-actions"><button disabled={!comments.trim()} onClick={() => void onSave(choice, comments)}>Save decision</button>{onCancel && <button className="secondary" onClick={onCancel}>Cancel</button>}</div>}
    </div>
  </article>
}
