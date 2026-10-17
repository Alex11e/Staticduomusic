import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedDownloadUrl, isAllowedLicense, requireMp3File, resolveMusicDownload, searchJamendo } from './music-sources.js'

test('only Creative Commons licenses allowing redistribution and public domain are accepted', () => {
  assert.equal(isAllowedLicense('https://creativecommons.org/licenses/by/4.0/'), true)
  assert.equal(isAllowedLicense('https://creativecommons.org/licenses/by-nc-sa/4.0/'), true)
  assert.equal(isAllowedLicense('https://creativecommons.org/licenses/by-nd/4.0/'), false)
  assert.equal(isAllowedLicense('https://attacker.test/creativecommons.org/licenses/by/4.0/'), false)
  assert.equal(isAllowedLicense(''), false)
})

test('download URLs must use HTTPS on an approved catalog host', () => {
  assert.equal(isAllowedDownloadUrl('https://archive.org/download/item/song.mp3'), true)
  assert.equal(isAllowedDownloadUrl('https://prod-1.storage.jamendo.com/song.mp3'), true)
  assert.equal(isAllowedDownloadUrl('http://archive.org/song.mp3'), false)
  assert.equal(isAllowedDownloadUrl('https://archive.org.attacker.test/song.mp3'), false)
  assert.equal(isAllowedDownloadUrl('https://127.0.0.1/song.mp3'), false)
})

test('Jamendo results require explicit download permission and an allowed license', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    headers: { status: 'success' },
    results: [
      { id: 1, name: 'Allowed', artist_name: 'Artist', audiodownload_allowed: true, license_ccurl: 'https://creativecommons.org/licenses/by/4.0/', audiodownload: 'https://prod-1.storage.jamendo.com/download/track/1/mp32/' },
      { id: 2, name: 'No download', audiodownload_allowed: false, license_ccurl: 'https://creativecommons.org/licenses/by/4.0/', audiodownload: 'https://prod-1.storage.jamendo.com/song.mp3' },
      { id: 3, name: 'No derivatives', audiodownload_allowed: true, license_ccurl: 'https://creativecommons.org/licenses/by-nd/4.0/', audiodownload: 'https://prod-1.storage.jamendo.com/song.mp3' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const results = await searchJamendo('Allowed', 'test-client', fetchImpl)
  assert.deepEqual(results.map((track) => track.id), ['1'])
})

test('direct imports reject unsupported hosts and non-MP3 files', async () => {
  await assert.rejects(resolveMusicDownload({ source: 'direct', url: 'https://example.com/song.mp3' }), /támogatott MP3-forrás/)
  const jamendoDownload = await resolveMusicDownload({
    source: 'direct', url: 'https://prod-1.storage.jamendo.com/download/track/1/mp32/', title: 'Allowed', artist: 'Artist',
  })
  assert.equal(jamendoDownload.title, 'Allowed')
  assert.throws(() => requireMp3File('../song.mp3'), /Csak MP3-fájl/)
  assert.throws(() => requireMp3File('song.flac'), /Csak MP3-fájl/)
})