'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

lib.installFormat();

function textOf(node) {
	if (!node)
		return '';
	if (node.nodeType === 3)
		return node.textContent;
	return (node.childNodes || []).map(textOf).join('');
}

function depsOf(option) {
	return option.deps.map(function(d) {
		return [ d.field, d.value instanceof RegExp ? d.value.source : d.value ];
	});
}

function dependsGroups(option) {
	const groups = [];
	for (const d of option.deps)
		(groups[d.group - 1] ||= []).push(
			[ d.field, d.value instanceof RegExp ? d.value.source : d.value ]);
	return groups;
}

function tableTitles(node) {
	let titles = [];

	function walk(n) {
		if (!n || typeof n !== 'object')
			return;

		const cls = n.nodeType === 1 && n.attrs && n.attrs['class'];
		if (typeof cls === 'string' && cls.split(/\s+/).indexOf('table-titles') !== -1)
			titles = n.childNodes.map(textOf);

		for (const child of n.childNodes || [])
			walk(child);
	}

	walk(node);
	return titles;
}

function buttonsOf(modal) {
	const buttons = [];

	function walk(node) {
		if (!node || typeof node !== 'object')
			return;

		if (node.nodeType === 1 && node.tagName === 'BUTTON')
			buttons.push(node);

		for (const child of node.childNodes || [])
			walk(child);
	}

	for (const child of modal.children || [])
		walk(child);

	return buttons;
}

function nodesByTag(node, tag) {
	const nodes = [];

	function walk(n) {
		if (!n || typeof n !== 'object')
			return;

		if (n.nodeType === 1 && n.tagName === tag.toUpperCase())
			nodes.push(n);

		for (const child of n.childNodes || [])
			walk(child);
	}

	walk(node);
	return nodes;
}

function nodesByClass(node, cls) {
	const nodes = [];

	function walk(n) {
		if (!n || typeof n !== 'object')
			return;

		if (n.nodeType === 1 && n.classList && n.classList.contains(cls))
			nodes.push(n);

		for (const child of n.childNodes || [])
			walk(child);
	}

	walk(node);
	return nodes;
}

function makeE() {
	function elementChildren(el) {
		return el.childNodes.filter(function(child) {
			return child && child.nodeType === 1;
		});
	}

	function classNames(el) {
		const cls = el.attrs && el.attrs['class'];

		return typeof cls === 'string' ? cls.split(/\s+/).filter(Boolean) : [];
	}

	function attach(parent, child) {
		if (child.nodeType === 11) {
			for (const node of child.childNodes.slice())
				attach(parent, node);
			child.childNodes = [];
			return child;
		}

		child.parentNode = parent;
		parent.childNodes.push(child);
		return child;
	}

	function matchesSelector(el, selector) {
		const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
		let m;

		while ((m = re.exec(selector)) !== null) {
			if (m[1] && el.tagName !== m[1].toUpperCase())
				return false;
			if (m[2] && !el.classList.contains(m[2]))
				return false;
			if (m[3] && !el.hasAttribute(m[3]))
				return false;
			if (m[3] && m[4] != null && el.getAttribute(m[3]) !== m[4])
				return false;
		}

		return true;
	}

	function append(el, children) {
		if (children == null || children === false)
			return;

		if (!Array.isArray(children))
			children = [ children ];

		for (const child of children) {
			if (child == null || child === false)
				continue;
			if (Array.isArray(child)) {
				append(el, child);
				continue;
			}
			attach(el, typeof child === 'object'
				? child
				: { nodeType: 3, textContent: String(child), parentNode: null });
		}
	}

	return function E(tag, attrs, children) {
		if (Array.isArray(tag)) {
			const frag = { nodeType: 11, childNodes: [] };
			frag.appendChild = function(child) {
				append(frag, child);
				return child;
			};
			append(frag, tag);
			return frag;
		}

		if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.nodeType) {
			children = attrs;
			attrs = {};
		}

		const el = {
			nodeType: 1,
			tagName: String(tag).toUpperCase(),
			attrs: attrs || {},
			childNodes: [],
			parentNode: null,
			listeners: {}
		};

		el.appendChild = function(child) {
			attach(el, child);
			return child;
		};

		el.insertBefore = function(child, ref) {
			const index = el.childNodes.indexOf(ref);

			child.parentNode = el;
			el.childNodes.splice(index === -1 ? el.childNodes.length : index, 0, child);
			return child;
		};

		el.removeChild = function(child) {
			const index = el.childNodes.indexOf(child);

			if (index !== -1)
				el.childNodes.splice(index, 1);

			child.parentNode = null;
			return child;
		};

		el.remove = function() {
			if (el.parentNode)
				el.parentNode.removeChild(el);
		};

		el.getAttribute = function(name) {
			const value = el.attrs ? el.attrs[name] : null;

			return value == null ? null : String(value);
		};

		el.setAttribute = function(name, value) {
			if (value == null)
				delete el.attrs[name];
			else
				el.attrs[name] = String(value);
		};

		el.hasAttribute = function(name) {
			return el.attrs && el.attrs[name] != null;
		};

		el.removeAttribute = function(name) {
			delete el.attrs[name];
		};

		el.classList = {
			add(name) {
				const names = classNames(el);

				if (names.indexOf(name) === -1)
					names.push(name);
				el.attrs['class'] = names.join(' ') || null;
			},
			remove(name) {
				el.attrs['class'] = classNames(el).filter(function(n) {
					return n !== name;
				}).join(' ') || null;
			},
			contains(name) {
				return classNames(el).indexOf(name) !== -1;
			}
		};

		el.addEventListener = function(type, fn) {
			(el.listeners[type] ||= []).push(fn);
		};

		el.dispatchEvent = function(ev) {
			ev.target = ev.target || el;

			for (let node = el; node; node = node.parentNode) {
				for (const fn of (node.listeners[ev.type] || []).slice())
					fn.call(node, ev);
			}

			return true;
		};

		el.querySelectorAll = function(selector) {
			const found = [];

			function walk(node) {
				for (const child of node.childNodes || []) {
					if (child.nodeType !== 1)
						continue;
					if (matchesSelector(child, selector))
						found.push(child);
					walk(child);
				}
			}

			walk(el);
			return found;
		};

		el.querySelector = function(selector) {
			return el.querySelectorAll(selector)[0] || null;
		};

		Object.defineProperty(el, 'children', {
			get() { return elementChildren(el); }
		});
		Object.defineProperty(el, 'firstElementChild', {
			get() { return elementChildren(el)[0] || null; }
		});
		Object.defineProperty(el, 'isConnected', {
			get() { return el.parentNode != null; }
		});
		Object.defineProperty(el, 'previousElementSibling', {
			get() {
				if (!el.parentNode)
					return null;
				const siblings = elementChildren(el.parentNode);
				return siblings[siblings.indexOf(el) - 1] || null;
			}
		});

		append(el, children);
		return el;
	};
}

function makeForm(registry) {
	function Option(kind, name, title, description) {
		this.__kind = kind;
		this.name = name;
		this.title = title;
		this.description = description;
		this.deps = [];
		this.values = [];
		this.default = undefined;
		this.password = false;
		this.datatype = null;
		this.onclick = null;
	}

	Option.prototype.depends = function(field, value) {
		/*
		 * LuCI ORs separate depends() calls and ANDs the keys of one object
		 * argument.  Group the flattened entries so tests can tell the two
		 * apart.
		 */
		const group = (this.dependsGroups = (this.dependsGroups || 0) + 1);
		if (field != null && typeof field === 'object') {
			for (const key of Object.keys(field))
				this.deps.push({ field: key, value: field[key], group });
		}
		else {
			this.deps.push({ field, value, group });
		}
	};

	Option.prototype.value = function(value, label) {
		this.values.push([ value, label ]);
	};

	function makeClass(kind) {
		function C(name, title, description) {
			Option.call(this, kind, name, title, description);
		}
		C.prototype = Object.create(Option.prototype);
		C.prototype.constructor = C;
		C.__kind = kind;
		return C;
	}

	const Flag = makeClass('Flag');
	const ListValue = makeClass('ListValue');
	const Value = makeClass('Value');
	const MultiValue = makeClass('MultiValue');
	const Button = makeClass('Button');
	const DummyValue = makeClass('DummyValue');

	function Section(type, title, description) {
		this.type = type;
		this.title = title;
		this.description = description;
		this.tabs = [];
		this.options = [];
	}

	Section.prototype.tab = function(name, title, description) {
		this.tabs.push({ name, title, description });
	};

	Section.prototype.taboption = function(tab, Class, name, title, description) {
		const o = new Class(name, title, description);
		o.tab = tab;
		this.options.push(o);
		registry.options[name] = o;
		return o;
	};

	function Map(config, title, description) {
		this.config = config;
		this.title = title;
		this.description = description;
		this.sections = [];
		registry.map = this;
	}

	Map.prototype.section = function(Class, type, title, description) {
		const s = new Section(Class, title, description);
		s.sectionName = type;
		this.sections.push(s);
		registry.section = s;
		return s;
	};

	/*
	 * LuCI's Map.render() and Map.save() both end in renderContents(), which
	 * rebuilds the map DOM in place and reuses this.root.  Mirror that split
	 * so a save-triggered re-render can be exercised by the tests.
	 */
	Map.prototype.renderContents = function() {
		const E = makeE();
		const mapEl = (this.root ||= E('div', { class: 'cbi-map' }));

		mapEl.childNodes = [];

		for (const sec of this.sections) {
			const sectionEl = E('div', { class: 'cbi-section' });
			const nodeEl = E('div', {
				class: sec.tabs.length ? 'cbi-section-node cbi-section-node-tabbed' : 'cbi-section-node',
				'data-section-id': 'cfg01'
			});

			function renderRow(opt) {
				return E('div', {
					class: 'cbi-value',
					'data-name': opt.name,
					'data-field': 'cbid.meshassistant.cfg01.' + opt.name
				}, [ opt.title || opt.name ]);
			}

			if (sec.tabs.length === 0) {
				for (const opt of sec.options)
					nodeEl.appendChild(renderRow(opt));
			}

			for (const tab of sec.tabs) {
				const containerEl = E('div', {
					'data-tab': tab.name,
					'data-tab-title': tab.title
				}, E('div', { class: 'cbi-tab-descr' }, [ tab.description ]));

				for (const opt of sec.options) {
					if (opt.tab === tab.name)
						containerEl.appendChild(renderRow(opt));
				}

				nodeEl.appendChild(containerEl);
			}

			/*
			 * LuCI's initTabGroup inserts the tab menu before the pane group
			 * and gives each menu item a data-tab attribute too, so selectors
			 * must not confuse a menu item with its pane.
			 */
			if (sec.tabs.length) {
				sectionEl.appendChild(E('ul', { class: 'cbi-tabmenu' },
					sec.tabs.map(function(tab) {
						return E('li', { 'data-tab': tab.name },
							E('a', { href: '#' }, [ tab.title ]));
					})));
			}

			sectionEl.appendChild(nodeEl);
			mapEl.appendChild(sectionEl);
		}

		return Promise.resolve(mapEl);
	};

	Map.prototype.render = function() {
		return Promise.resolve().then(this.renderContents.bind(this));
	};

	return {
		Map,
		TypedSection: { __kind: 'TypedSection' },
		Flag, ListValue, Value, MultiValue, Button, DummyValue
	};
}

