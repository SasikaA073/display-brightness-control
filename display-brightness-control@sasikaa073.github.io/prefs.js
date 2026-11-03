import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUTS = [
    ['brightness-up', 'Increase brightness'],
    ['brightness-down', 'Decrease brightness'],
    ['show-popup', 'Open brightness popup at cursor'],
];

export default class DisplayBrightnessPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);

        const step = new Adw.SpinRow({
            title: 'Brightness step',
            subtitle: 'Percent per key press',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 25, step_increment: 1}),
        });
        settings.bind('step', step, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(step);

        const keys = new Adw.SwitchRow({
            title: 'Brightness keys follow the cursor',
            subtitle: 'The keyboard brightness keys change the display under the mouse cursor',
        });
        settings.bind('take-over-brightness-keys', keys, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(keys);

        const software = new Adw.SwitchRow({
            title: 'Software dimming fallback',
            subtitle: 'Dim displays that do not support DDC/CI with an overlay',
        });
        settings.bind('software-dimming', software, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(software);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'GTK accelerator syntax, e.g. <Control><Super>Page_Up. Leave empty to disable.',
        });
        page.add(shortcuts);
        for (const [key, title] of SHORTCUTS)
            shortcuts.add(this._shortcutRow(settings, key, title));

        const status = new Adw.PreferencesGroup({title: 'Status'});
        page.add(status);
        status.add(new Adw.ActionRow({
            title: 'ddcutil',
            subtitle: GLib.find_program_in_path('ddcutil') ?? 'Not installed: sudo apt install ddcutil',
        }));
    }

    _shortcutRow(settings, key, title) {
        const row = new Adw.EntryRow({title, show_apply_button: true});
        const load = () => (row.text = settings.get_strv(key)[0] ?? '');
        load();

        row.connect('changed', () => {
            const text = row.text.trim();
            const [ok] = text ? Gtk.accelerator_parse(text) : [true];
            if (ok)
                row.remove_css_class('error');
            else
                row.add_css_class('error');
        });
        row.connect('apply', () => {
            const text = row.text.trim();
            if (text && !Gtk.accelerator_parse(text)[0])
                return;
            settings.set_strv(key, text ? [text] : []);
        });
        settings.connect(`changed::${key}`, load);
        return row;
    }
}
