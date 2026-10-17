# HANGTÁR

Saját zenekönyvtárból streamelő, telefonon és számítógépen is használható webes zenelejátszó. A zenék a te szervereden maradnak; az alkalmazás nem tartalmaz előre feltöltött zenét.

## Indítás fejlesztéshez

Szükséges a Node.js 20 vagy újabb.

```sh
npm install
npm run dev
```

Nyisd meg a Vite által jelzett címet. A fejlesztői szerver automatikusan elindítja a zenekönyvtár API-t is. Tegyél MP3, FLAC, OGG, OPUS, WAV, M4A, AAC vagy WEBM fájlokat a `music` mappába. Az előadó a mappanévből, a dal címe a fájlnévből készül; frissítsd a könyvtárat a fájlok hozzáadása után.

## Saját szerveren Dockerrel

Másold a projektet a szerverre, a zenéket pedig a `music` mappába, majd:

```sh
docker compose up -d --build
```

Az alkalmazás a `http://SZERVER-IP:4000` címen érhető el a helyi hálózaton, telefonról is. A kezdőképernyős alkalmazásként telepítéshez állítsd HTTPS mögé egy reverse proxyval, mert a böngészők a telepíthető webappokhoz biztonságos kapcsolatot várnak. A `music` mappa Docker-kötetként van csatolva, ezért a zeneállományok a konténer újraindítása után is megmaradnak.

## Beállítások

- `PORT`: port, alapértelmezés szerint `4000`.
- `MUSIC_DIR`: zenekönyvtár helye, alapértelmezés szerint a projekt `music` mappája.
- `MUSIC_SERVER_URL`: fejlesztéskor a Vite proxy célcíme, ha a zeneszerver nem a saját gépen fut.

Publikus internetre csak HTTPS-sel és hitelesítést biztosító reverse proxy mögött tedd ki. Az első változat egyetlen, közös könyvtárat használ, nincs benne felhasználói fiók vagy feltöltőfelület; a kedvencek böngészőnként helyben tárolódnak.