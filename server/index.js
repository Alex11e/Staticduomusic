import { createServer } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
  import { parseFile } from 'music-metadata'
  import yauzl from 'yauzl'

const root = path.dirname(fileURLToPath(import.meta.url))
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(root, '..', 'music'))
const distDir = path.resolve(root, '..', 'dist')
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '..', 'data'))
const storePath = path.join(dataDir, 'store.json')
const bootstrapTokenPath = path.join(dataDir, 'bootstrap-token')
const port = Number(process.env.PORT || 4000)
const host = process.env.HOST || '0.0.0.0'
const sessionLifetime = 30 * 24 * 60 * 60 * 1000
const maxUploadBytes = 500 * 1024 * 1024
const maxArchiveEntries = 5000
const maxArchiveFileBytes = 500 * 1024 * 1024
const maxArchiveExtractedBytes = 2 * 1024 * 1024 * 1024
const mimeTypes = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
}
const supportedExtensions = new Set(Object.keys(mimeTypes))
const metadataCache = new Map()

function defaultStore() {
  return { users: [], sessions: [], settings: { registrationOpen: true } }
}

function defaultProfileState() {
  return { favorites: [], recent: [], queue: [], volume: 0.8 }
}

let store = defaultStore()
let writeQueue = Promise.resolve()
const loginFailures = new Map()

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(data))
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key))
  })
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await derivePassword(password, salt)
  return { salt, passwordHash: hash.toString('hex') }
}

async function verifyPassword(password, user) {
  const hash = await derivePassword(password, user.salt)
  const expected = Buffer.from(user.passwordHash, 'hex')
  return expected.length === hash.length && timingSafeEqual(expected, hash)
}

function constantTimeMatch(value, expected) {
  const left = Buffer.from(String(value || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

async function saveStore() {
  const snapshot = JSON.stringify(store)
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, snapshot, { mode: 0o600 })
    await rename(temporaryPath, storePath)
  })
  return writeQueue
}

