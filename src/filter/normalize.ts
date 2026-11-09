import type { NormalizeResult } from '../types.js'

// Zero-width characters, bidi controls, word joiners and invisible separators,
// the byte-order mark, the soft hyphen, the tag block and the variation
// selectors supplement.
const INVISIBLE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu

function countCodepoints(text: string): number {
  return Array.from(text).length
}

/**
 * NFKC-folds, strips invisible code points and collapses long runs of spaces
 * and tabs. `suspicious` is true when anything was stripped. Non-string input
 * is empty and suspicious.
 */
export function normalizeText(raw: unknown): NormalizeResult {
  if (typeof raw !== 'string') return { clean: '', strippedCount: 0, suspicious: true }
  if (raw.length === 0) return { clean: '', strippedCount: 0, suspicious: false }

  const folded = raw.normalize('NFKC')
  const stripped = folded.replace(INVISIBLE, '')
  const strippedCount = countCodepoints(folded) - countCodepoints(stripped)
  const clean = stripped.replace(/[ \t]{3,}/g, '  ').trim()
  return { clean, strippedCount, suspicious: strippedCount > 0 }
}
