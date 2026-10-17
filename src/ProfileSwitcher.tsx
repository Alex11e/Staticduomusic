import { useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronDown, LoaderCircle, Pencil, Plus, Trash2, UserRound, X } from 'lucide-react'
import type { SessionUser } from './AuthScreen'

type ProfileSwitcherProps = {
  user: SessionUser
  onProfileChanged: (user: SessionUser) => Promise<void>
}

type ProfileResponse = { user?: SessionUser; error?: string }

export default function ProfileSwitcher({ user, onProfileChanged }: ProfileSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [pins, setPins] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const activeProfile = user.profiles.find((profile) => profile.id === user.selectedProfileId) || user.profiles[0]

  async function request(route: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(route, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const result = await response.json() as ProfileResponse
      if (!response.ok || !result.user) throw new Error(result.error || 'A profilművelet nem sikerült.')
      await onProfileChanged(result.user)
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nem sikerült kapcsolódni a szerverhez.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function switchProfile(event: FormEvent<HTMLFormElement>, profileId: string) {
    event.preventDefault()
    const changed = await request(`/api/profiles/${encodeURIComponent(profileId)}/select`, 'POST', { pin: pins[profileId] || '' })
    if (changed) {
      setPins((saved) => ({ ...saved, [profileId]: '' }))
      setOpen(false)
    }
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim()) return
    const changed = await request('/api/profiles', 'POST', { name, pin })
    if (changed) { setName(''); setPin('') }
  }

  async function renameProfile(event: FormEvent<HTMLFormElement>, profileId: string) {
    event.preventDefault()
    const changed = await request(`/api/profiles/${encodeURIComponent(profileId)}`, 'PATCH', { name: editingName })
    if (changed) { setEditingId(''); setEditingName('') }
  }

  async function deleteProfile(profileId: string, profileName: string) {
    if (!window.confirm(`Törlöd a(z) „${profileName}” profilt és annak saját lejátszási adatait?`)) return
    await request(`/api/profiles/${encodeURIComponent(profileId)}`, 'DELETE')
  }

  return (
    <div className="profile-switcher">
      <button className="profile-trigger" aria-label={`Aktív profil: ${activeProfile?.name || user.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <UserRound size={16} /><span>{activeProfile?.name || user.name}</span><ChevronDown size={13} />
      </button>
      {open ? <div className="profile-popover" role="dialog" aria-label="Duo profilok">
        <div className="profile-popover-head"><div><strong>Duo profilok</strong><small>{user.profiles.length}/2 profil</small></div><button aria-label="Profilmenü bezárása" onClick={() => setOpen(false)}><X size={15} /></button></div>
        <div className="profile-list">
          {user.profiles.map((profile, index) => <div className="profile-row" key={profile.id}>
            {editingId === profile.id ? <form className="profile-rename-form" onSubmit={(event) => void renameProfile(event, profile.id)}>
              <input aria-label="Profil új neve" value={editingName} onChange={(event) => setEditingName(event.target.value)} minLength={2} maxLength={40} required />
              <button type="submit" aria-label="Profilnév mentése" disabled={busy}><Check size={14} /></button>
              <button type="button" aria-label="Átnevezés megszakítása" onClick={() => setEditingId('')}><X size={14} /></button>
            </form> : <>
              <div className="profile-identity"><span className="profile-avatar"><UserRound size={15} /></span><div><strong>{profile.name}</strong><small>{profile.id === user.selectedProfileId ? 'Aktív ezen az eszközön' : profile.hasPin ? 'PIN-védett profil' : 'Külön lejátszási adatok'}</small></div></div>
              {profile.id !== user.selectedProfileId ? <form className="profile-select-form" onSubmit={(event) => void switchProfile(event, profile.id)}>
                {profile.hasPin ? <input aria-label={`${profile.name} PIN`} inputMode="numeric" type="password" pattern="[0-9]{4,8}" placeholder="PIN" value={pins[profile.id] || ''} onChange={(event) => setPins((saved) => ({ ...saved, [profile.id]: event.target.value }))} required /> : null}
                <button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : 'Váltás'}</button>
              </form> : <span className="profile-active-check"><Check size={15} /></span>}
              <button className="profile-action" aria-label={`${profile.name} átnevezése`} title="Átnevezés" onClick={() => { setEditingId(profile.id); setEditingName(profile.name) }}><Pencil size={14} /></button>
              {index > 0 ? <button className="profile-action danger" aria-label={`${profile.name} profil törlése`} title="Profil törlése" onClick={() => void deleteProfile(profile.id, profile.name)}><Trash2 size={14} /></button> : null}
            </>}
          </div>)}
        </div>
        {user.profiles.length < 2 ? <form className="profile-create-form" onSubmit={(event) => void createProfile(event)}>
          <div className="profile-form-title"><Plus size={15} /><strong>Második profil hozzáadása</strong></div>
          <input aria-label="Új profil neve" placeholder="Profilnév" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={40} required />
          <input aria-label="Új profil PIN-kódja" placeholder="PIN (opcionális, 4–8 számjegy)" inputMode="numeric" type="password" pattern="[0-9]{4,8}" value={pin} onChange={(event) => setPin(event.target.value)} />
          <button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : 'Profil létrehozása'}</button>
        </form> : <div className="profile-limit">A Duo fiók már két profilt használ.</div>}
        {error ? <p className="profile-error" role="alert">{error}</p> : null}
        <div className="profile-popover-foot">A két profil saját listákat és előzményeket használ.</div>
      </div> : null}
    </div>
  )
}