function loadView(opts) {
	opts = opts || {};

	const viewFile = process.env.MESHASSISTANT_VIEW_JS ||
		path.join(lib.ROOT, 'htdocs/luci-static/resources/view/meshassistant.js');
	const src = fs.readFileSync(viewFile, 'utf8');
	const utils = lib.loadUtils();
	const E = makeE();
	const registry = {
		map: null,
		section: null,
		options: {},
		notifications: [],
		modals: [],
		calls: [],
		rpcCalls: [],
		reads: [],
		writes: [],
		saveApply: null,
		tabGroups: [],
		timers: [],
		clearedTimers: [],
		document: null
	};
	const form = makeForm(registry);

	const uci = {
		loaded: [],
		load(config) {
			this.loaded.push(config);
			return Promise.resolve();
		},
		sections(config, type) {
			if (config === 'network')
				return (opts.networkSections || []).filter(function(s) {
					return !type || s['.type'] === type;
				});
			return opts.wirelessSections || [];
		},
		get(config, section, option) {
			const values = (opts.uciValues || {})[config] || {};
			const sec = values[section];

			if (!sec)
				return null;

			if (option == null)
				return sec;

			return sec[option] != null ? sec[option] : null;
		},
		set() {},
		unset() {},
		save() {},
		apply() {}
	};

	const fsStub = {
		exec(command, args) {
			registry.calls.push({ command, args });

			if (opts.execReject)
				return Promise.reject(new Error('exec denied'));

			if (opts.execReplies) {
				const key = [ command ].concat(args || []).join(' ');

				if (opts.execReplies[key] !== undefined)
					return Promise.resolve(opts.execReplies[key]);
			}

			return Promise.resolve(opts.execReply || { code: 0, stdout: '' });
		},
		read(path) {
			registry.reads.push(path);

			if (opts.missingFiles && opts.missingFiles.indexOf(path) !== -1) {
				/*
				 * LuCI rejects a missing file with its fs error object:
				 * name NotFoundError, code -2 (ENOENT).
				 */
				const err = new Error('Resource not found');
				err.name = 'NotFoundError';
				err.code = -2;
				return Promise.reject(err);
			}

			if (opts.readReject)
				return Promise.reject(new Error('read denied'));

			return Promise.resolve(opts.files && opts.files[path] != null
				? opts.files[path] : '');
		},
		write(path, data, mode) {
			registry.writes.push({ path, data, mode });

			if (opts.writeReject)
				return Promise.reject(new Error('write denied'));

			return Promise.resolve();
		}
	};

	const network = {
		getWifiDevices() {
			if (opts.networkReject)
				return Promise.reject(new Error('rpc denied'));
			return Promise.resolve(opts.devices || []);
		},
		getHostHints() {
			if (opts.hostsReject)
				return Promise.reject(new Error('rpc denied'));
			return Promise.resolve(opts.hosts || { hosts: {} });
		}
	};

	const rpc = {
		declare(spec) {
			return function(iface) {
				registry.rpcCalls.push({ spec, interface: iface });

				if (spec.object === 'iwinfo') {
					const lists = (opts.iwinfo || {})[spec.method] || [];

					/*
					 * rpc.declare() unwraps the key named in `expect`, so these
					 * calls resolve to the array itself, not { results: [...] }.
					 */
					return Promise.resolve(Array.isArray(lists) ? lists : (lists[iface] || []));
				}

				if (opts.lanStatusReject)
					return Promise.reject(new Error('rpc denied'));

				return Promise.resolve(opts.lanStatus || null);
			};
		}
	};

	const ui = {
		addNotification(title, children) {
			registry.notifications.push({ title, children });
		},
		showModal(title, children) {
			const modal = { title, children, open: true };
			registry.modals.push(modal);
			return modal;
		},
		hideModal() {
			const modal = registry.modals[registry.modals.length - 1];
			if (modal)
				modal.open = false;
		},
		createHandlerFn(ctx, fn) {
			return function() {
				/*
				 * LuCI reads arguments[0].currentTarget before invoking the
				 * handler, so calling a wrapped handler without a DOM event
				 * throws.  Emulate that to catch direct calls.
				 */
				if (arguments[0] === undefined)
					throw new TypeError("Cannot read properties of undefined (reading 'currentTarget')");

				return fn.apply(ctx, arguments);
			};
		},
		tabs: {
			/*
			 * Mirrors the parts of ui.tabs that the view relies on: the tab
			 * menu is inserted before the group, the first non-empty pane
			 * becomes active.  Explicitly switching is driven through the
			 * anchor click handler like in LuCI.
			 */
			initTabGroup(panes) {
				const list = Array.prototype.slice.call(panes);

				registry.tabGroups.push(list);

				if (list.length === 0)
					return;

				const group = list[0].parentNode;
				const menu = E('ul', { class: 'cbi-tabmenu' }, list.map(function(pane) {
					const item = E('li', { 'data-tab': pane.getAttribute('data-tab') },
						E('a', { href: '#' }, [ pane.getAttribute('data-tab-title') ]));

					item.firstElementChild.click = function() {
						ui.tabs.switchTab(pane);
					};

					return item;
				}));

				group.parentNode.insertBefore(menu, group);

				for (const pane of list) {
					if (!ui.tabs.isEmptyPane(pane)) {
						pane.setAttribute('data-tab-active', 'true');
						break;
					}
				}
			},
			isEmptyPane(pane) {
				return !pane.children.some(function(child) {
					return !child.classList.contains('hidden');
				});
			},
			switchTab(pane) {
				for (const group of registry.tabGroups) {
					if (group.indexOf(pane) === -1)
						continue;

					for (const other of group)
						other.setAttribute('data-tab-active', other === pane ? 'true' : 'false');
				}
			}
		},
		changes: { apply() {} }
	};

	const L = {
		bind(fn, self, ...args) { return fn.bind(self, ...args); },
		hasSystemFeature() { return true; },
		resource(path) { return '/luci-static/resources/' + path; }
	};

	const document = {
		visibilityState: 'visible',
		listeners: {},
		querySelector() {
			return { appendChild() {} };
		},
		addEventListener(type, fn) {
			(this.listeners[type] ||= []).push(fn);
		}
	};

	registry.document = document;

	/*
	 * Do not arm a real interval: the test suite would never exit.  Capture
	 * the callbacks so a test can run one tick explicitly.
	 */
	const setIntervalStub = function(fn, ms) {
		registry.timers.push({ fn, ms, id: registry.timers.length + 1 });
		return registry.timers.length;
	};

	const clearIntervalStub = function(id) {
		registry.clearedTimers.push(id);
	};

	function ViewBase() {}
	ViewBase.extend = function(def) { return def; };
	ViewBase.prototype.handleSaveApply = function(ev, mode) {
		registry.saveApply = { ev, mode };
		registry.calls.push({ command: 'VIEW_HANDLE_SAVE_APPLY', args: [] });
		return Promise.resolve('saved');
	};

	const factory = new Function(
		'view', 'form', 'uci', 'ui', 'fs', 'rpc', 'network', 'utils', 'E', '_', 'L',
		'document', 'setInterval', 'clearInterval', src);

	const def = factory(ViewBase, form, uci, ui, fsStub, rpc, network, utils, E,
		function(s) { return s; }, L, document, setIntervalStub, clearIntervalStub);
	const instance = Object.assign({}, def);

	registry.uci = uci;

	return { view: instance, registry, E, opts };
}

const DEVICES = [
	{ getName() { return 'radio0'; }, getI18n() { return 'Radio Zero Controller (radio0)'; } },
	{ getName() { return 'radio1'; }, getI18n() { return 'Radio One Controller (radio1)'; } }
];

const NEIGHBORS = [
	'aa:bb:cc:dd:ee:ff    2.345s (    450.0) [     wlan0]',
	'    wlan0\t  aa:bb:cc:dd:ee:ff    3.456s'
].join('\n');

const NEIGHBORS_HEADER =
	'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: wlan0/aa:bb:cc:dd:ee:ff (bat0/11:22:33:44:55:66)]';

