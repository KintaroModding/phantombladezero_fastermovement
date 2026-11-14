// Offline test of the mod, run by build.ps1: node tests/test_mod.js
// It loads src/phantombladezero_fastermovement/main.js as PBZModLoader does (a module whose __dirname is the mod's
// folder) with stand-ins for the modules the game gives it (ue, puerts, the game's TsHelper and UIHelper) and a small
// game: the player with its ability system (it records every timed speed effect), the player controller's keys, an
// optional running Mods Menu and the settings file. It drives the mod's poll and key timers by hand and checks the
// speed effects, the PageUp/PageDown keys, stop() and a second copy after it (PBZModLoader's reload).
"use strict";
const fs = require("fs");
const path = require("path");
const Module = require("module");

const FOLDER = path.join(__dirname, "..", "src", "phantombladezero_fastermovement");
const SCRIPT = path.join(FOLDER, "main.js");
const SETTINGS = path.join(FOLDER, "phantombladezero_fastermovement.txt");
const SETTINGS_PATH = FOLDER.replace(/[\\/]+$/, "") + "/phantombladezero_fastermovement.txt";
const MENU_PATH = "C:/Game/ProjectPBZ/Saved/PBZModsMenu/Settings/phantombladezero_fastermovement.txt";
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "mod.json"), "utf8")).version;
const BASE = { WalkSpeed: 130, JogSpeed: 300, SprintSpeed: 600 };

let failed = 0;
function check(name, ok) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) {
        failed++;
    }
}

function modsMenu(world, missing = []) {
    return {
        api: { has: (feature) => !missing.includes(feature) },
        push(...mods) { world.pushed.push(...mods); return world.pushed.length; },
        settingsPath: (id) => (world.pushed.some((m) => m.id == id) ? MENU_PATH : undefined),
    };
}

// The game: the player's effects stay with it across copies of the mod.
function newGame() {
    return { effects: [], keysDown: new Set(), tips: [], loads: [] };
}
// the active speed effects of one attribute, as "multiplier" texts
const active = (game, attr) => game.effects.filter((e) => e.active && e.attr == attr).map((e) => String(e.m));

