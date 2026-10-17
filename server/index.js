import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(root, '..', 'music'))
const distDir = path.resolve(root, '..', 'dist')
const port = Number(process.env.PORT || 4000)
const host = process.env.HOST || '0.0.0.0'
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

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
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
      tracks.push({
        id,
        title: filename.replace(/[_]+/g, ' ').replace(/\s+-\s+/g, ' - '),
        artist: folder === '.' ? 'Ismeretlen előadó' : folder.split('/').at(-1),
        album: folder === '.' ? 'Saját könyvtár' : folder,
        duration: null,
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

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  try {
    if (pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' })
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
server.listen(port, host, () => {
  console.log(`HANGTÁR elérhető: http://localhost:${port}`)
  console.log(`Zenekönyvtár: ${musicDir}`)
})