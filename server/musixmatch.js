import { parseLrc } from './lyrics.js'

const apiUrl = 'https://api.musixmatch.com/ws/1.1/'

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function related(left, right) {
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)))
}

function matchScore(track, title, artist) {
  if (Number(track.restricted) === 1 || Number(track.has_subtitles) !== 1 || !track.commontrack_id) return -1
  const candidateTitle = normalize(track.track_name)
  const candidateArtist = normalize(track.artist_name)
  if (!related(title, candidateTitle) || !related(artist, candidateArtist)) return -1
  return (title === candidateTitle ? 4 : 2) + (artist === candidateArtist ? 3 : 1)
}

async function requestMusixmatch(endpoint, parameters, apiKey, fetchImpl) {
  const url = new URL(endpoint, apiUrl)
  url.search = new URLSearchParams({ ...parameters, format: 'json', apikey: apiKey }).toString()
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw Object.assign(new Error('A Musixmatch szolgáltatás nem érhető el.'), { status: 502 })
  const result = await response.json()
  const header = result.message?.header
  if (Number(header?.status_code) !== 200) {
    const status = Number(header?.status_code) === 401 ? 503 : 404
    throw Object.assign(new Error(status === 503 ? 'A Musixmatch API-kulcs vagy előfizetés nem megfelelő.' : 'Ehhez a zenéhez nincs elérhető szinkronizált dalszöveg.'), { status })
  }
  return result.message?.body || {}
}

function safeTrackingUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'tracking.musixmatch.com' ? url.toString() : ''
  } catch {
    return ''
  }
}

export async function fetchSyncedLyrics({ title, artist }, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw Object.assign(new Error('Az automatikus dalszöveghez MUSIXMATCH_API_KEY szükséges.'), { status: 503 })
  const normalizedTitle = normalize(title)
  const normalizedArtist = normalize(artist)
  if (!normalizedTitle || !normalizedArtist) throw Object.assign(new Error('A zeneszám metaadatai nem elegendők a dalszöveg kereséséhez.'), { status: 404 })

  const searchBody = await requestMusixmatch('track.search', {
    q_track: title,
    q_artist: artist,
    f_has_subtitle: '1',
    page_size: '10',
  }, apiKey, fetchImpl)
  const matches = (searchBody.track_list || []).map((entry) => entry.track).filter(Boolean)
    .map((track) => ({ track, score: matchScore(track, normalizedTitle, normalizedArtist) }))
    .filter((match) => match.score >= 0)
    .sort((left, right) => right.score - left.score)
  const track = matches[0]?.track
  if (!track) throw Object.assign(new Error('Ehhez a zenéhez nem található engedélyezett, szinkronizált dalszöveg.'), { status: 404 })

  const subtitleBody = await requestMusixmatch('track.subtitle.get', {
    commontrack_id: String(track.commontrack_id),
    subtitle_format: 'lrc',
  }, apiKey, fetchImpl)
  const subtitle = subtitleBody.subtitle
  const lines = parseLrc(subtitle?.subtitle_body)
  if (!lines.length) throw Object.assign(new Error('Ehhez a zenéhez nincs használható szinkronizált dalszöveg.'), { status: 404 })
  return {
    lines,
    attribution: subtitle.lyrics_copyright || 'Lyrics powered by Musixmatch',
    trackingUrl: safeTrackingUrl(subtitle.pixel_tracking_url),
  }
}