function boot(options = {}) {
    const game = options.game || newGame();
    const world = { game, now: 1000000, files: new Map(), saved: [], warnings: [], logs: [], pushed: [], cleared: [],
        loadError: undefined };
    for (const [file, text] of Object.entries(options.files || {})) {
        world.files.set(file, text);
    }
    const gameInstance = { path: "/Engine/Transient.GameInstance" };
    const pawn = { path: "/Game/Maps/Level.Level:PersistentLevel.BP_Player_C_0" };
    const asc = {
        BP_ApplyGameplayEffectSpecToSelf(spec) {
            const handle = { attr: spec.attr, m: spec.m, seconds: spec.seconds, active: true };
            game.effects.push(handle);
            return handle;
        },
        RemoveActiveGameplayEffect(handle) { handle.active = false; },
        HasMatchingGameplayTag: () => false,
    };
    const pc = { IsInputKeyDown: (key) => game.keysDown.has(key.KeyName) };
    const ue = {
        AbilitySystemBlueprintLibrary: {
            GetAbilitySystemComponent: () => asc,
            GetFloatAttributeBase: (character, attr) => BASE[attr.name],
            MakeSpecHandle: (effect) => ({ attr: /GE_MA_(\w+?)_0_Mul/.exec(effect.path)[1] }),
            AssignSetByCallerMagnitude: (spec, name, m) => Object.assign(spec, { m }),
            SetDuration: (spec, seconds) => Object.assign(spec, { seconds }),
            GetActiveGameplayEffectStackCount: (handle) => (handle.active ? 1 : 0),
        },
        PBZBlueprintFunctionLibrary: { MakeAttribute: (name) => ({ name }), GetAttributeFromCharacter: () => 0 },
        BasicAttributeSet: { StaticClass: () => "BasicAttributeSet" },
        Object: { Load: (p) => { game.loads.push(p); return p.includes("/AttributesModifyEffect/GE_MA_") ? { path: p } : null; } },
        Class: { Load: () => null },
        KismetSystemLibrary: { IsValid: (o) => !!o, GetPathName: (o) => o.path, ConvertToAbsolutePath: (p) => p },
        KismetTextLibrary: { Conv_StringToText: (s) => ({ text: s }) },
        GameplayStatics: { GetPlayerCharacter: () => pawn, GetPlayerController: () => pc },
        BlueprintPathsLibrary: { FileExists: (p) => world.files.has(p) },
        EasyCsv: {
            LoadStringFromLocalFile(p, out) { out[0] = world.files.get(p); return true; },
            SaveStringToFileWithFullPath(text, p) { world.saved.push([p, text]); world.files.set(p, text); return true; },
        },
        Key: class { constructor(name) { this.KeyName = name; } },
        EGameplayModOp: { Override: 3 },
    };
    const puerts = {
        $ref: (value) => [value],
        $unref: (box) => box[0],
        argv: { getByName: (name) => (name == "GameInstance" && !options.noGameInstance ? gameInstance : undefined) },
    };
    const stubs = { "ue": ue, "puerts": puerts, "Library/TsHelper": { default: {} },
        "Library/UIHelper": { default: { showTipsText: (p, text) => game.tips.push(text.text) } } };
    // the game's modules, also for a require() at run time (the tip's Library/UIHelper)
    const load = Module._load;
    const hooked = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return load.call(this, request, parent, isMain);
    };
    const realNow = Date.now, realWarn = console.warn, realLog = console.log;
    const enter = () => {
        Module._load = hooked;
        Date.now = () => world.now;
        console.warn = (message) => world.warnings.push(String(message));
        console.log = (message) => world.logs.push(String(message));
    };
    const leave = () => {
        Module._load = load;
        Date.now = realNow;
        console.warn = realWarn;
        console.log = realLog;
    };
    let nextTimer = 0;
    world.timers = new Map();
    globalThis.setInterval = (fn, ms) => { const id = ++nextTimer; world.timers.set(id, { fn, ms }); return id; };
    globalThis.clearInterval = (id) => { world.cleared.push(id); world.timers.delete(id); };
    globalThis.PBZModsMenu = options.menu === "array" ? [] : options.menu ? modsMenu(world, options.menuMissing) : undefined;
    world.menuGlobal = globalThis.PBZModsMenu;
    delete require.cache[require.resolve(SCRIPT)];
    enter();
    try {
        world.exports = require(SCRIPT);
    }
    catch (e) {
        world.loadError = e;
    }
    finally {
        leave();
    }
    // runs every timer of `ms` once, `ms` later
    world.run = (ms, times = 1) => {
        for (let i = 0; i < times; i++) {
            world.now += ms;
            enter();
            try {
                for (const t of [...world.timers.values()].filter((t) => t.ms == ms)) t.fn();
            }
            finally {
                leave();
            }
        }
    };
    world.polls = (count = 1) => world.run(500, count);
    world.stop = () => {
        enter();
        try {
            world.exports.stop();
        }
        finally {
            leave();
        }
    };
    return world;
}

// The module as PBZModLoader loads it, without Mods Menu.
{
    const text = fs.readFileSync(SCRIPT, "utf8");
    check("the source's Mods Menu start list and its throwing stop() are gone",
        !text.includes("__PBZLoaderEntries") && !text.includes("Restart the game to update"));
    const w = boot();
    const ms = [...w.timers.values()].map((t) => t.ms).sort((a, b) => a - b).join(",");
    check("no error at load; stop() exported; a 500 ms poll and a 16 ms key timer", !w.loadError
        && typeof w.exports.stop == "function" && ms == "16,500");
    check("one start line for loader.log, naming the settings file in the mod's folder",
        w.logs.length == 1 && w.logs[0] == `[PBZMOD] [Faster Movement] ${VERSION} started; settings: ${SETTINGS_PATH}`);
    check("no Mods Menu: no page pushed anywhere", globalThis.PBZModsMenu === undefined && w.pushed.length == 0);
    w.polls();
    check("no settings file: walk, jog and sprint x2 (the default), each as one timed effect",
        ["WalkSpeed", "JogSpeed", "SprintSpeed"].every((a) => active(w.game, a).join() == "2")
        && w.game.effects.every((e) => e.seconds == 1000000));
    const shipped = boot({ files: { [SETTINGS_PATH]: fs.readFileSync(SETTINGS, "utf8") } });
    shipped.polls();
    check("the shipped settings file (CRLF): Speed 2, Jog and Sprint the same",
        fs.readFileSync(SETTINGS, "utf8").includes("\r\n")
        && ["WalkSpeed", "JogSpeed", "SprintSpeed"].every((a) => active(shipped.game, a).join() == "2"));
}

