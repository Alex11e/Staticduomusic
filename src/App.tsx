import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import {
  AudioLines, Clock3, Disc3, Heart, ListMusic, ListPlus, LoaderCircle, Music2,
  Pause, Play, Plus, Radio, RefreshCw, Repeat, Search, Shuffle, SkipBack,
  SkipForward, Trash2, Volume2, VolumeX,
} from 'lucide-react'

type Track = {
  id: string
  title: string
  artist: string
  album: string
  duration: number | null
  size: number
  url: string
}

type LibraryResponse = { tracks: Track[] }
type Playlist = { id: string; name: string; trackIds: string[] }
type View = 'all' | 'favorites' | 'recent' | `playlist:${string}`
type RepeatMode = 'off' | 'all' | 'one'

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
  const [tracks, setTracks] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('all')
  const [favorites, setFavorites] = useState<string[]>(() => readSaved('hangtar-favorites', []))
  const [playlists, setPlaylists] = useState<Playlist[]>(() => readSaved('hangtar-playlists', []))
  const [recent, setRecent] = useState<string[]>(() => readSaved('hangtar-recent', []))
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => readSaved('hangtar-volume', 0.8))
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [playlistName, setPlaylistName] = useState('')

  async function loadLibrary() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/tracks')
      if (!response.ok) throw new Error('A zeneszerver nem válaszol.')
      const data = await response.json() as LibraryResponse
      setTracks(data.tracks)
    } catch {
      setError('Nem sikerült elérni a zeneszervert. Ellenőrizd a kapcsolatot, majd próbáld újra.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadLibrary() }, [])
  useEffect(() => { localStorage.setItem('hangtar-favorites', JSON.stringify(favorites)) }, [favorites])
  useEffect(() => { localStorage.setItem('hangtar-playlists', JSON.stringify(playlists)) }, [playlists])
  useEffect(() => { localStorage.setItem('hangtar-recent', JSON.stringify(recent)) }, [recent])
  useEffect(() => { localStorage.setItem('hangtar-volume', JSON.stringify(volume)) }, [volume])
  useEffect(() => {
    if (!audio.current) return
    audio.current.volume = volume
    if (playing) void audio.current.play().catch(() => setPlaying(false))
    else audio.current.pause()
  }, [current, playing, volume])

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

  const visibleTracks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('hu')
    const activePlaylist = view.startsWith('playlist:')
      ? playlists.find((playlist) => `playlist:${playlist.id}` === view)
      : undefined
    const source = view === 'favorites' ? tracks.filter((track) => favorites.includes(track.id))
      : view === 'recent' ? recent.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => !!track)
        : activePlaylist ? activePlaylist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => !!track)
          : tracks
    return tracks.filter((track) => {
      const matchesView = source.some((item) => item.id === track.id)
      const matchesSearch = !normalizedQuery ||
        `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase('hu').includes(normalizedQuery)
      return matchesView && matchesSearch
    })
  }, [favorites, playlists, query, recent, tracks, view])

  const activePlaylist = view.startsWith('playlist:')
    ? playlists.find((playlist) => `playlist:${playlist.id}` === view)
    : undefined
  const viewTitle = activePlaylist?.name || (view === 'favorites' ? 'KEDVENCEK' : view === 'recent' ? 'LEGUTÓBBI' : 'ÖSSZES ZENE')

  function playTrack(track: Track) {
    if (current?.id === track.id) setPlaying(!playing)
    else {
      setCurrent(track)
      setPlaying(true)
      setTime(0)
      setRecent((saved) => [track.id, ...saved.filter((id) => id !== track.id)].slice(0, 40))
    }
  }

  function playRelative(offset: number, automatic = false) {
    const queue = visibleTracks.length ? visibleTracks : tracks
    if (!queue.length) return
    const index = current ? queue.findIndex((track) => track.id === current.id) : -1
    if (automatic && repeat === 'off' && index === queue.length - 1) {
      setPlaying(false)
      return
    }
    let nextIndex = index + offset
    if (shuffle && offset > 0 && queue.length > 1) {
      nextIndex = Math.floor(Math.random() * (queue.length - 1))
      if (nextIndex >= index) nextIndex += 1
    } else if (nextIndex < 0 || nextIndex >= queue.length) {
      nextIndex = (nextIndex + queue.length) % queue.length
    }
    const nextTrack = queue[nextIndex]
    if (!nextTrack) return
    setCurrent(nextTrack)
    setPlaying(true)
    setTime(0)
    setRecent((saved) => [nextTrack.id, ...saved.filter((id) => id !== nextTrack.id)].slice(0, 40))
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

  function createPlaylist(event: ChangeEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = playlistName.trim()
    if (!name) return
    const playlist = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, trackIds: [] }
    setPlaylists((saved) => [...saved, playlist])
    setView(`playlist:${playlist.id}`)
    setPlaylistName('')
    setCreatingPlaylist(false)
  }

  function addToPlaylist(playlistId: string, track: Track) {
    setPlaylists((saved) => saved.map((playlist) => playlist.id === playlistId && !playlist.trackIds.includes(track.id)
      ? { ...playlist, trackIds: [...playlist.trackIds, track.id] }
      : playlist))
  }

  function deletePlaylist(playlist: Playlist) {
    setPlaylists((saved) => saved.filter((item) => item.id !== playlist.id))
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
        </nav>

        <div className="playlist-heading"><span className="nav-label">LEJÁTSZÁSI LISTÁK</span><button className="add-playlist" aria-label="Új lejátszási lista" title="Új lejátszási lista" onClick={() => setCreatingPlaylist(!creatingPlaylist)}><Plus size={16} /></button></div>
        {creatingPlaylist ? <form className="playlist-form" onSubmit={createPlaylist}><input autoFocus aria-label="Lista neve" placeholder="Lista neve" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} /><button aria-label="Létrehozás" type="submit"><Plus size={15} /></button></form> : null}
        <nav className="playlist-nav" aria-label="Lejátszási listák">
          {playlists.map((playlist) => <div className="playlist-link-row" key={playlist.id}>
            <button className={view === `playlist:${playlist.id}` ? 'nav-item active' : 'nav-item'} onClick={() => setView(`playlist:${playlist.id}`)}><ListMusic size={17} /><span>{playlist.name}</span></button>
            <button className="delete-playlist" aria-label={`${playlist.name} törlése`} title="Lista törlése" onClick={() => deletePlaylist(playlist)}><Trash2 size={14} /></button>
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
        </header>

        <div className="content-wrap">
          <section className="library-heading">
            <div className="eyebrow"><span className="eyebrow-line" /> PRIVÁT ZENEKÖNYVTÁR</div>
            <div className="heading-row">
              <div>
                <h1>{activePlaylist ? <>{activePlaylist.name}<span>.</span></> : view === 'favorites' ? <>A te <span>kedvenceid.</span></> : view === 'recent' ? <>Nemrég <span>hallgatva.</span></> : <>Saját <span>hangzás.</span></>}</h1>
                <p className="subheading">{activePlaylist ? `${activePlaylist.trackIds.length} zeneszám a listában.` : view === 'favorites' ? 'A dalok, amik újra és újra hazatalálnak.' : view === 'recent' ? 'A legutóbb lejátszott dalaid.' : 'A gyűjteményed, bárhol is vagy.'}</p>
              </div>
              <div className="library-stat"><strong>{visibleTracks.length}</strong><span>ZENESZÁM</span></div>
            </div>
          </section>

          <section className="collection-section">
            <div className="section-heading">
              <div><span className="section-icon"><ListMusic size={16} /></span><h2>{query ? 'Találatok' : activePlaylist?.name || (view === 'favorites' ? 'Kedvenc zenék' : view === 'recent' ? 'Legutóbb játszott' : 'A gyűjteményed')}</h2></div>
              <span className="track-total">{visibleTracks.length} DAL</span>
            </div>

            <div className="track-head" aria-hidden="true"><span>#</span><span>CÍM</span><span>ALBUM / HELY</span><span>MÉRET</span><span /><span /></div>
            {loading ? <div className="empty-state"><LoaderCircle className="spin" size={24} /><p>Könyvtár betöltése...</p></div> : null}
            {!loading && error ? <div className="empty-state"><Radio size={27} /><p>{error}</p><button className="text-action" onClick={() => void loadLibrary()}>Újrapróbálás</button></div> : null}
            {!loading && !error && visibleTracks.length === 0 ? (
              <div className="empty-state">
                <div className="empty-disc"><Music2 size={25} /></div>
                <strong>{tracks.length === 0 ? 'Itt még csend van.' : view === 'favorites' ? 'Még nincsenek kedvenceid.' : view === 'recent' ? 'Még nincs lejátszási előzmény.' : activePlaylist ? 'Ez a lista még üres.' : 'Nincs ilyen találat.'}</strong>
                <p>{tracks.length === 0 ? 'Tegyél MP3, FLAC, OGG, WAV vagy M4A fájlokat a szerver music mappájába, aztán frissítsd a könyvtárat.' : view === 'favorites' ? 'A szív ikonra koppintva elmentheted a kedvenc dalaidat.' : activePlaylist ? 'A dalok melletti lista ikonra koppintva adhatsz hozzá zenét.' : view === 'recent' ? 'Indíts el egy zenét, és itt megtalálod.' : 'Próbálj másik keresőkifejezést.'}</p>
              </div>
            ) : null}

            <div className="track-list">
              {visibleTracks.map((track, index) => {
                const isCurrent = current?.id === track.id
                const isFavorite = favorites.includes(track.id)
                return (
                  <div className={isCurrent ? 'track-row current' : 'track-row'} key={track.id}>
                    <button className="track-number" aria-label={`${track.title} lejátszása`} onClick={() => playTrack(track)}>
                      {isCurrent && playing ? <AudioLines size={17} className="playing-bars" /> : isCurrent ? <Pause size={16} /> : <><span className="row-index">{String(index + 1).padStart(2, '0')}</span><Play size={15} className="row-play" fill="currentColor" /></>}
                    </button>
                    <button className="track-title" onClick={() => playTrack(track)}>
                      <span className="cover-thumb"><Music2 size={17} /></span>
                      <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                    </button>
                    <span className="track-album">{track.album}</span>
                    <span className="track-size">{formatSize(track.size)}</span>
                    <details className="add-to-playlist"><summary aria-label="Hozzáadás lejátszási listához" title="Hozzáadás listához"><ListPlus size={17} /></summary><div className="playlist-menu">{playlists.length ? playlists.map((playlist) => <button key={playlist.id} onClick={() => addToPlaylist(playlist.id, track)}>{playlist.name}{playlist.trackIds.includes(track.id) ? ' ✓' : ''}</button>) : <button onClick={() => { setCreatingPlaylist(true); setView('all') }}>Új lista létrehozása</button>}</div></details>
                    <button className={isFavorite ? 'favorite-button liked' : 'favorite-button'} aria-label={isFavorite ? 'Eltávolítás a kedvencekből' : 'Hozzáadás a kedvencekhez'} title={isFavorite ? 'Eltávolítás a kedvencekből' : 'Kedvencekhez adás'} onClick={() => toggleFavorite(track)}>
                      <Heart size={17} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>

          <footer className="page-footer"><span>HANGTÁR <span className="footer-dot">·</span> PRIVÁTAN, SAJÁT SZERVEREDRŐL</span><span>MP3 · FLAC · OGG · WAV · M4A</span></footer>
        </div>
      </main>

      <section className="player" aria-label="Zenelejátszó">
        <div className="now-playing">
          <div className={current ? 'player-art has-track' : 'player-art'}>{current ? <Music2 size={20} /> : <Disc3 size={21} />}</div>
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
          <button className="control-button volume-icon" aria-label={volume === 0 ? 'Hang bekapcsolása' : 'Némítás'} onClick={() => setVolume(volume === 0 ? 0.8 : 0)}>{volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <input aria-label="Hangerő" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} style={{ '--progress': `${volume * 100}%` } as CSSProperties} />
        </div>
        <audio ref={audio} src={current?.url} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onEnded={handleEnded} onError={() => { if (current) setError('A kiválasztott zenefájl nem játszható le.') }} />
      </section>
    </div>
  )
}