async function initializeStore() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  let profilesChanged = false
  try {
    const saved = JSON.parse(await readFile(storePath, 'utf8'))
    if (Array.isArray(saved.users) && Array.isArray(saved.sessions)) {
      store = { ...defaultStore(), ...saved, settings: { ...defaultStore().settings, ...saved.settings } }
      for (const user of store.users) {
        if (!Array.isArray(user.profiles) || user.profiles.length === 0) {
          user.profiles = [{
            id: randomUUID(), name: user.name || 'Első profil',
            state: {
              favorites: user.favorites || [], playlists: user.playlists || [], recent: user.recent || [],
              queue: user.queue || [], volume: Number.isFinite(user.volume) ? user.volume : 0.8,
            },
          }]
          delete user.favorites
          delete user.playlists
          delete user.recent
          delete user.queue
          delete user.volume
          profilesChanged = true
        } else {
          user.profiles = user.profiles.slice(0, 2)
          for (const profile of user.profiles) {
            profile.state = { ...defaultProfileState(), ...profile.state }
          }
        }
        if (!Array.isArray(user.sharedPlaylists)) {
          const playlists = new Map()
          for (const profile of user.profiles) {
            for (const playlist of profile.state.playlists || []) {
              if (playlist.id && !playlists.has(playlist.id)) playlists.set(playlist.id, playlist)
            }
          }
          user.sharedPlaylists = [...playlists.values()]
          profilesChanged = true
        }
        for (const profile of user.profiles) {
          if (Array.isArray(profile.state.playlists)) {
            delete profile.state.playlists
            profilesChanged = true
          }
        }
      }
      for (const session of store.sessions) {
        const owner = store.users.find((user) => user.id === session.userId)
        if (owner && !owner.profiles.some((profile) => profile.id === session.profileId)) {
          session.profileId = owner.profiles[0].id
          profilesChanged = true
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await saveStore()
  }
  if (profilesChanged) await saveStore()

  if (!store.users.some((user) => user.role === 'admin' && user.active)) {
    if (process.env.BOOTSTRAP_ADMIN_TOKEN) return
    try {
      await readFile(bootstrapTokenPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const token = randomBytes(24).toString('base64url')
      try {
        await writeFile(bootstrapTokenPath, token, { flag: 'wx', mode: 0o600 })
        console.warn(`HANGTAR első admin regisztrációs kulcsa: ${token}`)
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError
      }
    }
  }
}

async function getBootstrapToken() {
  if (process.env.BOOTSTRAP_ADMIN_TOKEN) return process.env.BOOTSTRAP_ADMIN_TOKEN
  try { return (await readFile(bootstrapTokenPath, 'utf8')).trim() }
  catch { return '' }
}

function safeUser(user, session) {
  const profiles = (user.profiles || []).map((profile) => ({ id: profile.id, name: profile.name, hasPin: Boolean(profile.passwordHash) }))
  const selectedProfileId = profiles.some((profile) => profile.id === session?.profileId)
    ? session.profileId
    : profiles[0]?.id
  return {
    id: user.id, name: user.name, email: user.email, role: user.role, active: user.active,
    createdAt: user.createdAt, profiles, selectedProfileId,
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : ''
}

function sessionCookie(request, token, clear = false) {
  const secure = process.env.COOKIE_SECURE === 'true' || request.headers['x-forwarded-proto'] === 'https'
  return `${clear ? 'hangtar_session=; Max-Age=0' : `hangtar_session=${encodeURIComponent(token)}; Max-Age=${Math.floor(sessionLifetime / 1000)}`}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

function sessionForRequest(request) {
  const token = cookieValue(request, 'hangtar_session')
  if (!token) return null
  return store.sessions.find((entry) => entry.tokenHash === hashToken(token) && entry.expiresAt > Date.now()) || null
}

async function userForRequest(request) {
  const session = sessionForRequest(request)
  const user = session && store.users.find((entry) => entry.id === session.userId && entry.active)
  return user || null
}

function profileForSession(user, session) {
  return user.profiles.find((profile) => profile.id === session?.profileId) || user.profiles[0]
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true
  const hostHeader = request.headers['x-forwarded-host'] || request.headers.host
  const protocol = request.headers['x-forwarded-proto'] || (request.socket.encrypted ? 'https' : 'http')
  try { return new URL(origin).origin === `${protocol}://${hostHeader}` }
  catch { return false }
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('A kérés túl nagy.'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Hibás JSON kérés.'), { status: 400 }) }
}

function cookieForUser(request, user) {
  const token = randomBytes(32).toString('base64url')
  store.sessions = store.sessions.filter((session) => session.expiresAt > Date.now())
  store.sessions.push({ tokenHash: hashToken(token), userId: user.id, profileId: user.profiles[0].id, expiresAt: Date.now() + sessionLifetime })
  return saveStore().then(() => sessionCookie(request, token))
}

async function createUser({ name, email, password, role }) {
  const passwordFields = await hashPassword(password)
  const user = {
    id: randomUUID(), name, email, role, active: true, createdAt: new Date().toISOString(),
    ...passwordFields,
    sharedPlaylists: [],
    profiles: [{ id: randomUUID(), name, state: defaultProfileState() }],
  }
  store.users.push(user)
  await saveStore()
  return user
}

function adminCount() {
  return store.users.filter((user) => user.role === 'admin' && user.active).length
}

async function readTrackMetadata(filePath, details) {
  const cached = metadataCache.get(filePath)
  if (cached && cached.size === details.size && cached.mtimeMs === details.mtimeMs) return cached.metadata

  let metadata = { title: '', artist: '', album: '', duration: null, year: null, genre: '', picture: null }
  try {
    const parsed = await parseFile(filePath, { duration: true })
    const picture = parsed.common.picture?.[0]
    metadata = {
      title: parsed.common.title || '',
      artist: parsed.common.artist || '',
      album: parsed.common.album || '',
      duration: Number.isFinite(parsed.format.duration) ? parsed.format.duration : null,
      year: parsed.common.year || null,
      genre: parsed.common.genre?.[0] || '',
      picture: picture && picture.data.length <= 8 * 1024 * 1024
        ? { format: picture.format, data: Buffer.from(picture.data) }
        : null,
    }
  } catch {
    // Fájlok ID3/audio tagek nélkül is maradhatnak a könyvtárban.
  }
  metadataCache.set(filePath, { size: details.size, mtimeMs: details.mtimeMs, metadata })
  return metadata
}

async function listTracks(directory = musicDir, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const tracks = []

  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name)
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      tracks.push(...await listTracks(absolutePath, relativePath))
    } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      const details = await stat(absolutePath)
      const folder = path.posix.dirname(relativePath)
      const filename = path.basename(entry.name, path.extname(entry.name))
      const id = Buffer.from(relativePath).toString('base64url')
      const metadata = await readTrackMetadata(absolutePath, details)
      tracks.push({
        id,
        title: metadata.title || filename.replace(/[_]+/g, ' ').replace(/\s+-\s+/g, ' - '),
        artist: metadata.artist || (folder === '.' ? 'Ismeretlen előadó' : folder.split('/').at(-1)),
        album: metadata.album || (folder === '.' ? 'Saját könyvtár' : folder),
        duration: metadata.duration,
        year: metadata.year,
        genre: metadata.genre,
        coverUrl: metadata.picture ? `/api/covers/${id}` : null,
        size: details.size,
        url: `/api/stream/${id}`,
      })
    }
  }

  return tracks
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const candidate = path.resolve(distDir, requestedPath)
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${path.sep}`)) {
    sendJson(response, 403, { error: 'Tiltott útvonal.' })
    return
  }

  let filePath = candidate
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file')
  } catch {
    filePath = path.join(distDir, 'index.html')
  }

  try {
    const details = await stat(filePath)
    const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8' :
      filePath.endsWith('.js') ? 'text/javascript; charset=utf-8' :
        filePath.endsWith('.css') ? 'text/css; charset=utf-8' :
          filePath.endsWith('.svg') ? 'image/svg+xml' :
            filePath.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': details.size })
    if (request.method === 'HEAD') response.end()
    else createReadStream(filePath).pipe(response)
  } catch {
    sendJson(response, 404, { error: 'Az alkalmazás még nincs lefordítva.' })
  }
}

function archiveError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function archivePathParts(entryName) {
  const normalized = entryName.replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw archiveError('Az archívum abszolút vagy érvénytelen útvonalat tartalmaz.')
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) throw archiveError('Az archívum útvonalkilépést tartalmaz.')
  if (parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw archiveError('Az archívum nem hordozható fájlnevet tartalmaz.')
  }
  const destination = path.resolve(musicDir, ...parts)
  if (!destination.startsWith(`${musicDir}${path.sep}`)) throw archiveError('Az archívum útvonala kilép a zenekönyvtárból.')
  return { parts, destination }
}

async function ensureArchiveDirectories(parts, createdDirectories) {
  let directory = musicDir
  for (const part of parts) {
    directory = path.join(directory, part)
    try {
      await mkdir(directory, { mode: 0o750 })
      createdDirectories.add(directory)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) throw archiveError('Az archívum nem biztonságos könyvtárútvonalat tartalmaz.')
  }
}

function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zipFile) => {
      if (error) reject(error)
      else resolve(zipFile)
    })
  })
}

function openZipEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
  })
}

async function extractAudioArchive(archivePath) {
  const zipFile = await openZipFile(archivePath)
  const extractedFiles = []
  const createdFiles = new Set()
  const createdDirectories = new Set()
  let entryCount = 0
  let declaredBytes = 0
  let extractedBytes = 0

  async function cleanup() {
    await Promise.all([...createdFiles].map((filePath) => unlink(filePath).catch(() => {})))
    const directories = [...createdDirectories].sort((left, right) => right.length - left.length)
    for (const directory of directories) await rmdir(directory).catch(() => {})
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      zipFile.close()
      void cleanup().finally(() => reject(error))
    }

    zipFile.on('error', fail)
    zipFile.on('end', () => {
      if (settled) return
      settled = true
      zipFile.close()
      if (!extractedFiles.length) {
        void cleanup().finally(() => reject(archiveError('Az archívumban nem található támogatott zenefájl.')))
      } else {
        resolve(extractedFiles)
      }
    })
    zipFile.on('entry', (entry) => {
      if (settled) return
      void (async () => {
        entryCount += 1
        if (entryCount > maxArchiveEntries) throw archiveError('Az archívum túl sok fájlt tartalmaz.', 413)
        const { parts, destination } = archivePathParts(entry.fileName)
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
        const fileType = unixMode & 0o170000
        if (fileType === 0o120000) throw archiveError('Az archívum szimbolikus hivatkozást tartalmaz.')
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw archiveError('Az archívum speciális fájlt tartalmaz.')

        const isDirectory = entry.fileName.endsWith('/') || fileType === 0o040000
        if (isDirectory) {
          zipFile.readEntry()
          return
        }
        const extension = path.extname(destination).toLowerCase()
        if (!supportedExtensions.has(extension)) {
          zipFile.readEntry()
          return
        }
        if (entry.uncompressedSize > maxArchiveFileBytes) throw archiveError('Egy kicsomagolt zenefájl legfeljebb 500 MB lehet.', 413)
        declaredBytes += entry.uncompressedSize
        if (declaredBytes > maxArchiveExtractedBytes) throw archiveError('Az archívum kicsomagolt mérete meghaladja a 2 GB-ot.', 413)

        await ensureArchiveDirectories(parts.slice(0, -1), createdDirectories)
        const fileHandle = await open(destination, 'wx', 0o640)
        createdFiles.add(destination)
        let fileBytes = 0
        const limit = new Transform({
          transform(chunk, encoding, callback) {
            fileBytes += chunk.length
            if (fileBytes > maxArchiveFileBytes || extractedBytes + fileBytes > maxArchiveExtractedBytes) {
              callback(archiveError('A kicsomagolt archívum túllépte a méretkorlátot.', 413))
              return
            }
            callback(null, chunk)
          },
        })
        const output = fileHandle.createWriteStream()
        try {
          const input = await openZipEntry(zipFile, entry)
          await pipeline(input, limit, output)
        } catch (error) {
          await fileHandle.close().catch(() => {})
          throw error
        }
        if (fileBytes !== entry.uncompressedSize) throw archiveError('Az archívum sérült vagy csonka.')
        extractedBytes += fileBytes
        extractedFiles.push(path.relative(musicDir, destination))
        zipFile.readEntry()
      })().catch(fail)
    })
    zipFile.readEntry()
  })
}

async function saveUploadedArchive(request, response) {
  const contentLength = Number(request.headers['content-length'] || 0)
  if (contentLength > maxUploadBytes) {
    sendJson(response, 413, { error: 'A ZIP fájl legfeljebb 500 MB lehet.' })
    request.resume()
    return
  }

  const archivePath = path.join(dataDir, `${randomUUID()}.upload.zip`)
  let uploadedBytes = 0
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      uploadedBytes += chunk.length
      callback(uploadedBytes > maxUploadBytes ? archiveError('A ZIP fájl legfeljebb 500 MB lehet.', 413) : null, chunk)
    },
  })
  try {
    await pipeline(request, sizeLimit, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }))
    const extracted = await extractAudioArchive(archivePath)
    sendJson(response, 201, { extracted: extracted.length, files: extracted })
  } catch (error) {
    const status = error.status || (error.code === 'EEXIST' ? 409 : 400)
    sendJson(response, status, { error: status === 409 ? 'Már létezik ilyen fájl a zenekönyvtárban.' : error.message || 'A ZIP feldolgozása nem sikerült.' })
  } finally {
    await unlink(archivePath).catch(() => {})
  }
}

async function saveUploadedTrack(request, response, url) {
  const requestedName = (url.searchParams.get('filename') || '').replaceAll('\\', '/')
  const originalName = path.posix.basename(requestedName)
  const extension = path.extname(originalName).toLowerCase()
  if (!originalName || (extension !== '.zip' && !supportedExtensions.has(extension))) {
    sendJson(response, 400, { error: 'Nem támogatott vagy hiányzó fájlnév.' })
    request.resume()
    return
  }
  if (extension === '.zip') return saveUploadedArchive(request, response)

  const safeBase = path.basename(originalName, path.extname(originalName))
    .normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+/, '').slice(0, 120)
  const filename = `${safeBase || 'zene'}${extension}`
  const filePath = path.join(musicDir, filename)
  const contentLength = Number(request.headers['content-length'] || 0)
  if (contentLength > maxUploadBytes) {
    sendJson(response, 413, { error: 'A fájl legfeljebb 500 MB lehet.' })
    request.resume()
    return
  }

  let uploadedBytes = 0
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      uploadedBytes += chunk.length
      callback(uploadedBytes > maxUploadBytes ? Object.assign(new Error('A fájl legfeljebb 500 MB lehet.'), { status: 413 }) : null, chunk)
    },
  })
  let createdFile = false
  try {
    const fileHandle = await open(filePath, 'wx', 0o640)
    createdFile = true
    await pipeline(request, sizeLimit, fileHandle.createWriteStream())
    sendJson(response, 201, { filename, size: uploadedBytes })
  } catch (error) {
    if (createdFile) await unlink(filePath).catch(() => {})
    const status = error.code === 'EEXIST' ? 409 : error.status || 500
    sendJson(response, status, { error: status === 409 ? 'Már létezik ilyen nevű fájl.' : error.message || 'A feltöltés nem sikerült.' })
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost')
  const pathname = url.pathname
  try {
    if (pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' })
      return
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '') && !sameOrigin(request)) {
      sendJson(response, 403, { error: 'A kérés forrása nem engedélyezett.' })
      return
    }
    if (pathname === '/api/auth/status' && request.method === 'GET') {
      const setupRequired = adminCount() === 0
      sendJson(response, 200, { setupRequired, registrationOpen: store.settings.registrationOpen })
      return
    }
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const setupRequired = adminCount() === 0
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12) {
        sendJson(response, 400, { error: 'Adj meg nevet, érvényes email-címet és legalább 12 karakteres jelszót.' })
        return
      }
      if (store.users.some((user) => user.email === email)) {
        sendJson(response, 409, { error: 'Ezzel az email-címmel már létezik fiók.' })
        return
      }
      let role = 'user'
      if (setupRequired) {
        if (!constantTimeMatch(body.bootstrapToken, await getBootstrapToken())) {
          sendJson(response, 403, { error: 'Az első adminisztrátor létrehozásához érvényes telepítőkulcs szükséges.' })
          return
        }
        role = 'admin'
      } else if (!store.settings.registrationOpen) {
        sendJson(response, 403, { error: 'Az új regisztráció jelenleg zárva van.' })
        return
      }
      const user = await createUser({ name, email, password, role })
      if (role === 'admin') await unlink(bootstrapTokenPath).catch(() => {})
      const cookie = await cookieForUser(request, user)
      sendJson(response, 201, { user: safeUser(user) }, { 'Set-Cookie': cookie })
      return
    }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const ip = request.socket.remoteAddress || 'unknown'
      const failure = loginFailures.get(ip)
      if (failure && failure.until > Date.now() && failure.count >= 10) {
        sendJson(response, 429, { error: 'Túl sok sikertelen belépés. Próbáld újra 15 perc múlva.' })
        return
      }
      const body = await readJson(request)
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const user = store.users.find((entry) => entry.email === email)
      if (!user || !user.active || typeof body.password !== 'string' || !await verifyPassword(body.password, user)) {
        const next = failure?.until > Date.now() ? failure : { count: 0, until: Date.now() + 15 * 60 * 1000 }
        next.count += 1
        loginFailures.set(ip, next)
        sendJson(response, 401, { error: 'Hibás email-cím vagy jelszó.' })
        return
      }
      loginFailures.delete(ip)
      const cookie = await cookieForUser(request, user)
      sendJson(response, 200, { user: safeUser(user) }, { 'Set-Cookie': cookie })
      return
    }

    const user = await userForRequest(request)
    const session = user ? sessionForRequest(request) : null
    const profile = user ? profileForSession(user, session) : null
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = cookieValue(request, 'hangtar_session')
      store.sessions = store.sessions.filter((session) => session.tokenHash !== hashToken(token))
      await saveStore()
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', true) })
      return
    }
    if (pathname.startsWith('/api/') && !user) {
      sendJson(response, 401, { error: 'A folytatáshoz jelentkezz be.' })
      return
    }
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      sendJson(response, 200, { user: safeUser(user, session) })
      return
    }
    if (pathname === '/api/profiles' && request.method === 'POST') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
      const pin = typeof body.pin === 'string' ? body.pin : ''
      if (name.length < 2) { sendJson(response, 400, { error: 'A profilnév legalább 2 karakter legyen.' }); return }
      if (user.profiles.length >= 2) { sendJson(response, 409, { error: 'A Duo fiókban legfeljebb két profil lehet.' }); return }
      if (user.profiles.some((entry) => entry.name.toLocaleLowerCase('hu') === name.toLocaleLowerCase('hu'))) {
        sendJson(response, 409, { error: 'Már létezik ilyen nevű profil.' })
        return
      }
      if (pin && !/^\d{4,8}$/.test(pin)) { sendJson(response, 400, { error: 'A profil PIN-kódja 4–8 számjegy lehet.' }); return }
      const pinFields = pin ? await hashPassword(pin) : {}
      user.profiles.push({ id: randomUUID(), name, state: defaultProfileState(), ...pinFields })
      await saveStore()
      sendJson(response, 201, { user: safeUser(user, session) })
      return
    }
    const profileSelectMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/select$/)
    if (profileSelectMatch && request.method === 'POST') {
      const target = user.profiles.find((entry) => entry.id === profileSelectMatch[1])
      if (!target) { sendJson(response, 404, { error: 'A profil nem található.' }); return }
      const body = await readJson(request)
      if (target.passwordHash && (typeof body.pin !== 'string' || !await verifyPassword(body.pin, target))) {
        sendJson(response, 403, { error: 'Hibás profil PIN-kód.' })
        return
      }
      session.profileId = target.id
      await saveStore()
      sendJson(response, 200, { user: safeUser(user, session) })
      return
    }
    const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/)
    if (profileMatch && request.method === 'PATCH') {
      const target = user.profiles.find((entry) => entry.id === profileMatch[1])
      if (!target) { sendJson(response, 404, { error: 'A profil nem található.' }); return }
      const body = await readJson(request)
      const name = body.name === undefined ? target.name : typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
      if (name.length < 2) { sendJson(response, 400, { error: 'A profilnév legalább 2 karakter legyen.' }); return }
      if (user.profiles.some((entry) => entry.id !== target.id && entry.name.toLocaleLowerCase('hu') === name.toLocaleLowerCase('hu'))) {
        sendJson(response, 409, { error: 'Már létezik ilyen nevű profil.' })
        return
      }
      if (body.pin !== undefined && body.pin !== '' && (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin))) {
        sendJson(response, 400, { error: 'A profil PIN-kódja 4–8 számjegy lehet.' })
        return
      }
      const pinFields = typeof body.pin === 'string' && body.pin ? await hashPassword(body.pin) : null
      target.name = name
      if (body.pin === '') { delete target.salt; delete target.passwordHash }
      else if (pinFields) Object.assign(target, pinFields)
      await saveStore()
      sendJson(response, 200, { user: safeUser(user, session) })
      return
    }
    if (profileMatch && request.method === 'DELETE') {
      const target = user.profiles.find((entry) => entry.id === profileMatch[1])
      if (!target) { sendJson(response, 404, { error: 'A profil nem található.' }); return }
      if (user.profiles.length <= 1 || target.id === user.profiles[0].id) {
        sendJson(response, 400, { error: 'Az elsődleges profil nem törölhető.' })
        return
      }
      user.profiles = user.profiles.filter((entry) => entry.id !== target.id)
      for (const accountSession of store.sessions) {
        if (accountSession.userId === user.id && accountSession.profileId === target.id) accountSession.profileId = user.profiles[0].id
      }
      await saveStore()
      sendJson(response, 200, { user: safeUser(user, session) })
      return
    }
    if (pathname === '/api/me/playlists' && request.method === 'GET') {
      sendJson(response, 200, { playlists: user.sharedPlaylists || [] })
      return
    }
    if (pathname === '/api/me/playlists' && request.method === 'POST') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      if (name.length < 1) { sendJson(response, 400, { error: 'A lista neve nem lehet üres.' }); return }
      if (user.sharedPlaylists.length >= 100) { sendJson(response, 409, { error: 'Egy fiókban legfeljebb 100 lista lehet.' }); return }
      if (user.sharedPlaylists.some((playlist) => playlist.name.toLocaleLowerCase('hu') === name.toLocaleLowerCase('hu'))) {
        sendJson(response, 409, { error: 'Már létezik ilyen nevű lejátszási lista.' })
        return
      }
      user.sharedPlaylists.push({ id: randomUUID(), name, trackIds: [] })
      await saveStore()
      sendJson(response, 201, { playlists: user.sharedPlaylists })
      return
    }
    const playlistTracksMatch = pathname.match(/^\/api\/me\/playlists\/([^/]+)\/tracks(?:\/([^/]+))?$/)
    if (playlistTracksMatch && ['POST', 'DELETE'].includes(request.method || '')) {
      const playlist = user.sharedPlaylists.find((entry) => entry.id === playlistTracksMatch[1])
      if (!playlist) { sendJson(response, 404, { error: 'A lejátszási lista nem található.' }); return }
      if (request.method === 'POST' && !playlistTracksMatch[2]) {
        const body = await readJson(request)
        if (typeof body.trackId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(body.trackId)) {
          sendJson(response, 400, { error: 'Érvénytelen zeneszám.' })
          return
        }
        if (!playlist.trackIds.includes(body.trackId)) playlist.trackIds.push(body.trackId)
      } else if (request.method === 'DELETE' && playlistTracksMatch[2]) {
        playlist.trackIds = playlist.trackIds.filter((id) => id !== playlistTracksMatch[2])
      } else {
        sendJson(response, 404, { error: 'A lejátszási művelet nem található.' })
        return
      }
      await saveStore()
      sendJson(response, 200, { playlists: user.sharedPlaylists })
      return
    }
    const playlistMatch = pathname.match(/^\/api\/me\/playlists\/([^/]+)$/)
    if (playlistMatch && ['PATCH', 'DELETE'].includes(request.method || '')) {
      const playlist = user.sharedPlaylists.find((entry) => entry.id === playlistMatch[1])
      if (!playlist) { sendJson(response, 404, { error: 'A lejátszási lista nem található.' }); return }
      if (request.method === 'DELETE') {
        user.sharedPlaylists = user.sharedPlaylists.filter((entry) => entry.id !== playlist.id)
      } else {
        const body = await readJson(request)
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
        if (name.length < 1) { sendJson(response, 400, { error: 'A lista neve nem lehet üres.' }); return }
        if (user.sharedPlaylists.some((entry) => entry.id !== playlist.id && entry.name.toLocaleLowerCase('hu') === name.toLocaleLowerCase('hu'))) {
          sendJson(response, 409, { error: 'Már létezik ilyen nevű lejátszási lista.' })
          return
        }
        playlist.name = name
      }
      await saveStore()
      sendJson(response, 200, { playlists: user.sharedPlaylists })
      return
    }
    if (pathname === '/api/me/state' && request.method === 'GET') {
      sendJson(response, 200, { ...profile.state, playlists: user.sharedPlaylists || [] })
      return
    }
    if (pathname === '/api/me/state' && request.method === 'PUT') {
      const body = await readJson(request, 1024 * 1024)
      profile.state.favorites = Array.isArray(body.favorites) ? body.favorites.filter((id) => typeof id === 'string').slice(0, 10000) : []
      profile.state.recent = Array.isArray(body.recent) ? body.recent.filter((id) => typeof id === 'string').slice(0, 100) : []
      profile.state.queue = Array.isArray(body.queue) ? [...new Set(body.queue.filter((id) => typeof id === 'string'))].slice(0, 500) : []
      profile.state.volume = Number.isFinite(body.volume) ? Math.max(0, Math.min(1, body.volume)) : 0.8
      await saveStore()
      sendJson(response, 200, { ok: true })
      return
    }
    if (pathname === '/api/admin/users' && request.method === 'GET') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      sendJson(response, 200, { users: store.users.map(safeUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
      return
    }
    if (pathname === '/api/admin/settings' && request.method === 'GET') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      sendJson(response, 200, { registrationOpen: store.settings.registrationOpen })
      return
    }
    if (pathname === '/api/admin/stats' && request.method === 'GET') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      const tracks = await listTracks()
      sendJson(response, 200, {
        users: store.users.length,
        tracks: tracks.length,
        storageBytes: tracks.reduce((total, track) => total + track.size, 0),
      })
      return
    }
    if (pathname === '/api/admin/settings' && request.method === 'PATCH') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      const body = await readJson(request)
      if (typeof body.registrationOpen !== 'boolean') { sendJson(response, 400, { error: 'Hibás beállítás.' }); return }
      store.settings.registrationOpen = body.registrationOpen
      await saveStore()
      sendJson(response, 200, { registrationOpen: store.settings.registrationOpen })
      return
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (userMatch && request.method === 'PATCH') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      const target = store.users.find((entry) => entry.id === userMatch[1])
      if (!target) { sendJson(response, 404, { error: 'A felhasználó nem található.' }); return }
      const body = await readJson(request)
      const nextRole = body.role === undefined ? target.role : body.role
      const nextActive = body.active === undefined ? target.active : body.active
      if (!['admin', 'user'].includes(nextRole) || typeof nextActive !== 'boolean') {
        sendJson(response, 400, { error: 'Hibás szerepkör vagy fiókállapot.' })
        return
      }
      if (target.id === user.id && (nextRole !== 'admin' || !nextActive)) {
        sendJson(response, 400, { error: 'A saját admin fiókodat nem tilthatod le és nem fokozhatod vissza.' })
        return
      }
      if (target.role === 'admin' && target.active && (nextRole !== 'admin' || !nextActive) && adminCount() <= 1) {
        sendJson(response, 409, { error: 'Az utolsó aktív adminisztrátor nem módosítható.' })
        return
      }
      target.role = nextRole
      target.active = nextActive
      if (!target.active) store.sessions = store.sessions.filter((session) => session.userId !== target.id)
      await saveStore()
      sendJson(response, 200, { user: safeUser(target) })
      return
    }
    if (pathname === '/api/admin/tracks' && request.method === 'POST') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); request.resume(); return }
      await saveUploadedTrack(request, response, url)
      return
    }
    const trackMatch = pathname.match(/^\/api\/admin\/tracks\/([^/]+)$/)
    if (trackMatch && request.method === 'DELETE') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Ehhez adminisztrátori jogosultság kell.' }); return }
      const relativePath = Buffer.from(trackMatch[1], 'base64url').toString()
      const trackPath = path.resolve(musicDir, relativePath)
      if (trackPath === musicDir || !trackPath.startsWith(`${musicDir}${path.sep}`) || !supportedExtensions.has(path.extname(trackPath).toLowerCase())) {
        sendJson(response, 400, { error: 'Érvénytelen zenefájl.' })
        return
      }
      await unlink(trackPath)
      metadataCache.delete(trackPath)
      sendJson(response, 200, { ok: true })
      return
    }
    if (pathname.startsWith('/api/covers/') && request.method === 'GET') {
      const id = pathname.slice('/api/covers/'.length)
      const relativePath = Buffer.from(id, 'base64url').toString()
      const coverTrackPath = path.resolve(musicDir, relativePath)
      if (coverTrackPath === musicDir || !coverTrackPath.startsWith(`${musicDir}${path.sep}`)) {
        sendJson(response, 400, { error: 'Érvénytelen zenefájl.' })
        return
      }
      const details = await stat(coverTrackPath)
      const metadata = await readTrackMetadata(coverTrackPath, details)
      if (!metadata.picture) { sendJson(response, 404, { error: 'Ehhez a zenéhez nincs beágyazott borító.' }); return }
      const format = /^image\/(jpeg|png|webp|gif)$/.test(metadata.picture.format) ? metadata.picture.format : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': format, 'Content-Length': metadata.picture.data.length, 'Cache-Control': 'private, max-age=86400' })
      response.end(metadata.picture.data)
      return
    }
    if (pathname === '/api/tracks' && request.method === 'GET') {
      sendJson(response, 200, { tracks: await listTracks() })
      return
    }
    if (pathname.startsWith('/api/stream/') && ['GET', 'HEAD'].includes(request.method || '')) {
      const id = pathname.slice('/api/stream/'.length)
      const relativePath = Buffer.from(id, 'base64url').toString()
      const audioPath = path.resolve(musicDir, relativePath)
      if (audioPath !== musicDir && !audioPath.startsWith(`${musicDir}${path.sep}`)) {
        sendJson(response, 400, { error: 'Érvénytelen zenefájl.' })
        return
      }

      const details = await stat(audioPath)
      if (!details.isFile() || !supportedExtensions.has(path.extname(audioPath).toLowerCase())) {
        sendJson(response, 404, { error: 'A zenefájl nem található.' })
        return
      }
      const range = request.headers.range
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range)
      const start = match ? Number(match[1] || 0) : 0
      const end = match && match[2] ? Number(match[2]) : details.size - 1
      if (start >= details.size || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${details.size}` })
        response.end()
        return
      }
      const contentEnd = Math.min(end, details.size - 1)
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Length': contentEnd - start + 1,
        'Content-Type': mimeTypes[path.extname(audioPath).toLowerCase()],
      }
      if (match) headers['Content-Range'] = `bytes ${start}-${contentEnd}/${details.size}`
      response.writeHead(match ? 206 : 200, headers)
      if (request.method === 'HEAD') response.end()
      else createReadStream(audioPath, { start, end: contentEnd }).pipe(response)
      return
    }
    await serveStatic(request, response, pathname)
  } catch (error) {
    if (error.code === 'ENOENT') sendJson(response, 404, { error: 'A zenefájl nem található.' })
    else {
      console.error(error)
      sendJson(response, 500, { error: 'Szerverhiba történt.' })
    }
  }
})

await mkdir(musicDir, { recursive: true })
await initializeStore()
server.listen(port, host, () => {
  console.log(`HANGTÁR elérhető: http://localhost:${port}`)
  console.log(`Zenekönyvtár: ${musicDir}`)
})