import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import type { Decision } from './extension.js';
import { MODES, MODE_LABELS, type Mode, type Rule, cloneDefaults, parseRules } from './rules.js';

const MODE_HELP: Record<Mode, string> = {
  smart: 'Click stays a click; drag or press-and-pause scrolls',
  classic: 'Every middle press scrolls, like Windows',
  native: 'The app does its own thing (browsers, LibreOffice, Wine)',
  off: 'Middle drag means something else here',
};

/** What the extension's Describe method returns. */
interface Description {
  daemon: boolean;
  last: Decision | null;
  windows: (Decision & { ids: string[]; title: string })[];
}

function describe(callback: (info: Description | null) => void) {
  Gio.DBus.session.call(
    'org.gnome.Shell',
    '/io/github/taulit/Glide',
    'io.github.taulit.Glide',
    'Describe',
    null,
    new GLib.VariantType('(s)'),
    Gio.DBusCallFlags.NONE,
    1000,
    null,
    (conn, res) => {
      try {
        const [json] = conn!.call_finish(res).deepUnpack() as [string];
        callback(JSON.parse(json) as Description);
      } catch {
        callback(null);
      }
    },
  );
}

function modeModel(modes: readonly Mode[]) {
  return Gtk.StringList.new(modes.map(m => MODE_LABELS[m]));
}