// Live settings; no speed keys (1.1).
{
    const w = boot({ files: { [SETTINGS_PATH]: "Speed=1.5\r\nSprint=3\r\n" } });
    w.polls();
    check("Speed=1.5, Sprint=3: walk and jog x1.5, sprint x3", active(w.game, "WalkSpeed").join() == "1.5"
        && active(w.game, "JogSpeed").join() == "1.5" && active(w.game, "SprintSpeed").join() == "3");
    w.files.set(SETTINGS_PATH, "Speed=1\r\n");
    w.polls(4);
    check("Speed=1 (live): no effect left (stock)", w.game.effects.every((e) => !e.active));
    w.files.set(SETTINGS_PATH, "Speed=2\r\n");
    w.polls(4);
    for (const key of ["PageUp", "PageDown"]) {
        w.game.keysDown.add(key);
        w.run(16);
        w.game.keysDown.delete(key);
        w.run(16, 20);
    }
    w.polls();
    check("1.1: PageUp and PageDown do nothing: no step, no file write, no tip, still x2", w.saved.length == 0
        && w.game.tips.length == 0 && active(w.game, "SprintSpeed").join() == "2"
        && !fs.readFileSync(SCRIPT, "utf8").split("\n").some((l) => !l.trim().startsWith("//") && /PageUp|PageDown/.test(l)));
    const sprint = "/SGameLocomotionDriver/Input/IA_Sprint.IA_Sprint";
    const t = boot({ files: { [SETTINGS_PATH]: "SprintMode=Toggle\r\n" } });
    t.run(16);
    const before = t.game.loads.includes(sprint);
    t.polls();
    t.run(16);
    check("1.1: the 16 ms timer still runs the sprint modes (with SprintMode=Toggle read, it asks for the game's sprint action)",
        !before && t.game.loads.includes(sprint));
}

// stop(), and a second copy after it (PBZModLoader's reload).
{
    const game = newGame();
    const w = boot({ game, files: { [SETTINGS_PATH]: "Speed=2\r\n" } });
    w.polls();
    const before = active(game, "SprintSpeed").join();
    w.stop();
    check("stop(): both timers cleared, a line for loader.log, no warning", w.timers.size == 0
        && w.logs[w.logs.length - 1] == "[PBZMOD] [Faster Movement] stopped" && w.warnings.length == 0);
    check(`stop(): the speed effects taken off the player (before: x${before})`, before == "2"
        && game.effects.every((e) => !e.active));
    const again = boot({ game, files: { [SETTINGS_PATH]: "Speed=2\r\n" } });
    again.polls();
    check("a second copy after stop() (the reload): one effect per speed again, x2, not x2 on top of x2",
        !again.loadError && ["WalkSpeed", "JogSpeed", "SprintSpeed"].every((a) => active(game, a).join() == "2"));
    const plain = boot();
    plain.stop();
    check("stop() before the first poll: no warning", plain.warnings.length == 0 && plain.timers.size == 0);
}

// Mods Menu: optional.
{
    const m = boot({ menu: true, files: { [MENU_PATH]: "Speed=3\r\n" } });
    const page = m.pushed[0];
    check("Mods Menu running: one page with the mod's id, version, file, store \"saved\" and name",
        m.pushed.length == 1 && page.id == "phantombladezero_fastermovement" && page.version == VERSION
        && page.file == "phantombladezero_fastermovement.txt" && page.store == "saved" && page.title == "Faster Movement"
        && page.settings.length >= 5);
    m.polls();
    check("... the mod reads the file the page saves (Speed=3 there: x3)",
        m.logs[0] == `[PBZMOD] [Faster Movement] ${VERSION} started; settings: ${MENU_PATH} (Mods Menu's page)`
        && active(m.game, "WalkSpeed").join() == "3");
    const a = boot({ menu: "array", files: { [MENU_PATH]: "Speed=3\r\n" } });
    a.polls();
    check("Mods Menu not started yet (a plain array): nothing pushed, the mod's own file (none: x2)",
        a.menuGlobal.length == 0 && active(a.game, "WalkSpeed").join() == "2");
    const o = boot({ menu: true, menuMissing: ["store.saved"] });
    check("an older Mods Menu without store \"saved\": no page", o.pushed.length == 0);
}

// A failed start.
{
    const n = boot({ noGameInstance: true });
    check("no GameInstance: the load throws (PBZModLoader logs the mod as failed), no timer",
        !!n.loadError && n.timers.size == 0);
}

process.exit(failed ? 1 : 0);
