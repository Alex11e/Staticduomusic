import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import yazl from 'yazl'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let temporaryDirectory
let serverProcess
let serverUrl
let bootstrapToken
let serverOutput = ''

async function freePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = listener.address()
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function requestJson(route, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${serverUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { response, data: text ? JSON.parse(text) : null }
}

function sessionCookie(response) {
  const value = response.headers.get('set-cookie')
  assert.ok(value, 'A szervernek session sütit kell küldenie.')
  return value.split(';', 1)[0]
}

function id3Frame(id, data) {
  const header = Buffer.alloc(10)
  header.write(id)
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function textFrame(id, value) {
  return id3Frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(value)]))
}

function taggedAudioFixture() {
  const picture = id3Frame('APIC', Buffer.concat([
    Buffer.from([0]), Buffer.from('image/png\0', 'ascii'), Buffer.from([3, 0]),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  ]))
  const frames = Buffer.concat([
    textFrame('TIT2', 'Fixture title'),
    textFrame('TPE1', 'Fixture artist'),
    textFrame('TALB', 'Fixture album'),
    picture,
  ])
  const header = Buffer.from([
    73, 68, 51, 3, 0, 0,
    (frames.length >> 21) & 127, (frames.length >> 14) & 127,
    (frames.length >> 7) & 127, frames.length & 127,
  ])
  return Buffer.concat([header, frames, Buffer.from([255, 251, 144, 100, 0, 0, 0, 0])])
}

