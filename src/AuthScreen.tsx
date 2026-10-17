import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AudioLines, LoaderCircle, LogIn, UserPlus } from 'lucide-react'

export type AccountProfile = {
  id: string
  name: string
  hasPin: boolean
}

export type SessionUser = {
  id: string
  name: string
  email: string
  role: 'user' | 'admin'
  active: boolean
  createdAt: string
  profiles: AccountProfile[]
  selectedProfileId: string
}

export type AuthStatus = {
  setupRequired: boolean
  registrationOpen: boolean
}

type AuthScreenProps = {
  status: AuthStatus
  onSignedIn: (user: SessionUser) => Promise<void>
}

export default function AuthScreen({ status, onSignedIn }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>(status.setupRequired ? 'register' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const registering = mode === 'register'

  useEffect(() => {
    setMode(status.setupRequired ? 'register' : 'login')
  }, [status.setupRequired])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, bootstrapToken }),
      })
      const result = await response.json() as { user?: SessionUser; error?: string }
      if (!response.ok || !result.user) throw new Error(result.error || 'Nem sikerült a belépés.')
      await onSignedIn(result.user)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nem sikerült kapcsolódni a szerverhez.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <a className="brand auth-brand" href="#home" aria-label="HANGTÁR">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.4} /></span>
          <span>hangtár<span className="brand-period">.</span></span>
        </a>
        <div className="auth-eyebrow">SAJÁT ZENE. SAJÁT SZERVER.</div>
        <h1>{status.setupRequired ? <>Első lépés:<br /><span>adminfiók.</span></> : registering ? <>Legyen saját<br /><span>fiókod.</span></> : <>Jó újra<br /><span>itt lenni.</span></>}</h1>
        <p className="auth-description">{status.setupRequired ? 'A szerver első adminisztrátorát most lehet létrehozni.' : 'Lépj be a saját zenetáradba bármelyik eszközödről.'}</p>

        {!status.setupRequired && status.registrationOpen ? (
          <div className="auth-tabs" role="tablist" aria-label="Fiók műveletek">
            <button type="button" role="tab" aria-selected={!registering} className={!registering ? 'selected' : ''} onClick={() => { setMode('login'); setError('') }}><LogIn size={15} /> Belépés</button>
            <button type="button" role="tab" aria-selected={registering} className={registering ? 'selected' : ''} onClick={() => { setMode('register'); setError('') }}><UserPlus size={15} /> Regisztráció</button>
          </div>
        ) : null}

        <form className="auth-form" onSubmit={submit}>
          {registering ? <label>Név<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={60} required /></label> : null}
          <label>Email-cím<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></label>
          <label>Jelszó<input type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={registering ? 12 : undefined} required /></label>
          {status.setupRequired ? <label>Admin telepítőkulcs<input type="password" autoComplete="one-time-code" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required /></label> : null}
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          {!status.registrationOpen && !status.setupRequired ? <p className="auth-hint">Az új fiókok létrehozása jelenleg szünetel.</p> : null}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : registering ? <UserPlus size={17} /> : <LogIn size={17} />}
            {status.setupRequired ? 'Adminfiók létrehozása' : registering ? 'Fiók létrehozása' : 'Belépés'}
          </button>
        </form>
        <div className="auth-footer">A jelszavadat csak sózott, egyirányú hash formájában tároljuk.</div>
      </div>
      <div className="auth-side-art" aria-hidden="true"><AudioLines size={88} strokeWidth={1} /><span>HANGTÁR / PRIVÁT ZENEKÖNYVTÁR</span></div>
    </main>
  )
}