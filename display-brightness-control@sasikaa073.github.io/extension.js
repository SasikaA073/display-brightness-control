// Display Brightness Control: MonitorControl-style brightness for GNOME.
//
// - External monitors are driven over DDC/CI (ddcutil).
// - Built-in panels go through GNOME's own brightness manager.
// - Displays without DDC/CI fall back to a software dimming overlay.
// - The brightness keys / shortcuts act on the display under the mouse
//   cursor, and a popup with that display's sliders opens at the cursor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Ddc from './lib/ddc.js';
import {BuiltinControl, DdcControl, NoControl, SoftwareControl} from './lib/controls.js';
import {DisplaySection} from './lib/ui.js';

const SYSTEM_KEYBINDINGS = 'org.gnome.shell.keybindings';
const SYSTEM_KEYS = [
    ['screen-brightness-up', +1],
    ['screen-brightness-down', -1],
];
const OWN_KEYS = [
    ['brightness-up', +1],
    ['brightness-down', -1],
];
const HOTPLUG_DETECT_DELAY_MS = 1500;
const STORE_DELAY_MS = 500;

export default class DisplayBrightnessExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._controls = new Map();
        this._ddcDisplays = [];
        this._ddcState = Ddc.findDdcutil() ? 'detecting' : 'missing';
        this._detectGeneration = 0;
        this._cancellable = new Gio.Cancellable();
        this._softwareLevels = this._settings.get_value('software-levels').deepUnpack();

        this._buildIndicator();
        this._buildCursorPopup();
        this._addKeybindings();

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._rebuild();
            this._scheduleDetect(HOTPLUG_DETECT_DELAY_MS);
        }, this);
        Main.brightnessManager?.connectObject('changed', () => this._rebuild(), this);
        this._settings.connectObject(
            'changed::software-dimming', () => this._rebuild(),
            'changed::take-over-brightness-keys', () => this._updateSystemKeys(),
            this);

        this._rebuild();
        if (this._ddcState === 'detecting')
            this._detect();
    }

    disable() {
        this._cancellable.cancel();
        for (const id of [this._detectTimeoutId, this._storeTimeoutId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._detectTimeoutId = this._storeTimeoutId = 0;
        this._flushSoftwareLevels();

        this._removeKeybindings();

        this._popupMenu.removeAll();
        this._indicator.menu.removeAll();
        Main.layoutManager.disconnectObject(this);
        Main.brightnessManager?.disconnectObject(this);
        this._settings.disconnectObject(this);

        for (const control of this._controls.values())
            control.destroy();
        this._controls.clear();
        for (const d of this._ddcDisplays)
            d.destroy();
        this._ddcDisplays = [];

        this._popupManager = null;
        this._popupMenu.destroy();
        this._popupMenu = null;
        this._popupAnchor.destroy();
        this._popupAnchor = null;

        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    // ---- DDC detection -------------------------------------------------

    _scheduleDetect(delay) {
        if (this._ddcState === 'missing')
            return;
        if (this._detectTimeoutId)
            GLib.source_remove(this._detectTimeoutId);
        this._detectTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._detectTimeoutId = 0;
            this._detect();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _detect() {
        const generation = ++this._detectGeneration;
        let displays = [];
        try {
            displays = await Ddc.detectDisplays(this._cancellable);
            await Promise.all(displays.map(d => d.refresh(this._cancellable).catch(e =>
                console.warn(`[display-brightness] ${d.label}: ${e.message}`))));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`[display-brightness] detection failed: ${e.message}`);
        }

        // A newer detection (or disable()) superseded this one.
        if (generation !== this._detectGeneration || this._cancellable.is_cancelled()) {
            displays.forEach(d => d.destroy());
            return;
        }

        this._ddcDisplays.forEach(d => d.destroy());
        // Only keep displays that actually answered a brightness read.
        this._ddcDisplays = displays.filter(d => {
            const ok = !!d.feature(Ddc.VCP_BRIGHTNESS);
            if (!ok)
                d.destroy();
            return ok;
        });
        this._ddcState = 'ready';
        this._rebuild();
    }

    // ---- Display/control mapping ---------------------------------------

    _takeDdcFor(monitor, available) {
        const connector = Ddc.normalizeConnector(monitor.get_connector());
        const serial = monitor.get_serial();
        const vendor = monitor.get_vendor();
        const product = monitor.get_product();

        let i = available.findIndex(d => Ddc.normalizeConnector(d.connector) === connector);
        if (i < 0 && serial)
            i = available.findIndex(d => d.serial === serial && d.vendor === vendor);
        if (i < 0) {
            const same = available.filter(d => d.vendor === vendor && d.product === product);
            if (same.length === 1)
                i = available.indexOf(same[0]);
        }
        return i < 0 ? null : available.splice(i, 1)[0];
    }

    _softwareKey(monitor) {
        return `${monitor.get_connector()}:${monitor.get_serial() ?? ''}`;
    }

    _rebuild() {
        // Tear down the menus first: their sliders hold signal connections
        // to the old controls.
        if (this._popupMenu.isOpen)
            this._popupMenu.close(BoxPointer.PopupAnimation.NONE);
        this._popupMenu.removeAll();
        this._indicator.menu.removeAll();

        for (const control of this._controls.values())
            control.destroy();
        this._controls.clear();

        const scales = Main.brightnessManager?.scales ?? [];
        const available = [...this._ddcDisplays];
        const softwareDimming = this._settings.get_boolean('software-dimming');
        const logicalMonitors = global.backend.get_monitor_manager().get_logical_monitors();

        for (const lm of logicalMonitors) {
            const index = lm.get_number();
            const monitors = lm.get_monitors();
            if (!monitors.length || !Main.layoutManager.monitors[index])
                continue;
            const name = monitors[0].get_display_name() || monitors[0].get_connector();

            let control = null;
            const scale = scales.find(s => s.monitor === lm);
            if (scale) {
                control = new BuiltinControl(index, name, scale);
            } else {
                const ddc = monitors.map(m => this._takeDdcFor(m, available)).filter(Boolean);
                if (ddc.length) {
                    control = new DdcControl(index, name, ddc);
                } else if (softwareDimming && this._ddcState !== 'detecting') {
                    const key = this._softwareKey(monitors[0]);
                    control = new SoftwareControl(index, name, this._softwareLevels[key] ?? 1,
                        value => this._storeSoftwareLevel(key, value));
                } else if (this._ddcState !== 'detecting') {
                    control = new NoControl(index, name);
                }
            }
            if (control)
                this._controls.set(index, control);
        }

        this._rebuildIndicatorMenu();
    }

    _storeSoftwareLevel(key, value) {
        this._softwareLevels[key] = value;
        if (this._storeTimeoutId)
            return;
        this._storeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STORE_DELAY_MS, () => {
            this._storeTimeoutId = 0;
            this._flushSoftwareLevels();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushSoftwareLevels() {
        this._settings?.set_value('software-levels',
            new GLib.Variant('a{sd}', this._softwareLevels));
    }

    // ---- Cursor handling -----------------------------------------------

    _cursorMonitorIndex() {
        const lm = global.backend.get_current_logical_monitor?.();
        return lm ? lm.get_number() : global.display.get_current_monitor();
    }

    _cursorControl() {
        return this._controls.get(this._cursorMonitorIndex()) ?? null;
    }

    async _stepUnderCursor(direction) {
        const control = this._cursorControl();
        if (!control || control.brightness === null)
            return;

        await control.refreshIfStale();
        if (!this._controls || this._controls.get(control.index) !== control)
            return;

        const step = this._settings.get_int('step') / 100;
        // Snap to the step grid so repeated presses land on round values.
        const current = control.brightness;
        const next = direction > 0
            ? Math.floor((current + 1e-6) / step) * step + step
            : Math.ceil((current - 1e-6) / step) * step - step;
        control.brightness = Math.clamp(next, 0, 1);

        if (!control.showsOwnOsd) {
            Main.osdWindowManager.showOne(control.index,
                Gio.ThemedIcon.new('display-brightness-symbolic'),
                control.name, control.brightness, 1);
        }
    }

    // ---- Keybindings ---------------------------------------------------

    _addKeybindings() {
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
        for (const [name, direction] of OWN_KEYS) {
            Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE, mode,
                () => this._stepUnderCursor(direction));
        }
        Main.wm.addKeybinding('show-popup', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._openCursorPopup());

        this._systemKeysOverridden = false;
        this._updateSystemKeys();
    }

    _removeKeybindings() {
        for (const [name] of OWN_KEYS)
            Main.wm.removeKeybinding(name);
        Main.wm.removeKeybinding('show-popup');
        this._restoreSystemKeys();
    }

    // GNOME 50 binds the hardware brightness keys inside the shell
    // (BrightnessManager). Re-bind them so they act on the display under
    // the cursor, like MonitorControl on macOS.
    _updateSystemKeys() {
        const bm = Main.brightnessManager;
        if (!bm)
            return;

        const wanted = this._settings.get_boolean('take-over-brightness-keys');
        if (wanted === this._systemKeysOverridden)
            return;

        const systemSettings = new Gio.Settings({schema_id: SYSTEM_KEYBINDINGS});
        for (const [name, direction] of SYSTEM_KEYS) {
            Main.wm.removeKeybinding(name);
            const handler = wanted
                ? () => this._stepUnderCursor(direction)
                : () => this._systemStep(bm, direction);
            Main.wm.addKeybinding(name, systemSettings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL, handler);
        }
        this._systemKeysOverridden = wanted;
    }

    _restoreSystemKeys() {
        if (!this._systemKeysOverridden)
            return;
        const bm = Main.brightnessManager;
        const systemSettings = new Gio.Settings({schema_id: SYSTEM_KEYBINDINGS});
        for (const [name, direction] of SYSTEM_KEYS) {
            Main.wm.removeKeybinding(name);
            Main.wm.addKeybinding(name, systemSettings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL, () => this._systemStep(bm, direction));
        }
        this._systemKeysOverridden = false;
    }

    // Same behaviour as GNOME's own handlers (global scale step).
    _systemStep(bm, direction) {
        if (direction > 0)
            bm._screenBrightnessUp ? bm._screenBrightnessUp() : bm.globalScale?.stepUp();
        else
            bm._screenBrightnessDown ? bm._screenBrightnessDown() : bm.globalScale?.stepDown();
    }

    // ---- Panel indicator -----------------------------------------------

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'system-status-icon',
        }));
        this._indicator.menu.actor.add_style_class_name('display-brightness-menu');
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshAll();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _rebuildIndicatorMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        if (this._controls.size === 0 && this._ddcState === 'detecting')
            menu.addMenuItem(new PopupMenu.PopupMenuItem('Detecting displays…', {reactive: false}));

        let first = true;
        for (const control of [...this._controls.values()].sort((a, b) => a.index - b.index)) {
            if (!first)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            first = false;
            menu.addMenuItem(new DisplaySection(control));
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._ddcState === 'missing') {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'Install ddcutil to control external monitors', {reactive: false}));
        } else if (this._ddcState === 'detecting' && this._controls.size > 0) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem('Detecting DDC/CI monitors…', {reactive: false}));
        }
        menu.addAction('Re-detect displays', () => {
            if (this._ddcState === 'missing' && Ddc.findDdcutil())
                this._ddcState = 'ready';
            this._scheduleDetect(0);
        });
        menu.addAction('Settings', () => this.openPreferences());
    }

    _refreshAll() {
        for (const control of this._controls.values())
            control.refresh();
    }

    // ---- Popup at the cursor -------------------------------------------

    _buildCursorPopup() {
        this._popupAnchor = new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
        Main.layoutManager.uiGroup.add_child(this._popupAnchor);

        this._popupMenu = new PopupMenu.PopupMenu(this._popupAnchor, 0.5, St.Side.TOP);
        this._popupMenu.actor.add_style_class_name('display-brightness-menu');
        Main.layoutManager.uiGroup.add_child(this._popupMenu.actor);
        this._popupMenu.actor.hide();

        this._popupManager = new PopupMenu.PopupMenuManager(this._popupAnchor);
        this._popupManager.addMenu(this._popupMenu);
    }

    _openCursorPopup() {
        if (this._popupMenu.isOpen) {
            this._popupMenu.close(BoxPointer.PopupAnimation.FULL);
            return;
        }
        const control = this._cursorControl();
        if (!control)
            return;

        const [x, y] = global.get_pointer();
        this._popupAnchor.set_position(x, y);

        this._popupMenu.removeAll();
        const section = new DisplaySection(control, {underCursor: true});
        this._popupMenu.addMenuItem(section);
        this._popupMenu.open(BoxPointer.PopupAnimation.FULL);
        section.brightnessItem?.grab_key_focus();
        control.refresh();
    }
}
