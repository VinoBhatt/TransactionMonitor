import type { ScreeningMatch } from './types'

// One name to compare against: a list entry's name or one of its aliases.
export type ListEntry = {
  list: 'UNSC' | 'MOHA'
  ref: string
  name: string
  aliases: string[]
  detail: string
}

export type ScreeningList = {
  list: 'UNSC' | 'MOHA'
  label: string
  entries: ListEntry[]
  // MOHA entries are whole lines of PDF text, so an investor's name only needs to appear inside one.
  lineMatch: boolean
}

export type ScreenedName = { investorId: string, name: string }

// Words that carry no identity: Malay patronymic connectors, honorifics and company suffixes.
const filler = new Set(['bin', 'binti', 'bte', 'bt', 'binte', 'ibni', 'al', 'el', 'a', 'l', 'p', 'b', 'mr', 'mrs', 'ms', 'dr', 'haji', 'hj', 'hajjah', 'hjh', 'dato', 'datuk', 'datin', 'tan', 'sri', 'sdn', 'bhd', 'berhad', 'plc', 'ltd', 'limited', 'llp', 'inc', 'co', 'enterprise', 'the', 'and', 'of'])
const variants: Record<string, string> = {
  mohd: 'muhammad', mohamad: 'muhammad', mohammad: 'muhammad', mohammed: 'muhammad', mohamed: 'muhammad', muhamad: 'muhammad', muhammed: 'muhammad', mohamud: 'muhammad', muhd: 'muhammad', md: 'muhammad',
  abd: 'abdul', abdel: 'abdul', abdal: 'abdul', abdull: 'abdul', abdoul: 'abdul',
  nur: 'noor', nor: 'noor', nurul: 'noorul',
}

export function nameTokens(value: string) {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  return [...new Set(text.split(' ').filter(Boolean).map(t => variants[t] || t).filter(t => !filler.has(t)))]
}

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 2
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}
// Allows one-letter spelling differences in longer words (e.g. HUSSAIN / HUSAIN).
const sameToken = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1)

type Weight = (token: string) => number

// Each investor word may match at most one entry word; common words (Muhammad, Abdul, Rahman…)
// count for less, so two shared common names alone are not a match.
function score(investor: string[], entry: string[], lineMatch: boolean, weight: Weight) {
  const used = new Set<number>()
  let matched = 0, matchedCount = 0
  for (const t of investor) {
    const j = entry.findIndex((e, i) => !used.has(i) && sameToken(t, e))
    if (j < 0) continue
    used.add(j); matched += Math.min(weight(t), weight(entry[j])); matchedCount++
  }
  if (!matchedCount) return 0
  // A one-word name only counts when the entry is exactly that word.
  if (investor.length === 1 || entry.length === 1) return !lineMatch && investor.length === entry.length ? 1 : 0
  if (matchedCount < 2) return 0
  const total = (tokens: string[]) => tokens.reduce((n, t) => n + weight(t), 0)
  return lineMatch ? matched / total(investor) : (2 * matched) / (total(investor) + total(entry))
}

export const MATCH_THRESHOLD = 0.8

export function screenNames(names: ScreenedName[], lists: ScreeningList[]): ScreeningMatch[] {
  const matches = new Map<string, ScreeningMatch>()
  for (const list of lists) {
    const prepared = list.entries.flatMap(entry => [entry.name, ...entry.aliases].map(alias => ({ entry, alias, tokens: nameTokens(alias) }))).filter(x => x.tokens.length)
    const index = new Map<string, typeof prepared>()
    // How many distinct names use each word, across the list and the investors being screened.
    const frequency = new Map<string, number>()
    for (const tokens of [...prepared.map(p => p.tokens), ...names.map(n => nameTokens(n.name))]) for (const t of tokens) frequency.set(t, (frequency.get(t) || 0) + 1)
    const weight: Weight = t => { const n = frequency.get(t) || 0; return n >= 20 ? 0.4 : n >= 8 ? 0.7 : 1 }
    for (const p of prepared) for (const t of p.tokens) index.set(t, [...(index.get(t) || []), p])
    for (const person of names) {
      const tokens = nameTokens(person.name)
      if (!tokens.length) continue
      const candidates = new Set(tokens.flatMap(t => index.get(t) || []))
      for (const c of candidates) {
        const s = score(tokens, c.tokens, list.lineMatch, weight)
        if (s < MATCH_THRESHOLD) continue
        const key = `${person.investorId || person.name}|${list.list}|${c.entry.ref}`
        const existing = matches.get(key)
        if (existing && existing.score >= s) continue
        matches.set(key, {
          key, list: list.list, investorId: person.investorId, investorName: person.name,
          entryName: c.alias === c.entry.name ? c.entry.name : `${c.alias} (alias of ${c.entry.name})`,
          entryRef: c.entry.ref, entryDetail: c.entry.detail.slice(0, 1000), score: Math.round(s * 100) / 100,
        })
      }
    }
  }
  return [...matches.values()].sort((a, b) => b.score - a.score || a.investorName.localeCompare(b.investorName))
}

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').trim()
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : '' }
const blocks = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1])

