# Faster Movement

The player walks, runs and sprints faster: x2 by default, 0.5 to 3, with separate jog and sprint speeds, sprint modes (hold, toggle, auto, always) and a boat speed. A PBZModLoader mod; settings in a text file in its folder, or on its Mods Menu page.

A [PBZModLoader](https://github.com/KintaroModding/phantombladezero_pbzmodloader) mod for Phantom Blade Zero (Unreal Engine
5.7), made with game version `CL-302256_JKS-17280` and PBZModLoader 2.1.0. This README is for developers.
What the mod does, how to install it and its compatibility are in [openmods.md](openmods.md), the mod page on
[openmods](https://openmods.nexus).

## How it works

The game runs much of its logic in JavaScript (Puerts). PBZModLoader loads every folder in
`ProjectPBZ/PBZModLoader/mods/` that has a `main.js`, through the game's own module system, after the game's
`MainStart`; `require("ue")`, `require("puerts")` and `require("Library/TsHelper")` are the game's modules, and
`puerts.argv.getByName("GameInstance")` gives the game instance. Before a reload (Alt+F5) the loader awaits the mod's
`stop()`, which must give back everything the mod changed.

The logic is the author's earlier Mods Menu script 1.4.0, unchanged except where a comment says "1.0 (port)". At
load it starts a 500 ms poll and a 16 ms key timer:

- **Speed:** the poll puts the game's own timed attribute effects `GE_MA_<WalkSpeed|JogSpeed|SprintSpeed>_0_Mul`
  (`HasDuration`, SetByCaller magnitude `AttributeOpMagnitude`, 1,000,000 s) on the player through
  `AbilitySystemBlueprintLibrary.MakeSpecHandle` and `BP_ApplyGameplayEffectSpecToSelf`. A timed effect changes the
  current value only, so base values and saves stay stock. When the game clears them (death, rest, load) or the speed
  changes, the poll removes the rest and puts new ones on. If a base value moves anyway, the mod puts it back and stops.
- **Super Sprint:** its effect `GE_Talent_SuperSprint` overrides SprintSpeed with a flat 950; the mod scales that value
  in the effect's class default object, so Super Sprint keeps pace with the sprint multiplier.
- **Sprint modes:** Toggle, Auto and Always hold the game's own sprint action (`IA_Sprint`) through Enhanced Input
  injection, only while the player's own move input is not zero and no blocking state (crouch, forced walk, ship, death)
  is on.
- **Boat:** scales the steered boat's `MaxSpeed`, `MaxReverseSpeed`, `Acceleration` and `BrakingDeceleration` and puts
  them back when the player leaves it.
- **Input timer:** every 16 ms, for the sprint modes (the player's move input and the sprint key bindings).

The port (1.0):

- **Settings file:** next to `main.js`, or with Mods Menu's page the file the page saves. A missing file means the
  defaults (Speed 2, the rest stock).
- **stop():** the source's own stop (timers, sprint hold, Super Sprint, boat values), and then the timed speed effects off
  the player. The source left them on (a game restart cleared them) and keeps no state on `globalThis`, so after a
  reload the new copy would have put its own on top (x2 on x2 = x4).

1.1 (the user's choice): the source's speed keys (PageUp and PageDown, with a step list, a write into the settings file
and an on-screen tip) are gone; only the settings set the speed. The 16 ms timer stays for the sprint modes.

`tests/test_mod.js` runs the script in Node.js against a small stand-in game (19 checks).

- **Settings file:** `phantombladezero_fastermovement.txt` next to `main.js` (`__dirname`, the mod's folder as a full path), read every
  2 s with `EasyCsv.LoadStringFromLocalFile`; the mod never writes it.
  The shipped file holds the defaults with comments (`tests/test_mod.js` checks that it gives x2).
- **Mods Menu, optional:** PBZModLoader starts its mods after Mods Menu's, so a running Mods Menu (0.9.0 or later) has
  its registry object in `globalThis.PBZModsMenu` by then. Only when it has the features `settingsPath` and
  `store.saved`, the mod pushes its page (id `phantombladezero_fastermovement`, `store: "saved"`) and reads the file the page saves
  (`PBZModsMenu.settingsPath(id)`, in Mods Menu's Saved folder): a registered page cannot save anywhere else.
- **Log:** `console.log` lines that start with `[PBZMOD]` and the game's warnings reach `ProjectPBZ/PBZModLoader/loader.log`.

## Check and deploy

Requirements: Windows PowerShell 5.1 and [Node.js](https://nodejs.org/) (for `node --check` and the offline test).

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1             # node --check, tests\test_mod.js
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Deploy     # the checks, then deploy.ps1
powershell -ExecutionPolicy Bypass -File .\deploy.ps1            # copy src\phantombladezero_fastermovement to the game
```

`deploy.ps1` mirrors `src\phantombladezero_fastermovement\` to `<game folder>\ProjectPBZ\PBZModLoader\mods\phantombladezero_fastermovement\`. The
settings file that is already there is the tester's and stays; `-ResetConfig` copies the shipped one. The game folder
comes from `gameDir` in `_tools\gamedata\phantombladezero\game.json`, else `$env:UE5_GAMES_DIR\PBZ`; `-GameDir` or
`-ModsDir` override it. It stops when PBZModLoader is not installed (its start file
`ProjectPBZ\Content\JavaScript\PBZModLoader\bootstrap.js` is missing).

The GitHub release zip holds the mod folder at `ProjectPBZ/PBZModLoader/mods/phantombladezero_fastermovement/`, so players unpack it
into the game folder.

Versioning: every change raises the second number in `mod.json` and `main.js` (1.0 -> 1.1): `python scripts\bump_version.py`.

## Project layout

```
src/phantombladezero_fastermovement/   The mod folder: main.js and the shipped settings file
tests/test_mod.js     Offline test of main.js (Node.js, stand-ins for the game)
docs/                 Cover and screenshots
scripts/              bump_version.py, check_openmods.py, publish.ps1
build.ps1, deploy.ps1 Checks; copy into the game
mod.json              Name, version, game, kind pbzmodloader, modsPath
```

## License

MIT, see [LICENSE](LICENSE).
