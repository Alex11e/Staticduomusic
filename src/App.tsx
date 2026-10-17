import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import {
  ArrowDown, ArrowUp, AudioLines, Captions, Check, Clock3, Disc3, Heart, ListMusic,
  ListPlus, LoaderCircle, LogOut, Music2, Pause, Pencil, Play, Plus, Radio,
  RefreshCw, Repeat, Search, ShieldCheck, Shuffle, SkipBack, SkipForward,
  Trash2, Volume2, VolumeX, X,
} from 'lucide-react'
import AdminPanel from './AdminPanel'
import AuthScreen from './AuthScreen'
import ProfileSwitcher from './ProfileSwitcher'
import type { AuthStatus, SessionUser } from './AuthScreen'

type Track = {
  id: string
  title: string
  artist: string
  album: string
  duration: number | null
  year?: number | null
  genre?: string
  coverUrl?: string | null
  size: number
  url: string
}

type LibraryResponse = { tracks: Track[] }
type Playlist = { id: string; name: string; trackIds: string[] }
type View = 'all' | 'favorites' | 'recent' | 'queue' | 'artists' | 'albums' | 'discover' | 'artist' | 'album' | 'admin' | `playlist:${string}`
type RepeatMode = 'off' | 'all' | 'one'
type SortBy = 'custom' | 'title' | 'artist' | 'album'
type PlaybackState = { trackId: string; position: number; playing: boolean; shuffle: boolean; repeat: RepeatMode }
type UserState = { favorites: string[]; playlists: Playlist[]; recent: string[]; queue: string[]; volume: number; playback?: PlaybackState }
type LyricLine = { time: number; text: string }

function readSaved<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) as T : fallback
  } catch {
    return fallback
  }
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function formatSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