function createZipFixture(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const chunks = []
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.once('error', reject)
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)))
    for (const entry of entries) zip.addBuffer(entry.data, entry.name)
    zip.end()
  })
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'hangtar-auth-test-'))
  const musicDirectory = path.join(temporaryDirectory, 'music')
  const dataDirectory = path.join(temporaryDirectory, 'data')
  await Promise.all([mkdir(musicDirectory), mkdir(dataDirectory)])
  const port = await freePort()
  serverUrl = `http://127.0.0.1:${port}`
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', MUSIC_DIR: musicDirectory, DATA_DIR: dataDirectory }
  delete env.BOOTSTRAP_ADMIN_TOKEN
  serverProcess = spawn(process.execPath, [path.join(projectRoot, 'server', 'index.js')], {
    cwd: projectRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString() })
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString() })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`A tesztszerver leállt: ${serverOutput}`)
    try {
      const response = await fetch(`${serverUrl}/api/auth/status`)
      if (response.ok) break
    } catch { /* A szerver még indul. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const tokenPath = path.join(dataDirectory, 'bootstrap-token')
  bootstrapToken = (await readFile(tokenPath, 'utf8')).trim()
})

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill()
    await Promise.race([once(serverProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))])
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
})

test('admin setup, fiókok, jogosultságok, szinkron és zenefeltöltés', async () => {
  const initialStatus = await requestJson('/api/auth/status')
  assert.deepEqual(initialStatus.data, { setupRequired: true, registrationOpen: true })
  assert.equal((await requestJson('/api/tracks')).response.status, 401)

  const blockedSetup = await requestJson('/api/auth/register', {
    method: 'POST', body: { name: 'Admin', email: 'admin@example.test', password: 'strong-test-password-1' },
  })
  assert.equal(blockedSetup.response.status, 403)

  const adminResult = await requestJson('/api/auth/register', {
    method: 'POST',
    body: { name: 'Admin', email: 'admin@example.test', password: 'strong-test-password-1', bootstrapToken },
    headers: { Origin: serverUrl },
  })
  assert.equal(adminResult.response.status, 201)
  assert.equal(adminResult.data.user.role, 'admin')
  const adminCookie = sessionCookie(adminResult.response)

  const bootstrapAfterUse = await requestJson('/api/auth/status')
  assert.equal(bootstrapAfterUse.data.setupRequired, false)
  await assert.rejects(readFile(path.join(temporaryDirectory, 'data', 'bootstrap-token')))

  const userResult = await requestJson('/api/auth/register', {
    method: 'POST', body: { name: 'Hallgató', email: 'user@example.test', password: 'strong-test-password-2' },
  })
  assert.equal(userResult.response.status, 201)
  assert.equal(userResult.data.user.role, 'user')
  const userCookie = sessionCookie(userResult.response)
  const userId = userResult.data.user.id
  const login = await requestJson('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: 'strong-test-password-2' },
    headers: { Origin: serverUrl },
  })
  assert.equal(login.response.status, 200)
  const secondSessionCookie = sessionCookie(login.response)
  assert.equal((await requestJson('/api/auth/me', { cookie: secondSessionCookie })).response.status, 200)
  assert.equal((await requestJson('/api/auth/login', { method: 'POST', body: { email: 'user@example.test', password: 'wrong-password' } })).response.status, 401)

  const primaryProfileId = userResult.data.user.profiles[0].id
  const createProfile = await requestJson('/api/profiles', {
    method: 'POST', body: { name: 'Második profil', pin: '2468' }, cookie: userCookie,
  })
  assert.equal(createProfile.response.status, 201)
  assert.equal(createProfile.data.user.profiles.length, 2)
  assert.equal(createProfile.data.user.maxProfiles, 10)
  const duoProfile = createProfile.data.user.profiles.find((profile) => profile.id !== primaryProfileId)
  assert.ok(duoProfile?.hasPin)
  for (let profileNumber = 3; profileNumber <= 10; profileNumber += 1) {
    const additionalProfile = await requestJson('/api/profiles', {
      method: 'POST', body: { name: `Profil ${profileNumber}` }, cookie: userCookie,
    })
    assert.equal(additionalProfile.response.status, 201)
  }
  assert.equal((await requestJson('/api/profiles', { method: 'POST', body: { name: 'Tizenegyedik' }, cookie: userCookie })).response.status, 409)
  assert.equal((await requestJson(`/api/profiles/${duoProfile.id}/select`, { method: 'POST', body: { pin: '0000' }, cookie: userCookie })).response.status, 403)

  const renameProfile = await requestJson(`/api/profiles/${duoProfile.id}`, {
    method: 'PATCH', body: { name: 'Duo profil' }, cookie: userCookie,
  })
  assert.equal(renameProfile.data.user.profiles.find((profile) => profile.id === duoProfile.id).name, 'Duo profil')
  assert.equal((await requestJson(`/api/profiles/${primaryProfileId}`, { method: 'DELETE', cookie: userCookie })).response.status, 400)

  const selectDuo = await requestJson(`/api/profiles/${duoProfile.id}/select`, {
    method: 'POST', body: { pin: '2468' }, cookie: userCookie,
  })
  assert.equal(selectDuo.data.user.selectedProfileId, duoProfile.id)
  const state = { favorites: ['track-1'], recent: ['track-1'], queue: ['track-2'], volume: 0.4 }
  assert.equal((await requestJson('/api/me/state', { method: 'PUT', body: state, cookie: userCookie })).response.status, 200)
  assert.deepEqual((await requestJson('/api/me/state', { cookie: userCookie })).data, { ...state, playlists: [] })
  assert.deepEqual((await requestJson('/api/me/state', { cookie: secondSessionCookie })).data, {
    favorites: [], recent: [], queue: [], volume: 0.8, playlists: [],
  })
  const selectOtherSession = await requestJson(`/api/profiles/${duoProfile.id}/select`, {
    method: 'POST', body: { pin: '2468' }, cookie: secondSessionCookie,
  })
  assert.equal(selectOtherSession.data.user.selectedProfileId, duoProfile.id)
  assert.deepEqual((await requestJson('/api/me/state', { cookie: secondSessionCookie })).data, { ...state, playlists: [] })

  const sharedPlaylistCreate = await requestJson('/api/me/playlists', {
    method: 'POST', body: { name: 'Duo közös lista' }, cookie: userCookie,
  })
  assert.equal(sharedPlaylistCreate.response.status, 201)
  const sharedPlaylistId = sharedPlaylistCreate.data.playlists[0].id
  assert.equal((await requestJson(`/api/me/playlists/${sharedPlaylistId}/tracks`, {
    method: 'POST', body: { trackId: 'track-1' }, cookie: userCookie,
  })).response.status, 200)
  assert.deepEqual((await requestJson('/api/me/playlists', { cookie: secondSessionCookie })).data.playlists[0].trackIds, ['track-1'])
  const renameSharedPlaylist = await requestJson(`/api/me/playlists/${sharedPlaylistId}`, {
    method: 'PATCH', body: { name: 'A mi közös zenéink' }, cookie: secondSessionCookie,
  })
  assert.equal(renameSharedPlaylist.data.playlists[0].name, 'A mi közös zenéink')
  assert.equal((await requestJson(`/api/me/playlists/${sharedPlaylistId}/tracks/track-1`, {
    method: 'DELETE', cookie: secondSessionCookie,
  })).response.status, 200)
  assert.deepEqual((await requestJson('/api/me/playlists', { cookie: userCookie })).data.playlists[0].trackIds, [])
  await requestJson(`/api/me/playlists/${sharedPlaylistId}/tracks`, {
    method: 'POST', body: { trackId: 'track-2' }, cookie: userCookie,
  })
  assert.equal((await requestJson(`/api/me/playlists/${sharedPlaylistId}`, {
    method: 'DELETE', cookie: secondSessionCookie,
  })).response.status, 200)
  assert.deepEqual((await requestJson('/api/me/playlists', { cookie: userCookie })).data.playlists, [])
  await requestJson(`/api/profiles/${primaryProfileId}/select`, { method: 'POST', body: {}, cookie: userCookie })
  const deleteProfile = await requestJson(`/api/profiles/${duoProfile.id}`, { method: 'DELETE', cookie: userCookie })
  assert.equal(deleteProfile.response.status, 200)
  assert.equal(deleteProfile.data.user.profiles.length, 9)
  assert.deepEqual((await requestJson('/api/me/state', { cookie: secondSessionCookie })).data, {
    favorites: [], recent: [], queue: [], volume: 0.8, playlists: [],
  })

  assert.equal((await requestJson('/api/admin/users', { cookie: userCookie })).response.status, 403)
  assert.equal((await requestJson('/api/admin/users', { cookie: adminCookie })).data.users.length, 2)
  assert.equal((await requestJson('/api/admin/stats', { cookie: adminCookie })).data.users, 2)

  const csrf = await requestJson('/api/admin/settings', {
    method: 'PATCH', body: { registrationOpen: false }, cookie: adminCookie, headers: { Origin: 'https://attacker.example' },
  })
  assert.equal(csrf.response.status, 403)

  const deniedUpload = await fetch(`${serverUrl}/api/admin/tracks?filename=denied.mp3`, {
    method: 'POST', headers: { Cookie: userCookie }, body: Buffer.from('audio'),
  })
  assert.equal(deniedUpload.status, 403)
  await deniedUpload.arrayBuffer()

  const upload = await fetch(`${serverUrl}/api/admin/tracks?filename=tagged-test.mp3`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'audio/mpeg' }, body: taggedAudioFixture(),
  })
  assert.equal(upload.status, 201)
  const duplicateUpload = await fetch(`${serverUrl}/api/admin/tracks?filename=tagged-test.mp3`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'audio/mpeg' }, body: Buffer.from('replacement'),
  })
  assert.equal(duplicateUpload.status, 409)
  await duplicateUpload.arrayBuffer()
  const tracks = await requestJson('/api/tracks', { cookie: adminCookie })
  const uploadedTrack = tracks.data.tracks.find((track) => track.title === 'Fixture title')
  assert.ok(uploadedTrack)
  assert.equal(uploadedTrack.artist, 'Fixture artist')
  assert.equal(uploadedTrack.album, 'Fixture album')
  assert.ok(uploadedTrack.coverUrl)
  const cover = await fetch(`${serverUrl}${uploadedTrack.coverUrl}`, { headers: { Cookie: adminCookie } })
  assert.equal(cover.status, 200)
  assert.equal(cover.headers.get('content-type'), 'image/png')
  assert.equal((await cover.arrayBuffer()).byteLength, 8)
  assert.equal((await requestJson(`/api/admin/tracks/${uploadedTrack.id}`, { method: 'DELETE', cookie: adminCookie })).response.status, 200)

  const archive = await createZipFixture([
    { name: 'Artist/Album/zip-track.mp3', data: taggedAudioFixture() },
    { name: 'notes/readme.txt', data: Buffer.from('ignored') },
  ])
  const archiveResponse = await fetch(`${serverUrl}/api/admin/tracks?filename=collection.zip`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/zip' }, body: archive,
  })
  assert.equal(archiveResponse.status, 201)
  const archiveResult = await archiveResponse.json()
  assert.equal(archiveResult.extracted, 1)
  assert.deepEqual(archiveResult.files, [path.join('Artist', 'Album', 'zip-track.mp3')])
  const importedTracks = await requestJson('/api/tracks', { cookie: adminCookie })
  const importedTrack = importedTracks.data.tracks.find((track) => track.id === Buffer.from(path.posix.join('Artist', 'Album', 'zip-track.mp3')).toString('base64url'))
  assert.ok(importedTrack)
  assert.equal(importedTrack.title, 'Fixture title')
  await assert.rejects(readFile(path.join(temporaryDirectory, 'music', 'notes', 'readme.txt')))
  assert.equal((await requestJson(`/api/admin/tracks/${importedTrack.id}`, { method: 'DELETE', cookie: adminCookie })).response.status, 200)

  const maliciousArchive = await createZipFixture([
    { name: 'safe/partial.mp3', data: taggedAudioFixture() },
    { name: 'ab/test.mp3', data: Buffer.from('escape') },
  ])
  const originalEntryName = Buffer.from('ab/test.mp3')
  const traversalEntryName = Buffer.from('../aest.mp3')
  assert.equal(originalEntryName.length, traversalEntryName.length)
  let entryOffset = 0
  while ((entryOffset = maliciousArchive.indexOf(originalEntryName, entryOffset)) !== -1) {
    traversalEntryName.copy(maliciousArchive, entryOffset)
    entryOffset += traversalEntryName.length
  }
  const maliciousResponse = await fetch(`${serverUrl}/api/admin/tracks?filename=malicious.zip`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/zip' }, body: maliciousArchive,
  })
  assert.equal(maliciousResponse.status, 400)
  await assert.rejects(readFile(path.join(temporaryDirectory, 'music', 'safe', 'partial.mp3')))

  const promote = await requestJson(`/api/admin/users/${userId}`, {
    method: 'PATCH', body: { role: 'admin' }, cookie: adminCookie,
  })
  assert.equal(promote.data.user.role, 'admin')
  const demote = await requestJson(`/api/admin/users/${userId}`, {
    method: 'PATCH', body: { role: 'user' }, cookie: adminCookie,
  })
  assert.equal(demote.data.user.role, 'user')

  const registrationSetting = await requestJson('/api/admin/settings', {
    method: 'PATCH', body: { registrationOpen: false }, cookie: adminCookie,
  })
  assert.equal(registrationSetting.data.registrationOpen, false)
  const blockedRegistration = await requestJson('/api/auth/register', {
    method: 'POST', body: { name: 'New user', email: 'new@example.test', password: 'strong-test-password-3' },
  })
  assert.equal(blockedRegistration.response.status, 403)

  const lastAdminChange = await requestJson(`/api/admin/users/${adminResult.data.user.id}`, {
    method: 'PATCH', body: { role: 'user' }, cookie: adminCookie,
  })
  assert.equal(lastAdminChange.response.status, 400)

  const deactivate = await requestJson(`/api/admin/users/${userId}`, {
    method: 'PATCH', body: { active: false }, cookie: adminCookie,
  })
  assert.equal(deactivate.data.user.active, false)
  assert.equal((await requestJson('/api/auth/me', { cookie: userCookie })).response.status, 401)

  const logout = await requestJson('/api/auth/logout', { method: 'POST', cookie: adminCookie })
  assert.equal(logout.response.status, 200)
  assert.equal((await requestJson('/api/auth/me', { cookie: adminCookie })).response.status, 401)

  const savedStore = await readFile(path.join(temporaryDirectory, 'data', 'store.json'), 'utf8')
  assert.equal(savedStore.includes('strong-test-password-1'), false)
  assert.equal(savedStore.includes(bootstrapToken), false)
})