export default class GlidePrefs extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    window.set_default_size(720, 820);
    window.add(this.generalPage(settings, window));
    window.add(this.rulesPage(settings, window));
    return Promise.resolve();
  }

  private generalPage(settings: Gio.Settings, window: Adw.PreferencesWindow) {
    const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'input-mouse-symbolic' });

    const status = new Adw.PreferencesGroup({ title: 'Status' });
    const daemonRow = new Adw.ActionRow({ title: 'glided daemon', subtitle: 'checking…' });
    const lastRow = new Adw.ActionRow({ title: 'Last middle press', subtitle: '—' });
    status.add(daemonRow);
    status.add(lastRow);
    page.add(status);

    const refresh = () =>
      describe(info => {
        if (!info) {
          daemonRow.subtitle = 'Extension not reachable (is it enabled?)';
          return;
        }
        daemonRow.subtitle = info.daemon
          ? 'Running – middle presses are routed through Glide'
          : 'Not running – start it with: systemctl --user enable --now glided';
        if (info.last) {
          const who = info.last.ids?.[0] ?? '';
          lastRow.subtitle = `${who} → ${MODE_LABELS[info.last.mode] ?? info.last.mode} (${info.last.reason})`;
        }
      });
    refresh();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      refresh();
      return GLib.SOURCE_CONTINUE;
    });
    window.connect('close-request', () => {
      GLib.source_remove(timer);
      return false;
    });

    const behaviour = new Adw.PreferencesGroup({ title: 'Behaviour' });
    const enabled = new Adw.SwitchRow({ title: 'Autoscroll' });
    settings.bind('enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviour.add(enabled);

    const defaults: Mode[] = ['smart', 'classic', 'off'];
    const mode = new Adw.ComboRow({
      title: 'Everywhere else',
      subtitle: 'Mode for apps without a rule',
      model: modeModel(defaults),
    });
    const syncMode = () => {
      mode.selected = Math.max(0, defaults.indexOf(settings.get_string('default-mode') as Mode));
    };
    syncMode();
    settings.connect('changed::default-mode', syncMode);
    mode.connect('notify::selected', () =>
      settings.set_string('default-mode', defaults[mode.selected] ?? 'smart'),
    );
    behaviour.add(mode);

    const fullscreen = new Adw.SwitchRow({
      title: 'Leave fullscreen windows alone',
      subtitle: 'Games and video players usually want the middle button',
    });
    settings.bind('fullscreen-off', fullscreen, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviour.add(fullscreen);
    page.add(behaviour);

    const feel = new Adw.PreferencesGroup({ title: 'Feel' });
    const spin = (
      key: string,
      title: string,
      subtitle: string,
      lower: number,
      upper: number,
      step: number,
      digits: number,
    ) => {
      const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step }),
      });
      settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
      feel.add(row);
    };
    spin('speed', 'Speed', 'How fast a given distance scrolls', 0.1, 5, 0.1, 1);
    spin(
      'sensitivity',
      'Sensitivity',
      'How far the indicator moves per mouse movement',
      0.1,
      5,
      0.1,
      1,
    );
    spin('dead-zone', 'Dead zone', 'Pixels around the anchor that do not scroll', 0, 80, 1, 0);
    page.add(feel);

    const how = new Adw.PreferencesGroup({
      title: 'Gestures',
      description:
        'Esc, any click or the scroll wheel stops autoscroll. While it runs the cursor turns into the indicator and stays where you started, so the same view keeps scrolling.',
    });
    for (const [title, subtitle] of [
      ['Smart: click', 'A normal middle click (open link in new tab, close tab, paste)'],
      ['Smart: hold and drag', 'Scrolls while held, stops when you let go'],
      [
        'Smart: press, pause, release',
        'Anchor appears after a moment and keeps scrolling until you click',
      ],
      ['Classic: click', 'Starts autoscroll that keeps going until you click'],
      ['Classic: hold and drag', 'Scrolls while held'],
    ])
      how.add(new Adw.ActionRow({ title, subtitle }));
    page.add(how);

    const browsers = new Adw.PreferencesGroup({
      title: 'Browsers',
      description:
        'Browsers know whether you are over a link, a text field or a canvas like Figma, so Glide lets them scroll themselves. On Linux that is switched off by default:',
    });
    browsers.add(
      new Adw.ActionRow({
        title: 'Firefox',
        subtitle: 'about:config → general.autoScroll = true (the installer does this)',
      }),
    );
    browsers.add(
      new Adw.ActionRow({
        title: 'Chrome, Brave, Chromium, Electron',
        subtitle:
          'Start with --enable-blink-features=MiddleClickAutoscroll (e.g. in ~/.config/chrome-flags.conf)',
      }),
    );
    page.add(browsers);
    return page;
  }

  private rulesPage(settings: Gio.Settings, window: Adw.PreferencesWindow) {
    const page = new Adw.PreferencesPage({ title: 'Apps', icon_name: 'view-list-symbolic' });
    let rules = parseRules(settings.get_string('rules'));
    const save = () => settings.set_string('rules', JSON.stringify(rules));

    const open = new Adw.PreferencesGroup({
      title: 'Open windows',
      description: 'What a middle press does in each open window right now.',
    });
    page.add(open);
    let openRows: Adw.ActionRow[] = [];

    const list = new Adw.PreferencesGroup({
      title: 'Rules',
      description:
        'The first matching rule wins. Match is a regular expression on the app id or WM class (shown above), Title optionally narrows it to some windows.',
    });
    const header = new Gtk.Box({ spacing: 6 });
    const addButton = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: 'Add rule',
      css_classes: ['flat'],
    });
    const resetButton = new Gtk.Button({
      label: 'Reset',
      tooltip_text: 'Restore the built-in rules',
      css_classes: ['flat'],
    });
    header.append(resetButton);
    header.append(addButton);
    list.set_header_suffix(header);
    page.add(list);
    let ruleRows: Adw.ExpanderRow[] = [];

    const rebuild = () => {
      ruleRows.forEach(r => list.remove(r));
      ruleRows = rules.map((rule, i) =>
        this.ruleRow(
          rule,
          () => {
            rules.splice(i, 1);
            save();
            rebuild();
          },
          save,
        ),
      );
      ruleRows.forEach(r => list.add(r));
    };

    const addRule = (rule: Rule) => {
      rules.unshift(rule);
      save();
      rebuild();
      if (ruleRows[0]) ruleRows[0].expanded = true;
    };
    addButton.connect('clicked', () => addRule({ name: 'New rule', match: '', mode: 'off' }));
    resetButton.connect('clicked', () => {
      rules = cloneDefaults();
      settings.set_string('rules', '');
      rebuild();
    });

    const refreshOpen = () =>
      describe(info => {
        openRows.forEach(r => open.remove(r));
        openRows = [];
        const seen = new Set<string>();
        for (const w of info?.windows ?? []) {
          const key = w.ids.join(' ');
          if (seen.has(key)) continue;
          seen.add(key);
          const firstId = w.ids[0] ?? '';
          const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(w.title || firstId || '?', -1),
            subtitle: GLib.markup_escape_text(
              `${w.ids.join(' · ')}\n${MODE_LABELS[w.mode]} — ${w.reason}`,
              -1,
            ),
          });
          const btn = new Gtk.Button({
            label: 'Add rule',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
          });
          btn.connect('clicked', () => {
            const id = firstId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            addRule({ name: firstId, match: `^${id}$`, mode: w.mode === 'off' ? 'smart' : 'off' });
          });
          row.add_suffix(btn);
          open.add(row);
          openRows.push(row);
        }
        if (!openRows.length) {
          const row = new Adw.ActionRow({ title: info ? 'No windows' : 'Extension not reachable' });
          open.add(row);
          openRows.push(row);
        }
      });
    refreshOpen();
    settings.connect('changed::rules', refreshOpen);
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
      refreshOpen();
      return GLib.SOURCE_CONTINUE;
    });
    window.connect('close-request', () => {
      GLib.source_remove(timer);
      return false;
    });

    rebuild();
    return page;
  }

  private ruleRow(rule: Rule, onDelete: () => void, onChange: () => void) {
    const row = new Adw.ExpanderRow({
      title: GLib.markup_escape_text(rule.name || rule.match || 'Unnamed', -1),
      subtitle: MODE_LABELS[rule.mode],
    });
    const entry = (title: string, key: 'name' | 'match' | 'title') => {
      const e = new Adw.EntryRow({ title, text: rule[key] ?? '' });
      e.connect('changed', () => {
        rule[key] = e.text;
        if (key === 'name') row.title = GLib.markup_escape_text(e.text || 'Unnamed', -1);
        let valid = true;
        if (key !== 'name') {
          try {
            new RegExp(e.text, 'i');
          } catch {
            valid = false;
          }
        }
        if (valid) e.remove_css_class('error');
        else e.add_css_class('error');
        onChange();
      });
      row.add_row(e);
    };
    entry('Name', 'name');
    entry('Match (app id / WM class)', 'match');
    entry('Title (optional)', 'title');

    const mode = new Adw.ComboRow({
      title: 'Mode',
      model: modeModel(MODES),
      selected: MODES.indexOf(rule.mode),
    });
    mode.subtitle = MODE_HELP[rule.mode];
    mode.connect('notify::selected', () => {
      rule.mode = MODES[mode.selected] ?? 'off';
      row.subtitle = MODE_LABELS[rule.mode];
      mode.subtitle = MODE_HELP[rule.mode];
      onChange();
    });
    row.add_row(mode);

    const del = new Adw.ButtonRow({ title: 'Remove rule', css_classes: ['destructive-action'] });
    del.connect('activated', onDelete);
    row.add_row(del);
    return row;
  }
}
