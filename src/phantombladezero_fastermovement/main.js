"use strict";
// Faster Movement for Phantom Blade Zero: a PBZModLoader mod (ProjectPBZ/PBZModLoader/mods/phantombladezero_fastermovement/).
//
// The logic is the author's earlier Mods Menu script 1.4.0, unchanged except where a comment says "1.0 (port)"; its own
// version notes stay in the comments. The port to PBZModLoader, which loads this file after the game's MainStart:
// - Settings: phantombladezero_fastermovement.txt in this mod's folder (__dirname). With Mods Menu (0.9.0 or later)
//   running, the mod adds its page there and reads the file that the page saves instead (pbzMoveSpeedPath): a
//   registered page cannot save anywhere else.
// - stop() (PBZModLoader's Alt+F5 reload) runs the source's own stop (timers, sprint hold, Super Sprint, boats) and then
//   also takes the timed speed effects off the player, which that stop left on: this script keeps no state on
//   globalThis, so a copy that starts later would put its own on top.
// - Log: a [PBZMOD] start and stop line for loader.log.
// 1.1: the source's PageUp/PageDown keys and their on-screen tip are gone (the user's choice): only the settings set
// the speed. The 16 ms timer stays, because the sprint modes run in it. Every place says "1.1".
const PBZ_MOVE_SPEED_VERSION = "1.1";
const PBZ_MOVE_SPEED_ID = "phantombladezero_fastermovement"; // the mod folder's name and Mods Menu's page id
let __pbzStandaloneReady = false;
let pbzMoveSpeedStop = undefined; // 1.0 (port): set by the closure below once it started
const __pbzRuntime = require("ue"), __pbzHost = require("puerts");
if (!__pbzHost.argv || !__pbzHost.argv.getByName("GameInstance") || !__pbzRuntime.KismetSystemLibrary || typeof __pbzRuntime.KismetSystemLibrary.ConvertToAbsolutePath !== "function") throw new Error("Faster Movement: runtime APIs of the game are missing");
// 1.0 (port): Mods Menu is optional. PBZModLoader starts its mods after Mods Menu's, so a running Mods Menu (0.9.0 or
// later, with settingsPath and store "saved") has its registry in globalThis.PBZModsMenu by now: the page goes there, and
// the file it saves is the one this mod reads. Without it nothing is pushed: an array left for a Mods Menu that starts
// later would give a page that saves another file than the one this mod reads.
const pbzMoveSpeedMenu = { on: false };
function pbzMoveSpeedMenuWanted() {
    const mm = globalThis.PBZModsMenu;
    return !!(mm && typeof mm === "object" && !Array.isArray(mm) && typeof mm.push === "function"
        && typeof mm.settingsPath === "function" && mm.api && typeof mm.api.has === "function"
        && mm.api.has("settingsPath") && mm.api.has("store.saved"));
}
function pbzMoveSpeedPush(page) {
    globalThis.PBZModsMenu.push(page);
    pbzMoveSpeedMenu.on = typeof globalThis.PBZModsMenu.settingsPath(PBZ_MOVE_SPEED_ID) === "string";
}
// 1.0 (port): the settings file: the one Mods Menu's page saves, else `file` next to this main.js (__dirname is the
// mod's folder, a full path, as PBZModLoader loads the mod).
function pbzMoveSpeedPath(file) {
    if (pbzMoveSpeedMenu.on) {
        const path = globalThis.PBZModsMenu.settingsPath(PBZ_MOVE_SPEED_ID);
        if (typeof path === "string" && path)
            return path;
    }
    return __pbzRuntime.KismetSystemLibrary.ConvertToAbsolutePath(String(__dirname).replace(/[\\/]+$/, "") + "/" + file);
}
// Faster Movement: begin. Faster walking, running and sprinting for the player character only.
// Puts the game's own timed attribute effect (GE_MA_<attr>_0_Mul: HasDuration, SetByCaller magnitude) on the player's
// WalkSpeed, JogSpeed and SprintSpeed. A timed effect changes the current value only, so base values and saves stay stock.
// The speed comes from the settings file (1.0 (port): see the head; "Speed=1.5"), re-read every 2 s (1.1: no keys).
// With no file, the multiplier baked into this variant is used.
// "Jog=" and "Sprint=" in the same file give running and sprinting their own speed; missing or "Same", they follow Speed.
// "SprintMode=" Hold (stock, also when missing), Toggle, Auto or Always: see sprintTick. "Boat=" (1, stock, when missing): see boatTick.
// Runs once, when MainStart.js requires this module at game start. Everything lives in this closure, so no stock name
// is touched, and a failure here can never stop the module above from loading.
(function pbzMoveSpeed() {
    const PBZ_MOVE_SPEED_MULTIPLIER = 2;
    const PBZ_MOVE_SPEED_ATTRIBUTES = ["WalkSpeed", "JogSpeed", "SprintSpeed"];
    // timed, never 0: a duration of 0 or less might fall back to the instant GE (_1_), which writes the base value
    const PBZ_MOVE_SPEED_SECONDS = 1000000;
    const PBZ_MOVE_SPEED_POLL_MS = 500;
    const PBZ_MOVE_SPEED_FILE_EVERY = 4; // polls, so the settings file is read every 2 s
    const PBZ_MOVE_SPEED_KEY_MS = 16; // the sprint modes' input timer (1.1: no speed keys); stock JS runs 16 ms timers too
    const PBZ_MOVE_SPEED_RANGE = [0.5, 3]; // the clamp range for the file (1.1: the hotkey steps between are gone)
    const PBZ_MOVE_SPEED_FILE = "phantombladezero_fastermovement.txt"; // 1.0 (port): in this mod's folder, or Mods Menu's
    // Super Sprint, the talent that starts after 2 s of sprinting: GE_Talent_SuperSprint overrides SprintSpeed with a flat 950,
    // and a GAS override beats our multiplier, so Super Sprint gets slower than a buffed jog. We scale the 950 in the effect's
    // class default object instead, which every new Super Sprint is built from.
    const PBZ_SUPER_SPRINT_GE = "/PBZCombatAsset/Prototypes/GameplayEffects/Talent/GE_Talent_SuperSprint.GE_Talent_SuperSprint_C";
    const PBZ_SUPER_SPRINT_STOCK = 950;
    // Sprint modes hold the game's own sprint action, the one the player's locomotion ability reads
    const PBZ_SPRINT_ACTION = "/SGameLocomotionDriver/Input/IA_Sprint.IA_Sprint";
    const PBZ_SPRINT_SWITCH_ACTION = "/SGameLocomotionDriver/Input/IA_SprintSwitch.IA_SprintSwitch";
    // while any of these is on, an injected sprint could stand you up, break a forced walk or move a ship: never hold it then
    const PBZ_SPRINT_BLOCKED = ["CharacterState.Crouching", "CharacterState.StoryCameraLock.DisableSprint", "CharacterState.StoryCameraLock.ForceWalk",
        "CHaracterState.WeakWalk", "CharacterState.Native.Attitude.ForceWalk", "CharacterState.ShipNavigation", "CharacterState.Dead"];
    const PBZ_SPRINT_MOVE_MIN = 0.25; // length of the player's own move input that counts as pressing a direction (a key gives 1)
    const PBZ_SPRINT_STILL_MS = 300; // no direction this long ends a toggled sprint; a quicker change of direction keeps it
    // Always in a fight: the game's sprint off this long under our hold, with no action running, presses sprint again (1.4.0)
    const PBZ_SPRINT_LOST_MS = 200, PBZ_SPRINT_REPRESS_MS = 500;
    const PBZ_SPRINT_REPRESS_GAP_MS = 50; // let go this long before the new press, so the game sees a release between the two
    const PBZ_MOVE_SPEED_MENU_STEP = 0.05; // Mods Menu rows: Speed, Jog, Sprint and Boat move by this much
    // Boat= scales the steered boat's own speed fields (ABoat, BP_Boat: 1800, -1200, 800, 1800); 0.5 to 2
    const PBZ_BOAT_FIELDS = ["MaxSpeed", "MaxReverseSpeed", "Acceleration", "BrakingDeceleration"];
    const PBZ_BOAT_MIN = 0.5, PBZ_BOAT_MAX = 2;
    const PBZ_BOAT_RECORDS = 4; // boats with fields of ours at once; a fifth boat stays stock until one is put back
    const PBZ_BOAT_TRIES = 40; // failed put-back polls per boat (20 s) before it is dropped
    const pbzLog = (message) => { }; // the debug build swaps this line for a file logger; message() only runs there
    let timer = undefined;
    let keyTimer = undefined;
    try {
        const UE = require("ue");
        const puerts = require("puerts");
        const gameInstance = puerts.argv.getByName("GameInstance");
        const ASC = UE.AbilitySystemBlueprintLibrary;
        const stop = () => { clearInterval(timer); clearInterval(keyTimer); unholdSafe(); scaleSuperSprint(1); boatOff = true; boatPass(null, "stop"); boatLinger(); };
        const [min, max] = PBZ_MOVE_SPEED_RANGE; // 1.1
        // character path name -> { m: the speeds it got, as text; handles }. A string key, so a new JS wrapper for the same actor cannot buff it twice.
        const buffs = new Map();
        let errors = 0;
        let polls = 0;
        let speed = PBZ_MOVE_SPEED_MULTIPLIER;
        let path; // 1.1: without the keys only the file sets the speed, so no last file value is kept
        // Jog= and Sprint= from the file; null follows Speed
        let jog = null, sprint = null;
        let sprintMode = "Hold"; // SprintMode= from the file
        let boatSpeed = 1; // Boat= from the file; 1 (stock) when missing
        // the multiplier for each of PBZ_MOVE_SPEED_ATTRIBUTES: walking always follows Speed
        const wanted = () => [speed, jog ?? speed, sprint ?? speed];
        const named = (want) => "walk x" + want[0] + " jog x" + want[1] + " sprint x" + want[2];
        const base = (character, attr) => ASC.GetFloatAttributeBase(character, attr, puerts.$ref(false));
        const attribute = (name) => UE.PBZBlueprintFunctionLibrary.MakeAttribute(name, UE.BasicAttributeSet.StaticClass());
        const attrs = (character) => PBZ_MOVE_SPEED_ATTRIBUTES.map((name) => name + " base " + base(character, attribute(name))
            + " cur " + UE.PBZBlueprintFunctionLibrary.GetAttributeFromCharacter(character, attribute(name))).join(", ");
        const effects = {};
        const effect = (name) => effects[name] ??= UE.Object.Load(`/PBZCombatAsset/Config/AttributesModifyEffect/GE_MA_${name}_0_Mul.GE_MA_${name}_0_Mul`);
        // ours are on, at the wanted speeds; an attribute at 1 (stock) gets none
        const current = (mine) => { let want = wanted(); return !!mine && mine.m == named(want)
            && mine.handles.length == want.filter((m) => m != 1).length && mine.handles.every((h) => ASC.GetActiveGameplayEffectStackCount(h) > 0); };
        const keyLine = (key) => new RegExp("^([ \\t]*" + key + "[ \\t]*=)([^\\r\\n]*)", "im");
        const SPEED_LINE = keyLine("speed"), JOG_LINE = keyLine("jog"), SPRINT_LINE = keyLine("sprint"), MODE_LINE = keyLine("sprintmode"), BOAT_LINE = keyLine("boat");
        // SprintMode: Hold when the line is missing or empty, undefined (keep the one before) when it is not a mode
        function parseMode(text) {
            let line = MODE_LINE.exec(text);
            let m = line ? /^\s*(hold|toggle|auto|always)?\s*([;#]|$)/i.exec(line[2]) : ["", "hold"];
            return !m ? undefined : !m[1] ? "Hold" : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        }
        // "Speed=1.5", also "1,5" and "x2"; clamped to min..max; undefined (ignored) when unreadable.
        // Jog and Sprint: null (follow Speed) when the line is missing, empty or "Same", each with an optional comment after it
        function parse(text, re, lo = min, hi = max) {
            let line = re.exec(text);
            if (re !== SPEED_LINE && (!line || /^\s*(same)?\s*([;#]|$)/i.test(line[2])))
                return null;
            let v = line ? parseFloat(line[2].replace(",", ".").replace(/^\s*x/i, "")) : NaN;
            return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
        }
        // the file's text now: undefined when it is missing, null when it could not be read (locked mid-save)
        function load() {
            // check first: EasyCsv logs an error for a missing file
            if (!UE.BlueprintPathsLibrary.FileExists(path))
                return undefined;
            let out = puerts.$ref("");
            return UE.EasyCsv.LoadStringFromLocalFile(path, out) ? puerts.$unref(out) : null;
        }
        function readSettings() {
            try {
                if (path === undefined) {
                    path = pbzMoveSpeedPath(PBZ_MOVE_SPEED_FILE); // 1.0 (port)
                    pbzLog(() => "settings file " + path + " (exists " + UE.BlueprintPathsLibrary.FileExists(path) + ")");
                }
                let text = load();
                if (text === null) {
                    pbzLog(() => "read failed, speed stays x" + speed);
                    return; // try again next time
                }
                let v = text === undefined ? PBZ_MOVE_SPEED_MULTIPLIER : parse(text, SPEED_LINE);
                // an unreadable Jog or Sprint value keeps the one before, as Speed does
                let j = text === undefined ? null : parse(text, JOG_LINE);
                let s = text === undefined ? null : parse(text, SPRINT_LINE);
                let mode = text === undefined ? "Hold" : parseMode(text);
                // Boat: missing, empty or Same is stock (1); unreadable keeps the one before
                let b = text === undefined ? null : parse(text, BOAT_LINE, PBZ_BOAT_MIN, PBZ_BOAT_MAX);
                pbzLog(() => "read " + (text === undefined ? "no file" : [SPEED_LINE, JOG_LINE, SPRINT_LINE, MODE_LINE, BOAT_LINE].map((re) => JSON.stringify((re.exec(text) || ["-"])[0])).join(" "))
                    + " -> " + (v === undefined ? "ignored" : "x" + v) + (v !== undefined && v !== speed ? " (changed)" : "")
                    + ", jog " + (j === undefined ? "ignored" : j ?? "same") + ", sprint " + (s === undefined ? "ignored" : s ?? "same")
                    + ", sprint mode " + (mode ?? "ignored") + ", boat " + (b === undefined ? "ignored" : "x" + (b ?? 1)));
                if (b !== undefined)
                    boatSpeed = b ?? 1;
                if (mode !== undefined && mode !== sprintMode) {
                    sprintMode = mode;
                    jogUntilStill = false; // a tap-to-run in the old mode does not carry over, even if no sprint poll saw the one in between
                }
                if (v !== undefined) // 1.1
                    speed = v;
                if (j !== undefined)
                    jog = j;
                if (s !== undefined)
                    sprint = s;
            }
            catch (e) {
                pbzLog(() => "read threw, speed stays x" + speed + ": " + e);
            }
        }
        function apply(character) {
            let key = UE.KismetSystemLibrary.GetPathName(character);
            let old = buffs.get(key);
            if (current(old))
                return;
            let asc = ASC.GetAbilitySystemComponent(character);
            if (!asc)
                return; // not set up yet (spawn, load): try again next poll
            if (!PBZ_MOVE_SPEED_ATTRIBUTES.map(effect).every((ge) => ge)) {
                // a patch moved or renamed the effects: leave the game stock
                pbzLog(() => "GE_MA effect missing, stopped");
                return stop();
            }
            // the speed changed, or the game cleared some or all of ours (death, rest, load): drop the rest first so nothing stacks
            for (let h of old ? old.handles : [])
                asc.RemoveActiveGameplayEffect(h, -1);
            let want = wanted();
            let mine = { m: named(want), handles: [] };
            buffs.set(key, mine); // before adding, so a throw halfway is cleaned up next poll
            pbzLog(() => "apply " + mine.m + " to " + key + (old ? " (had " + old.m + ", stacks "
                + old.handles.map((h) => ASC.GetActiveGameplayEffectStackCount(h)).join("/") + ")" : ""));
            for (let i = 0; i < PBZ_MOVE_SPEED_ATTRIBUTES.length; i++) {
                if (want[i] == 1)
                    continue; // stock: nothing to put on
                let name = PBZ_MOVE_SPEED_ATTRIBUTES[i];
                let attr = attribute(name);
                let before = base(character, attr);
                // AttributeUtils.AddAttributeBuff ran as an instant effect in game (base 130 -> 260, no active handle),
                // so build the timed spec ourselves: the game's own HasDuration GE, SetByCaller magnitude, locked duration
                let spec = ASC.MakeSpecHandle(effect(name), character, character, 1);
                spec = ASC.AssignSetByCallerMagnitude(spec, "AttributeOpMagnitude", want[i]);
                spec = ASC.SetDuration(spec, PBZ_MOVE_SPEED_SECONDS);
                mine.handles.push(asc.BP_ApplyGameplayEffectSpecToSelf(spec));
                if (base(character, attr) != before) {
                    // the buff landed on the base value, which the save may keep and the next poll would compound:
                    // put the base back, take ours off and stop for this session
                    UE.AttributeUtils.ModifyCharacterAttributeValue(character, attr, UE.EGameplayModOp.Override, before);
                    for (let h of mine.handles)
                        asc.RemoveActiveGameplayEffect(h, -1);
                    pbzLog(() => name + " base moved " + before + " -> " + base(character, attr) + ", restored and stopped");
                    return stop();
                }
            }
            pbzLog(() => "now " + attrs(character));
        }
        // the Super Sprint class, null once it is missing or cannot be patched (then Super Sprint stays stock)
        let superSprint = undefined;
        let superSprintSeen = false; // the first value read was the stock 950
        let superSprintThrew = false; // logged once
        // puts Super Sprint's SprintSpeed override at stock x m. A Super Sprint already running keeps its speed until the next.
        // shortcut: if the game's JS restarts inside one process, the old value is not 950 and Super Sprint stays at it; fine
        // unless that restart turns out to happen.
        function scaleSuperSprint(m) {
            try {
                if (superSprint === undefined)
                    superSprint = UE.Class.Load(PBZ_SUPER_SPRINT_GE) || null;
                if (!superSprint)
                    return;
                let mods = UE.SGameAIFunctionLibrary.GetClassDefaultObject(superSprint).Modifiers;
                for (let i = 0; i < mods.Num(); i++) {
                    let mod = mods.Get(i);
                    if (mod.Attribute.AttributeName != "SprintSpeed" || mod.ModifierOp != UE.EGameplayModOp.Override)
                        continue;
                    let magnitude = mod.ModifierMagnitude;
                    let flat = magnitude.ScalableFloatMagnitude;
                    let want = PBZ_SUPER_SPRINT_STOCK * m;
                    if (Math.abs(flat.Value - want) < 0.01)
                        return;
                    if (!superSprintSeen && Math.abs(flat.Value - PBZ_SUPER_SPRINT_STOCK) >= 0.01)
                        break; // not the stock 950: a patch changed it, leave it alone
                    superSprintSeen = true;
                    // struct values can come back as copies, so write every level back
                    flat.Value = want;
                    magnitude.ScalableFloatMagnitude = flat;
                    mod.ModifierMagnitude = magnitude;
                    mods.Set(i, mod);
                    let now = mods.Get(i).ModifierMagnitude.ScalableFloatMagnitude.Value;
                    pbzLog(() => "Super Sprint SprintSpeed override x" + m + " -> " + now);
                    if (Math.abs(now - want) >= 0.01)
                        superSprint = null; // the write did not reach the class: stop trying
                    return;
                }
                pbzLog(() => "Super Sprint override not found or not stock, left alone");
                superSprint = null;
            }
            catch (e) {
                // keep the class and retry next poll: the write may have landed before the throw, and only a later call can
                // put it back to stock (x1 or stop). Once the value matches, the call returns before writing again.
                if (!superSprintThrew)
                    pbzLog(() => "Super Sprint threw, retrying each poll: " + e);
                superSprintThrew = true;
            }
        }
        // Boat speed. The boat the player steers (ShipNavigationSystem.GetCurrentBoat, not the scripted GetSeqBoat) gets MaxSpeed,
        // MaxReverseSpeed, Acceleration and BrakingDeceleration at its class default x Boat, on that actor only. The boat's Tick
        // reads all four every frame, and auto navigation (docking) steers to its own target speed (native speed update, build
        // 26367565, research/boat-speed-2026-11-06.md). The class default is never written, so the next boat spawns stock and
        // nothing reaches a save. One record per boat object; at[i] is the multiplier field i is at by our write (1: stock,
        // null: the game set it, or the boat was not stock when found, so it is left alone). A put-back is read back field by
        // field; one that does not land stays ours at the old multiplier and is retried each poll, at most PBZ_BOAT_TRIES times.
        const boats = []; // { actor, key, stock, at, tried: a write not yet read back, per field, m: the multiplier last reached, tries }
        let boatOff = false; // a scale write failed, a put-back was dropped, 20 boat errors, or the mod stopped: stock for the session
        let boatErrors = 0, boatSteered = null, boatFullLogged = false;
        const boatNear = (a, b) => Math.abs(a - b) < 0.01;
        const boatFields = (r) => PBZ_BOAT_FIELDS.map((f) => f + " " + r.actor[f]).join(", ");
        // a dead wrapper throws "passing a invalid object", even inside IsValid (skill lessons): gone too; anything else is not
        function boatGone(actor) {
            try { return !UE.KismetSystemLibrary.IsValid(actor); }
            catch (e) { if (/invalid object/.test(String(e))) return true; throw e; }
        }
        // record r toward stock x m; returns the fields that did not land. A field no longer at our last write is the game's from then on
        function boatSet(r, m) {
            let missed = [];
            PBZ_BOAT_FIELDS.forEach((f, i) => {
                // a write that threw before its read-back may have landed: settle it from the field first
                if (r.tried[i] !== null) {
                    if (r.at[i] !== null && boatNear(r.actor[f], r.stock[i] * r.tried[i]))
                        r.at[i] = r.tried[i];
                    r.tried[i] = null;
                }
                if (r.at[i] === null || r.at[i] == m)
                    return;
                if (!boatNear(r.actor[f], r.stock[i] * r.at[i]))
                    return r.at[i] = null;
                r.tried[i] = m;
                r.actor[f] = r.stock[i] * m;
                if (boatNear(r.actor[f], r.stock[i] * m))
                    r.at[i] = m;
                else
                    missed.push(f); // still ours at the old multiplier
                r.tried[i] = null;
            });
            return missed;
        }
        function boatForget(r, why) {
            boats.splice(boats.indexOf(r), 1);
            if (why)
                pbzLog(() => "boat " + r.key + " " + why);
        }
        function boatFail(r, m, why) {
            if (m != 1) {
                // the write did not reach the actor: what landed goes back on the next pass, and every boat stays stock
                boatOff = true;
                return pbzLog(() => "boat " + r.key + " x" + r.m + " -> x" + m + " failed, boats stay stock this session: " + why);
            }
            if (++r.tries == 1)
                pbzLog(() => "boat " + r.key + " put-back failed, retrying each poll: " + why);
            if (r.tries >= PBZ_BOAT_TRIES) {
                boatOff = true; // a setter that fails 40 times will not write the next boat either
                boatForget(r, "put-back dropped after " + r.tries + " tries: " + PBZ_BOAT_FIELDS.filter((f, i) => r.at[i] !== null && r.at[i] != 1).join(", "));
            }
        }
        // every record: the steered boat goes to Boat, the rest back to stock (why: the reason logged). Never throws.
        function boatPass(steered, why) {
            for (let r of boats.slice()) {
                let m = r.actor === steered ? boatSpeed : 1; // off: boatPoll steers nothing
                try {
                    if (boatGone(r.actor)) {
                        boatForget(r, "gone");
                        continue;
                    }
                    if (r.at.every((a) => a === null || a == m) && r.tried.every((x) => x === null)) {
                        if (m == 1)
                            boatForget(r); // nothing of ours on it
                        continue;
                    }
                    let missed = boatSet(r, m);
                    if (missed.length) {
                        boatFail(r, m, "did not land: " + missed.join(", "));
                        continue;
                    }
                    let from = r.m;
                    r.m = m;
                    if (m != 1 || r.actor === steered)
                        pbzLog(() => "boat " + r.key + " x" + from + " -> x" + m + ": " + boatFields(r));
                    if (m == 1)
                        boatForget(r, r.actor === steered ? "" : "put back (" + why + "): " + boatFields(r));
                }
                catch (e) {
                    boatFail(r, m, "threw: " + e);
                }
            }
        }
        // after stop(): put-backs only, until every record is done; each fails at most PBZ_BOAT_TRIES times, so it ends within 20 s
        function boatLinger() {
            if (!boats.length)
                return;
            let t = setInterval(() => {
                boatPass(null, "stop");
                if (!boats.length)
                    clearInterval(t);
            }, PBZ_MOVE_SPEED_POLL_MS);
        }
        // the boat the player steers now, with a record when Boat is not 1; null when none or it is the scripted boat
        function boatTick(character) {
            let ship = UE.SubsystemBlueprintLibrary.GetWorldSubsystem(character, UE.ShipNavigationSystem.StaticClass());
            let actor = ship && ship.IsInNavigation() ? ship.GetCurrentBoat() : null;
            if (!actor)
                return null;
            let key = UE.KismetSystemLibrary.GetPathName(actor), seq = ship.GetSeqBoat();
            if (seq && UE.KismetSystemLibrary.GetPathName(seq) == key)
                return null;
            // the same object; a second wrapper of it only while the old one still reads alive (a live path is unique), never a
            // new actor under the path of a destroyed one
            let r = boats.find((b) => b.actor === actor) || boats.find((b) => b.key == key && !boatGone(b.actor));
            if (r)
                r.actor = actor;
            else if (boatSpeed != 1 && !boatOff) {
                if (boats.length >= PBZ_BOAT_RECORDS) {
                    if (!boatFullLogged)
                        pbzLog(() => "boat " + key + " stays stock: " + boats.length + " boats still wait for a put-back");
                    boatFullLogged = true;
                    return actor;
                }
                let cdo = UE.SGameAIFunctionLibrary.GetClassDefaultObject(actor.GetClass());
                let stock = PBZ_BOAT_FIELDS.map((f) => cdo[f]);
                // the stock shape (top speed and rates above 0, reverse below) with the actor still at it: else the game or a
                // patch set this boat's speed itself, and it is left alone
                let skip = !(stock[0] > 0 && stock[1] < 0 && stock[2] > 0 && stock[3] > 0) || PBZ_BOAT_FIELDS.some((f, i) => !boatNear(actor[f], stock[i]));
                r = { actor, key, stock, at: stock.map(() => skip ? null : 1), tried: stock.map(() => null), m: 1, tries: 0 };
                boats.push(r);
                pbzLog(() => "boat " + key + (skip ? " left alone, " : " stock ") + PBZ_BOAT_FIELDS.map((f, i) => f + " " + stock[i] + (skip ? "/" + actor[f] : "")).join(", "));
            }
            return actor;
        }
        // one poll of boat speed. Boat=1 (or off) with nothing of ours anywhere makes no boat call at all
        function boatPoll(character, why) {
            if (!character || boatOff || boatSpeed == 1 && !boats.length)
                boatSteered = null;
            else {
                // own try: a boat failure costs the boat speed only, and a one-off throw keeps the boat it had
                try {
                    boatSteered = boatTick(character);
                    boatErrors = 0;
                }
                catch (e) {
                    pbzLog(() => "boat threw: " + e);
                    if (++boatErrors >= 20)
                        boatOff = true; // a patch removed the class: put back and stay stock
                }
            }
            boatPass(boatSteered, why);
        }
        function tick() {
            try {
                if (!gameInstance || !UE.KismetSystemLibrary.IsValid(gameInstance))
                    return boatPoll(null, "no game instance");
                if (polls++ % PBZ_MOVE_SPEED_FILE_EVERY == 0)
                    readSettings();
                scaleSuperSprint(sprint ?? speed); // Super Sprint is a sprint: it follows Sprint
                // the player character only: enemies, NPCs and vehicles never get the buff
                let character = UE.GameplayStatics.GetPlayerCharacter(gameInstance, 0);
                if (character)
                    apply(character);
                boatPoll(character, character ? "left" : "no player");
                if (character && polls % 20 == 1)
                    pbzLog(() => "status " + named(wanted()) + ": " + attrs(character) + "; " + sprintStatus(character) + "; boat x" + boatSpeed
                        + (boats.some((r) => r.actor === boatSteered) ? " at x" + boats.find((r) => r.actor === boatSteered).m + ", speed " + Math.round(boatSteered.GetSpeed()) : ""));
                errors = 0;
            }
            catch (e) {
                pbzLog(() => "tick threw: " + e);
                if (++errors >= 20)
                    stop();
            }
        }
        // shortcut: polls every 500 ms because no free file gets a pawn-spawn or GE-removed event; switch if one does.
        timer = setInterval(tick, PBZ_MOVE_SPEED_POLL_MS);

        // 1.1: the PageUp/PageDown keys, their speed steps and their tip are gone (the user's choice). This 16 ms timer stays:
        // it is the sprint modes' input poll (sprintSafe below).
        let keyErrors = 0;
        function keys() {
            try {
                let pc = gameInstance && UE.GameplayStatics.GetPlayerController(gameInstance, 0);
                keyErrors = 0;
                sprintSafe(pc);
            }
            catch (e) {
                pbzLog(() => "keys threw: " + e);
                unholdSafe(); // a held sprint must never outlive the poll that can let it go
                if (++keyErrors >= 20)
                    clearInterval(keyTimer);
            }
        }

        // Sprint modes. Hold is stock, and then nothing below runs. Toggle: press the sprint key while moving and you keep
        // sprinting, Super Sprint included, after you let go; press it again, or stop moving, to end it. Auto: out of combat
        // you sprint whenever you move; a press of sprint jogs until you next stop. Always: Auto in combat too, where a sprint press
        // is left to the game (keyboard Shift is dodge too, and a sprint attack needs sprint) and never ends the auto sprint. We hold the game's own sprint action
        // through Enhanced Input injection, and only while the player's own move input is not zero, so a player who presses
        // no direction is never moved. The keys are the game's own bindings (QueryKeysMappedToAction), keyboard and pad.
        // No binding for sprint right now (a menu, a cutscene, a ship) means the game does not want a sprint: nothing is held.
        let sprintAction = undefined, switchAction = undefined; // loaded once; null when missing
        let latched = false; // false, "key" (the player pressed sprint) or "auto"
        let jogUntilStill = false; // Auto: the player pressed sprint to stop, so no auto sprint until they stand still
        let stillAt = undefined; // when the move input last went to zero
        let sprintDown = false, switchDown = false;
        let holding = null; // the input subsystem we hold sprint on
        let sprintErrors = 0;
        let sprintWho = ""; // path name of the pawn the latch belongs to
        let dbgOn = false, attitudeSprinting = undefined; // debug build only: the game's sprint tag as last seen while we hold
        let sprintLostAt = undefined, repressAt = -Infinity; // Always in a fight: since when the game's sprint is off under our hold; our last re-press
        let regrabAt = undefined; // the re-press still waiting for its new hold (the 50 ms gap); a new pawn or leaving the fight drops the wait
        pbzLog(() => (dbgOn = true, "Attitude.Sprinting changes are logged while sprint is held"));
        // debug status only (fetched fresh, so no actor is kept alive): the bindings, the game's own sprint tag and our state
        function sprintStatus(character) {
            let pc = UE.GameplayStatics.GetPlayerController(gameInstance, 0);
            let input = pc && UE.SubsystemBlueprintLibrary.GetLocalPlayerSubSystemFromPlayerController(pc, UE.EnhancedInputLocalPlayerSubsystem.StaticClass());
            let action = UE.Object.Load(PBZ_SPRINT_ACTION), flip = UE.Object.Load(PBZ_SPRINT_SWITCH_ACTION);
            return "sprint mode " + sprintMode + ", keys [" + (input && action ? keyNames(input.QueryKeysMappedToAction(action)) : "-") + "], switch ["
                + (input && flip ? keyNames(input.QueryKeysMappedToAction(flip)) : "-") + "], latch " + latched + ", holding " + !!holding
                + ", " + groundSpeed(character);
        }
        // debug only: how fast the player really moves, and the game's two sprint state tags
        function groundSpeed(character) {
            let v = character.GetVelocity(), asc = ASC.GetAbilitySystemComponent(character);
            return "ground speed " + Math.round(Math.hypot(v.X, v.Y)) + ", tags Sprinting " + asc.HasMatchingGameplayTag(gameplayTag("CharacterState.Sprinting"))
                + " Attitude.Sprinting " + asc.HasMatchingGameplayTag(gameplayTag("CharacterState.Native.Attitude.Sprinting"));
        }
        const gameplayTag = (name) => { let t = new UE.GameplayTag(); t.TagName = name; return t; };
        let blockTags = null, combatTag = null, attitudeTag = null, actionTag = null;
        const anyDown = (pc, keys) => { for (let i = 0; i < keys.Num(); i++) if (pc.IsInputKeyDown(keys.Get(i))) return true; return false; };
        const keyNames = (keys) => { let n = []; for (let i = 0; i < keys.Num(); i++) n.push(keys.Get(i).KeyName); return n.join(" "); };
        function unhold(why) {
            if (holding) {
                holding.StopContinuousInputInjectionForAction(sprintAction);
                holding = null; // after the call: a Stop that throws is tried again next poll
                attitudeSprinting = undefined; // debug: the next hold logs its first value, also after an error stop
                pbzLog(() => "sprint hold off: " + (why || "stopped"));
            }
        }
        function unholdSafe() {
            latched = false; // an error or a stop: the next sprint needs a fresh press
            sprintLostAt = undefined; // an error can skip the re-press check that resets it: the next hold counts its own 200 ms
            try { unhold(); } catch (e) { pbzLog(() => "sprint unhold threw: " + e); }
        }
        function sprintSafe(pc) {
            if (sprintErrors >= 20) {
                if (holding)
                    unholdSafe(); // stopped for good, but a held sprint is still let go
                return;
            }
            try {
                sprintTick(pc);
                sprintErrors = 0;
            }
            catch (e) {
                pbzLog(() => "sprint threw: " + e);
                unholdSafe();
                if (++sprintErrors >= 20)
                    pbzLog(() => "sprint modes stopped for this session");
            }
        }
        function sprintTick(pc) {
            if (sprintMode == "Hold" && !holding) {
                latched = false;
                jogUntilStill = false;
                return;
            }
            if (sprintAction === undefined) {
                sprintAction = UE.Object.Load(PBZ_SPRINT_ACTION) || null;
                switchAction = UE.Object.Load(PBZ_SPRINT_SWITCH_ACTION) || null;
                blockTags = PBZ_SPRINT_BLOCKED.map(gameplayTag);
                combatTag = gameplayTag("CharacterState.InCombat");
                attitudeTag = gameplayTag("CharacterState.Native.Attitude.Sprinting");
                actionTag = gameplayTag("CharacterState.Action"); // the parent: matches every CharacterState.Action.* an attack or dodge puts on
                pbzLog(() => "sprint actions " + (sprintAction ? "found" : "MISSING") + ", switch " + (switchAction ? "found" : "missing"));
            }
            let character = pc && sprintAction && UE.GameplayStatics.GetPlayerCharacter(gameInstance, 0);
            let input = character ? UE.SubsystemBlueprintLibrary.GetLocalPlayerSubSystemFromPlayerController(pc, UE.EnhancedInputLocalPlayerSubsystem.StaticClass()) : null;
            let who = character ? UE.KismetSystemLibrary.GetPathName(character) : "";
            if (who != sprintWho) {
                latched = false; // a new pawn (load, respawn) starts without a toggle
                jogUntilStill = false;
                sprintWho = who;
                sprintLostAt = regrabAt = undefined; // a new pawn (world change) starts its own 200 ms and holds at once
            }
            let asc = input && ASC.GetAbilitySystemComponent(character);
            let loco = asc && character.GetComponentByClass(UE.LocomotionDriverComponent.StaticClass());
            let keys = loco ? input.QueryKeysMappedToAction(sprintAction) : null;
            let switchKeys = loco && switchAction ? input.QueryKeysMappedToAction(switchAction) : null;
            let move = loco ? loco.GetCurrentMoveInputRaw() : null;
            let moving = !!move && Math.hypot(move.X, move.Y, move.Z) >= PBZ_SPRINT_MOVE_MIN;
            let now = Date.now();
            stillAt = moving ? undefined : stillAt ?? now;
            let blocked = sprintMode == "Hold" ? "Hold" : !keys || keys.Num() == 0 ? "no sprint binding"
                : (PBZ_SPRINT_BLOCKED.find((name, i) => asc.HasMatchingGameplayTag(blockTags[i])) || false);
            let press = !!keys && anyDown(pc, keys), pressed = press && !sprintDown;
            let flip = !!switchKeys && anyDown(pc, switchKeys), flipped = flip && !switchDown;
            sprintDown = press;
            switchDown = flip;
            let was = latched;
            if (blocked || (!moving && Math.abs(now - stillAt) >= PBZ_SPRINT_STILL_MS)) {
                latched = false;
                jogUntilStill = false;
            }
            else if (pressed && sprintMode == "Always" && asc.HasMatchingGameplayTag(combatTag)) {
                // Always in a fight: the press is the game's (keyboard Shift is dodge too, a sprint attack needs sprint), the latch stays
                pbzLog(() => "sprint press in combat, latch stays " + latched);
            }
            else if ((flipped && !pressed) || (pressed && latched)) { // a key bound to both counts as sprint
                latched = false; // sprint pressed again: back to stock until the next press (Auto: until you stop)
                jogUntilStill = true;
            }
            else if (pressed && moving) { // a tap while still, even inside the grace, does nothing
                latched = "key";
                jogUntilStill = false;
            }
            else if (latched != "key") {
                // Auto: on while moving out of combat; Always: in combat too; Toggle never auto-starts
                latched = (sprintMode == "Always" || sprintMode == "Auto" && !asc.HasMatchingGameplayTag(combatTag)) && moving && !jogUntilStill ? "auto" : false;
            }
            if (latched !== was)
                pbzLog(() => "sprint latch " + was + " -> " + latched + (blocked ? " (" + blocked + ")" : moving ? "" : " (still)"));
            let want = !!latched && moving && !blocked;
            // after a re-press, the gap only while its own case holds (Always, in a fight): anything else holds at once, as in 1.4.0 r1
            const gap = () => regrabAt !== undefined && Math.abs(now - regrabAt) < PBZ_SPRINT_REPRESS_GAP_MS && sprintMode == "Always" && asc.HasMatchingGameplayTag(combatTag);
            if (want && !holding && !gap()) {
                holding = input; // before the call, so a throw halfway is still let go
                regrabAt = undefined;
                input.StartContinuousInputInjectionForAction(sprintAction, UE.EnhancedInputLibrary.MakeInputActionValueOfType(1, 0, 0, UE.EInputActionValueType.Boolean),
                    UE.NewArray(UE.InputModifier), UE.NewArray(UE.InputTrigger));
                pbzLog(() => "sprint hold on (" + latched + (asc.HasMatchingGameplayTag(combatTag) ? ", in combat" : "") + "), move " + Math.hypot(move.X, move.Y, move.Z).toFixed(2) + ": " + attrs(character));
            }
            else if (!want && holding) {
                pbzLog(() => "sprint before let go: " + groundSpeed(character) + ", " + attrs(character));
                unhold(blocked || (moving ? "pressed" : "no direction"));
            }
            // Always in a fight: an attack or dodge can end the game's sprint while our hold stays down, and a held button never
            // presses again (bench 2026-11-11: Attitude.Sprinting off for 3.6 s after a dodge). Sprint off 200 ms with no action
            // running: let go, and the poll after the gap holds again. Own try: a failed read costs the re-press, never the hold.
            // A hold is only on while moving (want needs it), so holding covers the move check
            try {
                if (holding && sprintMode == "Always" && asc.HasMatchingGameplayTag(combatTag)
                    && !asc.HasMatchingGameplayTag(attitudeTag) && !asc.HasMatchingGameplayTag(actionTag)) {
                    sprintLostAt ??= now;
                    if (Math.abs(now - sprintLostAt) >= PBZ_SPRINT_LOST_MS && Math.abs(now - repressAt) >= PBZ_SPRINT_REPRESS_MS) {
                        repressAt = regrabAt = now;
                        pbzLog(() => "sprint re-pressed: Sprinting false " + PBZ_SPRINT_LOST_MS + " ms while held");
                        unhold("re-press");
                    }
                }
                else
                    sprintLostAt = undefined;
            }
            catch (e) {
                sprintLostAt = undefined;
            }
            // debug only (dbgOn is set by the logger, so the release build never reads the tag): does the game drop its sprint while we hold?
            // Own try: a failed read costs the line, never the hold
            try {
                let sprinting = dbgOn && holding && asc ? asc.HasMatchingGameplayTag(gameplayTag("CharacterState.Native.Attitude.Sprinting")) : undefined;
                if (sprinting !== undefined && sprinting !== attitudeSprinting)
                    pbzLog(() => "Attitude.Sprinting " + attitudeSprinting + " -> " + sprinting + " while held (" + latched
                        + (asc.HasMatchingGameplayTag(combatTag) ? ", in combat" : "") + "), " + groundSpeed(character));
                attitudeSprinting = sprinting;
            }
            catch (e) { }
        }
        keyTimer = setInterval(keys, PBZ_MOVE_SPEED_KEY_MS);

        // Rows in the Mods Menu; a registered entry replaces the menu's built-in one for this id (1.0 (port): only while
        // Mods Menu runs). The menu only edits the settings file, which the poller reads like a hand edit. Last and in its own try, so it costs nothing else.
        try {
            // 0.5, 0.55 ... 3: 51 options plus Same, under the menu's 64; toFixed keeps float noise out of the values
            const grid = [];
            for (let i = 0; min + i * PBZ_MOVE_SPEED_MENU_STEP <= max + 1e-9; i++)
                grid.push(String(+(min + i * PBZ_MOVE_SPEED_MENU_STEP).toFixed(2)));
            // en stays the exact text of 1.3.4, so the menu's language tables still match it for the other languages
            const same = { en: "Same as Speed", "zh-Hans": "与速度相同", "zh-Hant": "與速度相同" };
            const follow = (key, label, help) => ({ key, type: "choice", label, default: "Same", slider: true,
                options: [{ value: "Same", label: same }].concat(grid.map((v) => ({ value: v, label: v }))), help });
            if (pbzMoveSpeedMenuWanted()) pbzMoveSpeedPush({ id: PBZ_MOVE_SPEED_ID, title: "Faster Movement", file: PBZ_MOVE_SPEED_FILE,
                store: "saved", version: PBZ_MOVE_SPEED_VERSION,
                description: { en: "Makes your character walk, run and sprint faster. Running and sprinting can each have their own speed, and sprint can stay on without holding the key.",
                    "zh-Hans": "加快角色行走、中速移动和高速移动的速度。中速移动和高速移动可各自设置速度，高速移动还可以不用按住按键。",
                    "zh-Hant": "加快角色行走、中速移動和高速移動的速度。中速移動和高速移動可各自設定速度，高速移動還可以不用按住按鍵。" },
                settings: [
                    { key: "Speed", type: "number", label: "Speed", min, max, step: PBZ_MOVE_SPEED_MENU_STEP, default: PBZ_MOVE_SPEED_MULTIPLIER,
                        help: "How fast you walk, run and sprint. 1 is stock, 2 is twice as fast. Attacks and dodges keep their speed." },
                    follow("Jog", { en: "Jog Speed", "zh-Hans": "中速移动速度", "zh-Hant": "中速移動速度" },
                        { en: "How fast you run without the sprint key. 1 is stock. Same as Speed follows Speed. A number gives running its own speed.",
                            "zh-Hans": "不按高速移动键时的中速移动速度。1 为原版。“与速度相同”会跟随速度。选择数字则为中速移动单独设定速度。",
                            "zh-Hant": "不按高速移動鍵時的中速移動速度。1 為原版。「與速度相同」會跟隨速度。選擇數字則為中速移動單獨設定速度。" }),
                    follow("Sprint", { en: "Sprint Speed", "zh-Hans": "高速移动速度", "zh-Hant": "高速移動速度" },
                        { en: "How fast you sprint, Super Sprint included. 1 is stock. Same as Speed follows Speed. A number gives sprinting its own speed.",
                            "zh-Hans": "高速移动的速度，包括疾速奔行。1 为原版。“与速度相同”会跟随速度。选择数字则为高速移动单独设定速度。",
                            "zh-Hant": "高速移動的速度，包括疾速奔行。1 為原版。「與速度相同」會跟隨速度。選擇數字則為高速移動單獨設定速度。" }),
                    { key: "SprintMode", type: "choice", label: { en: "Sprint Mode", "zh-Hans": "高速移动方式", "zh-Hant": "高速移動方式" }, default: "Hold",
                        options: [{ value: "Hold", label: { en: "Hold", "zh-Hans": "按住", "zh-Hant": "按住" } },
                            { value: "Toggle", label: { en: "Toggle", "zh-Hans": "切换", "zh-Hant": "切換" } },
                            { value: "Auto", label: { en: "Auto", "zh-Hans": "自动", "zh-Hant": "自動" } },
                            { value: "Always", label: { en: "Always", "zh-Hans": "始终", "zh-Hant": "始終" } }],
                        help: { en: "Hold is the game's own. Toggle: press sprint while moving and you keep sprinting, Super Sprint included, until you press it again or stop moving. Auto: out of combat you sprint whenever you move; press sprint to run instead until you stop. Always: Auto in combat too, and in a fight a sprint press does not turn it off, so sprint attacks work. Keyboard and controller.",
                            "zh-Hans": "按住为游戏原有方式。切换：移动时按一下高速移动键即可持续高速移动（含疾速奔行），再按一次或停止移动即结束。自动：非战斗中移动即高速移动，按高速移动键改为跑步，直到停下。始终：与自动相同，战斗中也生效，且战斗中按高速移动键不会取消。键盘和手柄均可。",
                            "zh-Hant": "按住為遊戲原有方式。切換：移動時按一下高速移動鍵即可持續高速移動（含疾速奔行），再按一次或停止移動即結束。自動：非戰鬥中移動即高速移動，按高速移動鍵改為跑步，直到停下。始終：與自動相同，戰鬥中也生效，且戰鬥中按高速移動鍵不會取消。鍵盤和手把均可。" } },
                    { key: "Boat", type: "number", label: { en: "Boat Speed", "zh-Hans": "船速", "zh-Hant": "船速" }, min: PBZ_BOAT_MIN, max: PBZ_BOAT_MAX,
                        step: PBZ_MOVE_SPEED_MENU_STEP, default: 1,
                        help: { en: "How fast the boat you steer goes. 1 is stock. The game's own docking and scripted rides keep their speed.",
                            "zh-Hans": "你驾驶的船的速度。1 为原版。游戏自己的靠岸和剧情乘船保持原有速度。",
                            "zh-Hant": "你駕駛的船的速度。1 為原版。遊戲自己的靠岸和劇情乘船保持原有速度。" } },
                ] });
        }
        catch (e) {
            pbzLog(() => "Mods Menu registration threw: " + e);
            console.warn(`[Faster Movement] no Mods Menu page: ${e}`); // 1.0 (port)
        }
        // 1.0 (port): PBZModLoader's stop(): the source's own stop, then the timed speed effects off the player (the
        // source's stop left them on; a copy that starts later would put its own on top). Each part in its own try.
        pbzMoveSpeedStop = function () {
            try {
                stop();
            }
            catch (e) {
                console.warn(`[Faster Movement] stop: ${e}`);
            }
            try {
                const character = UE.GameplayStatics.GetPlayerCharacter(gameInstance, 0);
                const key = character ? UE.KismetSystemLibrary.GetPathName(character) : undefined;
                const asc = character ? ASC.GetAbilitySystemComponent(character) : undefined;
                const mine = key === undefined ? undefined : buffs.get(key);
                if (asc && mine)
                    for (const h of mine.handles)
                        asc.RemoveActiveGameplayEffect(h, -1);
                buffs.clear(); // another character's are gone with it
            }
            catch (e) {
                console.warn(`[Faster Movement] stop, speed effects: ${e}`);
            }
        };
        console.log(`[PBZMOD] [Faster Movement] ${PBZ_MOVE_SPEED_VERSION} started; settings: ${pbzMoveSpeedPath(PBZ_MOVE_SPEED_FILE)}`
            + (pbzMoveSpeedMenu.on ? " (Mods Menu's page)" : "")); // 1.0 (port)
        __pbzStandaloneReady = true;
    }
    catch (e) {
        console.warn(`[Faster Movement] not started: ${e}`); // 1.0 (port)
        throw e;
    }
})();
// Faster Movement: end

if (!__pbzStandaloneReady) throw new Error("Faster Movement: not started (no GameInstance)");
// 1.0 (port): PBZModLoader awaits this before a reload (Alt+F5).
exports.stop = function () {
    if (pbzMoveSpeedStop)
        pbzMoveSpeedStop();
    console.log("[PBZMOD] [Faster Movement] stopped");
};
