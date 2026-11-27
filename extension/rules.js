// Rules decide per window what a middle press does. Shared by the extension and the prefs
// window, so this file must not import anything from gnome-shell.
//
// Modes:
//   smart   – a click stays a normal middle click (paste, open link in new tab, close tab);
//             dragging with the button held, or pressing and pausing, starts autoscroll.
//   classic – Windows behaviour: every middle press starts autoscroll.
//   native  – the app has its own autoscroll / middle-button handling (browsers know whether
//             you are over a link, a text field or a canvas like Figma); Glide stays out.
//   off     – Glide stays out because middle drag means something else here (pan, orbit,
//             box selection, remote input, games).

export const MODES = ['smart', 'classic', 'native', 'off'];

export const MODE_LABELS = {
    smart: 'Smart',
    classic: 'Classic (Windows)',
    native: 'App handles it',
    off: 'Off',
};

/** Matched case-insensitively against the window's app id, WM class and instance. */
export const DEFAULT_RULES = [
    {
        name: 'Firefox and forks',
        match: '^(firefox|firefox-esr|firefox-developer-edition|org\\.mozilla\\.firefox|librewolf|io\\.gitlab\\.librewolf-community|zen|app\\.zen_browser\\.zen|floorp|waterfox|mullvadbrowser|tor-browser)$',
        mode: 'native',
    },
    {
        name: 'Chromium browsers',
        match: '^(google-chrome(-beta|-unstable)?|com\\.google\\.chrome|chromium(-browser)?|org\\.chromium\\.chromium|brave-browser(-beta|-nightly)?|com\\.brave\\.browser|vivaldi(-stable)?|com\\.vivaldi\\.vivaldi|microsoft-edge(-stable|-beta|-dev)?|com\\.microsoft\\.edge|opera|thorium-browser|helium)$',
        mode: 'native',
    },
    {
        name: 'LibreOffice',
        match: '^(libreoffice.*|soffice|org\\.libreoffice\\.libreoffice)$',
        mode: 'native',
    },
    {
        name: 'Windows apps (Wine, Proton)',
        match: '\\.exe$',
        mode: 'native',
    },
    {
        name: 'Document viewers with middle-drag panning',
        match: '^(evince|org\\.gnome\\.evince|papers|org\\.gnome\\.papers|okular|org\\.kde\\.okular|zathura|org\\.pwmt\\.zathura)$',
        mode: 'native',
    },
    {
        name: 'Design and canvas apps',
        match: '^(figma-linux|figma|gimp.*|org\\.gimp\\.gimp|inkscape|org\\.inkscape\\.inkscape|krita|org\\.kde\\.krita|penpot.*|darktable|rawtherapee|pinta|com\\.github\\.pintaproject\\.pinta|drawio|draw\\.io|com\\.jgraph\\.drawio\\.desktop|excalidraw|xournalpp|com\\.github\\.xournalpp\\.xournalpp|rnote|com\\.github\\.flxzt\\.rnote|obs|com\\.obsproject\\.studio|kdenlive|org\\.kde\\.kdenlive|shotcut|davinci.*|resolve)$',
        mode: 'off',
    },
    {
        name: '3D, CAD and electronics',
        match: '^(blender|org\\.blender\\.blender|freecad|org\\.freecad\\.freecad|kicad|pcbnew|eeschema|org\\.kicad\\.kicad|openscad|org\\.openscad\\.openscad|prusa-?slicer|com\\.prusa3d\\.prusaslicer|orca-?slicer|bambu-?studio|ultimaker-cura|cura|godot.*|org\\.godotengine\\.godot|unity.*|unrealeditor|sweethome3d|meshlab|f3d)$',
        mode: 'off',
    },
    {
        name: 'Code editors with middle-drag box selection',
        match: '^(code|code-oss|code-url-handler|com\\.visualstudio\\.code|vscodium|codium|com\\.vscodium\\.codium|cursor|windsurf)$',
        mode: 'off',
    },
    {
        name: 'Remote desktops and virtual machines',
        match: '^(virt-manager|virt-viewer|remote-viewer|org\\.remmina\\.remmina|remmina|org\\.gnome\\.connections|org\\.gnome\\.boxes|gnome-boxes|vncviewer|tigervnc.*|xfreerdp|wlfreerdp|sdl-freerdp|com\\.moonlight_stream\\.moonlight|moonlight|parsecd|parsec|rustdesk|anydesk|teamviewer|qemu.*|virtualbox.*|virtualboxvm|looking-glass-client|com\\.realvnc\\.vncviewer)$',
        mode: 'off',
    },
    {
        name: 'Games and emulators',
        match: '^(steam_app_\\d+|steam_proton|gamescope|minecraft.*|com\\.mojang\\.minecraft.*|net-minecraft-.*|prismlauncher|retroarch|dolphin-emu|org\\.dolphinemu\\.dolphinemu|pcsx2|rpcs3|ryujinx|osu!?|veloren.*|factorio|cs2|dota2|hl2_linux)$',
        mode: 'off',
    },
];

export function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_RULES));
}

export function parseRules(json) {
    if (!json)
        return cloneDefaults();
    try {
        const rules = JSON.parse(json);
        if (Array.isArray(rules))
            return rules.filter(r => r && typeof r.match === 'string' && MODES.includes(r.mode));
    } catch (e) {
        console.warn(`Glide: invalid rules JSON, using defaults: ${e}`);
    }
    return cloneDefaults();
}

function regex(source) {
    try {
        return source ? new RegExp(source, 'i') : null;
    } catch {
        return null;
    }
}

/**
 * Compiles rules once; returns `(ids, title) => rule | null`.
 * `ids` are the identifiers of one window (app id, WM class, instance, …).
 */
export function compileRules(rules) {
    const compiled = rules
        .map(rule => ({rule, match: regex(rule.match), title: regex(rule.title)}))
        .filter(c => c.match);
    return (ids, title) => {
        for (const c of compiled) {
            if (!ids.some(id => id && c.match.test(id)))
                continue;
            if (c.title && !c.title.test(title ?? ''))
                continue;
            return c.rule;
        }
        return null;
    };
}
