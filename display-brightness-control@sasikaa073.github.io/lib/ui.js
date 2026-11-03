import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Kind} from './controls.js';

const KIND_LABELS = {
    [Kind.BUILTIN]: 'Built-in',
    [Kind.DDC]: 'DDC/CI',
    [Kind.SOFTWARE]: 'Software dimming',
    [Kind.NONE]: 'Not controllable',
};

/** A slider row bound to one property ('brightness' or 'contrast') of a control. */
const ControlSliderItem = GObject.registerClass(
class ControlSliderItem extends PopupMenu.PopupBaseMenuItem {
    _init(control, property, iconName, accessibleName) {
        super._init({activate: false, style_class: 'display-brightness-slider-item'});
        this._control = control;
        this._property = property;

        this.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}));

        this.slider = new Slider(0);
        this.slider.accessible_name = accessibleName;
        this.slider.x_expand = true;
        this.add_child(this.slider);

        this._valueLabel = new St.Label({
            style_class: 'display-brightness-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._valueLabel);

        this.slider.connect('notify::value', () => {
            this._updateLabel();
            if (!this._syncing)
                this._control[this._property] = this.slider.value;
        });
        control.connectObject('changed', () => this.sync(), this);
        this.sync();
    }

    sync() {
        const value = this._control[this._property];
        this._syncing = true;
        this.slider.value = value ?? 0;
        this._syncing = false;
        this.slider.reactive = value !== null;
        this._updateLabel();
    }

    _updateLabel() {
        this._valueLabel.text = this._control[this._property] === null
            ? '–' : `${Math.round(this.slider.value * 100)}%`;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right)
            return this.slider.vfunc_key_press_event(event);
        return super.vfunc_key_press_event(event);
    }
});

/** Title + sliders for one display. */
export class DisplaySection extends PopupMenu.PopupMenuSection {
    constructor(control, {underCursor = false} = {}) {
        super();
        this.control = control;

        const title = new PopupMenu.PopupMenuItem(control.name, {reactive: false});
        title.label.add_style_class_name('display-brightness-title');
        const tag = new St.Label({
            text: underCursor ? `${KIND_LABELS[control.kind]} · under cursor` : KIND_LABELS[control.kind],
            style_class: 'display-brightness-tag',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.add_child(tag);
        this.addMenuItem(title);

        this.brightnessItem = null;
        if (control.kind === Kind.NONE) {
            const hint = new PopupMenu.PopupMenuItem(
                'No DDC/CI response. Enable DDC/CI in the monitor OSD.', {reactive: false});
            hint.label.add_style_class_name('display-brightness-hint');
            this.addMenuItem(hint);
            return;
        }

        this.brightnessItem = new ControlSliderItem(control, 'brightness',
            'display-brightness-symbolic', `${control.name} brightness`);
        this.addMenuItem(this.brightnessItem);

        if (control.contrast !== null) {
            this.addMenuItem(new ControlSliderItem(control, 'contrast',
                'accessibility-high-contrast-symbolic', `${control.name} contrast`));
        }
    }
}
