# Lokális réteg a marveen checkoutban

Készült 2026-08-25-én, Zoltán kérésére. Ez a dokumentum írja le, mi tartozik az
UPSTREAM-hez (Szotasz/marveen), mi a MIÉNK (zollak fork + ez a gép), és hova kerül
mi. A fájl maga is a lokális rétegben van, tehát verziózva a forkban.

## 1. A három réteg

| Réteg | Mi tartozik ide | Git-státusz |
|---|---|---|
| **Upstream** | `src/`, `web/`, `docs/` (a `docs/local/` kivételével), `scripts/` (a `scripts/local/` kivételével), `skills/`, `seed-*`, `templates/`, `install*.sh`, `update.sh`, `package.json`, `.gitignore` | követett, upstream-ből frissül |
| **Lokális, verziózott** | `scripts/local/`, `docs/local/` | követett a forkban, upstream nem ismeri |
| **Lokális, verziózatlan** | `nas/`, `tmp/`, `store/`, `agents/`, `.env`, `CLAUDE.md`, `dist/` | kizárva |

## 2. Miért `scripts/local/` és nem `scripts/`

Ott, ahol az upstream is tesz fájlokat, két baj van. Egy jövőbeli upstream fájl
ütközhet a nevünkkel, és `git status`-ban ránézésre nem lehet megmondani, melyik
sor a miénk. Az `upstream` egyetlen `local/` alkönyvtárat sem használ egyikben sem,
ezért a rebase soha nem érinti őket, viszont a hely az marad, ahol keresed őket.

Ugyanez `docs/local/`-ra.

## 3. Miért `.git/info/exclude` és nem `.gitignore`

A `.gitignore` **upstream-tulajdonú, követett fájl**. Ha lokális mintákat írunk bele,
minden upstream-sync rebase-nél konfliktus-jelölt lesz, és előbb-utóbb valaki
feloldás közben kidobja a soraikat.

A `.git/info/exclude` soha nem kerül commitba, tehát nem ütközhet. Az ára, hogy nem
verziózott: **friss klón esetén kézzel kell visszaírni.** A jelenlegi blokk:

```
nas/
tmp/
dist.bak.*/
*.bak
*.bak-*
*.bak2-*
*.orig
```

## 4. Ami korábban veszélyes volt

Az `update.sh` a `git status --porcelain --untracked-files=no` alapján dönti el, hogy
piszkos-e a fa, de ha piszkosnak találja, `git stash push -u`-val stashel, és a `-u`
**a követetlen fájlokat is beszippantja.** A `nas/` és a `tmp/` addig nem volt kizárva,
tehát egy frissítés, ami történetesen egy módosított követett fájlt talált, a fél gigányi
dokumentumot is stashbe tolta volna, konfliktusos `stash pop` esetén pedig ott is hagyta
volna. Egy `git clean -fd` pedig nyomtalanul törölte volna mindkettőt.

A 3. pont kizárásai pontosan ezt szüntetik meg.

## 5. Backup-konvenció

**Minden módosítás előtt kell backup, de nem a módosított fájl mellé.**

| Mit mentesz | Hova | Miért |
|---|---|---|
| Sima fájl, script, config, plist | `nas/backup/<ÉÉÉÉ-HH-NN>/` | a Synology Drive szinkronizálja, tehát a mentés a NAS-ra is átmegy |
| **Titkot tartalmazó** fájl (`.env`, token, kulcs, kdbx) | `store/backup/<ÉÉÉÉ-HH-NN>/`, `chmod 600` | a `store/` NEM szinkronizálódik a NAS-ra; egy `.env` backup a `nas/`-ban a bot-tokent is kivinné |
| Adatbázis-dump | `store/backup/db/` | méret és tartalom miatt |
| Build-artefaktum (`dist` másolat) | `store/backup/dist/` | újraépíthető, semmi értelme a NAS-ra szinkronizálni |

A dátumos alkönyvtár a lényeg: így egy művelet összes mentése egy helyen van, és
látszik, mikor és mi mellé készült.

## 6. A `nas/` felosztása

| Mappa | Tartalom | Ki nyúl hozzá |
|---|---|---|
| `nas/msc/` | egyetemi anyagok | **Zoltán szerkeszti, ne mozgasd** |
| `nas/incidents/<téma>/` | incidens- és RMA-dossziék | RMA/garancia témánál ide nézz először |
| `nas/ops/` | üzemeltetési runbookok, tervek | |
| `nas/pr/` | PR- és issue-szövegek beadásra | |
| `nas/findb/` | findb elemzések, exportok | |
| `nas/upstream/` | upstream-audit anyagok (szotasz-cruft) | |
| `nas/backup/` | titkot NEM tartalmazó mentések, dátum szerint | |

Ide nem való script, kód és átmeneti fájl. Azok `scripts/local/` és `tmp/` alá mennek.

## 7. Lokális scriptek leltára

| Script | Indítja | Szerepe |
|---|---|---|
| `scripts/local/ensure-agents.sh` | `~/Library/LaunchAgents/com.marveen.agents.plist` (RunAtLoad) | reboot után elindítja a sub-ágenseket a `store/agents-desired.json` alapján |

A többi `com.marveen.*` LaunchAgent vagy upstream scriptre mutat (`scripts/channels.sh`),
vagy az admin ágens homelab-config fájára; azok nem ehhez a réteghez tartoznak.

**Ha egy lokális script útvonala változik, a plistet is át kell írni**, majd
`launchctl bootout` + `bootstrap`, és ellenőrizni a `store/ensure-agents.log`-ban,
hogy tényleg lefutott.

## 8. Worktree-k és tesztfuttatás

A tesztsuite **szándékosan megtagadja az indulást élő telepítésen** (`store/.dashboard-token`
és `store/claudeclaw.db` jelenlétére), mert mutálná a `store/`, `.env`, `.claude/skills/`
tartalmát. Ezért tesztelni csak külön worktree-ben lehet, a HOME alatt (a `/tmp` sem jó,
a hook-path guard elutasítja).

| Worktree | Ág | Szerep |
|---|---|---|
| `/Users/edgar/marveen` | `main` | az ÉLES telepítés, itt nem futnak tesztek |
| `~/marveen-worktrees/marveen-staging` | `upstream-staging` | upstream-sync staging, az `upstream-sync` skill használja; tesztfuttatásra is ez a hely |
| `~/marveen-worktrees/samu-runagent` | `pr/runagent-error-surfacing` | **elavult**, 2026-04-22 óta érintetlen, samu ágens 2026-08-25-én megszűnt |

Eldobható worktree-hez: `git worktree add -b <ág> ~/<hely> <bázis>`, a `node_modules`-t
symlinkkel be lehet hozni az élesből, futtatás után `git worktree remove --force`.
