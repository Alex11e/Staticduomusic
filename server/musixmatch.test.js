import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchSyncedLyrics } from './musixmatch.js'

function jsonResponse(message) {
  return new Response(JSON.stringify({ message }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('fetches LRC only for a matching, unrestricted track and returns attribution tracking', async () => {
  const calls = []
  const fetchImpl = async (input) => {
    const url = new URL(input)
    calls.push(url)
    if (url.pathname.endsWith('track.search')) {
      return jsonResponse({ header: { status_code: 200 }, body: { track_list: [
        { track: { track_name: 'Example Song', artist_name: 'Other Artist', commontrack_id: 1, has_subtitles: 1, restricted: 0 } },
        { track: { track_name: 'Example Song', artist_name: 'Example Artist', commontrack_id: 2, has_subtitles: 1, restricted: 1 } },
        { track: { track_name: 'Example Song', artist_name: 'Example Artist', commontrack_id: 3, has_subtitles: 1, restricted: 0 } },
      ] } })
    }
    return jsonResponse({ header: { status_code: 200 }, body: { subtitle: {
      subtitle_body: '[00:01.25]Line one\n[00:02.50]Line two',
      lyrics_copyright: 'Lyrics powered by Musixmatch',
      pixel_tracking_url: 'https://tracking.musixmatch.com/view?id=3',
    } } })
  }
  const result = await fetchSyncedLyrics({ title: 'Example Song', artist: 'Example Artist' }, 'server-secret', fetchImpl)
  assert.equal(new URL(calls[0]).searchParams.get('f_has_subtitle'), '1')
  assert.equal(new URL(calls[1]).searchParams.get('commontrack_id'), '3')
  assert.deepEqual(result.lines, [{ time: 1.25, text: 'Line one' }, { time: 2.5, text: 'Line two' }])
  assert.equal(result.attribution, 'Lyrics powered by Musixmatch')
  assert.equal(result.trackingUrl, 'https://tracking.musixmatch.com/view?id=3')
})

test('requires an API key and rejects a non-matching track', async () => {
  await assert.rejects(fetchSyncedLyrics({ title: 'Song', artist: 'Artist' }, ''), /MUSIXMATCH_API_KEY/)
  await assert.rejects(fetchSyncedLyrics({ title: 'Song', artist: 'Artist' }, 'key', async () => jsonResponse({
    header: { status_code: 200 }, body: { track_list: [] },
  })), /nem található engedélyezett/)
})