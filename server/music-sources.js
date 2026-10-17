const archiveApi = 'https://archive.org'
const jamendoApi = 'https://api.jamendo.com/v3.0/tracks/'

function textValue(value) {
  if (Array.isArray(value)) return textValue(value[0])
  return typeof value === 'string' ? value.trim() : ''
}

function isAllowedLicense(value) {
  try {
    const license = new URL(value)
    if (!['http:', 'https:'].includes(license.protocol) || license.hostname !== 'creativecommons.org') return false
    return /\/publicdomain\/(zero|mark)\//.test(license.pathname)
      || /\/licenses\/by(?:-nc)?(?:-sa)?\//.test(license.pathname)
  } catch {
    return false
  }
}

function isMp3DownloadUrl(value) {
  try {
    const url = new URL(value)
    return /\.mp3$/i.test(url.pathname)
      || (url.hostname.toLowerCase().endsWith('.jamendo.com') && /^\/download\/track\/\d+\/mp3[12]\/?$/i.test(url.pathname))
  } catch {
    return false
  }
}

function isAllowedDownloadUrl(value) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const trustedHost = hostname === 'archive.org' || hostname.endsWith('.archive.org')
      || hostname === 'jamendo.com' || hostname.endsWith('.jamendo.com')
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && trustedHost
  } catch {
    return false
  }
}

function requireIdentifier(value) {
  const identifier = String(value || '')
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(identifier)) throw new Error('Érvénytelen zeneszám-azonosító.')
  return identifier
}

function requireMp3File(value) {
  const fileName = String(value || '')
  if (!/^[^/\\]{1,255}\.mp3$/i.test(fileName)) throw new Error('Csak MP3-fájl importálható.')
  return fileName
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('A zeneforrás átmenetileg nem érhető el.')
  return response.json()
}

async function archiveMetadata(fetchImpl, identifier) {
  const safeIdentifier = requireIdentifier(identifier)
  return readJson(fetchImpl, `${archiveApi}/metadata/${encodeURIComponent(safeIdentifier)}`)
}

function archiveMp3Files(item) {
  const licenseUrl = textValue(item.metadata?.licenseurl)
  if (!isAllowedLicense(licenseUrl)) return []
  return (item.files || []).filter((file) => {
    const name = typeof file.name === 'string' ? file.name : ''
    return /^([^/\\]+)\.mp3$/i.test(name) && file.source !== 'metadata'
  }).map((file) => ({ fileName: file.name, licenseUrl }))
}

async function getJamendoTrack(fetchImpl, clientId, id) {
  if (!clientId) throw new Error('A Jamendo kereséshez állítsd be a JAMENDO_CLIENT_ID értékét.')
  const url = new URL(jamendoApi)
  url.search = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    id: String(id),
    include: 'licenses',
    audiodlformat: 'mp32',
  }).toString()
  const result = await readJson(fetchImpl, url)
  if (result.headers?.status !== 'success') throw new Error('A Jamendo keresés nem sikerült.')
  return result.results?.[0]
}

export { isAllowedDownloadUrl, isAllowedLicense, requireIdentifier, requireMp3File }

export async function searchInternetArchive(query, fetchImpl = fetch) {
  const search = String(query || '').trim().slice(0, 120)
  if (!search) throw new Error('Írj be egy címet vagy előadót.')
  const url = new URL('/advancedsearch.php', archiveApi)
  url.search = new URLSearchParams({
    q: `mediatype:audio AND title:"${search.replace(/["\\]/g, '\\$&')}"`,
    'fl[]': 'identifier,title,creator',
    rows: '10',
    page: '1',
    output: 'json',
  }).toString()
  const result = await readJson(fetchImpl, url)
  const docs = result.response?.docs || []
  const items = await Promise.all(docs.slice(0, 10).map(async (doc) => {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(doc.identifier || '')) return null
    const item = await archiveMetadata(fetchImpl, doc.identifier)
    const files = archiveMp3Files(item)
    if (!files.length) return null
    return {
      source: 'archive',
      id: doc.identifier,
      fileName: files[0].fileName,
      title: textValue(item.metadata?.title) || textValue(doc.title) || doc.identifier,
      artist: textValue(item.metadata?.creator) || textValue(doc.creator) || 'Ismeretlen előadó',
      licenseUrl: files[0].licenseUrl,
    }
  }))
  return items.filter(Boolean)
}

export async function searchJamendo(query, clientId, fetchImpl = fetch) {
  if (!clientId) throw new Error('A Jamendo kereséshez állítsd be a JAMENDO_CLIENT_ID értékét.')
  const search = String(query || '').trim().slice(0, 120)
  if (!search) throw new Error('Írj be egy címet vagy előadót.')
  const url = new URL(jamendoApi)
  url.search = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    search,
    limit: '20',
    include: 'licenses',
    audiodlformat: 'mp32',
  }).toString()
  const result = await readJson(fetchImpl, url)
  if (result.headers?.status !== 'success') throw new Error('A Jamendo keresés nem sikerült.')
  return (result.results || []).filter((track) => track.audiodownload_allowed === true
    && isAllowedLicense(track.license_ccurl)
    && isAllowedDownloadUrl(track.audiodownload)
    && isMp3DownloadUrl(track.audiodownload)).map((track) => ({
    source: 'jamendo',
    id: String(track.id),
    title: textValue(track.name) || 'Ismeretlen cím',
    artist: textValue(track.artist_name) || 'Ismeretlen előadó',
    album: textValue(track.album_name),
    licenseUrl: track.license_ccurl,
  }))
}

export async function resolveMusicDownload({ source, id, fileName, url, title, artist }, clientId, fetchImpl = fetch) {
  if (source === 'direct') {
    if (!isAllowedDownloadUrl(url) || !isMp3DownloadUrl(url)) {
      throw new Error('Csak HTTPS-es, támogatott MP3-forrásból importálhatsz.')
    }
    return {
      url,
      title: textValue(title) || 'Internetről importált zene',
      artist: textValue(artist) || 'Ismeretlen előadó',
      licenseUrl: '',
    }
  }
  if (source === 'archive') {
    const item = await archiveMetadata(fetchImpl, id)
    const safeFileName = requireMp3File(fileName)
    const file = archiveMp3Files(item).find((entry) => entry.fileName === safeFileName)
    if (!file) throw new Error('A fájl nem letölthető vagy nincs megfelelő licence.')
    const encodedFileName = safeFileName.split('/').map(encodeURIComponent).join('/')
    return {
      url: `${archiveApi}/download/${encodeURIComponent(requireIdentifier(id))}/${encodedFileName}`,
      title: textValue(item.metadata?.title) || id,
      artist: textValue(item.metadata?.creator) || 'Ismeretlen előadó',
      licenseUrl: file.licenseUrl,
    }
  }
  if (source === 'jamendo') {
    const track = await getJamendoTrack(fetchImpl, clientId, id)
    if (!track || track.audiodownload_allowed !== true || !isAllowedLicense(track.license_ccurl)
      || !isAllowedDownloadUrl(track.audiodownload) || !isMp3DownloadUrl(track.audiodownload)) {
      throw new Error('A Jamendo nem engedélyezi ennek a zeneszámnak az MP3-letöltését.')
    }
    return {
      url: track.audiodownload,
      title: textValue(track.name) || 'Ismeretlen cím',
      artist: textValue(track.artist_name) || 'Ismeretlen előadó',
      licenseUrl: track.license_ccurl,
    }
  }
  throw new Error('Ismeretlen zeneforrás.')
}