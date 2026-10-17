Keresés, album- és előadóböngészés, kedvencek, saját lejátszási listák (átnevezés és dalok eltávolítása), átrendezhető lejátszási sor, hallgatási előzmények, helyi könyvtárból ajánlott zenék, keverés, ismétlés, hangerő- és pozícióvezérlés tartozik hozzá. A szerver kiolvassa a támogatott audio tageket (cím, előadó, album, év, műfaj, hossz és beágyazott borító); hiányzó tageknél a fájlnév és mappanév a tartalék. Az admin kezelheti és törölheti a zenetár fájljait. A `/` billentyű a keresőt fókuszálja, a szóköz lejátszik vagy szüneteltet, az `N` a következő zenére lép. A fiókadatok a szerveren tárolódnak, így több eszköz között is szinkronizálódnak.
# HANGTÁR

Saját zenekönyvtárból streamelő, telefonon és számítógépen is használható webes zenelejátszó. A zenék a te szervereden maradnak; az alkalmazás nem tartalmaz előre feltöltött zenét.

Keresés, album- és előadóböngészés, kedvencek, szerkeszthető lejátszási listák, átrendezhető queue, előzmények és helyi zenéken alapuló ajánlások tartoznak hozzá. Egy fiók legfeljebb két külön profilt kezel; a lejátszási állapotuk eszközönként önálló, ezért egyszerre két külön zenét is lehet hallgatni. A `/` billentyű a keresőt fókuszálja, a szóköz lejátszik vagy szüneteltet, az `N` a következő zenére lép.

## Fiókok és adminisztráció

Az első indítás létrehoz egy admin telepítőkulcsot. Fejlesztés közben itt olvashatod ki: `Get-Content .\data\bootstrap-token` PowerShellben, vagy `cat data/bootstrap-token` Linuxon. A Linux telepítőnél: `sudo cat /var/lib/hangtar/bootstrap-token`. Add meg ezt a kulcsot az első regisztrációs képernyőn; az első fiók adminisztrátor lesz. A kulcsot sikeres beállítás után a szerver eltávolítja.

Ezután a regisztrációs képernyőn bárki saját fiókot hozhat létre legalább 12 karakteres jelszóval. Duo módban két eszköz ugyanazzal a fiókkal jelentkezik be, majd külön profilt választ. A kedvencek, listák, előzmények, hangerő és várólista profilonként külön marad, miközben a két böngésző külön lejátszója párhuzamosan működik. A második profil opcionális PIN-kóddal védhető. Ez profilmegosztás, nem számlázási vagy fizetős előfizetési rendszer.

Az adminisztrátor az Adminisztráció oldalon megnyithatja vagy lezárhatja az új regisztrációt, módosíthatja a fiókok szerepkörét, letilthat vagy visszakapcsolhat fiókokat, zenéket tölthet fel vagy törölhet, és megtekintheti a könyvtár tárhelyhasználatát. A webes feltöltés zenefájlonként vagy ZIP archívumonként legfeljebb 500 MB. ZIP-ből csak a támogatott audioformátumok kerülnek a `music` mappába; a belső könyvtárstruktúra megmarad, az egyéb fájlok kimaradnak. Az archívum legfeljebb 5000 bejegyzést és 2 GB kicsomagolt zenét tartalmazhat. Útvonalkilépést vagy szimbolikus hivatkozást tartalmazó archívumot a szerver elutasít, és visszavonja az addig kibontott részleges fájlokat.

A jelszavak sózott scrypt hashként, a munkamenetek hash-elt tokenként kerülnek tárolásra. Az admin kulcsot és az adattárat ne tedd közzé, és ne töröld a `data` mappát, mert abban vannak a fiókok és a lejátszási listák.

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

Az alkalmazás a `http://SZERVER-IP:4000` címen érhető el a helyi hálózaton, telefonról is. A `music` és a `data` mappa Docker-kötetként van csatolva, ezért a zenék és fiókok a konténer újraindítása után is megmaradnak. A kezdő admin kulcs a szerver naplójában jelenik meg: `docker compose logs hangtar`.

## Natív telepítés Linuxra

Ubuntu vagy Debian szerveren telepíts Node.js 20-at vagy újabbat, majd másold fel vagy klónozd a projektet. A telepítő `hangtar` rendszerfelhasználót, `/opt/hangtar` alkalmazáskönyvtárat és systemd szolgáltatást hoz létre; az adatok helye `/var/lib/hangtar/music`.

```sh
sudo bash scripts/install-linux.sh
sudo systemctl status hangtar
```

Tegyél zenéket a könyvtárba, majd indítsd újra a szolgáltatást, ha a böngészőben frissítve nem jelennek meg:

```sh
sudo install -o hangtar -g hangtar /sajat/zenek/song.mp3 /var/lib/hangtar/music/
sudo systemctl restart hangtar
```

A Linux szolgáltatás alapértelmezetten csak a `127.0.0.1:4000` címen figyel. Telepítés után olvasd ki az admin telepítőkulcsot a `sudo cat /var/lib/hangtar/bootstrap-token` paranccsal. Weboldalként való használathoz állítsd be a domain DNS rekordját a szerver IP-címére, majd telepíts Nginxet és Certbotot:

```sh
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx apache2-utils
sudo cp deploy/nginx-hangtar.conf /etc/nginx/sites-available/hangtar
```

Az Nginx konfigurációban cseréld le a `music.example.com` címet a saját domainedre. Hozz létre belépési jelszót a webes eléréshez:

```sh
sudo htpasswd -c /etc/nginx/.htpasswd sajatfelhasznalo
```

Ezután a konfigurációban vedd ki a kommentet az `auth_basic` és `auth_basic_user_file` sorok elől, majd engedélyezd a webhelyet és kérj TLS-tanúsítványt:

```sh
sudo ln -s /etc/nginx/sites-available/hangtar /etc/nginx/sites-enabled/hangtar
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d music.sajatdomain.hu
```

Ezután az app a `https://music.sajatdomain.hu` címen használható. Frissítéskor a projekt könyvtárából futtasd: `sudo bash scripts/update-linux.sh`. Az állapot és a napló megtekintése: `sudo systemctl status hangtar`, illetve `sudo journalctl -u hangtar -f`.

## Beállítások

- `PORT`: port, alapértelmezés szerint `4000`.
- `HOST`: figyelési cím, alapértelmezés szerint `0.0.0.0`; Nginx mögötti Linux telepítésnél `127.0.0.1`.
- `MUSIC_DIR`: zenekönyvtár helye, alapértelmezés szerint a projekt `music` mappája.
- `DATA_DIR`: a fiókok és beállítások adattára, alapértelmezés szerint a projekt `data` mappája.
- `BOOTSTRAP_ADMIN_TOKEN`: opcionális előre beállított kulcs az első adminisztrátor létrehozásához; enélkül a szerver biztonságos, véletlenszerű kulcsot generál az adattárban.
- `COOKIE_SECURE`: állítsd `true` értékre, ha a HTTPS reverse proxy nem küldi tovább az `X-Forwarded-Proto` fejlécet.
- `MUSIC_SERVER_URL`: fejlesztéskor a Vite proxy célcíme, ha a zeneszerver nem a saját gépen fut.

Publikus internetre csak HTTPS-sel és hitelesítést biztosító reverse proxy mögött tedd ki. Az alkalmazás egy közös zenekönyvtárat használ; a fiókok privát listái és előzményei felhasználónként elkülönülnek.