export default function App() {
  const audio = useRef<HTMLAudioElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const lyricLineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const pendingSeek = useRef(0)
  const saveTimeout = useRef(0)
  const profileSwitching = useRef(false)
  const stateSnapshot = useRef<UserState | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ setupRequired: false, registrationOpen: true })
  const [authReady, setAuthReady] = useState(false)
  const [loadedUserId, setLoadedUserId] = useState('')
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('all')
  const [favorites, setFavorites] = useState<string[]>(() => readSaved('hangtar-favorites', []))
  const [playlists, setPlaylists] = useState<Playlist[]>(() => readSaved('hangtar-playlists', []))
  const [recent, setRecent] = useState<string[]>(() => readSaved('hangtar-recent', []))
  const [queue, setQueue] = useState<string[]>([])
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => readSaved('hangtar-volume', 0.8))
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [editingPlaylistId, setEditingPlaylistId] = useState('')
  const [editingPlaylistName, setEditingPlaylistName] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('custom')
  const [selectedArtist, setSelectedArtist] = useState('')
  const [selectedAlbum, setSelectedAlbum] = useState('')

  const activeLyricIndex = lyrics.reduce((active, line, index) => line.time <= time ? index : active, -1)

  stateSnapshot.current = {
    favorites, playlists, recent, queue, volume,
    playback: { trackId: current?.id || '', position: time, playing, shuffle, repeat },
  }

  async function persistProfileState() {
    const state = stateSnapshot.current
    if (!state) return
    const response = await fetch('/api/me/state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
    })
    if (!response.ok) throw new Error('Nem sikerült menteni a profil lejátszási állapotát.')
  }

  async function loadLibrary() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/tracks')
      if (response.status === 401) { setUser(null); return }
      if (!response.ok) throw new Error('A zeneszerver nem válaszol.')
      const data = await response.json() as LibraryResponse
      setTracks(data.tracks)
    } catch {
      setError('Nem sikerült elérni a zeneszervert. Ellenőrizd a kapcsolatot, majd próbáld újra.')
    } finally {
      setLoading(false)
    }
  }

  async function loadAccount(account: SessionUser) {
    setLoading(true)
    const [libraryResponse, stateResponse] = await Promise.all([fetch('/api/tracks'), fetch('/api/me/state')])
    if (libraryResponse.status === 401 || stateResponse.status === 401) throw new Error('A munkamenet lejárt. Jelentkezz be újra.')
    if (!libraryResponse.ok || !stateResponse.ok) throw new Error('Nem sikerült betölteni a fiók adatait.')
    const [library, saved] = await Promise.all([libraryResponse.json(), stateResponse.json()]) as [LibraryResponse, UserState]
    setTracks(library.tracks)
    setFavorites(saved.favorites || [])
    setPlaylists(saved.playlists || [])
    setRecent(saved.recent || [])
    setQueue(saved.queue || [])
    setVolume(Number.isFinite(saved.volume) ? saved.volume : 0.8)
    const playback = saved.playback
    const resumedTrack = playback?.trackId ? library.tracks.find((track) => track.id === playback.trackId) || null : null
    pendingSeek.current = resumedTrack ? Math.max(0, playback?.position || 0) : 0
    setCurrent(resumedTrack)
    setTime(pendingSeek.current)
    setDuration(0)
    setPlaying(Boolean(resumedTrack && playback?.playing))
    setShuffle(playback?.shuffle === true)
    setRepeat(playback?.repeat === 'all' || playback?.repeat === 'one' ? playback.repeat : 'off')
    setLoadedUserId(account.id)
    setUser(account)
    profileSwitching.current = false
    setError('')
    setLoading(false)
  }

  async function initializeAuth() {
    try {
      const statusResponse = await fetch('/api/auth/status')
      if (!statusResponse.ok) throw new Error('A hitelesítési szerver nem válaszol.')
      setAuthStatus(await statusResponse.json() as AuthStatus)
      const response = await fetch('/api/auth/me')
      if (response.ok) {
        const data = await response.json() as { user: SessionUser }
        await loadAccount(data.user)
      } else {
        setLoading(false)
      }
    } catch {
      setError('Nem sikerült kapcsolódni a szerverhez.')
      setLoading(false)
    } finally {
      setAuthReady(true)
    }
  }

  async function signIn(account: SessionUser) {
    await loadAccount(account)
    setView('all')
  }

  async function switchProfile(account: SessionUser) {
    await loadAccount(account)
    setView('all')
  }

  async function prepareProfileSwitch() {
    if (!user || loadedUserId !== user.id) return false
    if (saveTimeout.current) {
      window.clearTimeout(saveTimeout.current)
      saveTimeout.current = 0
    }
    try {
      await persistProfileState()
      profileSwitching.current = true
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nem sikerült menteni a profil lejátszási állapotát.')
      return false
    }
  }

  function cancelProfileSwitch() {
    profileSwitching.current = false
  }

  async function signOut() {
    await persistProfileState().catch(() => {})
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
    setLoadedUserId('')
    setTracks([])
    setCurrent(null)
    setPlaying(false)
    setAuthStatus((status) => ({ ...status, setupRequired: false }))
  }

  useEffect(() => { void initializeAuth() }, [])
  useEffect(() => {
    if (!user || loadedUserId !== user.id || profileSwitching.current) return
    const timeout = window.setTimeout(() => {
      saveTimeout.current = 0
      if (!profileSwitching.current) void persistProfileState().catch(() => setError('Nem sikerült szinkronizálni a fiók adatait.'))
    }, 250)
    saveTimeout.current = timeout
    return () => {
      window.clearTimeout(timeout)
      if (saveTimeout.current === timeout) saveTimeout.current = 0
    }
  }, [current, favorites, loadedUserId, playing, queue, recent, repeat, shuffle, user, volume])
  useEffect(() => {
    if (!user || loadedUserId !== user.id) return
    const interval = window.setInterval(() => {
      if (!profileSwitching.current) void persistProfileState().catch(() => setError('Nem sikerült menteni a lejátszás pozícióját.'))
    }, 5000)
    return () => window.clearInterval(interval)
  }, [loadedUserId, user])
  useEffect(() => {
    if (!user || loadedUserId !== user.id) return
    let active = true
    async function syncSharedPlaylists() {
      try {
        const response = await fetch('/api/me/playlists')
        if (!response.ok) return
        const data = await response.json() as { playlists: Playlist[] }
        if (active) setPlaylists((current) => JSON.stringify(current) === JSON.stringify(data.playlists) ? current : data.playlists)
      } catch {
        // The next poll retries if a device is temporarily offline.
      }
    }
    function handleVisibility() {
      if (!document.hidden) void syncSharedPlaylists()
    }
    void syncSharedPlaylists()
    const interval = window.setInterval(() => void syncSharedPlaylists(), 5000)
    window.addEventListener('focus', handleVisibility)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', handleVisibility)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [loadedUserId, user])
  useEffect(() => {
    if (!audio.current) return
    audio.current.volume = volume
    if (playing) void audio.current.play().catch(() => setPlaying(false))
    else audio.current.pause()
  }, [current, playing, volume])
  useEffect(() => {
    if (!lyricsOpen || !current) {
      setLyrics([])
      setLyricsError('')
      return
    }
    let active = true
    setLyricsLoading(true)
    setLyricsError('')
    void fetch(`/api/lyrics/${encodeURIComponent(current.id)}`)
      .then(async (response) => {
        const result = await response.json() as { lines?: LyricLine[]; error?: string }
        if (!response.ok) throw new Error(result.error || 'A dalszöveg nem érhető el.')
        if (active) setLyrics(result.lines || [])
      })
      .catch((cause) => {
        if (active) setLyricsError(cause instanceof Error ? cause.message : 'A dalszöveg nem érhető el.')
      })
      .finally(() => { if (active) setLyricsLoading(false) })
    return () => { active = false }
  }, [current?.id, lyricsOpen])
  useEffect(() => {
    if (lyricsOpen && activeLyricIndex >= 0) {
      lyricLineRefs.current[activeLyricIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [activeLyricIndex, lyricsOpen])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchInput.current?.focus()
      } else if (event.code === 'Space' && !typing) {
        event.preventDefault()
        if (current) setPlaying((isPlaying) => !isPlaying)
        else if (tracks[0]) playTrack(tracks[0])
      } else if (event.key.toLowerCase() === 'n' && !typing) {
        playRelative(1)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  const recommendedTracks = useMemo(() => {
    const listeningIds = new Set([...favorites, ...recent.slice(0, 12)])
    const preferredArtists = new Set(tracks.filter((track) => listeningIds.has(track.id)).map((track) => track.artist))
    const playedRecently = new Set(recent.slice(0, 8))
    const recommendations = tracks.filter((track) => preferredArtists.has(track.artist) && !playedRecently.has(track.id) && !favorites.includes(track.id))
    return recommendations.length ? recommendations : tracks.filter((track) => !favorites.includes(track.id))
  }, [favorites, recent, tracks])

  const artistCollections = useMemo(() => {
    const groups = new Map<string, Track[]>()
    for (const track of tracks) {
      const group = groups.get(track.artist)
      if (group) group.push(track)
      else groups.set(track.artist, [track])
    }
    return Array.from(groups, ([name, entries]) => ({ name, count: entries.length, coverUrl: entries.find((track) => track.coverUrl)?.coverUrl || null }))
      .sort((left, right) => left.name.localeCompare(right.name, 'hu'))
  }, [tracks])

  const albumCollections = useMemo(() => {
    const groups = new Map<string, Track[]>()
    for (const track of tracks) {
      const key = `${track.artist}\u0000${track.album}`
      const group = groups.get(key)
      if (group) group.push(track)
      else groups.set(key, [track])
    }
    return Array.from(groups, ([key, entries]) => ({
      key,
      name: entries[0].album,
      artist: entries[0].artist,
      year: entries.find((track) => track.year)?.year || null,
      count: entries.length,
      coverUrl: entries.find((track) => track.coverUrl)?.coverUrl || null,
    })).sort((left, right) => left.name.localeCompare(right.name, 'hu'))
  }, [tracks])

  const matchingArtists = useMemo(() => artistCollections.filter((artist) =>
    !query || artist.name.toLocaleLowerCase('hu').includes(query.toLocaleLowerCase('hu'))), [artistCollections, query])
  const matchingAlbums = useMemo(() => albumCollections.filter((album) =>
    !query || `${album.name} ${album.artist}`.toLocaleLowerCase('hu').includes(query.toLocaleLowerCase('hu'))), [albumCollections, query])

  const visibleTracks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('hu')
    const activePlaylist = view.startsWith('playlist:')
      ? playlists.find((playlist) => `playlist:${playlist.id}` === view)
      : undefined
    const source = view === 'favorites' ? tracks.filter((track) => favorites.includes(track.id))
      : view === 'recent' ? recent.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => !!track)
        : view === 'queue' ? queue.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => !!track)
          : view === 'discover' ? recommendedTracks
            : view === 'artist' ? tracks.filter((track) => track.artist === selectedArtist)
              : view === 'album' ? tracks.filter((track) => track.artist === selectedArtist && track.album === selectedAlbum)
                : activePlaylist ? activePlaylist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => !!track)
                  : tracks
    const filtered = source.filter((track) => !normalizedQuery ||
      `${track.title} ${track.artist} ${track.album} ${track.genre || ''}`.toLocaleLowerCase('hu').includes(normalizedQuery))
    if (sortBy === 'custom' || view === 'recent' || view === 'queue' || activePlaylist) return filtered
    return [...filtered].sort((left, right) => left[sortBy].localeCompare(right[sortBy], 'hu'))
  }, [favorites, playlists, query, queue, recent, recommendedTracks, selectedAlbum, selectedArtist, sortBy, tracks, view])

  const activePlaylist = view.startsWith('playlist:')
    ? playlists.find((playlist) => `playlist:${playlist.id}` === view)
    : undefined
  const viewTitle = view === 'admin' ? 'ADMINISZTRÁCIÓ' : view === 'artists' ? 'ELŐADÓK' : view === 'albums' ? 'ALBUMOK' : view === 'discover' ? 'FELFEDEZÉS' : view === 'queue' ? 'LEJÁTSZÁSI SOR' : view === 'artist' ? selectedArtist : view === 'album' ? selectedAlbum : activePlaylist?.name || (view === 'favorites' ? 'KEDVENCEK' : view === 'recent' ? 'LEGUTÓBBI' : 'ÖSSZES ZENE')

  function playTrack(track: Track) {
    if (current?.id === track.id) setPlaying(!playing)
    else {
      setCurrent(track)
      setPlaying(true)
      setTime(0)
      setQueue((saved) => saved.filter((id) => id !== track.id))
      setRecent((saved) => [track.id, ...saved.filter((id) => id !== track.id)].slice(0, 40))
    }
  }

  function playRelative(offset: number, automatic = false) {
    if (offset > 0) {
      const queuedTrack = queue.map((id) => tracks.find((track) => track.id === id)).find((track): track is Track => !!track)
      if (queuedTrack) {
        setQueue((saved) => saved.filter((id) => id !== queuedTrack.id))
        setCurrent(queuedTrack)
        setPlaying(true)
        setTime(0)
        setRecent((saved) => [queuedTrack.id, ...saved.filter((id) => id !== queuedTrack.id)].slice(0, 40))
        return
      }
    }
    const playOrder = visibleTracks.length ? visibleTracks : tracks
    if (!playOrder.length) return
    const index = current ? playOrder.findIndex((track) => track.id === current.id) : -1
    if (automatic && repeat === 'off' && index === playOrder.length - 1) {
      setPlaying(false)
      return
    }
    let nextIndex = index + offset
    if (shuffle && offset > 0 && playOrder.length > 1) {
      nextIndex = Math.floor(Math.random() * (playOrder.length - 1))
      if (nextIndex >= index) nextIndex += 1
    } else if (nextIndex < 0 || nextIndex >= playOrder.length) {
      nextIndex = (nextIndex + playOrder.length) % playOrder.length
    }
    const nextTrack = playOrder[nextIndex]
    if (!nextTrack) return
    setCurrent(nextTrack)
    setPlaying(true)
    setTime(0)
    setRecent((saved) => [nextTrack.id, ...saved.filter((id) => id !== nextTrack.id)].slice(0, 40))
  }

  function addToQueue(track: Track) {
    if (track.id !== current?.id) setQueue((saved) => saved.includes(track.id) ? saved : [...saved, track.id])
  }

  function removeFromQueue(track: Track) {
    setQueue((saved) => saved.filter((id) => id !== track.id))
  }

  function moveQueuedTrack(track: Track, offset: number) {
    setQueue((saved) => {
      const from = saved.indexOf(track.id)
      const to = from + offset
      if (from < 0 || to < 0 || to >= saved.length) return saved
      const reordered = [...saved]
      ;[reordered[from], reordered[to]] = [reordered[to], reordered[from]]
      return reordered
    })
  }

  function toggleFavorite(track: Track) {
    setFavorites((saved) => saved.includes(track.id)
      ? saved.filter((id) => id !== track.id)
      : [...saved, track.id])
  }

  function seek(event: ChangeEvent<HTMLInputElement>) {
    const nextTime = Number(event.target.value)
    if (audio.current) audio.current.currentTime = nextTime
    setTime(nextTime)
  }

  function handleLoadedMetadata(event: React.SyntheticEvent<HTMLAudioElement>) {
    const loadedDuration = event.currentTarget.duration
    setDuration(loadedDuration)
    if (pendingSeek.current > 0) {
      const position = Math.min(pendingSeek.current, Number.isFinite(loadedDuration) ? loadedDuration : pendingSeek.current)
      event.currentTarget.currentTime = position
      setTime(position)
      pendingSeek.current = 0
    }
  }

  async function updateSharedPlaylists(route: string, method: string, body?: unknown) {
    setActionError('')
    try {
      const response = await fetch(route, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const result = await response.json() as { playlists?: Playlist[]; error?: string }
      if (!response.ok || !result.playlists) throw new Error(result.error || 'A lejátszási lista módosítása nem sikerült.')
      setPlaylists(result.playlists)
      return result.playlists
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Nem sikerült kapcsolódni a szerverhez.')
      return null
    }
  }

  async function createPlaylist(event: ChangeEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = playlistName.trim()
    if (!name) return
    const updated = await updateSharedPlaylists('/api/me/playlists', 'POST', { name })
    const playlist = updated?.at(-1)
    if (!playlist) return
    setView(`playlist:${playlist.id}`)
    setPlaylistName('')
    setCreatingPlaylist(false)
  }

  async function addToPlaylist(playlistId: string, track: Track) {
    const playlist = playlists.find((entry) => entry.id === playlistId)
    if (!playlist || playlist.trackIds.includes(track.id)) return
    await updateSharedPlaylists(`/api/me/playlists/${encodeURIComponent(playlistId)}/tracks`, 'POST', { trackId: track.id })
  }

  async function savePlaylistRename(event: ChangeEvent<HTMLFormElement>, playlistId: string) {
    event.preventDefault()
    const name = editingPlaylistName.trim()
    if (!name) return
    if (!await updateSharedPlaylists(`/api/me/playlists/${encodeURIComponent(playlistId)}`, 'PATCH', { name })) return
    setEditingPlaylistId('')
    setEditingPlaylistName('')
  }

  async function removeFromPlaylist(track: Track) {
    if (!activePlaylist) return
    await updateSharedPlaylists(`/api/me/playlists/${encodeURIComponent(activePlaylist.id)}/tracks/${encodeURIComponent(track.id)}`, 'DELETE')
  }

  async function deletePlaylist(playlist: Playlist) {
    if (!await updateSharedPlaylists(`/api/me/playlists/${encodeURIComponent(playlist.id)}`, 'DELETE')) return
    if (view === `playlist:${playlist.id}`) setView('all')
  }

  function handleEnded() {
    if (repeat === 'one' && audio.current) {
      audio.current.currentTime = 0
      void audio.current.play()
      return
    }
    playRelative(1, true)
  }

  const headingTitle = activePlaylist?.name || (view === 'favorites' ? 'A te kedvenceid' : view === 'recent' ? 'Nemrég hallgatva' : view === 'queue' ? 'Lejátszási sor' : view === 'artists' ? 'Előadók' : view === 'albums' ? 'Albumok' : view === 'discover' ? 'Felfedezés' : view === 'artist' ? selectedArtist : view === 'album' ? selectedAlbum : 'Saját hangzás')
  const headingSubtitle = activePlaylist ? `${activePlaylist.trackIds.length} zeneszám a listában.` : view === 'favorites' ? 'A dalok, amik újra és újra hazatalálnak.' : view === 'recent' ? 'A legutóbb lejátszott dalaid.' : view === 'queue' ? `${queue.length} zeneszám várakozik.` : view === 'artists' ? `${artistCollections.length} előadó a könyvtáradban.` : view === 'albums' ? `${albumCollections.length} album a gyűjteményedben.` : view === 'discover' ? 'Válogatás a hallgatási szokásaid alapján.' : view === 'artist' ? `${visibleTracks.length} zeneszám ettől az előadótól.` : view === 'album' ? `${visibleTracks.length} zeneszám ezen az albumon.` : 'A gyűjteményed, bárhol is vagy.'
  const sectionTitle = query ? 'Találatok' : activePlaylist?.name || (view === 'favorites' ? 'Kedvenc zenék' : view === 'recent' ? 'Legutóbb játszott' : view === 'queue' ? 'Következik' : view === 'discover' ? 'Neked válogattuk' : view === 'artist' || view === 'album' ? 'Zeneszámok' : 'A gyűjteményed')

  if (!authReady) return <main className="auth-loading"><LoaderCircle className="spin" size={24} /><span>Kapcsolódás a saját szerverhez...</span></main>
  if (!user) return <AuthScreen status={authStatus} onSignedIn={signIn} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="HANGTÁR kezdőlap">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.4} /></span>
          <span>hangtár<span className="brand-period">.</span></span>
        </a>

        <div className="nav-label">A TE ZENÉID</div>
        <nav className="side-nav" aria-label="Könyvtár">
          <button className={view === 'all' ? 'nav-item active' : 'nav-item'} onClick={() => setView('all')}>
            <Disc3 size={18} /> <span>Teljes könyvtár</span>
          </button>
          <button className={view === 'favorites' ? 'nav-item active' : 'nav-item'} onClick={() => setView('favorites')}>
            <Heart size={18} /> <span>Kedvencek</span>
            <span className="nav-count">{favorites.length}</span>
          </button>
          <button className={view === 'recent' ? 'nav-item active' : 'nav-item'} onClick={() => setView('recent')}>
            <Clock3 size={18} /> <span>Legutóbb játszott</span>
          </button>
          <button className={view === 'queue' ? 'nav-item active' : 'nav-item'} onClick={() => setView('queue')}><ListMusic size={18} /><span>Lejátszási sor</span><span className="nav-count">{queue.length}</span></button>
          <button className={view === 'discover' ? 'nav-item active' : 'nav-item'} onClick={() => setView('discover')}><AudioLines size={18} /><span>Felfedezés</span></button>
          <button className={view === 'albums' ? 'nav-item active' : 'nav-item'} onClick={() => setView('albums')}><Disc3 size={18} /><span>Albumok</span></button>
          <button className={view === 'artists' ? 'nav-item active' : 'nav-item'} onClick={() => setView('artists')}><Radio size={18} /><span>Előadók</span></button>
          {user.role === 'admin' ? <button className={view === 'admin' ? 'nav-item active' : 'nav-item'} onClick={() => setView('admin')}><ShieldCheck size={18} /><span>Adminisztráció</span></button> : null}
        </nav>

        <div className="playlist-heading"><span className="nav-label">LEJÁTSZÁSI LISTÁK</span><button className="add-playlist" aria-label="Új lejátszási lista" title="Új lejátszási lista" onClick={() => setCreatingPlaylist(!creatingPlaylist)}><Plus size={16} /></button></div>
        {creatingPlaylist ? <form className="playlist-form" onSubmit={createPlaylist}><input autoFocus aria-label="Lista neve" placeholder="Lista neve" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} /><button aria-label="Létrehozás" type="submit"><Plus size={15} /></button></form> : null}
        <nav className="playlist-nav" aria-label="Lejátszási listák">
          {playlists.map((playlist) => <div className="playlist-link-row" key={playlist.id}>
            {editingPlaylistId === playlist.id ? <form className="playlist-rename-form" onSubmit={(event) => savePlaylistRename(event, playlist.id)}>
              <input autoFocus aria-label={`${playlist.name} új neve`} value={editingPlaylistName} onChange={(event) => setEditingPlaylistName(event.target.value)} maxLength={80} />
              <button type="submit" aria-label="Név mentése" title="Mentés"><Check size={14} /></button>
              <button type="button" aria-label="Átnevezés megszakítása" title="Mégse" onClick={() => setEditingPlaylistId('')}><X size={14} /></button>
            </form> : <>
              <button className={view === `playlist:${playlist.id}` ? 'nav-item active' : 'nav-item'} onClick={() => setView(`playlist:${playlist.id}`)}><ListMusic size={17} /><span>{playlist.name}</span></button>
              <button className="rename-playlist" aria-label={`${playlist.name} átnevezése`} title="Lista átnevezése" onClick={() => { setEditingPlaylistId(playlist.id); setEditingPlaylistName(playlist.name) }}><Pencil size={13} /></button>
              <button className="delete-playlist" aria-label={`${playlist.name} törlése`} title="Lista törlése" onClick={() => deletePlaylist(playlist)}><Trash2 size={14} /></button>
            </>}
          </div>)}
        </nav>

        <div className="sidebar-rule" />
        <div className="server-note">
          <span className="server-light" />
          <div><strong>Saját szerver</strong><small>{loading ? 'Kapcsolódás...' : error ? 'Nem elérhető' : 'Csatlakoztatva'}</small></div>
          <Radio className="server-icon" size={17} />
        </div>
        <div className="sidebar-footer">A zenéid. A te szabályaid.</div>
      </aside>

      <main className="main-content" id="home">
        <header className="topbar">
          <div className="breadcrumb"><span>KÖNYVTÁR</span><span className="crumb-slash">/</span>{viewTitle.toLocaleUpperCase('hu')}</div>
          <label className="search-box">
            <Search size={17} />
            <input ref={searchInput} aria-label="Keresés a zenék között" placeholder="Keresés előadó, dal..." value={query} onChange={(event) => setQuery(event.target.value)} />
            <kbd>/</kbd>
          </label>
          <button className="icon-button refresh-button" aria-label="Könyvtár frissítése" title="Könyvtár frissítése" onClick={() => void loadLibrary()} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={17} />}
          </button>
          <div className="account-actions"><div><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Adminisztrátor' : 'Fiók'}</small></div><ProfileSwitcher user={user} onBeforeProfileChange={prepareProfileSwitch} onProfileChangeCanceled={cancelProfileSwitch} onProfileChanged={switchProfile} /><button className="icon-button" aria-label="Kijelentkezés" title="Kijelentkezés" onClick={() => void signOut()}><LogOut size={17} /></button></div>
        </header>

        {actionError ? <div className="action-error" role="alert">{actionError}</div> : null}
        {view === 'admin' ? <AdminPanel onLibraryChanged={loadLibrary} /> : <div className="content-wrap">
          <section className="library-heading">
            <div className="eyebrow"><span className="eyebrow-line" /> PRIVÁT ZENEKÖNYVTÁR</div>
            <div className="heading-row">
              <div>
                <h1>{headingTitle}<span>.</span></h1>
                <p className="subheading">{headingSubtitle}</p>
              </div>
              <div className="library-stat"><strong>{visibleTracks.length}</strong><span>ZENESZÁM</span></div>
            </div>
          </section>

          {view === 'artists' ? <section className="collection-grid" aria-label="Előadók">
            {matchingArtists.length ? matchingArtists.map((artist) => <button className="collection-card" key={artist.name} onClick={() => { setSelectedArtist(artist.name); setView('artist') }}>
              <span className="collection-art artist-art">{artist.coverUrl ? <img src={artist.coverUrl} alt="" loading="lazy" /> : <Radio size={25} />}</span>
              <strong>{artist.name}</strong><small>{artist.count} zeneszám</small>
            </button>) : <div className="empty-state"><strong>{query ? 'Nincs ilyen előadó.' : 'Még nincs előadó a könyvtárban.'}</strong><p>{query ? 'Próbálj másik keresést.' : 'A zenefájlok metaadataiból vagy mappaneveiből épül fel ez a lista.'}</p></div>}
          </section> : view === 'albums' ? <section className="collection-grid" aria-label="Albumok">
            {matchingAlbums.length ? matchingAlbums.map((album) => <button className="collection-card" key={album.key} onClick={() => { setSelectedArtist(album.artist); setSelectedAlbum(album.name); setView('album') }}>
              <span className="collection-art">{album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <Disc3 size={25} />}</span>
              <strong>{album.name}</strong><small>{album.artist}{album.year ? ` · ${album.year}` : ''}</small>
            </button>) : <div className="empty-state"><strong>{query ? 'Nincs ilyen album.' : 'Még nincs album a könyvtárban.'}</strong><p>{query ? 'Próbálj másik keresést.' : 'A zenefájlok metaadataiból vagy mappaneveiből épül fel ez a lista.'}</p></div>}
          </section> : <section className="collection-section">
            <div className="section-heading">
              <div><span className="section-icon"><ListMusic size={16} /></span><h2>{sectionTitle}</h2></div>
              <div className="section-tools"><label className="sort-select"><span>RENDEZÉS</span><select aria-label="Rendezés" value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)}><option value="custom">Alapértelmezett</option><option value="title">Cím szerint</option><option value="artist">Előadó szerint</option><option value="album">Album szerint</option></select></label><span className="track-total">{visibleTracks.length} DAL</span></div>
            </div>

            <div className="track-head" aria-hidden="true"><span>#</span><span>CÍM</span><span>ALBUM</span><span>IDŐ</span><span /><span /><span /></div>
            {loading ? <div className="empty-state"><LoaderCircle className="spin" size={24} /><p>Könyvtár betöltése...</p></div> : null}
            {!loading && error ? <div className="empty-state"><Radio size={27} /><p>{error}</p><button className="text-action" onClick={() => void loadLibrary()}>Újrapróbálás</button></div> : null}
            {!loading && !error && visibleTracks.length === 0 ? (
              <div className="empty-state">
                <div className="empty-disc"><Music2 size={25} /></div>
                <strong>{tracks.length === 0 ? 'Itt még csend van.' : view === 'favorites' ? 'Még nincsenek kedvenceid.' : view === 'recent' ? 'Még nincs lejátszási előzmény.' : view === 'queue' ? 'A lejátszási sor üres.' : activePlaylist ? 'Ez a lista még üres.' : 'Nincs találat.'}</strong>
                <p>{tracks.length === 0 ? 'Tegyél zenefájlokat a szerver könyvtárába, aztán frissítsd a gyűjteményt.' : view === 'favorites' ? 'A szív ikonra koppintva elmentheted a kedvenc dalaidat.' : view === 'queue' ? 'A dalok melletti sor ikonnal tehetsz zenét a következők közé.' : activePlaylist ? 'A dalok melletti lista ikonnal adhatsz hozzá zenét.' : view === 'recent' ? 'Indíts el egy zenét, és itt megtalálod.' : 'Próbálj másik keresőkifejezést.'}</p>
              </div>
            ) : null}

            <div className="track-list">
              {visibleTracks.map((track, index) => {
                const isCurrent = current?.id === track.id
                const isFavorite = favorites.includes(track.id)
                const queueIndex = queue.indexOf(track.id)
                return (
                  <div className={isCurrent ? 'track-row current' : 'track-row'} key={track.id}>
                    <button className="track-number" aria-label={`${track.title} lejátszása`} onClick={() => playTrack(track)}>
                      {isCurrent && playing ? <AudioLines size={17} className="playing-bars" /> : isCurrent ? <Pause size={16} /> : <><span className="row-index">{String(index + 1).padStart(2, '0')}</span><Play size={15} className="row-play" fill="currentColor" /></>}
                    </button>
                    <button className="track-title" onClick={() => playTrack(track)}>
                      <span className="cover-thumb">{track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <Music2 size={17} />}</span>
                      <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                    </button>
                    <span className="track-album">{track.album}<small>{track.year || track.genre || ''}</small></span>
                    <span className="track-size" title={formatSize(track.size)}>{track.duration ? formatTime(track.duration) : '--:--'}</span>
                    <div className="row-actions">
                      {view === 'queue' ? <>
                        <button aria-label="Fel a sorban" title="Fel a sorban" disabled={queueIndex <= 0} onClick={() => moveQueuedTrack(track, -1)}><ArrowUp size={14} /></button>
                        <button aria-label="Le a sorban" title="Le a sorban" disabled={queueIndex < 0 || queueIndex >= queue.length - 1} onClick={() => moveQueuedTrack(track, 1)}><ArrowDown size={14} /></button>
                        <button aria-label="Eltávolítás a lejátszási sorból" title="Eltávolítás a sorból" onClick={() => removeFromQueue(track)}><Trash2 size={15} /></button>
                      </> : activePlaylist ? <button aria-label="Eltávolítás a lejátszási listából" title="Eltávolítás a listából" onClick={() => removeFromPlaylist(track)}><Trash2 size={15} /></button> : <button aria-label="Hozzáadás a lejátszási sorhoz" title="Hozzáadás a sorhoz" onClick={() => addToQueue(track)}><ListMusic size={16} /></button>}
                    </div>
                    <details className="add-to-playlist"><summary aria-label="Hozzáadás lejátszási listához" title="Hozzáadás listához"><ListPlus size={17} /></summary><div className="playlist-menu">{playlists.length ? playlists.map((playlist) => <button key={playlist.id} onClick={() => addToPlaylist(playlist.id, track)}>{playlist.name}{playlist.trackIds.includes(track.id) ? ' ✓' : ''}</button>) : <button onClick={() => { setCreatingPlaylist(true); setView('all') }}>Új lista létrehozása</button>}</div></details>
                    <button className={isFavorite ? 'favorite-button liked' : 'favorite-button'} aria-label={isFavorite ? 'Eltávolítás a kedvencekből' : 'Hozzáadás a kedvencekhez'} title={isFavorite ? 'Eltávolítás a kedvencekből' : 'Kedvencekhez adás'} onClick={() => toggleFavorite(track)}>
                      <Heart size={17} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>}

          <footer className="page-footer"><span>HANGTÁR <span className="footer-dot">·</span> PRIVÁTAN, SAJÁT SZERVEREDRŐL</span><span>MP3 · FLAC · OGG · WAV · M4A</span></footer>
        </div>}
      </main>

      {lyricsOpen ? <aside className="lyrics-panel" aria-label="Szinkronizált dalszöveg">
        <div className="lyrics-panel-head"><div><span>IDŐZÍTETT DALSZÖVEG</span><strong>{current?.title || 'Nincs lejátszott zene'}</strong></div><button className="icon-button" aria-label="Dalszöveg bezárása" onClick={() => setLyricsOpen(false)}><X size={17} /></button></div>
        {lyricsLoading ? <div className="lyrics-message"><LoaderCircle className="spin" size={20} /> Dalszöveg betöltése...</div> : lyricsError ? <div className="lyrics-message">{lyricsError}</div> : <div className="lyrics-lines" aria-live="polite">
          {lyrics.map((line, index) => <p ref={(element) => { lyricLineRefs.current[index] = element }} className={index === activeLyricIndex ? 'lyric-line active' : index > activeLyricIndex ? 'lyric-line upcoming' : 'lyric-line'} key={`${line.time}:${index}`}>{line.text}</p>)}
        </div>}
      </aside> : null}
      <section className="player" aria-label="Zenelejátszó">
        <div className="now-playing">
          <div className={current ? 'player-art has-track' : 'player-art'}>{current?.coverUrl ? <img src={current.coverUrl} alt="" /> : current ? <Music2 size={20} /> : <Disc3 size={21} />}</div>
          <div className="now-copy"><strong>{current?.title || 'Válassz egy zenét'}</strong><small>{current?.artist || 'A lejátszód készen áll'}</small></div>
          {current ? <button className={favorites.includes(current.id) ? 'player-heart liked' : 'player-heart'} aria-label="Kedvencekhez adás" onClick={() => toggleFavorite(current)}><Heart size={17} fill={favorites.includes(current.id) ? 'currentColor' : 'none'} /></button> : null}
        </div>
        <div className="player-controls">
          <div className="control-buttons">
            <button className="control-button" aria-label="Előző zeneszám" onClick={() => playRelative(-1)} disabled={!tracks.length}><SkipBack size={18} fill="currentColor" /></button>
            <button className="play-button" aria-label={playing ? 'Szünet' : 'Lejátszás'} onClick={() => current ? setPlaying(!playing) : tracks[0] && playTrack(tracks[0])}>
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button className="control-button" aria-label="Következő zeneszám" onClick={() => playRelative(1)} disabled={!tracks.length}><SkipForward size={18} fill="currentColor" /></button>
            <button className={shuffle ? 'control-button mode-active' : 'control-button'} aria-label={shuffle ? 'Keverés kikapcsolása' : 'Keverés bekapcsolása'} title="Keverés" onClick={() => setShuffle(!shuffle)}><Shuffle size={17} /></button>
            <button className={repeat !== 'off' ? 'control-button mode-active repeat-button' : 'control-button repeat-button'} aria-label={`Ismétlés: ${repeat === 'off' ? 'ki' : repeat === 'all' ? 'mind' : 'egy szám'}`} title={`Ismétlés: ${repeat === 'off' ? 'ki' : repeat === 'all' ? 'mind' : 'egy szám'}`} onClick={() => setRepeat((mode) => mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off')}><Repeat size={17} />{repeat === 'one' ? <span>1</span> : null}</button>
          </div>
          <div className="timeline"><span>{formatTime(time)}</span><input aria-label="Lejátszás pozíciója" type="range" min="0" max={duration || 0} value={Math.min(time, duration || 0)} onChange={seek} style={{ '--progress': `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties} /><span>{formatTime(duration)}</span></div>
        </div>
        <div className="player-volume">
          <span className="server-live"><span /> SZERVER AKTÍV</span>
          <button className={lyricsOpen ? 'control-button mode-active' : 'control-button'} aria-label={lyricsOpen ? 'Dalszöveg bezárása' : 'Időzített dalszöveg megjelenítése'} title="Dalszöveg" disabled={!current} onClick={() => setLyricsOpen(!lyricsOpen)}><Captions size={17} /></button>
          <button className="control-button volume-icon" aria-label={volume === 0 ? 'Hang bekapcsolása' : 'Némítás'} onClick={() => setVolume(volume === 0 ? 0.8 : 0)}>{volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <input aria-label="Hangerő" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} style={{ '--progress': `${volume * 100}%` } as CSSProperties} />
        </div>
        <audio key={user.selectedProfileId} ref={audio} src={current?.url} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onLoadedMetadata={handleLoadedMetadata} onEnded={handleEnded} onError={() => { if (current) setError('A kiválasztott zenefájl nem játszható le.') }} />
      </section>
    </div>
  )
}