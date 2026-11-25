import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// On phones each table row is shown as a small card, so every cell needs its column name.
// Labels are copied from the table header whenever the page changes.
function labelTableCells() {
  for (const table of document.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent?.trim() || '')
    for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
      let column = 0
      for (const cell of row.children) {
        const span = (cell as HTMLTableCellElement).colSpan || 1
        const label = span > 1 || row.parentElement?.tagName === 'TFOOT' ? '' : heads[column] || ''
        if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label)
        column += span
      }
    }
  }
}
let pending = 0
new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; labelTableCells() }) })
  .observe(document.body, { childList: true, subtree: true, characterData: true })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