// Parses the UN Security Council Consolidated List XML (scsanctions.un.org).
export function parseUnscXml(xml: string): ScreeningList {
  if (!xml.includes('<CONSOLIDATED_LIST')) throw new Error('This is not the UN Security Council Consolidated List XML.')
  const generated = xml.match(/dateGenerated="([^"]+)"/)?.[1]?.slice(0, 10) || 'unknown date'
  const entries: ListEntry[] = []
  for (const kind of ['INDIVIDUAL', 'ENTITY'] as const) {
    for (const block of blocks(xml, kind)) {
      const name = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map(t => tag(block, t)).filter(Boolean).join(' ')
      if (!name) continue
      const aliases = blocks(block, `${kind}_ALIAS`).filter(a => tag(a, 'QUALITY').toLowerCase() !== 'low').map(a => tag(a, 'ALIAS_NAME')).filter(Boolean)
      const born = blocks(block, 'INDIVIDUAL_DATE_OF_BIRTH').map(b => tag(b, 'DATE') || tag(b, 'YEAR')).filter(Boolean)
      const nationality = blocks(block, 'NATIONALITY').map(b => tag(b, 'VALUE')).filter(Boolean)
      const detail = [kind === 'ENTITY' ? 'Entity' : 'Individual', tag(block, 'UN_LIST_TYPE') && `List: ${tag(block, 'UN_LIST_TYPE')}`, born.length && `Born: ${born.join(', ')}`, nationality.length && `Nationality: ${nationality.join(', ')}`, tag(block, 'LISTED_ON') && `Listed: ${tag(block, 'LISTED_ON')}`].filter(Boolean).join(' · ')
      entries.push({ list: 'UNSC', ref: tag(block, 'REFERENCE_NUMBER') || tag(block, 'DATAID'), name, aliases, detail })
    }
  }
  if (!entries.length) throw new Error('No entries were found in the UN list.')
  return { list: 'UNSC', label: `UNSC Consolidated List generated ${generated} (${entries.length} entries)`, entries, lineMatch: false }
}

// Reads the MOHA domestic list PDF line by line. The layout is not fixed, so every line of text is
// treated as a possible entry and matches show the line for the reviewer to check.
export async function parseMohaPdf(file: File): Promise<ScreeningList> {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  const entries: ListEntry[] = []
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent()
    const lines = new Map<number, { x: number, text: string }[]>()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5] / 3)
      lines.set(y, [...(lines.get(y) || []), { x: item.transform[4], text: item.str }])
    }
    ;[...lines.entries()].sort((a, b) => b[0] - a[0]).forEach(([, parts], i) => {
      const text = parts.sort((a, b) => a.x - b.x).map(p => p.text).join(' ').replace(/\s+/g, ' ').trim()
      if (text.length >= 4) entries.push({ list: 'MOHA', ref: `Page ${page}, line ${i + 1}`, name: text, aliases: [], detail: text })
    })
  }
  await task.destroy()
  if (!entries.length) throw new Error('No readable text was found in this PDF. It may be a scanned image; ask MOHA or your compliance adviser for a text version.')
  return { list: 'MOHA', label: `MOHA list ${file.name} (${doc.numPages} page(s), ${entries.length} lines)`, entries, lineMatch: true }
}
