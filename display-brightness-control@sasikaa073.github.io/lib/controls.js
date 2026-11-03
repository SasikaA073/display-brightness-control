// One "control" per GNOME logical monitor. Each control exposes brightness
// (and optionally contrast) as a 0..1 value and emits 'changed' whenever the
// value changes from any source.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import * as Ddc from './ddc.js';

const STALE_MS = 10 * 1000;
const MAX_SOFTWARE_DIM = 0.85;

export const Kind = {
    BUILTIN: 'builtin',
    DDC: 'ddc',
    SOFTWARE: 'software',
    NONE: 'none',
};

class Control extends EventEmitter {
    constructor(index, name, kind) {
        super();
        this.index = index;
        this.name = name;
        this.kind = kind;
    }

    /** @returns {number|null} 0..1, or null when unsupported */
    get brightness() {
        return null;
    }

    set brightness(_value) {}

    /** @returns {number|null} 0..1, or null when unsupported */
    get contrast() {
        return null;
    }

    set contrast(_value) {}

    /** True when GNOME itself shows the brightness OSD for this display. */
    get showsOwnOsd() {
        return false;
    }

    async refresh() {}

    async refreshIfStale() {}

    destroy() {
        this.disconnectAll();
    }
}

/** Displays GNOME already drives (laptop panels, or DDC once Mutter supports it). */
export class BuiltinControl extends Control {
    constructor(index, name, scale) {
        super(index, name, Kind.BUILTIN);
        this._scale = scale;
        this._scale.connectObject('notify::value', () => this.emit('changed'), this);
    }

    get brightness() {
        return this._scale.value;
    }

    set brightness(value) {
        this._scale.value = Math.clamp(value, 0, 1);
    }

    get showsOwnOsd() {
        return true;
    }

    destroy() {
        this._scale.disconnectObject(this);
        super.destroy();
    }
}

/** External monitors driven over DDC/CI. A mirrored logical monitor may hold several. */
export class DdcControl extends Control {
    constructor(index, name, displays) {
        super(index, name, Kind.DDC);
        this._displays = displays;
        this._lastRefresh = GLib.get_monotonic_time() / 1000;
        for (const d of displays)
            d.onChanged = () => this.emit('changed');
    }

    get hardwareLabel() {
        return this._displays.map(d => d.label).join(', ');
    }

    _get(code) {
        const feature = this._displays[0].feature(code);
        return feature ? feature.current / feature.max : null;
    }

    _set(code, value) {
        value = Math.clamp(value, 0, 1);
        for (const d of this._displays) {
            const feature = d.feature(code);
            if (feature)
                d.setFeature(code, value * feature.max);
        }
        this.emit('changed');
    }

    get brightness() {
        return this._get(Ddc.VCP_BRIGHTNESS);
    }

    set brightness(value) {
        this._set(Ddc.VCP_BRIGHTNESS, value);
    }

    get contrast() {
        return this._get(Ddc.VCP_CONTRAST);
    }

    set contrast(value) {
        this._set(Ddc.VCP_CONTRAST, value);
    }

    async refresh() {
        this._lastRefresh = GLib.get_monotonic_time() / 1000;
        await Promise.all(this._displays.map(d => d.refresh().catch(e =>
            console.warn(`[display-brightness] ${d.label}: ${e.message}`))));
    }

    async refreshIfStale() {
        if (GLib.get_monotonic_time() / 1000 - this._lastRefresh > STALE_MS)
            await this.refresh();
    }

    destroy() {
        for (const d of this._displays)
            d.onChanged = null;
        super.destroy();
    }
}

/** Fallback for displays without DDC/CI: a click-through black overlay. */
export class SoftwareControl extends Control {
    constructor(index, name, value, onStore) {
        super(index, name, Kind.SOFTWARE);
        this._onStore = onStore;

        const monitor = Main.layoutManager.monitors[index];
        this._overlay = new St.Widget({
            style_class: 'display-brightness-dimmer',
            reactive: false,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        Main.layoutManager.uiGroup.add_child(this._overlay);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, null);

        this._value = Math.clamp(value, 0, 1);
        this._apply();
    }

    _apply() {
        this._overlay.opacity = Math.round((1 - this._value) * MAX_SOFTWARE_DIM * 255);
        this._overlay.visible = this._value < 1;
    }

    get brightness() {
        return this._value;
    }

    set brightness(value) {
        this._value = Math.clamp(value, 0, 1);
        this._apply();
        this._onStore(this._value);
        this.emit('changed');
    }

    destroy() {
        this._overlay.destroy();
        super.destroy();
    }
}

/** A display we can't control (no DDC/CI, software dimming disabled). */
export class NoControl extends Control {
    constructor(index, name) {
        super(index, name, Kind.NONE);
    }
}
