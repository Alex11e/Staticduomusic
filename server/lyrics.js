export const maxLyricsBytes = 512 * 1024

const timestampPattern = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g

export function parseLrc(source) {
  if (typeof source !== 'string' || source.length > maxLyricsBytes) return []
  const offsetMatch = source.match(/^\[offset:([+-]?\d+)\]/im)
  const offsetSeconds = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0
  const entries = []

  for (const line of source.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(timestampPattern)]
    if (!timestamps.length) continue
    const text = line.replace(timestampPattern, '').trim().slice(0, 500)
    if (!text) continue

    for (const match of timestamps) {
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0
      const time = Math.max(0, Number(match[1]) * 60 + Number(match[2]) + fraction + offsetSeconds)
      if (time <= 24 * 60 * 60) entries.push({ time, text })
    }
  }

  return entries.sort((left, right) => left.time - right.time)
}