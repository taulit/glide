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

export const MODES = ['smart', 'classic', 'native', 'off'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  smart: 'Smart',
  classic: 'Classic (Windows)',
  native: 'App handles it',
  off: 'Off',
};

export interface Rule {
  name: string;
  /** Regular expression on the app id, WM class or instance (case-insensitive). */
  match: string;
  /** Optional regular expression on the window title. */
  title?: string;
  mode: Mode;
}

export function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

/** Matched case-insensitively against the window's app id, WM class and instance. */
export const DEFAULT_RULES: readonly Rule[] = [
  {
    name: 'Firefox and forks',
    match:
      '^(firefox|firefox-esr|firefox-developer-edition|org\\.mozilla\\.firefox|librewolf|io\\.gitlab\\.librewolf-community|zen|app\\.zen_browser\\.zen|floorp|waterfox|mullvadbrowser|tor-browser)$',
    mode: 'native',
  },
  {
    name: 'Chromium browsers',
    match:
      '^(google-chrome(-beta|-unstable)?|com\\.google\\.chrome|chromium(-browser)?|org\\.chromium\\.chromium|brave-browser(-beta|-nightly)?|com\\.brave\\.browser|vivaldi(-stable)?|com\\.vivaldi\\.vivaldi|microsoft-edge(-stable|-beta|-dev)?|com\\.microsoft\\.edge|opera|thorium-browser|helium)$',
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
    match:
      '^(evince|org\\.gnome\\.evince|papers|org\\.gnome\\.papers|okular|org\\.kde\\.okular|zathura|org\\.pwmt\\.zathura)$',
    mode: 'native',
  },
  {
    name: 'Design and canvas apps',
    match:
      '^(figma-linux|figma|gimp.*|org\\.gimp\\.gimp|inkscape|org\\.inkscape\\.inkscape|krita|org\\.kde\\.krita|penpot.*|darktable|rawtherapee|pinta|com\\.github\\.pintaproject\\.pinta|drawio|draw\\.io|com\\.jgraph\\.drawio\\.desktop|excalidraw|xournalpp|com\\.github\\.xournalpp\\.xournalpp|rnote|com\\.github\\.flxzt\\.rnote|obs|com\\.obsproject\\.studio|kdenlive|org\\.kde\\.kdenlive|shotcut|davinci.*|resolve)$',
    mode: 'off',
  },
  {
    name: '3D, CAD and electronics',
    match:
      '^(blender|org\\.blender\\.blender|freecad|org\\.freecad\\.freecad|kicad|pcbnew|eeschema|org\\.kicad\\.kicad|openscad|org\\.openscad\\.openscad|prusa-?slicer|com\\.prusa3d\\.prusaslicer|orca-?slicer|bambu-?studio|ultimaker-cura|cura|godot.*|org\\.godotengine\\.godot|unity.*|unrealeditor|sweethome3d|meshlab|f3d)$',
    mode: 'off',
  },
  {
    name: 'Code editors with middle-drag box selection',
    match:
      '^(code|code-oss|code-url-handler|com\\.visualstudio\\.code|vscodium|codium|com\\.vscodium\\.codium|cursor|windsurf)$',
    mode: 'off',
  },
  {
    name: 'Remote desktops and virtual machines',
    match:
      '^(virt-manager|virt-viewer|remote-viewer|org\\.remmina\\.remmina|remmina|org\\.gnome\\.connections|org\\.gnome\\.boxes|gnome-boxes|vncviewer|tigervnc.*|xfreerdp|wlfreerdp|sdl-freerdp|com\\.moonlight_stream\\.moonlight|moonlight|parsecd|parsec|rustdesk|anydesk|teamviewer|qemu.*|virtualbox.*|virtualboxvm|looking-glass-client|com\\.realvnc\\.vncviewer)$',
    mode: 'off',
  },
  {
    name: 'Games and emulators',
    match:
      '^(steam_app_\\d+|steam_proton|gamescope|minecraft.*|com\\.mojang\\.minecraft.*|net-minecraft-.*|prismlauncher|retroarch|dolphin-emu|org\\.dolphinemu\\.dolphinemu|pcsx2|rpcs3|ryujinx|osu!?|veloren.*|factorio|cs2|dota2|hl2_linux)$',
    mode: 'off',
  },
];

export function cloneDefaults(): Rule[] {
  return DEFAULT_RULES.map(rule => ({ ...rule }));
}

function isRule(value: unknown): value is Rule {
  const r = value as Partial<Rule> | null;
  return !!r && typeof r.match === 'string' && isMode(r.mode);
}

export function parseRules(json: string): Rule[] {
  if (!json) return cloneDefaults();
  try {
    const rules: unknown = JSON.parse(json);
    if (Array.isArray(rules)) return rules.filter(isRule);
  } catch (e) {
    console.warn(`Glide: invalid rules JSON, using defaults: ${e}`);
  }
  return cloneDefaults();
}

function regex(source: string | undefined): RegExp | null {
  try {
    return source ? new RegExp(source, 'i') : null;
  } catch {
    return null;
  }
}

export type RuleMatcher = (ids: string[], title: string) => Rule | null;

/**
 * Compiles rules once. `ids` are the identifiers of one window (app id, WM class,
 * instance, …).
 */
export function compileRules(rules: Rule[]): RuleMatcher {
  const compiled = rules.flatMap(rule => {
    const match = regex(rule.match);
    return match ? [{ rule, match, title: regex(rule.title) }] : [];
  });
  return (ids, title) => {
    for (const c of compiled) {
      if (!ids.some(id => id && c.match.test(id))) continue;
      if (c.title && !c.title.test(title)) continue;
      return c.rule;
    }
    return null;
  };
}
