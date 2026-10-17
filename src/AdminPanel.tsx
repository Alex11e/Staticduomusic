import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Activity, Captions, Download, ExternalLink, HardDrive, LoaderCircle, Music2, RefreshCw, Search, ShieldCheck, Trash2, Upload, Users } from 'lucide-react'
import type { SessionUser } from './AuthScreen'

type AdminStats = { users: number; tracks: number; storageBytes: number }
type AdminTrack = { id: string; title: string; artist: string; album: string; size: number }
type MusicSource = 'archive' | 'jamendo' | 'direct'
type MusicSourceTrack = { source: 'archive' | 'jamendo'; id: string; fileName?: string; title: string; artist: string; album?: string; licenseUrl: string }
type AdminPanelProps = { onLibraryChanged: () => Promise<void> }

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

export default function AdminPanel({ onLibraryChanged }: AdminPanelProps) {
  const [users, setUsers] = useState<SessionUser[]>([])
  const [tracks, setTracks] = useState<AdminTrack[]>([])
  const [stats, setStats] = useState<AdminStats>({ users: 0, tracks: 0, storageBytes: 0 })
  const [registrationOpen, setRegistrationOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadingLyricsId, setUploadingLyricsId] = useState('')
  const [musicSource, setMusicSource] = useState<MusicSource>('archive')
  const [musicQuery, setMusicQuery] = useState('')
  const [musicResults, setMusicResults] = useState<MusicSourceTrack[]>([])
  const [musicSearching, setMusicSearching] = useState(false)
  const [musicImporting, setMusicImporting] = useState('')
  const [directUrl, setDirectUrl] = useState('')
  const [directTitle, setDirectTitle] = useState('')
  const [directArtist, setDirectArtist] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [usersResponse, statsResponse, settingsResponse, tracksResponse] = await Promise.all([
        fetch('/api/admin/users'), fetch('/api/admin/stats'), fetch('/api/admin/settings'), fetch('/api/tracks'),
      ])
      const [usersData, statsData, settingsData, tracksData] = await Promise.all([
        usersResponse.json(), statsResponse.json(), settingsResponse.json(), tracksResponse.json(),
      ]) as [{ users?: SessionUser[]; error?: string }, AdminStats, { registrationOpen?: boolean }, { tracks?: AdminTrack[]; error?: string }]
      if (!usersResponse.ok) throw new Error(usersData.error || 'Nem sikerült betölteni a fiókokat.')
      if (!tracksResponse.ok) throw new Error(tracksData.error || 'Nem sikerült betölteni a zenekönyvtárat.')
      setUsers(usersData.users || [])
      setStats(statsData)
      setRegistrationOpen(settingsData.registrationOpen !== false)
      setTracks(tracksData.tracks || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nem sikerült betölteni az admin adatokat.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function patchUser(user: SessionUser, changes: Partial<Pick<SessionUser, 'role' | 'active'>>) {
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'A fiók módosítása nem sikerült.')
      setNotice(`${user.email} fiókja frissült.`)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A fiók módosítása nem sikerült.')
    }
  }

  async function toggleRegistration() {
    const nextValue = !registrationOpen
    setError('')
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationOpen: nextValue }),
      })
      const result = await response.json() as { error?: string; registrationOpen?: boolean }
      if (!response.ok) throw new Error(result.error || 'A beállítás mentése nem sikerült.')
      setRegistrationOpen(result.registrationOpen === true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A beállítás mentése nem sikerült.')
    }
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = Array.from(input.files || [])
    if (!files.length) return
    setUploading(true)
    setError('')
    setNotice('')
    let importedTracks = 0
    try {
      for (const file of files) {
        const response = await fetch(`/api/admin/tracks?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        })
        const result = await response.json() as { error?: string; extracted?: number }
        if (!response.ok) throw new Error(`${file.name}: ${result.error || 'A feltöltés nem sikerült.'}`)
        importedTracks += result.extracted ?? 1
      }
      setNotice(`${importedTracks} zeneszám importálva.`)
      await onLibraryChanged()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A feltöltés nem sikerült.')
    } finally {
      setUploading(false)
      input.value = ''
    }
  }

  async function searchOnline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMusicSearching(true)
    setMusicResults([])
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/music/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: musicSource, query: musicQuery }),
      })
      const result = await response.json() as { error?: string; results?: MusicSourceTrack[] }
      if (!response.ok) throw new Error(result.error || 'A keresés nem sikerült.')
      setMusicResults(result.results || [])
      if (!result.results?.length) setNotice('Nem található letölthető MP3 ezen a forráson.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A keresés nem sikerült.')
    } finally {
      setMusicSearching(false)
    }
  }

  async function importOnlineTrack(track: MusicSourceTrack) {
    const importId = `${track.source}:${track.id}:${track.fileName || ''}`
    setMusicImporting(importId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/music/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: track.source, id: track.id, fileName: track.fileName }),
      })
      const result = await response.json() as { error?: string; filename?: string }
      if (!response.ok) throw new Error(result.error || 'A letöltés nem sikerült.')
      setNotice(`${result.filename || track.title} letöltve és importálva.`)
      await onLibraryChanged()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A letöltés nem sikerült.')
    } finally {
      setMusicImporting('')
    }
  }

  async function importDirectUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMusicImporting('direct')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/music/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'direct', url: directUrl, title: directTitle, artist: directArtist, rightsConfirmed }),
      })
      const result = await response.json() as { error?: string; filename?: string }
      if (!response.ok) throw new Error(result.error || 'A letöltés nem sikerült.')
      setNotice(`${result.filename || 'A zeneszám'} letöltve és importálva.`)
      setDirectUrl('')
      await onLibraryChanged()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A letöltés nem sikerült.')
    } finally {
      setMusicImporting('')
    }
  }

  async function deleteTrack(track: AdminTrack) {
    if (!window.confirm(`Biztosan törlöd a „${track.title}” című fájlt a szerverről?`)) return
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE' })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'A fájl törlése nem sikerült.')
      setNotice('A zenefájl törölve.')
      await onLibraryChanged()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A fájl törlése nem sikerült.')
    }
  }

  async function uploadLyrics(track: AdminTrack, event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setUploadingLyricsId(track.id)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/tracks/${encodeURIComponent(track.id)}/lyrics`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: file,
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'A dalszöveg feltöltése nem sikerült.')
      setNotice(`${track.title} időzített dalszövege frissült.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A dalszöveg feltöltése nem sikerült.')
    } finally {
      setUploadingLyricsId('')
      input.value = ''
    }
  }

  return (
    <div className="content-wrap admin-content">
      <div className="eyebrow"><span className="eyebrow-line" /> SZERVERKEZELÉS</div>
      <div className="admin-title-row">
        <div><h1>Admin <span>központ.</span></h1><p className="subheading">Fiókok, regisztráció és zenekönyvtár.</p></div>
        <button className="icon-button" aria-label="Admin adatok frissítése" title="Frissítés" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={17} />}</button>
      </div>

      {error ? <p className="admin-message error" role="alert">{error}</p> : null}
      {notice ? <p className="admin-message success" role="status">{notice}</p> : null}

      <div className="admin-stats">
        <div><Users size={18} /><strong>{stats.users}</strong><span>FELHASZNÁLÓ</span></div>
        <div><Music2 size={18} /><strong>{stats.tracks}</strong><span>ZENESZÁM</span></div>
        <div><HardDrive size={18} /><strong>{formatBytes(stats.storageBytes)}</strong><span>TÁRHELY</span></div>
      </div>

      <section className="admin-section">
        <div className="admin-section-title"><div><ShieldCheck size={18} /><h2>Regisztráció</h2></div><span className={registrationOpen ? 'status-pill online' : 'status-pill'}>{registrationOpen ? 'NYITVA' : 'ZÁRVA'}</span></div>
        <div className="registration-setting"><div><strong>Új fiókok létrehozása</strong><small>A beállítás a következő regisztrációnál lép életbe.</small></div><label className="switch"><input type="checkbox" checked={registrationOpen} onChange={() => void toggleRegistration()} /><span /></label></div>
      </section>

      <section className="admin-section">
        <div className="admin-section-title"><div><Users size={18} /><h2>Felhasználói fiókok</h2></div><span className="admin-count">{users.length} FIÓK</span></div>
        {loading ? <div className="admin-loading"><LoaderCircle className="spin" size={20} /> Betöltés...</div> : users.length ? (
          <div className="user-table-wrap"><table className="user-table"><thead><tr><th>FELHASZNÁLÓ</th><th>JOGOSULTSÁG</th><th>ÁLLAPOT</th><th>REGISZTRÁLT</th></tr></thead><tbody>
            {users.map((user) => <tr key={user.id}>
              <td><strong>{user.name}</strong><small>{user.email}</small></td>
              <td><select aria-label={`${user.email} jogosultsága`} value={user.role} onChange={(event) => void patchUser(user, { role: event.target.value as SessionUser['role'] })}><option value="user">Felhasználó</option><option value="admin">Admin</option></select></td>
              <td><label className="switch"><input aria-label={`${user.email} aktív`} type="checkbox" checked={user.active} onChange={(event) => void patchUser(user, { active: event.target.checked })} /><span /></label></td>
              <td>{new Date(user.createdAt).toLocaleDateString('hu-HU')}</td>
            </tr>)}
          </tbody></table></div>
        ) : <p className="admin-empty">Nincs megjeleníthető fiók.</p>}
      </section>

      <section className="admin-section">
        <div className="admin-section-title"><div><Upload size={18} /><h2>Zenék feltöltése</h2></div><span className="admin-limit">MAX. 10 GB / FÁJL</span></div>
        <label className={uploading ? 'upload-drop disabled' : 'upload-drop'}>
          {uploading ? <LoaderCircle className="spin" size={22} /> : <Upload size={22} />}
          <strong>{uploading ? 'Feltöltés és importálás...' : 'Válassz zenéket vagy ZIP archívumot'}</strong>
          <span>ZIP esetén csak a támogatott hangfájlok kerülnek a zenekönyvtárba.</span>
          <span>MP3 · FLAC · OGG · OPUS · WAV · M4A · AAC · WEBM · ZIP</span>
          <input type="file" accept=".mp3,.flac,.ogg,.opus,.wav,.m4a,.aac,.webm,.zip" multiple disabled={uploading} onChange={(event) => void uploadFiles(event)} />
        </label>
      </section>
      <section className="admin-section">
        <div className="admin-section-title"><div><Download size={18} /><h2>MP3 importálása az internetről</h2></div><span className="admin-limit">LICENCELT FORRÁSOK</span></div>
        <div className="music-source-tabs" role="group" aria-label="Zeneforrás">
          <button type="button" className={musicSource === 'archive' ? 'active' : ''} onClick={() => { setMusicSource('archive'); setMusicResults([]) }}>Internet Archive</button>
          <button type="button" className={musicSource === 'jamendo' ? 'active' : ''} onClick={() => { setMusicSource('jamendo'); setMusicResults([]) }}>Jamendo</button>
          <button type="button" className={musicSource === 'direct' ? 'active' : ''} onClick={() => { setMusicSource('direct'); setMusicResults([]) }}>Közvetlen URL</button>
        </div>
        {musicSource === 'direct' ? (
          <form className="music-source-form" onSubmit={(event) => void importDirectUrl(event)}>
            <input aria-label="MP3 letöltési URL" type="url" placeholder="https://archive.org/.../zeneszam.mp3" value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} required />
            <input aria-label="Dal címe" placeholder="Dal címe" value={directTitle} onChange={(event) => setDirectTitle(event.target.value)} />
            <input aria-label="Előadó" placeholder="Előadó" value={directArtist} onChange={(event) => setDirectArtist(event.target.value)} />
            <label className="music-source-rights"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} required /> Jogosult vagyok a fájl letöltésére és tárolására.</label>
            <button className="music-source-submit" type="submit" disabled={musicImporting !== ''}><Download size={15} />{musicImporting === 'direct' ? 'Letöltés...' : 'Letöltés'}</button>
            <p className="music-source-hint">Csak HTTPS-es Archive.org vagy Jamendo forrásból származó MP3 URL használható.</p>
          </form>
        ) : (
          <>
            <form className="music-source-search" onSubmit={(event) => void searchOnline(event)}>
              <input aria-label="Keresés cím vagy előadó szerint" type="search" placeholder="Dal címe vagy előadó" value={musicQuery} onChange={(event) => setMusicQuery(event.target.value)} required />
              <button className="music-source-submit" type="submit" disabled={musicSearching || musicImporting !== ''}>{musicSearching ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}{musicSearching ? 'Keresés...' : 'Keresés'}</button>
            </form>
            {musicSource === 'jamendo' ? <p className="music-source-hint">A Jamendo kereséshez szerveroldali JAMENDO_CLIENT_ID szükséges. Csak a letöltést engedélyező, megfelelő Creative Commons licencű zenék jelennek meg.</p> : null}
            {musicResults.length ? <div className="music-source-results">{musicResults.map((track) => {
              const importId = `${track.source}:${track.id}:${track.fileName || ''}`
              return <div className="music-source-result" key={importId}>
                <div><strong>{track.title}</strong><small>{track.artist}{track.album ? ` · ${track.album}` : ''}</small></div>
                <a href={track.licenseUrl} target="_blank" rel="noreferrer" aria-label={`${track.title} licencének megnyitása`} title="Licenc"><ExternalLink size={15} /></a>
                <button type="button" className="music-source-download" aria-label={`${track.title} letöltése`} title="MP3 letöltése" disabled={musicImporting !== ''} onClick={() => void importOnlineTrack(track)}>{musicImporting === importId ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button>
              </div>
            })}</div> : null}
          </>
        )}
      </section>
      <section className="admin-section">
        <div className="admin-section-title"><div><Music2 size={18} /><h2>Zenekönyvtár kezelése</h2></div><span className="admin-count">{tracks.length} ZENE</span></div>
        {tracks.length ? <div className="admin-track-list">{tracks.map((track) => <div className="admin-track-row" key={track.id}>
          <div><strong>{track.title}</strong><small>{track.artist} · {track.album} · {formatBytes(track.size)}</small></div>
          <label className="upload-lyrics" title="Időzített LRC dalszöveg feltöltése"><Captions size={16} /><input type="file" accept=".lrc,text/plain" aria-label={`${track.title} időzített dalszövegének feltöltése`} disabled={uploadingLyricsId !== ''} onChange={(event) => void uploadLyrics(track, event)} /></label>
          <button className="delete-track" aria-label={`${track.title} törlése`} title="Zenefájl törlése" onClick={() => void deleteTrack(track)}><Trash2 size={16} /></button>
        </div>)}</div> : <p className="admin-empty">A könyvtár még üres.</p>}
      </section>
      <div className="admin-footnote"><Activity size={15} /> A fiókokat a szerver kezeli; jelszavak nem jelennek meg ezen a felületen.</div>
    </div>
  )
}
