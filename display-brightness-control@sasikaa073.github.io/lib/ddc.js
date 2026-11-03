// DDC/CI access through the ddcutil command line tool.
//
// Every call is asynchronous so the shell never blocks on the I2C bus
// (a single ddcutil call typically takes 50-500 ms). Writes are coalesced
// per display: while one setvcp is in flight only the latest requested value
// is kept, so dragging a slider never builds up a backlog.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const VCP_BRIGHTNESS = 0x10;
export const VCP_CONTRAST = 0x12;

const READ_FEATURES = [VCP_BRIGHTNESS, VCP_CONTRAST];

function hex(code) {
    return code.toString(16).padStart(2, '0');
}

export function findDdcutil() {
    return GLib.find_program_in_path('ddcutil');
}

export async function runDdcutil(args, cancellable = null) {
    const ddcutil = findDdcutil();
    if (!ddcutil)
        throw new Error('ddcutil is not installed');

    const proc = Gio.Subprocess.new([ddcutil, ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);

    if (!proc.get_successful()) {
        const detail = (stderr || stdout || '').trim().split('\n').pop();
        throw new Error(`ddcutil ${args.join(' ')} failed: ${detail}`);
    }
    return stdout;
}

/**
 * Parses `ddcutil detect --brief`. Only valid "Display N" blocks are
 * returned; "Invalid display" / "Phantom display" blocks are skipped.
 *
 * @param {string} text
 * @returns {{bus: number, connector: string, vendor: string, product: string, serial: string}[]}
 */
export function parseDetect(text) {
    const displays = [];
    let current = null;

    for (const line of text.split('\n')) {
        if (/^Display \d+/.test(line)) {
            current = {bus: -1, connector: '', vendor: '', product: '', serial: ''};
            displays.push(current);
            continue;
        }
        if (/^\S/.test(line)) {
            current = null;
            continue;
        }
        if (!current)
            continue;

        const match = line.match(/^\s+([^:]+):\s*(.*)$/);
        if (!match)
            continue;
        const [, key, value] = match;

        if (key === 'I2C bus') {
            const bus = value.match(/i2c-(\d+)/);
            if (bus)
                current.bus = Number(bus[1]);
        } else if (key === 'DRM connector') {
            // "card2-HDMI-A-5" -> "HDMI-A-5"
            current.connector = value.replace(/^card\d+-/, '').trim();
        } else if (key === 'Monitor') {
            // "MFG:Model name:Serial"
            const parts = value.split(':');
            current.vendor = (parts.shift() ?? '').trim();
            current.serial = (parts.length > 1 ? parts.pop() : '').trim();
            current.product = parts.join(':').trim();
        }
    }

    return displays.filter(d => d.bus >= 0);
}

/**
 * Parses `ddcutil getvcp <codes...> --brief`, e.g. "VCP 10 C 70 100".
 *
 * @param {string} text
 * @returns {Map<number, {current: number, max: number}>}
 */
export function parseGetvcp(text) {
    const values = new Map();
    for (const line of text.split('\n')) {
        const match = line.match(/^VCP\s+([0-9a-fA-F]{2})\s+C\s+(\d+)\s+(\d+)/);
        if (match && Number(match[3]) > 0)
            values.set(parseInt(match[1], 16), {current: Number(match[2]), max: Number(match[3])});
    }
    return values;
}

/**
 * Normalizes connector names so DRM names ("HDMI-A-5") compare equal to
 * Mutter names ("HDMI-5").
 *
 * @param {string} name
 */
export function normalizeConnector(name) {
    return (name ?? '').toUpperCase()
        .replace(/^HDMI-A-/, 'HDMI-')
        .replace(/^DVI-[IDA]-/, 'DVI-');
}

export async function detectDisplays(cancellable = null) {
    const out = await runDdcutil(['detect', '--brief'], cancellable);
    return parseDetect(out).map(info => new DdcDisplay(info));
}

export class DdcDisplay {
    constructor(info) {
        Object.assign(this, info);
        this._values = new Map();
        this._pending = new Map();
        this._writing = false;
        this._refreshing = null;
        this._destroyed = false;
        this.onChanged = null;
    }

    get label() {
        if (this.product && this.product.startsWith(this.vendor))
            return this.product;
        return [this.vendor, this.product].filter(Boolean).join(' ') || `i2c-${this.bus}`;
    }

    /** @returns {{current: number, max: number}|undefined} */
    feature(code) {
        return this._values.get(code);
    }

    /** Re-reads brightness/contrast from the monitor. Concurrent calls share one read. */
    refresh(cancellable = null) {
        if (!this._refreshing) {
            this._refreshing = this._doRefresh(cancellable)
                .finally(() => (this._refreshing = null));
        }
        return this._refreshing;
    }

    async _doRefresh(cancellable) {
        const out = await runDdcutil(
            ['--bus', String(this.bus), 'getvcp', ...READ_FEATURES.map(hex), '--brief'],
            cancellable);
        if (this._destroyed)
            return;

        for (const [code, value] of parseGetvcp(out)) {
            // Don't clobber a value the user is changing right now.
            if (!this._pending.has(code))
                this._values.set(code, value);
        }
        this.onChanged?.();
    }

    /** Sets a VCP feature in monitor units (0..max). */
    setFeature(code, value) {
        const feature = this._values.get(code);
        if (!feature)
            return;
        value = Math.round(Math.min(Math.max(value, 0), feature.max));
        if (value === feature.current && !this._pending.has(code))
            return;

        feature.current = value;
        this._pending.set(code, value);
        this._drain();
    }

    async _drain() {
        if (this._writing)
            return;
        this._writing = true;
        try {
            while (this._pending.size > 0 && !this._destroyed) {
                const [code, value] = this._pending.entries().next().value;
                this._pending.delete(code);
                try {
                    await runDdcutil(['--bus', String(this.bus), 'setvcp', hex(code), String(value), '--noverify']);
                } catch (e) {
                    console.warn(`[display-brightness] ${this.label}: ${e.message}`);
                }
            }
        } finally {
            this._writing = false;
        }
    }

    destroy() {
        this._destroyed = true;
        this._pending.clear();
        this.onChanged = null;
    }
}