async function run() {
	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		const root = await t.view.render();

		lib.eq(t.registry.map.config, 'meshassistant', 'map config');
		lib.eq(t.registry.map.title, undefined, 'map has no separate page title');
		lib.eq(t.registry.map.description, undefined, 'map has no separate description');

		lib.eq(t.registry.tabGroups.length, 1, 'view creates one top-level tab group');
		const panes = t.registry.tabGroups[0];
		lib.eq(panes.map(p => p.attrs['data-tab']),
			[ 'settings', 'status', 'backup', 'log' ],
			'top-level tab ids');
		lib.eq(panes.map(p => p.attrs['data-tab-title']),
			[ 'Mesh Settings', 'Mesh Status', 'Backup Management', 'Run Log' ],
			'top-level tab titles');
		lib.eq(panes[0].attrs['data-tab-active'], 'true',
			'the settings tab is active by default');
		lib.eq(root.childNodes[0].tagName, 'UL', 'the top-level tab menu is inserted');
		lib.eq(root.childNodes[0].classList.contains('cbi-tabmenu'), true,
			'the top-level tab menu keeps the theme tab menu class');
		lib.eq(root.childNodes[0].classList.contains('tabs'), true,
			'the top-level tab menu also gets the theme tab bar class');
		lib.eq(root.childNodes[1].attrs.style, 'margin-block-start: 0.5rem',
			'tab panes sit a small gap below the tab menu');

		lib.ok(!textOf(root).includes('First set up the Mesh gateway server'),
			'the setup hint is removed');
		lib.ok(!textOf(root).includes('Official website'),
			'the official website hint is removed');
		lib.ok(!textOf(root).includes('Mesh Assistant WiFi Setup'),
			'the old page title is removed');

		lib.eq(t.registry.section.tabs.map(x => x.name),
			['setup', 'spectrum', 'apmode', 'advanced'], 'four tabs');
		lib.eq(t.registry.section.tabs[1].title, 'Spectrum Settings',
			'the spectrum tab follows the basic setup tab');

		lib.eq(root.querySelectorAll('.meshassistant-tab-pane').map(p => p.attrs['data-tab']),
			['setup', 'spectrum', 'apmode', 'advanced'],
			'the four form panes carry the shared height class');

		const o = t.registry.options;

		lib.eq(o.enabled.__kind, 'Flag', 'enabled is a Flag');
		lib.eq(o.enabled.default, '0', 'enabled default');
		lib.eq(o.role.__kind, 'ListValue', 'role is a ListValue');
		lib.eq(o.role.values, [['server', 'Server'], ['off', 'Node'], ['client', 'Client']],
			'role values and labels');
		lib.eq(o.role.default, 'server', 'role default');
		lib.eq(o.role.rmempty, false,
			'role is written even when it equals the default');

		lib.eq(o.wifi_id.default, 'meshassistant_AC', 'wifi_id default');
		lib.eq(depsOf(o.wifi_id),
			[['mlo', '0'], ['ssid_mode', 'separate'], ['wifi_radio', '^[^,]+(?:,[^,]+)+$'], ['!reverse', true]],
			'wifi_id is hidden while separate SSIDs are in effect');
		lib.eq(o.mesh_id.default, 'meshassistant_AC', 'mesh_id default');
		lib.eq(o.mesh_id.rmempty, false,
			'mesh_id is written even when it equals the default');
		lib.eq(typeof o.mesh_id.validate, 'function', 'mesh_id has a validator');
		lib.eq(o.mesh_id.validate(null, 'meshassistant_AC'), true,
			'mesh_id accepts a name');
		lib.eq(o.mesh_id.validate(null, '   '), 'Enter a mesh network SSID.',
			'mesh_id rejects a blank name');
		lib.eq(o.wifi_radio.__kind, 'MultiValue', 'wifi_radio is a MultiValue');
		lib.eq(o.wifi_radio.default, 'radio0',
			'the default AP radio is the first radio of the device');
		lib.eq(o.wifi_radio.rmempty, false, 'wifi_radio cannot be empty');
		lib.eq(typeof o.wifi_radio.validate, 'function',
			'wifi_radio has a selection validator');
		lib.eq(o.wifi_radio.validate(null, 'radio0 radio1'), true,
			'wifi_radio accepts two radios');
		lib.eq(o.wifi_radio.validate(null, [ 'radio0', 'radio1', 'radio2' ]), true,
			'wifi_radio accepts every offered radio');
		lib.eq(o.wifi_radio.validate(null, 'radio0 radio1 radio2'), true,
			'wifi_radio accepts a three-radio selection');
		lib.eq(o.wifi_radio.validate(null, ''), 'Select at least one radio.',
			'wifi_radio rejects an empty selection');
		lib.eq(o.apRadio.__kind, 'ListValue', 'apRadio is a ListValue');
		lib.eq(o.apRadio.default, 'radio0', 'apRadio default');
		lib.eq(o.apRadio.rmempty, false,
			'apRadio is written even when it equals the default');

		lib.eq(o.mlo.__kind, 'Flag', 'mlo is a Flag');
		lib.eq(o.mlo.default, '0', 'mlo is off by default');
		lib.eq(depsOf(o.mlo), [['wifi_radio', '^[^,]+(?:,[^,]+)+$']],
			'mlo depends on two or more AP radios');
		const mloRegex = o.mlo.deps[0].value;
		lib.eq(mloRegex.test([ 'radio0' ].toString()), false,
			'mlo is hidden with one AP radio');
		lib.eq(mloRegex.test([ 'radio0', 'radio1' ].toString()), true,
			'mlo is shown with two AP radios');
		lib.eq(mloRegex.test([ 'radio0', 'radio1', 'radio2' ].toString()), true,
			'mlo is shown with three AP radios');
		lib.eq(typeof o.mlo.validate, 'function',
			'mlo has a radio-count validator');
		o.wifi_radio.formvalue = function() { return [ 'radio0', 'radio1' ]; };
		o.mlo.formvalue = function() { return '1'; };
		lib.eq(o.mlo.validate(null), true,
			'mlo can be enabled with exactly two AP radios');
		o.mlo.formvalue = function() { return '0'; };
		o.wifi_radio.formvalue = function() { return [ 'radio0', 'radio1', 'radio2' ]; };
		lib.eq(o.mlo.validate(null), true,
			'mlo stays disabled with three AP radios');
		o.mlo.formvalue = function() { return '1'; };
		lib.eq(o.mlo.validate(null), 'MLO requires exactly two radios.',
			'mlo rejects three AP radios');

		lib.eq(o.ssid_mode.__kind, 'ListValue', 'ssid_mode is a ListValue');
		lib.eq(o.ssid_mode.default, 'same', 'ssid_mode defaults to Same SSID');
		lib.eq(o.ssid_mode.values,
			[['same', 'Same SSID'], ['separate', 'Separate SSIDs']],
			'ssid_mode offers the shared and per-radio choices');
		lib.eq(depsOf(o.ssid_mode),
			[['mlo', '0'], ['wifi_radio', '^[^,]+(?:,[^,]+)+$']],
			'ssid_mode needs at least two AP radios and MLO off');
		const ssidModeRadioRe = o.ssid_mode.deps.find(d => d.field === 'wifi_radio').value;
		lib.eq(ssidModeRadioRe.test('radio0'), false,
			'ssid_mode is hidden with one AP radio');
		lib.eq(ssidModeRadioRe.test('radio0,radio1'), true,
			'ssid_mode is shown with two AP radios');
		lib.eq(ssidModeRadioRe.test('radio0,radio1,radio2'), true,
			'ssid_mode is shown with three AP radios');
		const wifiIdRadioRe = o.wifi_id.deps.find(d => d.field === 'wifi_radio').value;
		lib.eq(wifiIdRadioRe.test('radio0,radio1,radio2'), true,
			'the shared SSID is hidden with three separate-SSID radios');

		lib.eq(o.wifi_id_radio0.__kind, 'Value', 'per-radio SSID is a Value');
		lib.eq(o.wifi_id_radio0.title, 'SSID for radio0',
			'per-radio SSID is named after its radio');
		lib.eq(depsOf(o.wifi_id_radio0),
			[['mlo', '0'], ['ssid_mode', 'separate'], ['wifi_radio', '(^|,)radio0(,|$)']],
			'the first per-radio SSID depends on its own radio');
		lib.eq(o.wifi_id_radio1.title, 'SSID for radio1',
			'the second per-radio SSID is named after its radio');
		const radio0Re = o.wifi_id_radio0.deps.find(d => d.field === 'wifi_radio').value;
		lib.eq(radio0Re.test('radio0,radio1'), true,
			'the per-radio SSID shows while the radio is selected');
		lib.eq(radio0Re.test('radio1'), false,
			'the per-radio SSID hides while the radio is not selected');

		lib.eq(o.wifi_radio.values, [
			['radio0', 'Radio Zero Controller (radio0)'],
			['radio1', 'Radio One Controller (radio1)']
		], 'wifi_radio choices come from network API');
		lib.eq(o.apRadio.values, o.wifi_radio.values, 'apRadio choices come from network API');

		lib.eq(o.wired_backhaul.__kind, 'ListValue', 'wired_backhaul is a ListValue');
		lib.eq(o.wired_backhaul.default, 'none', 'wired_backhaul default');
		lib.eq(o.wired_backhaul.values, [['none', 'None (wireless backhaul only)']],
			'wired backhaul has only None without network data');
		lib.ok(t.registry.uci.loaded.indexOf('network') !== -1,
			'view loads the network config for wired ports');

		lib.eq(o.dhcp_dns.__kind, 'Value', 'dhcp_dns is a Value');
		lib.eq(o.dhcp_dns.title, 'DHCP DNS Server', 'dhcp_dns field title');
		lib.eq(o.dhcp_dns.datatype, 'ip4addr', 'dhcp_dns datatype');
		lib.eq(o.dhcp_dns.default, '',
			'dhcp_dns lets dnsmasq advertise this router by default');
		lib.eq(depsOf(o.dhcp_dns), [['server_dhcp', '1']],
			'dhcp_dns is only offered while the server provides DHCP');

		lib.eq(o.encryption.default, '0', 'encryption default');
		lib.eq(o.key.default, 'meshassistant', 'key default');
		lib.eq(o.key.password, true, 'key is a password field');
		lib.eq(o.key.datatype, 'minlength(8)', 'key datatype');
		lib.eq(depsOf(o.key), [['encryption', '1']], 'key depends on encryption');
		lib.eq(o.key.rmempty, false,
			'key is written even when it equals the default');

		lib.eq(o.kvr.default, '0', 'kvr default');
		lib.eq(o.ft.default, '1', 'ft default');
		lib.eq(o.mobility_domain.default, '4f57', 'mobility_domain default');
		lib.eq(o.mobility_domain.datatype, 'and(hexstring,rangelength(4,4))',
			'mobility_domain datatype');
		lib.eq(o.mobility_domain.rmempty, false,
			'mobility_domain is written even when it equals the default');
		lib.eq(depsOf(o.mobility_domain), [['ft', '1']],
			'mobility domain depends on fast roaming');
		lib.eq(o.rssi_val.default, '-60', 'rssi_val default');
		lib.eq(o.rssi_val.datatype, 'range(-120,-1)', 'rssi_val datatype');
		lib.eq(depsOf(o.rssi_val), [['kvr', '1']],
			'good RSSI threshold depends on client roaming');
		lib.eq(o.low_rssi_val.default, '-88', 'low_rssi_val default');
		lib.eq(o.low_rssi_val.datatype, 'range(-120,-1)', 'low_rssi_val datatype');
		lib.eq(depsOf(o.low_rssi_val), [['kvr', '1']],
			'bad RSSI threshold depends on client roaming');

		/* Per-band overrides stay hidden behind roaming too; an empty value
		 * means the band inherits the shared threshold above. */
		for (const [ field, title ] of [
			[ 'rssi_val', 'Good RSSI Threshold' ],
			[ 'low_rssi_val', 'Bad RSSI Threshold' ]
		]) {
			for (const band of [ [ '2g', '2.4 GHz' ], [ '5g', '5 GHz' ],
			                     [ '6g', '6 GHz' ] ]) {
				const opt = o[field + '_' + band[0]];

				lib.eq(opt.title, title + ' (' + band[1] + ')',
					field + '_' + band[0] + ' is named after its band');
				lib.eq(opt.default, '',
					field + '_' + band[0] + ' inherits the shared threshold');
				lib.eq(opt.datatype, 'range(-120,-1)',
					field + '_' + band[0] + ' accepts dBm values');
				lib.eq(depsOf(opt), [['kvr', '1']],
					field + '_' + band[0] + ' depends on client roaming');
			}
		}

		lib.eq(o.hostname.default, 'node2', 'hostname default');
		lib.eq(o.hostname.values.map(v => v[0]),
			['node2', 'node3', 'node4', 'node5', 'node6', 'node7', 'node8', 'node9'],
			'hostname suggestions');
		lib.eq(o.hostname.datatype, 'string', 'hostname datatype');
		lib.eq(depsOf(o.hostname), [['role', '^(off|client)$']],
			'hostname depends on role');
		lib.eq(o.hostname.rmempty, false,
			'hostname is written even when it equals the default');

		lib.eq(o.ipmode.default, 'dhcp', 'ipmode default');
		lib.eq(o.ipmode.values, [['dhcp', 'DHCP'], ['static', 'Static']], 'ipmode values');
		for (const name of ['ipaddr', 'gateway', 'netmask']) {
			lib.eq(o[name].datatype, 'ip4addr', name + ' datatype');
			/*
			 * One depends() call: LuCI ORs separate calls, so splitting
			 * role and ipmode would keep the fields visible in DHCP mode
			 * whenever the role matches.
			 */
			lib.eq(dependsGroups(o[name]), [[
				['role', '^(off|client)$'],
				['ipmode', 'static']
			]], name + ' requires role and IP mode together');
		}
		lib.eq(o.dns.datatype, 'ip4addr', 'dns datatype');
		lib.eq(depsOf(o.dns), [['role', '^(off|client)$']],
			'the DNS server is available in both IP modes');
		lib.eq(o.ipaddr.default, '', 'ipaddr has no hardcoded default without LAN status');
		lib.eq(o.gateway.default, '', 'gateway has no hardcoded default without LAN status');
		lib.eq(o.netmask.default, '', 'netmask has no hardcoded default without LAN status');
		lib.eq(o.dns.default, '', 'dns has no hardcoded default without LAN status');
		lib.eq(o.dns.placeholder, '', 'dns has no placeholder without LAN status');

		lib.ok(Array.isArray(o.ipaddr.validate) && o.ipaddr.validate.length === 1,
			'ipaddr has one custom validator',
			String(o.ipaddr.validate));
		lib.eq(o.ipaddr.validate[0](null, '192.168.10.112'), true,
			'a valid static address passes validation');
		lib.eq(o.ipaddr.validate[0](null, '192.168.10'), 'Enter a static IPv4 address.',
			'an incomplete static address is refused');
		lib.eq(o.ipaddr.validate[0](null, '0.0.0.0'), 'Enter a static IPv4 address.',
			'an unusable static address is refused');

		lib.ok(Array.isArray(o.netmask.validate) && o.netmask.validate.length === 1,
			'netmask has one custom validator',
			String(o.netmask.validate));
		lib.eq(o.netmask.validate[0](null, '255.255.255.0'), true,
			'a valid netmask passes validation');
		lib.eq(o.netmask.validate[0](null, '255.0.255.0'),
			'Enter a valid IPv4 netmask, for example 255.255.255.0.',
			'a non-contiguous netmask is refused');
		lib.eq(o.netmask.validate[0](null, '0.0.0.0'),
			'Enter a valid IPv4 netmask, for example 255.255.255.0.',
			'a /0 netmask is refused');
		lib.eq(o.gateway.validate, undefined,
			'gateway keeps the built-in datatype check');
		lib.eq(o.ipaddr.rmempty, false,
			'a static address is written even when it equals the default');
		lib.eq(o.netmask.rmempty, false,
			'a static netmask is written even when it equals the default');
		lib.eq(o.gateway.rmempty, true,
			'an undetected gateway stays optional');
		lib.eq(o.dns.rmempty, true,
			'an empty DNS server means no override');
		lib.eq(t.registry.rpcCalls.length, 1, 'view queries the LAN status once');
		lib.eq(t.registry.rpcCalls[0].spec, {
			object: 'network.interface',
			method: 'status',
			params: [ 'interface' ],
			expect: {}
		}, 'LAN status comes from network.interface status');
		lib.eq(t.registry.rpcCalls[0].interface, 'lan', 'LAN status targets the lan interface');

		lib.eq(depsOf(o._btn_apmode), [['role', '^(off|client)$']],
			'AP mode button depends on role');

		const text = textOf(root);
		// Both rows are the same hardif seen in two batman formats, so the
		// fixture holds one device even though it has two rows.
		lib.ok(text.includes('Number of Active Nodes: 1'),
			'status counts devices, not neighbor rows');
		lib.ok(text.includes('wlan0'), 'status shows interface');
		lib.ok(!text.includes('Last Seen Timestamp'),
			'the status table has no last-seen column');
		lib.ok(text.includes('IP Address'), 'status shows an IP address column');
		lib.ok(text.includes('Backhaul'), 'status shows a backhaul column');
		lib.ok(text.includes('Backhaul Status'), 'status shows a backhaul status column');
		lib.ok(text.includes('Frequency'), 'status shows a frequency column');
		lib.ok(text.includes('Channel'), 'status shows a channel column');
		lib.ok(text.includes('Channel Width'), 'status shows a channel width column');
		lib.ok(text.includes('Signal Strength'), 'status shows a signal strength column');
		lib.ok(text.includes('Load'), 'status shows a load column');
		lib.ok(text.includes('Channel Utilization'), 'status shows a channel utilization column');
		lib.ok(text.includes('Link Rate'), 'status shows a link rate column');
		lib.ok(text.includes('450.0 Mbps'), 'batman link speed is rendered');
		const logPane = t.registry.tabGroups[0].find(p => p.attrs['data-tab'] === 'log');
		lib.ok(logPane != null, 'the run log tab is rendered');
		lib.eq(nodesByTag(logPane, 'h3').length, 0,
			'the run log tab has no repeated heading');
		lib.ok(text.includes('Clear Log'), 'the clear log button is rendered');
		lib.ok(text.includes('No log entries.'), 'an empty run log shows a placeholder');
		lib.eq(t.registry.tabGroups[0].map(function(pane) {
			return pane.attrs['data-tab-title'];
		}), [ 'Mesh Settings', 'Mesh Status', 'Backup Management', 'Run Log' ],
			'backup management sits between status and the run log');
		lib.eq(tableTitles(root), [
			'Node Hostname', 'Backhaul', 'Backhaul Status', 'Node MAC', 'IP Address',
			'Interface', 'Load', 'Link Rate', 'Frequency', 'Channel', 'Channel Width',
			'Signal Strength', 'Channel Utilization'
		], 'status table column order');
		lib.eq(t.view.status.rows[0].ips, [], 'rows without IP data carry an empty list');
		lib.eq(t.view.status.rows[0].hostname, '',
			'rows without an announcement carry no hostname');
		lib.eq(t.registry.reads, [ '/tmp/meshassistant_peers', '/tmp/meshassistant.log' ],
			'view reads the peer announcement and run log files');

		await o._btn_reapply.onclick({});
		const callsBeforeConfirm = t.registry.calls.length;

		await o._btn_apmode.onclick({});
		lib.eq(t.registry.calls.length, callsBeforeConfirm,
			'dumb AP mode does not run before confirmation');
		lib.eq(t.registry.modals.length, 1, 'dumb AP mode opens a confirmation dialog');
		lib.eq(t.registry.modals[0].title, 'Enable Dumb AP Mode', 'confirmation dialog title');
		lib.ok(textOf(t.registry.modals[0].children[0]).includes(
			'WARNING: THIS WILL CHANGE THE IP ADDRESS OF THIS NODE, YOU WILL LOSE ACCESS TO THIS UI'),
			'confirmation dialog shows the warning');
		lib.eq(textOf(t.registry.modals[0].children[1]), 'Continue?',
			'confirmation dialog asks to continue');

		const firstButtons = buttonsOf(t.registry.modals[0]);
		lib.eq(firstButtons.length, 2, 'confirmation dialog has cancel and confirm buttons');
		lib.eq(textOf(firstButtons[0]), 'Cancel', 'first button is Cancel');
		lib.eq(textOf(firstButtons[1]), 'Enable Dumb AP Mode', 'second button confirms');

		await firstButtons[0].attrs.click({});
		lib.eq(t.registry.modals[0].open, false, 'Cancel closes the confirmation dialog');
		lib.eq(t.registry.calls.length, callsBeforeConfirm, 'Cancel does not run the script');

		await o._btn_apmode.onclick({});
		lib.eq(t.registry.modals.length, 2, 'dumb AP mode can be confirmed on a second click');
		const confirmButtons = buttonsOf(t.registry.modals[1]);
		await confirmButtons[1].attrs.click({});
		lib.eq(t.registry.modals[1].open, false, 'confirmation closes the dialog');
		lib.eq(t.registry.calls.filter(c => c.command === '/etc/meshassistant/shell/meshassistant.sh' &&
			c.args[0] === '--detach'), [
			{ command: '/etc/meshassistant/shell/meshassistant.sh', args: ['--detach'] },
			{ command: '/etc/meshassistant/shell/meshassistant.sh', args: ['--detach', 'dumbap'] }
		], 'buttons use exact detach arguments');
		lib.ok(t.registry.calls.some(c => c.command === '/etc/meshassistant/shell/meshassistant.sh' &&
			c.args[0] === 'linkinfo'), 'view requests frequency and signal data');
		lib.eq(t.registry.notifications.length, 2, 'two success notifications');
	}

	{
		const t = loadView({
			devices: DEVICES,
			lanStatus: {
				proto: 'dhcp',
				'ipv4-address': [ { address: '192.168.10.123', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.168.10.111' } ],
				'dns-server': [ '192.168.10.111', '1.1.1.1' ]
			}
		});

		await t.view.load();
		await t.view.render();

		const o = t.registry.options;

		lib.eq(o.ipaddr.default, '192.168.10.123',
			'ipaddr default is the current LAN address');
		lib.eq(o.netmask.default, '255.255.255.0',
			'netmask default is derived from the live prefix');
		lib.eq(o.gateway.default, '192.168.10.111',
			'gateway default is the live default route');
		lib.eq(o.dns.default, '',
			'dns stays empty so the DHCP servers can be used');
		lib.eq(o.dns.placeholder, '192.168.10.111',
			'dns placeholder shows the live DNS server');
		lib.eq(o.ipaddr.rmempty, false,
			'the prefilled static address is written to UCI');
		lib.eq(o.netmask.rmempty, false,
			'the prefilled netmask is written to UCI');
		lib.eq(o.gateway.rmempty, false,
			'the prefilled gateway is written to UCI');
		lib.eq(o.dns.rmempty, true,
			'the DNS server can be cleared');
	}

	{
		const t = loadView({
			devices: DEVICES,
			lanStatusReject: true,
			uciValues: {
				network: {
					lan: {
						proto: 'static',
						ipaddr: '192.168.10.100',
						netmask: '255.255.255.0',
						gateway: '192.168.10.1',
						dns: '192.168.10.1'
					}
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const o = t.registry.options;

		lib.eq(o.ipaddr.default, '192.168.10.100',
			'ipaddr default falls back to the UCI LAN address');
		lib.eq(o.netmask.default, '255.255.255.0',
			'netmask default falls back to the UCI netmask');
		lib.eq(o.gateway.default, '192.168.10.1',
			'gateway default falls back to the UCI gateway');
		lib.eq(o.dns.default, '',
			'dns stays empty when no server is configured');
		lib.eq(o.dns.placeholder, '192.168.10.1',
			'dns placeholder falls back to the UCI DNS server');
		lib.eq(o.gateway.rmempty, false,
			'a gateway detected from UCI is written to the meshassistant config');
		lib.eq(o.dns.rmempty, true,
			'the DNS server can be cleared');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': { code: 0, stdout: NEIGHBORS }
			},
			files: {
				'/tmp/meshassistant_peers': [
					'1700000000 aa:bb:cc:dd:ee:ff 192.168.10.3 node-b 0.20 77:88:99:aa:bb:cc',
					'1699999500 aa:bb:cc:dd:ee:ff 192.168.10.199 node-b 0.20 77:88:99:aa:bb:cc'
				].join('\n')
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.eq(t.view.status.rows[0].ips, [ '192.168.10.3' ],
			'the neighbor row shows only the address the remote router announces');
		lib.ok(text.includes('IP Address'), 'status table has an IP address column');
		lib.ok(text.includes('192.168.10.3'), 'the remote router address is rendered');
		lib.ok(!text.includes('192.168.10.199'),
			'an address from an older announcement is not rendered');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': {
					code: 0,
					stdout: NEIGHBORS_HEADER + '\n' + NEIGHBORS + '\n' +
						'bb:bb:bb:bb:bb:bb    1.200s ( 100000.0) [lan2]'
				},
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'local OpenWrt 192.168.10.111 0.15\n' +
						'kind wlan0 wlan\nkind lan2 wired\n' +
						'iface wlan0 2437 6 40\nbusy wlan0 4\npeer wlan0 aa:bb:cc:dd:ee:ff -52'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.eq(t.view.status.rows[0].frequency, '2437 MHz',
			'link info supplies the interface frequency');
		lib.eq(t.view.status.rows[0].channel, '6',
			'link info supplies the interface channel');
		lib.eq(t.view.status.rows[0].width, '40 MHz',
			'link info supplies the interface channel width');
		lib.eq(t.view.status.rows[0].signal, '-52 dBm',
			'link info supplies the neighbor signal strength');
		lib.eq(t.view.status.rows[0].utilization, '4%',
			'link info supplies the channel utilization');
		lib.eq(t.view.status.rows[0].backhaul, 'wlan',
			'a wireless neighbor row is labelled wireless');
		lib.eq(t.view.status.rows[2].backhaul, 'wired',
			'a wired neighbor row is labelled wired');
		lib.ok(text.includes('2437 MHz'), 'frequency is rendered');
		lib.ok(text.includes('-52 dBm'), 'signal strength is rendered');
		lib.ok(text.includes('4%'), 'channel utilization is rendered');
		lib.ok(text.includes('Wireless'), 'the wireless medium is rendered');
		lib.ok(text.includes('Wired'), 'the wired medium is rendered');

		lib.eq(t.view.status.local, [
			{
				hostname: 'OpenWrt',
				neighbor: 'aa:bb:cc:dd:ee:ff',
				ips: [ '192.168.10.111' ],
				iface: 'wlan0',
				backhaul: 'wlan',
				frequency: '2437 MHz',
				channel: '6',
				width: '40 MHz',
				signal: '-52 dBm',
				load: '0.15',
				utilization: '4%',
				speed: '450.0',
				lastSeen: '2.345s',
				backhaulState: ''
			},
			{
				hostname: 'OpenWrt',
				neighbor: '',
				ips: [ '192.168.10.111' ],
				iface: 'lan2',
				backhaul: 'wired',
				frequency: '',
				channel: '',
				width: '',
				signal: '',
				load: '0.15',
				utilization: '',
				speed: '100000.0',
				lastSeen: '1.200s',
				backhaulState: ''
			}
		], 'the local rows mirror their own hardif links');
		lib.eq(t.view.status.role, '', 'the local role is taken from link info');
		lib.ok(text.includes('Remote Hosts'), 'the remote hosts subtitle is rendered');
		lib.ok(text.includes('Local Host'), 'the local host subtitle is rendered');
		lib.ok(text.includes('Server'), 'the local host role is rendered');
		lib.ok(text.includes('OpenWrt'), 'the local hostname is rendered');
		lib.ok(text.includes('192.168.10.111'), 'the local address is rendered');
	}

	{
		/*
		 * The live shape of a dual-link node: node2 announces a wired and a
		 * wireless MAC under one address; batman routes to it over the wired
		 * link, so the wireless row is a standby.  node3 is reached directly
		 * over the mesh radio.
		 */
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': {
					code: 0,
					stdout: NEIGHBORS_HEADER + '\n' +
						'         Neighbor   last-seen      speed           IF\n' +
						'00:58:28:12:81:50    0.690s (   100000.0) [      lan2]\n' +
						'00:58:28:12:81:54    0.010s (     1870.0) [mesh_radio2]\n' +
						'00:58:28:12:82:e4    0.310s (     1889.0) [mesh_radio2]'
				},
				'/usr/sbin/batctl o': {
					code: 0,
					stdout: [
						'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: lan2/00:58:28:22:67:f9 (bat0/86:10:45:55:ab:8c BATMAN_V)]',
						'   Originator        last-seen ( throughput)  Nexthop           [outgoingIF]',
						'   00:58:28:12:82:e4    0.330s (     1471.5) 00:58:28:12:81:54 [mesh_radio2]',
						' * 00:58:28:12:82:e4    0.330s (     1890.1) 00:58:28:12:82:e4 [mesh_radio2]',
						'   00:58:28:12:82:e4    0.330s (     1091.7) 00:58:28:12:81:50 [      lan2]',
						'   00:58:28:12:81:54    0.070s (      964.3) 00:58:28:12:82:e4 [mesh_radio2]',
						'   00:58:28:12:81:54    0.070s (     1868.4) 00:58:28:12:81:54 [mesh_radio2]',
						' * 00:58:28:12:81:54    0.070s (   100000.0) 00:58:28:12:81:50 [      lan2]'
					].join('\n')
				},
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'local OpenWrt 192.168.10.1 0.10\n' +
						'kind lan2 wired\nkind mesh_radio2 wlan\n' +
						'iface mesh_radio2 6255 61 320\nbusy mesh_radio2 4\n' +
						'peer mesh_radio2 00:58:28:12:81:54 -73\n' +
						'peer mesh_radio2 00:58:28:12:82:e4 -70'
				}
			},
			files: {
				'/tmp/meshassistant_peers': [
					'1700000000 00:58:28:12:81:50 192.168.10.2 node2 0.08',
					'1700000000 00:58:28:12:81:54 192.168.10.2 node2 0.08',
					'1700000000 00:58:28:12:82:e4 192.168.10.3 node3 0.20'
				].join('\n')
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.eq(t.view.status.rows.map(function(row) {
			return row.backhaulState;
		}), [ 'inuse', 'standby', 'inuse' ],
			'the status rows mark the link batman currently uses');

		lib.ok(text.includes('In Use'), 'the used link is labelled In Use');
		lib.ok(text.includes('Standby'), 'the standby link is labelled Standby');

		const tables = nodesByClass(root, 'meshassistant-status-table');
		lib.eq(tables.length, 2, 'both status tables use the status table style');
		lib.eq(nodesByClass(root, 'meshassistant-status-scroll').length, 2,
			'both status tables sit in a scroll container');

		const cells = nodesByClass(tables[0], 'td');
		lib.eq(cells.length, 39, 'three rows of thirteen cells are rendered');
		lib.eq(cells.filter(function(cell) {
			return typeof cell.attrs['data-label'] !== 'string';
		}), [], 'every status cell carries a label for the phone layout');

		lib.eq(nodesByClass(tables[0], 'meshassistant-state-inuse').length, 2,
			'two links of the remote table are in use');
		lib.eq(nodesByClass(tables[0], 'meshassistant-state-standby').length, 1,
			'one link of the remote table is a standby');

		const localCells = nodesByClass(tables[1], 'td');
		lib.eq(localCells.length, 26, 'two local rows of thirteen cells are rendered');
		lib.eq(nodesByClass(tables[1], 'meshassistant-state-inuse').length, 2,
			'both local hardifs carry forwarding');
		lib.eq(nodesByClass(tables[1], 'meshassistant-state-standby').length, 0,
			'no local hardif is a standby');
		lib.eq(t.view.status.local.map(function(row) {
			return [ row.iface, row.backhaul, row.signal, row.speed, row.lastSeen,
				row.backhaulState ];
		}), [
			[ 'lan2', 'wired', '', '100000.0', '0.690s', 'inuse' ],
			[ 'mesh_radio2', 'wlan', '-70 dBm', '1889.0', '0.310s', 'inuse' ]
		], 'the local rows state the hardif and medium batman forwards over');
		lib.ok(text.includes('Server'), 'a local role without a UCI value is a server');
	}

	{
		/*
		 * A node forwards to node3 through the server's wired link, so its own
		 * originator table labels the direct radio link a standby.  node3
		 * announces that its radio carries forwarding, and the remote row must
		 * show the state that node3 reports for that hardif, not this device's
		 * path choice.  The server announces both of its hardifs in use.
		 */
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': {
					code: 0,
					stdout: '[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: ' +
						'mesh_radio2/00:58:28:12:81:54 (bat0/a2:0a:b4:0d:06:b9 BATMAN_V)]\n' +
						'         Neighbor   last-seen      speed           IF\n' +
						'02:58:28:22:67:fc    0.120s (     1612.5) [mesh_radio2]\n' +
						'00:58:28:12:82:e4    0.560s (     1628.4) [mesh_radio2]\n' +
						'00:58:28:22:67:f9    0.270s (   100000.0) [       wan]'
				},
				'/usr/sbin/batctl o': {
					code: 0,
					stdout: [
						'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: mesh_radio2/00:58:28:12:81:54 (bat0/a2:0a:b4:0d:06:b9 BATMAN_V)]',
						'   Originator        last-seen ( throughput)  Nexthop           [outgoingIF]',
						' * 00:58:28:22:67:f9    0.270s (   100000.0) 00:58:28:22:67:f9 [       wan]',
						' * 00:58:28:12:82:e4    0.570s (     1670.3) 00:58:28:22:67:f9 [       wan]',
						'   00:58:28:12:82:e4    0.570s (     1628.4) 00:58:28:12:82:e4 [mesh_radio2]'
					].join('\n')
				},
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'local node2 192.168.10.2 0.14 off\n' +
						'kind wan wired 00:58:28:12:81:50\n' +
						'kind mesh_radio2 wlan 00:58:28:12:81:54\n' +
						'iface mesh_radio2 6255 61 320\nbusy mesh_radio2 3\n' +
						'peer mesh_radio2 00:58:28:12:82:e4 -65\n' +
						'peer mesh_radio2 02:58:28:22:67:fc -71'
				}
			},
			files: {
				'/tmp/meshassistant_peers': [
					'1700000000 00:58:28:22:67:f9 192.168.10.1 OpenWrt 0.10 11:22:33:44:55:66 inuse',
					'1700000000 02:58:28:22:67:fc 192.168.10.1 OpenWrt 0.10 11:22:33:44:55:66 inuse',
					'1700000000 00:58:28:12:82:e4 192.168.10.3 node3 0.20 - inuse'
				].join('\n')
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.eq(t.view.status.rows.map(function(row) {
			return [ row.hostname, row.iface, row.backhaulState ];
		}), [
			[ 'OpenWrt', 'wan', 'inuse' ],
			[ 'OpenWrt', 'mesh_radio2', 'inuse' ],
			[ 'node3', 'mesh_radio2', 'inuse' ]
		], 'remote links show the state their own device announces');

		lib.eq(t.view.status.local.map(function(row) {
			return [ row.iface, row.backhaulState ];
		}), [ [ 'wan', 'inuse' ], [ 'mesh_radio2', 'standby' ] ],
			'the local rows keep this device\'s own forwarding state');
		lib.eq(t.view.status.role, 'off', 'the node role is reported');
		lib.ok(text.includes('Node'), 'the node role badge is rendered');

		const tables = nodesByClass(root, 'meshassistant-status-table');
		lib.eq(nodesByClass(tables[0], 'meshassistant-state-inuse').length, 3,
			'every remote link is in use');
		lib.eq(nodesByClass(tables[0], 'meshassistant-state-standby').length, 0,
			'no remote link is a standby');
		lib.eq(nodesByClass(tables[1], 'meshassistant-state-inuse').length, 1,
			'the local wired link is in use');
		lib.eq(nodesByClass(tables[1], 'meshassistant-state-standby').length, 1,
			'the local radio link is a standby');
	}

	{
		/*
		 * This node is two hops away from the server, so its neighbor table
		 * holds only the radio of each remote device.  Each device announces
		 * every hardif batman carries, so the remote table must list the
		 * wired hardif of the server and of node2 too, labelled with the
		 * medium and the state their own devices report.
		 */
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': {
					code: 0,
					stdout: '[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: ' +
						'mesh_radio2/00:58:28:12:82:e4 (bat0/86:10:45:55:ab:8c BATMAN_V)]\n' +
						'         Neighbor   last-seen      speed           IF\n' +
						'02:58:28:22:67:fc    0.010s (     1889.0) [mesh_radio2]\n' +
						'00:58:28:12:81:54    0.010s (     1870.0) [mesh_radio2]'
				},
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'local node3 192.168.10.3 0.20 off\n' +
						'kind mesh_radio2 wlan 00:58:28:12:82:e4\n' +
						'iface mesh_radio2 6255 61 320\nbusy mesh_radio2 4\n' +
						'peer mesh_radio2 00:58:28:12:81:54 -73'
				}
			},
			files: {
				'/tmp/meshassistant_peers': [
					'1700000000 00:58:28:22:67:f9 192.168.10.1 OpenWrt 0.10 - inuse wired 100000.0 lan2',
					'1700000000 02:58:28:22:67:fc 192.168.10.1 OpenWrt 0.10 - inuse wlan 1889.0 mesh_radio2',
					'1700000000 00:58:28:12:81:50 192.168.10.2 node2 0.08 - inuse wired 100000.0 wan',
					'1700000000 00:58:28:12:81:54 192.168.10.2 node2 0.08 - standby wlan 1870.0 mesh_radio2',
					'1700000000 00:58:28:12:82:e4 192.168.10.3 node3 0.20 - inuse wlan 1933.2 mesh_radio2'
				].join('\n')
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.eq(t.view.status.rows.map(function(row) {
			return [ row.hostname, row.iface, row.backhaul, row.backhaulState ];
		}), [
			[ 'OpenWrt', 'lan2', 'wired', 'inuse' ],
			[ 'OpenWrt', 'mesh_radio2', 'wlan', 'inuse' ],
			[ 'node2', 'wan', 'wired', 'inuse' ],
			[ 'node2', 'mesh_radio2', 'wlan', 'standby' ]
		], 'the remote table lists every announced hardif with its medium and state');
		lib.eq(t.view.status.rows.map(function(row) {
			return row.ips[0];
		}), [ '192.168.10.1', '192.168.10.1', '192.168.10.2', '192.168.10.2' ],
			'the announced rows carry the address of their device');
		lib.ok(!t.view.status.rows.some(function(row) {
			return row.hostname === 'node3';
		}), 'this device never lists itself as a remote');
		lib.ok(text.includes('Number of Active Nodes: 2'),
			'the two remote devices are counted once each');
		lib.eq((text.match(/100000\.0 Mbps/g) || []).length, 2,
			'the announced wired rows show the rate their own devices measured');
		lib.ok(text.includes('lan2') && text.includes('wan'),
			'the announced wired rows show the interface names of their own devices');

		const tables = nodesByClass(root, 'meshassistant-status-table');
		lib.eq(nodesByClass(tables[0], 'meshassistant-state-inuse').length, 3,
			'the announced in-use links are marked in the remote table');
		lib.eq(nodesByClass(tables[0], 'meshassistant-state-standby').length, 1,
			'the announced standby link is marked in the remote table');
	}

	{
		/*
		 * Two routers that still share the factory hostname and announce no
		 * address are told apart by the LAN bridge MAC in their announcements,
		 * so each device keeps its own rows and is counted once.
		 */
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': { code: 0, stdout: 'no neighbors' },
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'local node3 192.168.10.3 0.20 off\n' +
						'kind mesh_radio2 wlan 00:58:28:12:82:e4'
				}
			},
			files: {
				'/tmp/meshassistant_peers': [
					'1700000000 aa:00:00:00:00:01 - OpenWrt 0.10 aa:00:00:00:00:91 inuse wired',
					'1700000000 aa:00:00:00:00:02 - OpenWrt 0.10 aa:00:00:00:00:91 standby wlan',
					'1700000000 bb:00:00:00:00:01 - OpenWrt 0.10 bb:00:00:00:00:91 inuse wired',
					'1700000000 bb:00:00:00:00:02 - OpenWrt 0.10 bb:00:00:00:00:91 standby wlan'
				].join('\n')
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.eq(t.view.status.rows.map(function(row) {
			return [ row.hostname, row.backhaul, row.backhaulState ];
		}), [
			[ 'OpenWrt', 'wired', 'inuse' ],
			[ 'OpenWrt', 'wlan', 'standby' ],
			[ 'OpenWrt', 'wired', 'inuse' ],
			[ 'OpenWrt', 'wlan', 'standby' ]
		], 'each same-named device keeps its own rows');
		lib.ok(text.includes('Number of Active Nodes: 2'),
			'a shared hostname does not merge two devices into one');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			files: {
				'/tmp/meshassistant.log': 'applying mesh settings\nwifi reload\n'
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.ok(text.includes('applying mesh settings'), 'the run log content is rendered');

		const clearBtn = nodesByTag(root, 'button').find(function(button) {
			return textOf(button) === 'Clear Log';
		});

		lib.ok(clearBtn != null, 'the clear log button is present in the log tab');

		await clearBtn.attrs.click({});

		lib.eq(t.registry.calls.filter(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args[0] === 'clearlog';
		}), [
			{ command: '/etc/meshassistant/shell/meshassistant.sh', args: [ 'clearlog' ] }
		], 'the clear log button runs the clearlog action');
		lib.eq(t.registry.notifications.length, 0,
			'clearing the log succeeds silently');
		lib.ok(clearBtn.attrs.style.includes('margin:0.5rem 0 0 0.5rem'),
			'the clear log button has a top gap and a left inset');
		lib.eq(nodesByTag(root, 'pre')[0].textContent, 'No log entries.',
			'the log display is emptied after clearing');
		lib.ok(nodesByTag(root, 'pre')[0].attrs.style.includes('margin:1rem 0 0 0.5rem'),
			'the log display is inset from the left edge and separated from the button');
		lib.ok(nodesByTag(root, 'pre')[0].attrs.style.includes('padding-bottom:0.5rem'),
			'the log display has a bottom gap');
	}

	{
		const files = { '/tmp/meshassistant.log': 'first run\n' };
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			files: files
		});

		await t.view.load();
		const root = await t.view.render();

		const refreshBtn = nodesByTag(root, 'button').find(function(button) {
			return textOf(button) === 'Refresh Log';
		});

		lib.ok(refreshBtn != null, 'the refresh log button is present in the log tab');

		files['/tmp/meshassistant.log'] = 'second run\n';
		await refreshBtn.attrs.click({});

		lib.eq(nodesByTag(root, 'pre')[0].textContent, 'second run\n',
			'the refresh button shows the latest log content');
		lib.eq(t.registry.notifications.length, 0,
			'refreshing the log succeeds silently');
	}

	{
		/*
		 * After a reboot /tmp is empty and nothing has written the run log
		 * yet; clicking Refresh Log used to show "Failed to refresh the
		 * log: NotFoundError" while the initial load showed the empty-log
		 * text for the same missing file.
		 */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			missingFiles: [ '/tmp/meshassistant.log' ]
		});

		await t.view.load();
		const root = await t.view.render();

		const refreshBtn = nodesByTag(root, 'button').find(function(button) {
			return textOf(button) === 'Refresh Log';
		});

		lib.ok(refreshBtn != null, 'the refresh log button is present without a log file');

		await refreshBtn.attrs.click({});

		lib.eq(t.registry.notifications.length, 0,
			'refreshing a missing run log does not report an error');
		lib.eq(nodesByTag(root, 'pre')[0].textContent, 'No log entries.',
			'a missing run log shows the empty-log placeholder');
	}

	{
		const t = loadView({
			devices: DEVICES,
			readReject: true,
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		const root = await t.view.render();

		const refreshBtn = nodesByTag(root, 'button').find(function(button) {
			return textOf(button) === 'Refresh Log';
		});

		await refreshBtn.attrs.click({});

		lib.eq(t.registry.notifications.length, 1,
			'a log read error other than a missing file is still reported');
	}

	{
		const now = Math.floor(Date.now() / 1000);
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/usr/sbin/batctl n': { code: 0, stdout: NEIGHBORS }
			},
			files: {
				'/tmp/meshassistant_peers': [
					now + ' aa:bb:cc:dd:ee:ff 192.168.10.111 OpenWrt 0.20',
					(now - 500) + ' aa:bb:cc:dd:ee:ff 192.168.10.99 stale-node 1.50'
				].join('\n')
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.eq(t.view.status.rows[0].hostname, 'OpenWrt',
			'peer announcement supplies the neighbor hostname');
		lib.eq(t.view.status.rows[0].ips, [ '192.168.10.111' ],
			'peer announcement supplies the neighbor IP');
		lib.eq(t.view.status.rows[0].load, '0.20',
			'peer announcement supplies the neighbor load');
		lib.ok(text.includes('OpenWrt'), 'peer hostname is rendered');
		lib.ok(text.includes('0.20'), 'peer load is rendered');
		lib.ok(!text.includes('stale-node'), 'stale peer announcement is ignored');
	}

	{
		const t = loadView({
			devices: DEVICES,
			readReject: true,
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Frequency'),
			'a failed peer file read does not hide the mesh status');
		lib.eq(t.view.status.rows[0].ips, [], 'a failed peer file read keeps empty IP lists');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 1, stdout: '' }
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Unable to read mesh status.'), 'batctl failure renders error state');
		lib.ok(text.includes('Enable Mesh Networking'), 'form still renders after batctl failure');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: '' }
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('No neighbor nodes found.'), 'empty neighbor list renders empty state');
	}

	{
		const t = loadView({
			devices: DEVICES.concat([
				{ getName() { return 'radio2'; }, getI18n() { return 'Radio Two (radio2)'; } }
			]),
			uciValues: {
				wireless: {
					radio0: { band: '2g' },
					radio1: { band: '5g' },
					radio2: { band: '6g' }
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const o = t.registry.options;

		lib.eq(o.wifi_radio.values.map(v => v[0]), [ 'radio0', 'radio1', 'radio2' ],
			'6 GHz radio is offered for the regular AP');
		lib.eq(o.apRadio.values.map(v => v[0]), [ 'radio0', 'radio1', 'radio2' ],
			'6 GHz radio remains available for mesh backhaul');
		lib.eq(o.wifi_id_radio2.title, 'SSID for radio2 (6 GHz)',
			'the per-radio SSID label shows the band name');
		lib.eq([ 'radio0', 'radio1', 'radio2' ].map(function(radio) {
			return o['wifi_id_' + radio] ? o['wifi_id_' + radio].title : null;
		}), [ 'SSID for radio0 (2.4 GHz)', 'SSID for radio1 (5 GHz)', 'SSID for radio2 (6 GHz)' ],
			'a separate SSID is offered for every radio, including 6 GHz');
		lib.eq(depsOf(o.wifi_id_radio2),
			[['mlo', '0'], ['ssid_mode', 'separate'], ['wifi_radio', '(^|,)radio2(,|$)']],
			'the 6 GHz SSID follows MLO and SSID mode like the other radios');
		lib.eq(o.wifi_radio.validate(null, 'radio0,radio1,radio2'), true,
			'all three radios can serve the regular AP');
	}

	{
		const t = loadView({
			devices: DEVICES.concat([
				{ getName() { return 'radio2'; }, getI18n() { return 'Radio Two (radio2)'; } }
			]),
			uciValues: {
				meshassistant: { config: { wifi_radio: 'radio2' } },
				wireless: {
					radio0: { band: '2g' },
					radio1: { band: '5g' },
					radio2: { band: '6g' }
				}
			}
		});

		await t.view.load();
		await t.view.render();

		lib.eq(t.registry.options.wifi_radio.values.map(v => v[0]),
			[ 'radio0', 'radio1', 'radio2' ],
			'an already saved 6 GHz selection is kept visible');
	}

	{
		const t = loadView({
			networkReject: true,
			wirelessSections: [{ '.name': 'radio9' }],
			execReply: { code: 0, stdout: '' }
		});

		await t.view.load();
		await t.view.render();

		lib.eq(t.registry.options.wifi_radio.values, [['radio9', 'radio9']],
			'radio choices fall back to UCI sections');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReject: true
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Unable to read mesh status.'),
			'exec rejection renders error state');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: '' },
			networkSections: [
				{
					'.name': '@device[0]', '.type': 'device',
					name: 'br-lan', type: 'bridge',
					ports: [ 'lan2', 'lan3', 'lan4', 'wan' ]
				},
				{ '.name': 'lan', '.type': 'interface', device: 'br-lan' },
				{ '.name': 'wan', '.type': 'interface', device: 'wan' }
			],
			uciValues: {
				network: { lan: { device: 'br-lan' } },
				meshassistant: { config: { wired_backhaul: 'lan2' } }
			}
		});

		await t.view.load();
		await t.view.render();

		lib.eq(t.registry.options.wired_backhaul.values, [
			['none', 'None (wireless backhaul only)'],
			['lan2', 'lan2'],
			['lan3', 'lan3'],
			['lan4', 'lan4']
		], 'wired ports come from the LAN bridge without WAN-owned ports');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: '' },
			networkSections: [
				{
					'.name': '@device[0]', '.type': 'device',
					name: 'br-lan', type: 'bridge',
					ports: [ 'lan2', 'lan3' ]
				},
				{ '.name': 'lan', '.type': 'interface', device: 'br-lan' }
			],
			uciValues: {
				network: { lan: { device: 'br-lan' } },
				meshassistant: { config: { wired_backhaul: 'lan9' } }
			}
		});

		await t.view.load();
		await t.view.render();

		lib.eq(t.registry.options.wired_backhaul.values, [
			['none', 'None (wireless backhaul only)'],
			['lan9', 'lan9'],
			['lan2', 'lan2'],
			['lan3', 'lan3']
		], 'a saved port is kept even when it is no longer in the LAN bridge');
	}

	{
		const FREQS = [
			{ band: 2, channel: 1, mhz: 2412 },
			{ band: 2, channel: 6, mhz: 2437 },
			{ band: 2, channel: 11, mhz: 2462 },
			{ band: 5, channel: 36, mhz: 5180 },
			{ band: 5, channel: 52, mhz: 5260 },
			{ band: 5, channel: 100, mhz: 5500 },
			{ band: 5, channel: 149, mhz: 5745 },
			{ band: 6, channel: 5, mhz: 5975 },
			{ band: 6, channel: 37, mhz: 6135 }
		];
		const COUNTRIES = [
			{ code: 'TW', country: 'Taiwan', iso3166: 'TW', active: true },
			{ code: 'US', country: 'United States', iso3166: 'US' },
			{ code: 'DE', country: 'Germany', iso3166: 'DE' }
		];
		const t = loadView({
			devices: DEVICES.concat([
				{ getName() { return 'radio2'; }, getI18n() { return 'Radio Two (radio2)'; } }
			]),
			iwinfo: { freqlist: FREQS, countrylist: COUNTRIES },
			uciValues: {
				wireless: {
					radio0: { band: '2g', htmode: 'HT40', channel: '6',
						txpower: '20', country: 'TW' },
					radio1: { band: '5g', htmode: 'EHT80', channel: '36',
						txpower: '23', country: 'TW' },
					radio2: { band: '6g', htmode: 'EHT320', channel: '37',
						txpower: '28', country: 'TW' }
				}
			}
		});

		await t.view.load();
		const root = await t.view.render();

		const o = t.registry.options;

		const spectrumPane = root.querySelector('[data-tab-title][data-tab="spectrum"]');
		const tabMenu = spectrumPane.querySelector('.meshassistant-spectrum-tabmenu');

		lib.ok(tabMenu != null, 'the spectrum tab gets its own radio menu');
		lib.eq(tabMenu.children.map(function(item) {
			return item.attrs['data-spectrum-tab'];
		}), [ 'radio0', 'radio1', 'radio2' ],
			'one sub-tab per radio interface');
		lib.eq(tabMenu.children.map(textOf),
			[ '2.4 GHz (radio0)', '5 GHz (radio1)', '6 GHz (radio2)' ],
			'the sub-tab titles name the band and radio interface');
		lib.eq(tabMenu.children[0].classList.contains('meshassistant-spectrum-tab-active'), true,
			'the first radio is shown by default');
		lib.eq(spectrumPane.querySelector('.meshassistant-spectrum-tabs')
			.previousElementSibling === tabMenu, true,
			'the radio menu sits directly before the radio pages');

		const panes = spectrumPane.querySelectorAll('.meshassistant-spectrum-pane');

		lib.eq(panes.map(function(pane) { return pane.attrs['data-spectrum-tab']; }),
			[ 'radio0', 'radio1', 'radio2' ], 'one page per radio interface');
		lib.eq(panes.map(function(pane) { return pane.attrs.style; }),
			[ '', 'display:none', 'display:none' ],
			'the first radio page is the visible one');
		lib.eq(o._spectrum_band_2g, undefined,
			'radio sub-tabs replace the band headings');
		lib.eq(panes.map(function(pane) {
			return pane.children.map(function(row) { return row.attrs['data-name']; });
		}), [
			[ '_spectrum_radio_radio0', 'spectrum_radio0_band', 'spectrum_radio0_mode',
			  'spectrum_radio0_width', 'spectrum_radio0_channel',
			  'spectrum_radio0_txpower', 'spectrum_radio0_country',
			  'spectrum_radio0_hint' ],
			[ '_spectrum_radio_radio1', 'spectrum_radio1_band', 'spectrum_radio1_mode',
			  'spectrum_radio1_width', 'spectrum_radio1_channel',
			  'spectrum_radio1_txpower', 'spectrum_radio1_country',
			  'spectrum_radio1_hint' ],
			[ '_spectrum_radio_radio2', 'spectrum_radio2_band', 'spectrum_radio2_mode',
			  'spectrum_radio2_width', 'spectrum_radio2_channel',
			  'spectrum_radio2_txpower', 'spectrum_radio2_country',
			  'spectrum_radio2_hint' ]
		], 'each radio page holds only that radio s fields');
		lib.eq(o._spectrum_radio_radio2.default,
			'<h4 class="meshassistant-spectrum-radio">radio2 - 6 GHz</h4>',
			'each radio has a heading with its band');
		lib.eq(o.spectrum_radio2_hint.default,
			'<p class="meshassistant-note meshassistant-spectrum-hint">Make sure the “Server” and the “Node” or “Client” use the same settings.</p>',
			'a radio without a channel plan gets only the shared-settings hint');
		lib.eq(o.spectrum_radio0_hint.rawhtml, true, 'the hint is rendered as HTML');
		lib.eq('spectrum_radio0_hint' in o && 'spectrum_radio1_hint' in o &&
			'spectrum_radio2_hint' in o, true, 'every radio page gets the hint');

		/*
		 * With a single node every band gets the first channel of the
		 * non-overlapping set, at the width the radio already uses. The
		 * recommendation shares the hint line instead of taking its own row.
		 */
		lib.eq(o.spectrum_radio0_hint.default,
			'<p class="meshassistant-note meshassistant-spectrum-hint">Suggested channel for this node: 1 (40 MHz). Make sure the “Server” and the “Node” or “Client” use the same settings.</p>',
			'2.4 GHz merges the recommendation into the shared-settings hint');
		lib.eq(o.spectrum_radio1_hint.default,
			'<p class="meshassistant-note meshassistant-spectrum-hint">Suggested channel for this node: 36 (80 MHz). Make sure the “Server” and the “Node” or “Client” use the same settings.</p>',
			'5 GHz merges the recommendation into the shared-settings hint');
		lib.eq('spectrum_radio0_plan' in o || 'spectrum_radio1_plan' in o, false,
			'the recommendation is not a separate form row');

		lib.eq(o.spectrum_radio0_band.default, '2.4 GHz', 'radio0 band is read-only 2.4 GHz');
		lib.eq(o.spectrum_radio1_band.default, '5 GHz', 'radio1 band is read-only 5 GHz');
		lib.eq(o.spectrum_radio2_band.default, '6 GHz', 'radio2 band is read-only 6 GHz');

		lib.eq(o.spectrum_radio0_mode.values.map(v => v[0]),
			[ '', 'HT', 'HE', 'EHT' ], '2.4 GHz offers HT, HE and EHT');
		lib.eq(o.spectrum_radio1_mode.values.map(v => v[0]),
			[ '', 'HT', 'VHT', 'HE', 'EHT' ], '5 GHz adds VHT');
		lib.eq(o.spectrum_radio2_mode.values.map(v => v[0]),
			[ '', 'HE', 'EHT' ], '6 GHz starts at HE');
		lib.eq(o.spectrum_radio0_mode.values[0][1], 'Keep current (HT)',
			'the unset mode shows the current mode');
		lib.eq(o.spectrum_radio0_mode.default, '', 'the PHY mode defaults to keep current');

		lib.eq(o.spectrum_radio0_width.values.map(v => v[0]),
			[ '', '20', '40' ], '2.4 GHz widths stop at 40 MHz');
		lib.eq(o.spectrum_radio1_width.values.map(v => v[0]),
			[ '', '20', '40', '80', '160' ], '5 GHz offers up to 160 MHz');
		lib.eq(o.spectrum_radio2_width.values.map(v => v[0]),
			[ '', '20', '40', '80', '160', '320' ], '6 GHz offers 320 MHz');
		lib.eq(o.spectrum_radio2_width.values[0][1], 'Keep current (320 MHz)',
			'the unset width shows the current width');

		lib.eq(o.spectrum_radio0_channel.values.map(v => v[0]),
			[ '', 'auto', '1', '6', '11' ], '2.4 GHz lists its own channels');
		lib.eq(o.spectrum_radio1_channel.values.map(v => v[0]),
			[ '', 'auto', '36', '52', '100', '149' ], '5 GHz lists its own channels');
		lib.eq(o.spectrum_radio2_channel.values.map(v => v[0]),
			[ '', 'auto', '5', '37' ], '6 GHz lists its own channels');
		lib.eq(o.spectrum_radio0_channel.values[0][1], 'Keep current (6)',
			'the unset channel shows the current channel');
		lib.eq(o.spectrum_radio1_channel.values[1][1], 'Auto', 'auto is offered');
		lib.ok(o.spectrum_radio1_channel.values.some(function(v) {
			return v[0] === '52' && v[1].includes('DFS');
		}), '5 GHz DFS channels are marked');
		lib.ok(!o.spectrum_radio0_channel.values.some(function(v) {
			return v[1].includes('DFS');
		}), '2.4 GHz channels are not marked as DFS');

		lib.eq(o.spectrum_radio0_txpower.__kind, 'Value', 'transmit power is a Value');
		lib.eq(o.spectrum_radio0_txpower.placeholder, '20',
			'the transmit power placeholder shows the current value');
		lib.eq(o.spectrum_radio0_txpower.datatype, 'range(1,40)',
			'the transmit power is limited to 1-40 dBm');
		lib.eq(o.spectrum_radio0_txpower.default, '', 'transmit power defaults to keep current');

		lib.eq(o.spectrum_radio0_country.values.map(v => v[0]),
			[ '', 'TW', 'US', 'DE' ], 'countries come from iwinfo');
		lib.eq(o.spectrum_radio0_country.values[1][1], 'TW - Taiwan',
			'a country shows its ISO code and name');
		lib.eq(o.spectrum_radio0_country.values[0][1], 'Keep current (TW)',
			'the unset country shows the current one');

		lib.eq(depsOf(o.spectrum_radio0_mode), [
			[ 'wifi_radio', '(^|,)radio0(,|$)' ],
			[ 'mlo', '1' ],
			[ '!reverse', true ]
		], 'the PHY mode only hides while MLO is on and the radio serves the AP');
		lib.eq(depsOf(o.spectrum_radio1_channel), [],
			'the channel does not follow the radio selection');
		lib.eq(depsOf(o.spectrum_radio1_band), [],
			'the band field does not follow the radio selection');
		lib.eq(depsOf(o.spectrum_radio2_width), [],
			'a radio keeps its fields whatever is selected in the basic setup');

		lib.eq(o.spectrum_radio0_mode.validate(null, ''), true,
			'keep current passes mode validation');
		lib.eq(o.spectrum_radio0_mode.validate(null, 'HT'), true,
			'HT is valid with the current HT40 width');
		o.spectrum_radio0_width.formvalue = function() { return '320'; };
		lib.eq(o.spectrum_radio0_mode.validate(null, 'HT'),
			'The selected PHY mode does not support this channel width.',
			'HT is refused with a 320 MHz width');
		lib.eq(o.spectrum_radio0_width.validate(null, '320'),
			'The selected PHY mode does not support this channel width.',
			'a width the current mode cannot use is refused');
		o.spectrum_radio0_width.formvalue = function() { return undefined; };
		lib.eq(o.spectrum_radio0_width.validate(null, '20'), true,
			'a valid width passes validation');

		/*
		 * Switching radio tabs must only change the visible page: every
		 * radio keeps its tab, whatever the basic setup selects.
		 */
		tabMenu.children[2].firstElementChild.attrs.click({ preventDefault() {} });

		lib.eq(tabMenu.children.map(function(item) {
			return item.attrs['data-spectrum-tab'];
		}), [ 'radio0', 'radio1', 'radio2' ],
			'clicking the last tab keeps every radio tab');
		lib.eq(panes.map(function(pane) { return pane.attrs.style; }),
			[ 'display:none', 'display:none', '' ],
			'the clicked radio page becomes the visible one');
		lib.eq(tabMenu.children[2].classList.contains('meshassistant-spectrum-tab-active'), true,
			'the clicked tab is marked active');

		/*
		 * Map.save() ends with renderContents(), which rebuilds the map DOM
		 * in place and drops everything the view injected into it.  The radio
		 * pages must be rebuilt on every render and the open radio must stay
		 * open.
		 */
		await t.registry.map.renderContents();

		const rebuiltPane = t.registry.map.root.querySelector(
			'[data-tab-title][data-tab="spectrum"]');
		const rebuiltMenu = rebuiltPane.querySelector('.meshassistant-spectrum-tabmenu');
		const rebuilt = rebuiltPane.querySelectorAll('.meshassistant-spectrum-pane');

		lib.ok(rebuiltMenu != null, 'a save re-render rebuilds the radio sub-tabs');
		lib.eq(rebuiltMenu.children.map(function(item) {
			return item.attrs['data-spectrum-tab'];
		}), [ 'radio0', 'radio1', 'radio2' ],
			'the rebuilt radio sub-tabs keep their order');
		lib.eq(rebuilt.map(function(pane) {
			return pane.children.map(function(row) { return row.attrs['data-name']; });
		}), [
			[ '_spectrum_radio_radio0', 'spectrum_radio0_band', 'spectrum_radio0_mode',
			  'spectrum_radio0_width', 'spectrum_radio0_channel',
			  'spectrum_radio0_txpower', 'spectrum_radio0_country',
			  'spectrum_radio0_hint' ],
			[ '_spectrum_radio_radio1', 'spectrum_radio1_band', 'spectrum_radio1_mode',
			  'spectrum_radio1_width', 'spectrum_radio1_channel',
			  'spectrum_radio1_txpower', 'spectrum_radio1_country',
			  'spectrum_radio1_hint' ],
			[ '_spectrum_radio_radio2', 'spectrum_radio2_band', 'spectrum_radio2_mode',
			  'spectrum_radio2_width', 'spectrum_radio2_channel',
			  'spectrum_radio2_txpower', 'spectrum_radio2_country',
			  'spectrum_radio2_hint' ]
		], 'the rebuilt pages hold the same radio fields');
		lib.eq(rebuilt.map(function(pane) { return pane.attrs.style; }),
			[ 'display:none', 'display:none', '' ],
			'a re-render keeps the radio page the user opened');
		lib.eq(rebuiltPane.querySelectorAll('.meshassistant-spectrum-tabs').length, 1,
			'a re-render leaves exactly one radio page group behind');
		lib.eq(t.registry.map.root.querySelectorAll('.meshassistant-tab-pane').length, 4,
			'the four form panes are marked again after a re-render');
	}

	{
		/*
		 * A device without a 6 GHz radio must not get a 6 GHz page or any
		 * 6 GHz fields at all.
		 */
		const t = loadView({
			devices: [
				{ getName() { return 'radio0'; }, getI18n() { return 'Radio Zero (radio0)'; } },
				{ getName() { return 'radio1'; }, getI18n() { return 'Radio One (radio1)'; } }
			],
			iwinfo: { freqlist: [], countrylist: [] },
			uciValues: {
				wireless: {
					radio0: { band: '2g', htmode: 'HT20', channel: '1' },
					radio1: { band: '5g', htmode: 'VHT80', channel: '36' }
				}
			}
		});

		await t.view.load();
		const root = await t.view.render();

		const menu = root.querySelector('.meshassistant-spectrum-tabmenu');

		lib.eq(menu.children.map(function(item) {
			return item.attrs['data-spectrum-tab'];
		}), [ 'radio0', 'radio1' ],
			'only the radios of the device get a sub-tab');
		lib.eq(t.registry.options.spectrum_radio2_mode, undefined,
			'a router without a 6 GHz radio has no 6 GHz options');
		lib.eq(t.registry.options._spectrum_band_6g, undefined,
			'a router without a 6 GHz radio has no 6 GHz heading');
	}

	{
		/*
		 * A radio interface without band information still gets its tab, so
		 * the tab set is always the set of interfaces of the device.
		 */
		const t = loadView({
			devices: [
				{ getName() { return 'radio0'; }, getI18n() { return 'Radio Zero (radio0)'; } },
				{ getName() { return 'radio1'; }, getI18n() { return 'Radio One (radio1)'; } }
			],
			iwinfo: { freqlist: [], countrylist: [] },
			uciValues: {
				wireless: {
					radio0: { band: '2g', htmode: 'HT20', channel: '1' },
					radio1: { htmode: 'HT20', channel: 'auto' }
				}
			}
		});

		await t.view.load();
		const root = await t.view.render();

		const menu = root.querySelector('.meshassistant-spectrum-tabmenu');

		lib.eq(menu.children.map(function(item) {
			return item.attrs['data-spectrum-tab'];
		}), [ 'radio0', 'radio1' ],
			'a radio without band information keeps its tab');
		lib.eq(menu.children.map(textOf),
			[ '2.4 GHz (radio0)', 'radio1 (radio1)' ],
			'a radio without band information is titled with its name');
		lib.eq(t.registry.options.spectrum_radio1_note.default,
			'<p class="meshassistant-note">This radio interface reports no frequency band, so no spectrum settings are available.</p>',
			'a radio without band information explains the missing settings');
		lib.eq(t.registry.options.spectrum_radio1_hint.default,
			'<p class="meshassistant-note meshassistant-spectrum-hint">Make sure the “Server” and the “Node” or “Client” use the same settings.</p>',
			'a radio without band information still gets the shared-settings hint');
		lib.eq(t.registry.options.spectrum_radio1_mode, undefined,
			'a radio without band information gets no PHY mode');
	}

	{
		/*
		 * A single-band device keeps a plain heading instead of a one-item
		 * tab menu.
		 */
		const t = loadView({
			devices: [
				{ getName() { return 'radio0'; }, getI18n() { return 'Radio Zero (radio0)'; } }
			],
			iwinfo: { freqlist: [], countrylist: [] },
			uciValues: {
				wireless: { radio0: { band: '2g', htmode: 'HT20', channel: '1' } }
			}
		});

		await t.view.load();
		const root = await t.view.render();

		lib.eq(t.registry.options._spectrum_band_2g.default,
			'<h3 class="meshassistant-spectrum-band">2.4 GHz</h3>',
			'a single-band device keeps the band heading');
		lib.eq(root.querySelectorAll('.meshassistant-spectrum-tabmenu').length, 0,
			'a single-radio device gets no radio sub-tabs');
	}

	{
		const listReply = {
			code: 0,
			stdout: [
				'20261105-143022.tar\t2026-11-05 14:30:22\tOpenWrt\t192.168.10.111\tserver',
				'20261105-140000.tar\t2026-11-05 14:00:00\tNodeA\t192.168.10.154\toff',
				''
			].join('\n')
		};
		const t = loadView({
			devices: DEVICES,
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh backup list': listReply
			}
		});

		await t.view.load();
		const root = await t.view.render();
		await t.view.refreshBackups();

		lib.eq(t.view.backups.length, 2, 'the backup list is parsed');
		lib.eq(t.view.backups[0].name, '20261105-143022.tar',
			'backups are sorted newest first');
		lib.eq(t.view.backups[0].role, 'server', 'the backup role is parsed');
		lib.eq(t.view.backups[1].lan_ip, '192.168.10.154',
			'the backup LAN address is parsed');

		const backupPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.attrs['data-tab'] === 'backup';
		});

		lib.ok(backupPane != null, 'the backup management tab is rendered');
		lib.eq(nodesByTag(backupPane, 'button').map(textOf), [
			'Create Backup', 'Restore Backup', 'Delete Backup', 'Clear Backups'
		], 'the backup tab has the four requested buttons');
		lib.ok(textOf(backupPane).includes('/etc/meshassistant/backup'),
			'the backup tab shows the storage path');
		lib.ok(textOf(backupPane).includes('20261105-143022.tar'),
			'the backup list is rendered');
		lib.ok(textOf(backupPane).includes('Server'),
			'the role label is translated through the UI strings');

		const buttons = nodesByTag(backupPane, 'button');

		await buttons[1].attrs.click({});
		lib.eq(t.registry.modals.length, 1, 'restore opens a dialog');
		lib.eq(t.registry.modals[0].title, 'Restore Backup', 'restore dialog title');

		const restoreModal = t.registry.modals[0];
		const select = restoreModal.children[2].querySelector('select');

		lib.ok(select != null, 'multiple backups offer a selection');
		lib.eq(nodesByTag(restoreModal.children[2], 'option').length, 2,
			'both backups are offered');

		select.dispatchEvent({ type: 'change', target: { value: '20261105-140000.tar' } });

		const restoreButtons = buttonsOf(restoreModal);
		await restoreButtons[1].attrs.click({});

		lib.eq(t.registry.writes[0].path, '/tmp/meshassistant_backup_selection',
			'the selected backup name is written to the selection file');
		lib.eq(t.registry.writes[0].data, '20261105-140000.tar',
			'the chosen backup is passed to the script');
		lib.eq(t.registry.writes[0].mode, 384, 'the selection file is private');
		lib.eq(t.registry.calls.filter(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args[0] === '--detach' && call.args[1] === 'backup';
		}), [{
			command: '/etc/meshassistant/shell/meshassistant.sh',
			args: [ '--detach', 'backup', 'restore' ]
		}], 'restore runs detached');

		await buttons[2].attrs.click({});
		lib.eq(t.registry.modals.length, 2, 'delete opens a dialog');
		lib.eq(t.registry.modals[1].title, 'Delete Backup', 'delete dialog title');

		const deleteModal = t.registry.modals[1];
		const deleteButtons = buttonsOf(deleteModal);

		await deleteButtons[1].attrs.click({});
		lib.eq(t.registry.writes[1].data, '20261105-143022.tar',
			'the newest backup is selected by default');
		lib.ok(t.registry.calls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'backup delete';
		}), 'delete runs the backup delete command');

		await buttons[3].attrs.click({});
		lib.eq(t.registry.modals.length, 3, 'clear opens a dialog');
		lib.eq(t.registry.modals[2].title, 'Clear Backups', 'clear dialog title');

		await buttonsOf(t.registry.modals[2])[1].attrs.click({});
		lib.ok(t.registry.calls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'backup clear';
		}), 'clear runs the backup clear command');

		await buttons[0].attrs.click({});
		lib.ok(t.registry.calls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'backup create';
		}), 'the create button runs the backup create command');

		const callsBeforeApply = t.registry.calls.length;

		await t.view.handleSaveApply({}, '0');

		const applyCalls = t.registry.calls.slice(callsBeforeApply);
		const createIndex = applyCalls.findIndex(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'backup create';
		});
		const baseIndex = applyCalls.findIndex(function(call) {
			return call.command === 'VIEW_HANDLE_SAVE_APPLY';
		});

		lib.ok(createIndex !== -1, 'Save & Apply creates a backup');
		lib.ok(baseIndex !== -1, 'Save & Apply calls the LuCI handler');
		lib.ok(createIndex < baseIndex,
			'the backup is taken before Save & Apply writes the form');
		lib.eq(t.registry.saveApply.mode, '0',
			'the Save & Apply mode is forwarded to LuCI');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		await t.view.render();

		const panes = t.registry.tabGroups[0];
		const statusPane = panes.find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		lib.ok(!!statusPane, 'the Mesh Status pane exists');

		const timerMs = t.registry.timers.map(function(timer) { return timer.ms; });

		lib.eq(t.registry.timers.length, 2,
			'the Mesh Status and connected-device refresh timers are started');
		lib.eq(timerMs[0], 10000,
			'the Mesh Status refresh interval is 10 seconds');
		lib.eq(timerMs[1], 60000,
			'the connected-device refresh interval is 60 seconds');

		let before = t.registry.calls.length;

		/* The settings tab is active, so a tick must not read anything. */
		await t.registry.timers[0].fn();
		lib.eq(t.registry.calls.length, before,
			'an inactive Mesh Status tab is not refreshed');

		/* Active but in a background browser tab: still no reads. */
		statusPane.setAttribute('data-tab-active', 'true');
		t.registry.document.visibilityState = 'hidden';
		await t.registry.timers[0].fn();
		lib.eq(t.registry.calls.length, before,
			'a hidden browser tab does not refresh Mesh Status');

		/* Active and visible: only the status data is read again. */
		t.registry.document.visibilityState = 'visible';
		t.opts.execReply = {
			code: 0,
			stdout: 'cc:dd:ee:ff:00:11    0.100s (    999.0) [     wlan0]'
		};

		before = t.registry.calls.length;
		await t.registry.timers[0].fn();

		const refreshCalls = t.registry.calls.slice(before);

		lib.ok(refreshCalls.some(function(call) {
			return call.command === '/usr/sbin/batctl' && call.args.join(' ') === 'n';
		}), 'the refresh reads batctl n again');
		lib.ok(refreshCalls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'linkinfo';
		}), 'the refresh reads linkinfo again');
		lib.ok(!refreshCalls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'clients';
		}), 'a Mesh Status tick does not re-read the connected devices');
		lib.ok(t.registry.reads.length > 0, 'the refresh reads the peer file');
		lib.ok(textOf(statusPane).indexOf('cc:dd:ee:ff:00:11') !== -1,
			'the Mesh Status table is updated in place');

		/* A failed read keeps the last good snapshot, marked as stale. */
		t.opts.execReply = { code: 1, stdout: '' };
		await t.registry.timers[0].fn();
		lib.ok(textOf(statusPane).includes('cc:dd:ee:ff:00:11'),
			'a failed refresh keeps the previous snapshot');
		lib.ok(textOf(statusPane).includes('The last refresh failed'),
			'a failed refresh marks the kept snapshot as stale');

		/* Switching back to the tab refreshes without waiting for a tick. */
		t.opts.execReply = { code: 0, stdout: NEIGHBORS };
		before = t.registry.calls.length;
		statusPane.dispatchEvent({ type: 'cbi-tab-active' });
		await new Promise(function(resolve) { setImmediate(resolve); });
		lib.ok(t.registry.calls.length > before,
			'becoming the active tab refreshes immediately');

		/* A detached pane stops the timer instead of polling forever. */
		statusPane.remove();
		const cleared = t.registry.clearedTimers.length;
		before = t.registry.calls.length;
		await t.registry.timers[0].fn();
		lib.ok(t.registry.clearedTimers.length > cleared,
			'a detached Mesh Status pane stops the timer');
		lib.eq(t.registry.calls.length, before,
			'a detached Mesh Status pane performs no reads');
	}

	{
		/* Supported device, roaming off: the status page makes the feature
		 * discoverable instead of turning it on by default. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=0\nwnm=1\ndawn=1\n'
				}
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.ok(text.includes('This device supports 802.11k/v'),
			'a supported device with roaming off shows the enable hint');
		lib.ok(!text.includes('Client roaming is on, but'),
			'the off state shows no capability warning');
	}

	{
		/* Roaming on without 802.11v: say why clients are not steered. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=0\ndawn=1\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('this wpad build lacks 802.11v'),
			'roaming on without 802.11v shows a warning');
		lib.ok(!text.includes('This device supports 802.11k/v'),
			'the unsupported device gets no enable hint');
	}

	{
		/* Roaming on without DAWN: a separate warning names the missing piece. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=1\ndawn=0\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('DAWN is not installed'),
			'roaming on without DAWN shows a warning');
	}

	{
		/* DAWN is installed but its service is down: clients are not being
		 * steered, and the page has to say so while the roaming switch is on. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=0\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('DAWN service is not running'),
			'roaming on with a stopped DAWN shows a warning');
		lib.ok(!text.includes('DAWN is not installed'),
			'a stopped service is not mistaken for a missing package');
	}

	{
		/* A running DAWN produces no warning. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=1\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(!text.includes('Client roaming is on, but'),
			'a running DAWN shows no capability warning');
	}

	{
		/* The Mesh Status refresh re-reads the capabilities, so a DAWN that
		 * stops is reported without reloading the page. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=1\n'
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');
		t.registry.document.visibilityState = 'visible';

		lib.ok(!textOf(statusPane).includes('DAWN service is not running'),
			'a running DAWN shows no warning in the status pane');

		t.opts.execReplies['/etc/meshassistant/shell/meshassistant.sh capabilities'] = {
			code: 0, stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=0\n'
		};

		await t.registry.timers[0].fn();

		lib.ok(textOf(statusPane).includes('DAWN service is not running'),
			'a status refresh reports a DAWN that has stopped');
	}

	{
		/* procd keeps respawning a crashing DAWN, so the service looks
		 * "running" almost all the time.  A respawn count that grows
		 * between status refreshes is the visible sign of that loop; once
		 * the count resets (a manual restart) the warning goes away. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0,
					stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=1\ndawn_restarts=2\n'
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');
		t.registry.document.visibilityState = 'visible';

		lib.ok(!textOf(statusPane).includes('DAWN keeps restarting'),
			'a stable DAWN shows no restart warning');

		t.opts.execReplies['/etc/meshassistant/shell/meshassistant.sh capabilities'] = {
			code: 0,
			stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=1\ndawn_restarts=3\n'
		};

		await t.registry.timers[0].fn();

		lib.ok(textOf(statusPane).includes('DAWN keeps restarting'),
			'a growing respawn count warns about a restart loop');
		lib.ok(textOf(statusPane).includes('respawn count: 3'),
			'the restart warning names the current respawn count');

		t.opts.execReplies['/etc/meshassistant/shell/meshassistant.sh capabilities'] = {
			code: 0,
			stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=1\ndawn_restarts=0\n'
		};

		await t.registry.timers[0].fn();

		lib.ok(!textOf(statusPane).includes('DAWN keeps restarting'),
			'a manual restart resets the count and clears the warning');
	}

	{
		/* A failed capability read must not be mistaken for "unsupported". */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 1, stdout: ''
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(!text.includes('This device supports 802.11k/v') &&
			!text.includes('Client roaming is on, but'),
			'a failed capability read shows neither hint nor warning');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh clients': {
					code: 0,
					stdout: [
						'client aa:bb:cc:dd:ee:01 phy0.0-ap0 iphone 192.168.10.20 -61',
						'client aa:bb:cc:dd:ee:02 lan2 printer - -'
					].join('\n')
				}
			}
		});

		await t.view.load();
		const root = await t.view.render();
		const text = textOf(root);

		lib.eq(t.view.status.clients.ok, true, 'a successful client read is marked ok');
		lib.eq(t.view.status.clients.clients.length, 2,
			'both attached devices are kept');
		lib.ok(text.includes('Connected Devices'), 'the clients section has a heading');
		lib.ok(text.includes('Number of Connected Devices: 2'),
			'the clients section counts the attached devices');
		lib.ok(text.includes('iphone'), 'a wireless client hostname is rendered');
		lib.ok(text.includes('192.168.10.20'), 'a wireless client address is rendered');
		lib.ok(text.includes('-61 dBm'), 'a wireless client signal is rendered');
		lib.ok(text.includes('printer'), 'a wired client hostname is rendered');
		lib.eq(tableTitles(root),
			[ 'Hostname', 'Interface', 'MAC Address', 'IPv4 Address', 'Signal Strength' ],
			'clients table column order');
		const stacks = nodesByClass(root, 'meshassistant-status-sections');
		lib.eq(stacks.length, 1, 'the status sections share one spaced column');
		lib.eq(stacks[0].childNodes.filter(c => c.nodeType === 1).map(c => c.attrs.class),
			[ 'cbi-section', 'cbi-section' ],
			'mesh status and connected devices are separate cards');
	}

	{
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh clients': {
					code: 0, stdout: ''
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Number of Connected Devices: 0'),
			'an empty client list still shows the count');
		lib.ok(text.includes('No connected devices found.'),
			'an empty client list shows a placeholder');
	}

	{
		/* A failed clients read must not hide the mesh status above it. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh clients': {
					code: 1, stdout: ''
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Unable to read the connected devices.'),
			'a failed client read shows its own error');
		lib.ok(text.includes('Number of Active Nodes: 1'),
			'the mesh status still renders when the client read fails');
	}

	{
		/* And a failed mesh status read must not hide the clients section. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 1, stdout: '' },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh clients': {
					code: 0,
					stdout: 'client aa:bb:cc:dd:ee:01 phy0.0-ap0 iphone 192.168.10.20 -61'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Unable to read mesh status.'),
			'a failed mesh status read still reports the error');
		lib.ok(text.includes('iphone'),
			'the clients section still renders when the mesh status read fails');
	}

	{
		/* A transient failure of the clients read must not replace the
		 * last good device table with the error message. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh clients': {
					code: 0,
					stdout: 'client aa:bb:cc:dd:ee:01 phy0.0-ap0 iphone 192.168.10.20 -61'
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');
		lib.ok(textOf(statusPane).includes('iphone'),
			'the connected devices table starts with the device');

		t.opts.execReplies['/etc/meshassistant/shell/meshassistant.sh clients'] =
			{ code: 1, stdout: '' };
		await (t.registry.timers[1]
			? t.registry.timers[1].fn
			: function() { return Promise.resolve(); })();

		lib.ok(textOf(statusPane).includes('iphone'),
			'a failed clients refresh keeps the last good device table');
		lib.ok(!textOf(statusPane).includes('Unable to read the connected devices.'),
			'a failed clients refresh does not show the error over good data');
	}

	{
		/* The connected-device list refreshes on its own slower timer.  A
		 * clients tick must not re-read the mesh table, and a mesh tick must
		 * not wait for the (potentially expensive) clients read. */
		const CLIENTS = '/etc/meshassistant/shell/meshassistant.sh clients';
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				[CLIENTS]: {
					code: 0,
					stdout: 'client aa:bb:cc:dd:ee:01 phy0.0-ap0 iphone 192.168.10.20 -61'
				}
			}
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');

		lib.eq(t.registry.timers.length, 2,
			'both refresh timers are started for the connected-device test');

		const clientsTick = t.registry.timers[1]
			? t.registry.timers[1].fn
			: function() { return Promise.resolve(); };

		let before = t.registry.calls.length;
		await clientsTick();

		let calls = t.registry.calls.slice(before);

		lib.ok(calls.some(function(call) {
			return call.command === '/etc/meshassistant/shell/meshassistant.sh' &&
				call.args.join(' ') === 'clients';
		}), 'the connected-device timer reads the clients');
		lib.ok(!calls.some(function(call) {
			return call.command === '/usr/sbin/batctl';
		}), 'the connected-device timer does not re-read the mesh table');

		t.opts.execReplies[CLIENTS] = {
			code: 0,
			stdout: 'client aa:bb:cc:dd:ee:02 phy0.0-ap0 ipad 192.168.10.21 -55'
		};

		await clientsTick();

		lib.ok(textOf(statusPane).includes('ipad'),
			'the connected-device timer updates the device table');
		lib.ok(textOf(statusPane).includes('aa:bb:cc:dd:ee:ff'),
			'the connected-device refresh keeps the mesh table');

		/* The settings tab stays quiet on the clients timer too. */
		statusPane.setAttribute('data-tab-active', null);
		before = t.registry.calls.length;
		await clientsTick();
		lib.eq(t.registry.calls.length, before,
			'an inactive Mesh Status tab does not refresh the connected devices');
	}

	{
		/* A refresh rebuilds the whole status pane; the horizontal scroll
		 * positions of the wide tables must survive it. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');

		const scrollers = statusPane.querySelectorAll('.meshassistant-status-scroll');

		lib.ok(scrollers.length > 0, 'the status pane has scrollable tables');

		scrollers.forEach(function(el, i) {
			el.scrollLeft = 40 + i;
		});

		await t.registry.timers[0].fn();

		const after = statusPane.querySelectorAll('.meshassistant-status-scroll');

		lib.eq(after.length, scrollers.length,
			'the table containers are recreated with the same structure');
		lib.eq(after.map(function(el) { return el.scrollLeft; }),
			scrollers.map(function(_, i) { return 40 + i; }),
			'the horizontal scroll positions survive a status refresh');
	}

	{
		/* On a single-radio device the AP radio default must be that radio:
		 * a hardcoded default outside the offered choices would leave the
		 * form empty and fail its own validation on save. */
		const t = loadView({
			devices: [ DEVICES[0] ],
			execReply: { code: 0, stdout: NEIGHBORS }
		});

		await t.view.load();
		await t.view.render();

		const wifiRadio = t.registry.options.wifi_radio;

		lib.eq(wifiRadio.values.map(function(choice) { return choice[0]; }),
			[ 'radio0' ], 'a single-radio device offers only its radio');
		lib.eq(wifiRadio.default, 'radio0',
			'the AP radio default is the first offered radio');
	}

	{
		/* A mesh that the user turned off is a configured state, not a read
		 * error: the tab must say so instead of showing the red failure. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 1, stdout: '' },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'state active=0\nlocal router 192.168.10.2 0.10 server\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Mesh networking is disabled on this device.'),
			'a stopped mesh is reported as disabled');
		lib.ok(!text.includes('Unable to read mesh status.'),
			'a stopped mesh does not show the read error');
	}

	{
		/* Turning the mesh off also stops DAWN, so the roaming warning would
		 * be noise next to the disabled notice. */
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 1, stdout: '' },
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh linkinfo': {
					code: 0,
					stdout: 'state active=0\n'
				},
				'/etc/meshassistant/shell/meshassistant.sh capabilities': {
					code: 0, stdout: 'kvr=1\nwnm=1\ndawn=1\ndawn_running=0\n'
				}
			}
		});

		await t.view.load();
		const text = textOf(await t.view.render());

		lib.ok(text.includes('Mesh networking is disabled on this device.'),
			'a stopped mesh is still reported as disabled');
		lib.ok(!text.includes('DAWN service is not running'),
			'a stopped mesh shows no DAWN warning');
	}

	{
		/* The status snapshot carries its update time, and a failed refresh
		 * keeps the table but marks it stale instead of passing it off as
		 * current data forever. */
		const LINKINFO = '/etc/meshassistant/shell/meshassistant.sh linkinfo';
		const t = loadView({
			devices: DEVICES,
			execReply: { code: 0, stdout: NEIGHBORS },
			execReplies: {
				[LINKINFO]: { code: 0, stdout: 'state active=1\n' }
			}
		});

		await t.view.load();
		await t.view.render();

		const statusPane = t.registry.tabGroups[0].find(function(pane) {
			return pane.getAttribute('data-tab') === 'status';
		});

		statusPane.setAttribute('data-tab-active', 'true');

		lib.ok(textOf(statusPane).includes('Updated at'),
			'the status page shows when it was last updated');

		t.opts.execReply = { code: 1, stdout: '' };
		await t.registry.timers[0].fn();

		lib.ok(textOf(statusPane).includes('aa:bb:cc:dd:ee:ff'),
			'a failed refresh keeps the last table');
		lib.ok(textOf(statusPane).includes('The last refresh failed'),
			'a failed refresh marks the table as stale');

		t.opts.execReply = { code: 0, stdout: NEIGHBORS };
		await t.registry.timers[0].fn();

		lib.ok(!textOf(statusPane).includes('The last refresh failed'),
			'a successful refresh clears the stale marker');
		lib.ok(textOf(statusPane).includes('Updated at'),
			'a successful refresh updates the timestamp');

		/* Turning the mesh off while the page is open must be visible too. */
		t.opts.execReply = { code: 1, stdout: '' };
		t.opts.execReplies[LINKINFO] = { code: 0, stdout: 'state active=0\n' };
		await t.registry.timers[0].fn();

		lib.ok(textOf(statusPane).includes('Mesh networking is disabled on this device.'),
			'turning the mesh off is reported on the open page');
		lib.ok(textOf(statusPane).includes('The last refresh failed'),
			'the kept table stays marked as stale after the mesh is turned off');
	}

	/*
	 * The roaming counters are read with the status snapshot: hostapd keeps
	 * them per BSS, and a refresh must pick up new transitions without a
	 * page reload.
	 */
	{
		const ROAMING_KEY = '/etc/meshassistant/shell/meshassistant.sh roaming';
		const ROAMING = [
			'bss phy0.0-ap0 2462 40 26 3',
			'bss phy0.1-ap0 5180 - - -'
		].join('\n');
		const t = loadView({
			execReplies: {
				[ROAMING_KEY]: { code: 0, stdout: ROAMING }
			}
		});

		await t.view.load();
		const root = await t.view.render();

		lib.eq(t.view.status.roaming.map(function(row) {
			return [ row.iface, row.freq, row.nr, row.btmTx, row.btmRx ];
		}), [
			[ 'phy0.0-ap0', 2462, 40, 26, 3 ],
			[ 'phy0.1-ap0', 5180, null, null, null ]
		], 'the roaming counters reach the status object');

		let text = textOf(root);
		lib.ok(text.includes('Roaming Activity'),
			'the status page shows a roaming activity panel');
		lib.ok(text.includes('Cumulative 802.11k/v transition counters'),
			'the panel explains what the counters mean');
		lib.eq(tableTitles(root), [
			'Interface', 'Frequency', 'Neighbor Reports',
			'Steering Requests', 'Steering Responses'
		], 'the roaming table has one column per counter');
		lib.ok(text.includes('phy0.0-ap0') && text.includes('2462 MHz'),
			'the roaming table names the interface and its frequency');
		lib.ok(text.includes('40') && text.includes('26') && text.includes('3'),
			'the roaming table shows the counters');
		lib.ok(text.includes('phy0.1-ap0'),
			'an interface without counters still gets a row');

		const statusPane = root.querySelector('[data-tab-title][data-tab="status"]');

		statusPane.setAttribute('data-tab-active', 'true');

		t.opts.execReplies[ROAMING_KEY] = {
			code: 0,
			stdout: 'bss phy0.0-ap0 2462 41 27 4'
		};

		await t.registry.timers[0].fn();

		text = textOf(statusPane);
		lib.ok(text.includes('41') && text.includes('27') && text.includes('4'),
			'a status refresh updates the roaming counters');
	}

	/*
	 * Without counters (hostapd not running, or the exec denied) the panel
	 * stays away instead of showing an empty table.
	 */
	{
		const t = loadView({
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh roaming':
					{ code: 1, stdout: '' }
			}
		});

		await t.view.load();
		const root = await t.view.render();

		lib.eq(t.view.status.roaming, [], 'a failed roaming read yields no rows');
		lib.ok(!textOf(root).includes('Roaming Activity'),
			'the roaming panel is hidden without counters');
	}

	/*
	 * A node that expects a DHCP lease but has none has lost its uplink or the
	 * server's DHCP service.  The status page names that cause instead of
	 * leaving only an unreachable node.
	 */
	{
		const LINKINFO = '/etc/meshassistant/shell/meshassistant.sh linkinfo';
		const DHCP_NODE = {
			uciValues: { meshassistant: { config: { role: 'off', ipmode: 'dhcp' } } },
			lanStatus: { up: false, 'ipv4-address': [] },
			execReplies: { [LINKINFO]: { code: 0, stdout: 'local node2 192.168.10.2 0.14 off\n' } }
		};
		const t = loadView(DHCP_NODE);

		await t.view.load();
		let root = await t.view.render();
		let text = textOf(root);

		lib.eq(t.view.status.lanLease, '',
			'a node without a lease records the missing address');
		lib.ok(text.includes('This node has no DHCP lease'),
			'a DHCP node without a lease shows a warning');

		/* The lease can appear after the page was opened. */
		const statusPane = root.querySelector('[data-tab-title][data-tab="status"]');

		statusPane.setAttribute('data-tab-active', 'true');
		t.opts.lanStatus = { up: true, 'ipv4-address': [ { address: '192.168.10.2', mask: 24 } ] };
		await t.registry.timers[0].fn();
		lib.ok(!textOf(statusPane).includes('This node has no DHCP lease'),
			'a status refresh clears the warning once the lease is back');

		t.opts.lanStatus = { up: false, 'ipv4-address': [] };
		await t.registry.timers[0].fn();
		lib.ok(textOf(statusPane).includes('This node has no DHCP lease'),
			'a status refresh brings the warning back when the lease is lost');
	}

	/* A static node has no lease to miss, and the server does not use one. */
	{
		for (const scenario of [
			[ 'a static node', 'local node2 192.168.10.2 0.14 off\n',
				{ meshassistant: { config: { ipmode: 'static' } } } ],
			[ 'a node whose LAN is static without an ipmode',
				'local node2 192.168.10.2 0.14 off\n',
				{ network: { lan: { proto: 'static', ipaddr: '192.168.10.2' } } } ],
			[ 'the server', 'local router 192.168.10.1 0.10 server\n', {} ]
		]) {
			const t = loadView({
				uciValues: scenario[2],
				lanStatus: { up: false, 'ipv4-address': [] },
				execReplies: {
					'/etc/meshassistant/shell/meshassistant.sh linkinfo':
						{ code: 0, stdout: scenario[1] }
				}
			});

			await t.view.load();
			const text = textOf(await t.view.render());

			lib.ok(!text.includes('This node has no DHCP lease'),
				scenario[0] + ' shows no lease warning');
		}

		const t = loadView({
			uciValues: { meshassistant: { config: { role: 'off', ipmode: 'dhcp' } } },
			lanStatusReject: true,
			execReplies: {
				'/etc/meshassistant/shell/meshassistant.sh linkinfo':
					{ code: 0, stdout: 'local node2 192.168.10.2 0.14 off\n' }
			}
		});

		await t.view.load();
		lib.ok(!textOf(await t.view.render()).includes('This node has no DHCP lease'),
			'an unreadable LAN status shows no lease warning');
	}

	lib.summary('view');
}

run().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
