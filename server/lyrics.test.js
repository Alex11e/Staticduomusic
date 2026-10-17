import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLrc } from './lyrics.js'

test('parses LRC timestamps, duplicate line timings, and millisecond offsets', () => {
  const lyrics = parseLrc('[ar:Artist]\n[offset:250]\n[00:03.40][00:01.20]First line\n[00:05:123]Second line')
  assert.deepEqual(lyrics, [
    { time: 1.45, text: 'First line' },
    { time: 3.65, text: 'First line' },
    { time: 5.373, text: 'Second line' },
  ])
})

test('ignores metadata-only, empty, malformed, and oversized LRC input', () => {
  assert.deepEqual(parseLrc('[ti:Title]\n[00:99.00]bad\n[00:01.00]'), [])
  assert.deepEqual(parseLrc('x'.repeat(512 * 1024 + 1)), [])
})