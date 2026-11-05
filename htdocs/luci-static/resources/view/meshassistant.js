'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require rpc';
'require network';
'require meshassistant.utils as utils';

document.querySelector('head').appendChild(E('link', {
	'rel': 'stylesheet',
	'type': 'text/css',
	'href': L.resource('view/meshassistant/meshassistant.css')
}));

const BATCTL = '/usr/sbin/batctl';
const SCRIPT = '/meshassistant/meshassistant.sh';
const PEERS_FILE = '/tmp/meshassistant_peers';
const LOG_FILE = '/tmp/meshassistant.log';

const callLanStatus = rpc.declare({
	object: 'network.interface',
	method: 'status',
	params: [ 'interface' ],
	expect: { }
});

const callFreqList = rpc.declare({
	object: 'iwinfo',
	method: 'freqlist',
	params: [ 'device' ],
	expect: { results: [] }
});

const callCountryList = rpc.declare({
	object: 'iwinfo',
	method: 'countrylist',
	params: [ 'device' ],
	expect: { results: [] }
});

const BAND_NAMES = {
	'2g': '2.4 GHz',
	'5g': '5 GHz',
	'6g': '6 GHz'
};

const BAND_NUMBERS = {
	'2g': 2,
	'5g': 5,
	'6g': 6
};

const BAND_MODES = {
	'2g': [ 'HT', 'HE', 'EHT' ],
	'5g': [ 'HT', 'VHT', 'HE', 'EHT' ],
	'6g': [ 'HE', 'EHT' ]
};

const BAND_WIDTHS = {
	'2g': [ 20, 40 ],
	'5g': [ 20, 40, 80, 160 ],
	'6g': [ 20, 40, 80, 160, 320 ]
};

function radioBand(radio) {
	return uci.get('wireless', radio, 'band') || '';
}

function parseHtmode(htmode) {
	const match = /^(HT|VHT|HE|EHT)(20|40|80|160|320)$/.exec(htmode || '');

	return match
		? { mode: match[1], width: Number(match[2]) }
		: { mode: '', width: null };
}

function isDfsChannel(band, channel) {
	if (band !== '5g')
		return false;

	channel = Number(channel);

	return (channel >= 52 && channel <= 64) ||
		(channel >= 100 && channel <= 144);
}

function bandFrequencies(frequencies, band) {
	const want = BAND_NUMBERS[band];
	const seen = {};
	const out = [];

	for (const freq of frequencies || []) {
		if (freq.band !== want || !freq.channel || seen[freq.channel])
			continue;

		if (freq.restricted && (freq.flags || []).indexOf('no_ir') !== -1)
			continue;

		seen[freq.channel] = true;
		out.push(freq);
	}

	out.sort(function(a, b) { return a.channel - b.channel; });

	return out;
}

function validSpectrumPair(band, mode, width) {
	switch (mode) {
	case 'HT':
		return width === 20 || width === 40;
	case 'VHT':
		return band === '5g' && [ 20, 40, 80, 160 ].indexOf(width) !== -1;
	case 'HE':
		return [ 20, 40, 80, 160 ].indexOf(width) !== -1;
	case 'EHT':
		return [ 20, 40, 80, 160 ].indexOf(width) !== -1 ||
			(band === '6g' && width === 320);
	default:
		return true;
	}
}

function radioOptions(devices) {
	const choices = [];

	for (const dev of devices)
		choices.push([ dev.getName(), dev.getI18n() || dev.getName() ]);

	return choices;
}

/*
 * The spectrum settings of more than one band are shown as sub-tabs inside
 * the Spectrum Settings tab.  LuCI groups tab pages by their data-tab /
 * data-tab-title attributes, so the already rendered rows are moved into one
 * page per band and a regular tab menu is created for them.
 */
function renderSpectrumTabs(mapEl, groups) {
	const container = mapEl.querySelector('[data-tab="spectrum"]');

	if (!container)
		return;

	const nameBand = {};
	const panes = {};

	for (const group of groups) {
		for (const radio of group.radios) {
			const names = [ '_spectrum_radio_' + radio ];

			for (const field of [ 'band', 'mode', 'width', 'channel', 'txpower', 'country' ])
				names.push('spectrum_' + radio + '_' + field);

			for (const name of names)
				nameBand[name] = group.band;
		}

		panes[group.band] = E('div', {
			'data-tab': 'spectrum-' + group.band,
			'data-tab-title': group.label
		});
	}

	for (const row of Array.from(container.querySelectorAll('[data-name]'))) {
		const band = nameBand[row.getAttribute('data-name')];

		if (band)
			panes[band].appendChild(row);
	}

	/* Argon zeroes the top margin of the element after a tab menu. */
	const wrapper = E('div', { 'style': 'margin-block-start: 0.5rem' },
		groups.map(function(group) {
			return panes[group.band];
		}));

	container.appendChild(wrapper);
	ui.tabs.initTabGroup(wrapper.childNodes);

	/*
	 * CBI hides a band page once all of its radios are deselected.  If that
	 * page was the active one the area would stay visible but empty, so
	 * switch to a band that still has fields (checked after CBI updated the
	 * dependency states, which happens earlier in the same event).
	 */
	mapEl.addEventListener('widget-change', function() {
		keepBandTabActive(wrapper);
	});
}

function keepBandTabActive(wrapper) {
	const menu = wrapper.previousElementSibling;

	if (!menu || typeof ui.tabs.isEmptyPane !== 'function')
		return;

	const panes = wrapper.children;
	let active = null;

	for (let i = 0; i < panes.length; i++) {
		if (panes[i].getAttribute('data-tab-active') === 'true')
			active = panes[i];
	}

	if (active && !ui.tabs.isEmptyPane(active))
		return;

	for (let i = 0; i < panes.length; i++) {
		if (ui.tabs.isEmptyPane(panes[i]))
			continue;

		const name = panes[i].getAttribute('data-tab');

		for (let j = 0; j < menu.children.length; j++) {
			if (menu.children[j].getAttribute('data-tab') !== name)
				continue;

			const link = menu.children[j].firstElementChild;

			if (link && typeof link.click === 'function')
				link.click();

			return;
		}
	}
}

/*
 * Normalize a UCI option that may be a list or a legacy single string.
 * LuCI returns an array for UCI lists and a string for plain options.
 */
function listValues(value) {
	if (value == null)
		return [];

	if (Array.isArray(value))
		return value.filter(Boolean);

	return String(value).trim().split(/\s+/).filter(Boolean);
}

/*
 * Ethernet ports that can be dedicated to wired backhaul.  Only ports of the
 * LAN bridge are offered; ports owned by another logical interface (usually
 * the WAN uplink) are skipped because netifd cannot use the same device for
 * two interfaces.
 */
function wiredPortOptions() {
	const lan = uci.get('network', 'lan') || {};
	let lanDevice = lan.device;

	if (Array.isArray(lanDevice))
		lanDevice = lanDevice[0];

	if (!lanDevice) {
		const ifname = lan.ifname;
		lanDevice = Array.isArray(ifname) ? ifname[0] : ifname;
	}

	const devices = uci.sections('network', 'device');
	let bridge = null;

	if (lanDevice)
		bridge = devices.find(function(dev) {
			return dev.name === lanDevice && dev.type === 'bridge';
		});

	if (!bridge)
		bridge = devices.find(function(dev) { return dev.type === 'bridge'; });

	if (!bridge)
		return [];

	const ports = Array.isArray(bridge.ports)
		? bridge.ports
		: (bridge.ports ? String(bridge.ports).split(/\s+/) : []);
	const interfaces = uci.sections('network', 'interface');
	const choices = [];
	const seen = new Set();

	for (const port of ports) {
		if (!port || seen.has(port))
			continue;
		if (port === 'none' || port === 'lo' || port.indexOf('br-') === 0)
			continue;
		if (port === 'bat0' || port === 'mesh_batman' || port === 'mesh_wired')
			continue;

		const inUse = interfaces.some(function(iface) {
			if (iface['.name'] === 'lan' || iface['.name'] === 'mesh_wired')
				return false;

			const dev = iface.device;
			const ifn = iface.ifname;
			const ifnames = Array.isArray(ifn) ? ifn : (ifn ? [ ifn ] : []);

			return dev === port || ifnames.indexOf(port) !== -1;
		});

		if (inUse)
			continue;

		seen.add(port);
		choices.push([ port, port ]);
	}

	return choices;
}

function statusSubtitle(title) {
	return E('div', {
		'class': 'cbi-section-descr',
		'style': 'font-size:0.95rem;font-weight:bold'
	}, [ title ]);
}

function statusTable(rows) {
	const titles = [
		_('Node Hostname'),
		_('Node MAC'),
		_('IP Address'),
		_('Interface'),
		_('Backhaul'),
		_('Frequency'),
		_('Channel'),
		_('Channel Width'),
		_('Signal Strength'),
		_('Load'),
		_('Channel Utilization'),
		_('Link Rate')
	];

	const table = E('div', { 'class': 'table' }, [
		E('div', { 'class': 'tr table-titles' },
			titles.map(function(title) {
				return E('div', { 'class': 'th' }, [ title ]);
			}))
	]);

	for (const row of rows) {
		table.appendChild(E('div', { 'class': 'tr' }, [
			E('div', { 'class': 'td' }, [ row.hostname || '-' ]),
			E('div', { 'class': 'td' }, [ row.neighbor || '-' ]),
			E('div', { 'class': 'td' }, [
				row.ips && row.ips.length ? row.ips.join(', ') : '-'
			]),
			E('div', { 'class': 'td' }, [ row.iface || '-' ]),
			E('div', { 'class': 'td' }, [
				row.backhaul === 'wired' ? _('Wired') :
				row.backhaul === 'wlan' ? _('Wireless') : '-'
			]),
			E('div', { 'class': 'td' }, [ row.frequency || '-' ]),
			E('div', { 'class': 'td' }, [ row.channel || '-' ]),
			E('div', { 'class': 'td' }, [ row.width || '-' ]),
			E('div', { 'class': 'td' }, [ row.signal || '-' ]),
			E('div', { 'class': 'td' }, [ row.load || '-' ]),
			E('div', { 'class': 'td' }, [ row.utilization || '-' ]),
			E('div', { 'class': 'td' }, [ row.speed ? row.speed + ' Mbps' : '-' ])
		]));
	}

	return table;
}

function renderStatus(status) {
	const rows = status.rows;
	const children = [
		E('h3', {}, [ _('Mesh Status') ]),
		E('div', { 'class': 'cbi-section-descr' }, [
			E('strong', {}, [
				_('Number of Active Nodes: %d').format(rows.length)
			])
		])
	];

	if (!status.ok) {
		children.push(E('div', { 'class': 'alert-message error' }, [
			_('Unable to read mesh status.')
		]));

		return E('div', { 'class': 'cbi-section' }, children);
	}

	children.push(statusSubtitle(_('Remote Hosts')));

	if (rows.length === 0) {
		children.push(E('div', { 'class': 'cbi-section-descr' }, [
			_('No neighbor nodes found.')
		]));
	}
	else {
		children.push(statusTable(rows));
	}

	if (status.local) {
		children.push(statusSubtitle(_('Local Host')));
		children.push(statusTable([ status.local ]));
	}

	return E('div', { 'class': 'cbi-section' }, children);
}

function runScript(args) {
	return fs.exec(SCRIPT, args).then(function() {
		ui.addNotification(null, E('p', [
			_('Mesh settings are being applied in the background.')
		]), 'info');
	}).catch(function(err) {
		ui.addNotification(null, E('p', [
			_('Failed to apply mesh settings: %s').format(err)
		]), 'error');
	});
}

return view.extend({
	radios: [],
	apRadios: [],
	freqList: [],
	countryList: [],
	wiredPorts: [],
	status: { ok: true, rows: [] },
	logText: '',
	lanDefaults: { ipaddr: '', netmask: '', gateway: '', dns: '' },

	load() {
		return Promise.all([
			uci.load('meshassistant'),
			uci.load('wireless'),
			uci.load('network')
		]).then(() => {
			return Promise.all([
				network.getWifiDevices().catch(() => []),
				fs.exec(BATCTL, [ 'n' ]).catch(() => null),
				fs.exec(BATCTL, [ 'meshif', 'bat0', 'transtable_global_json' ]).catch(() => null),
				fs.exec(BATCTL, [ 'meshif', 'bat0', 'dat_cache_json' ]).catch(() => null),
				network.getHostHints().catch(() => null),
				callLanStatus('lan').catch(() => null),
				fs.read(PEERS_FILE).catch(() => ''),
				fs.exec(SCRIPT, [ 'linkinfo' ]).catch(() => null),
				fs.read(LOG_FILE).catch(() => '')
			]);
		}).then(([ devices, reply, ttReply, datReply, hosts, lanStatus, peers, linkReply, logText ]) => {
			this.radios = devices.length
				? radioOptions(devices)
				: uci.sections('wireless', 'wifi-device').map(function(s) {
					return [ s['.name'], s['.name'] ];
				});

			/*
			 * Any radio can serve the regular AP, so the same WiFi network
			 * can be offered on 2.4 GHz, 5 GHz and 6 GHz at once.
			 * Wi-Fi 6E is WPA3-only, so hostapd starts the 6 GHz radio with
			 * SAE even though the AP encryption is WPA2/WPA3 mixed.  A radio
			 * with no band information is kept for older configurations.
			 */
			this.apRadios = this.radios;

			this.wiredPorts = wiredPortOptions();

			const current = uci.get('meshassistant', 'config', 'wired_backhaul');

			if (current && current !== 'none' &&
			    !this.wiredPorts.some(function(p) { return p[0] === current; }))
				this.wiredPorts.unshift([ current, current ]);

			this.status = utils.parseStatus(reply, ttReply, datReply, hosts, peers, linkReply);
			this.logText = logText || '';
			this.lanDefaults = utils.lanDefaults(lanStatus, uci.get('network', 'lan') || {});

			/*
			 * The channel and country lists come from iwinfo.  Only radios
			 * with a known band are queried; a radio without band data has
			 * no meaningful spectrum section anyway.
			 */
			const banded = this.radios
				.map(function(choice) { return choice[0]; })
				.filter(function(radio) { return BAND_NAMES[radioBand(radio)] != null; });

			this.freqList = [];
			this.countryList = [];

			if (banded.length === 0)
				return;

			return Promise.all([
				Promise.all(banded.map(function(radio) {
					return callFreqList(radio).catch(function() {
						return { results: [] };
					});
				})),
				callCountryList(banded[0]).catch(function() {
					return { results: [] };
				})
			]).then(([ lists, countries ]) => {
				const seen = {};

				for (const list of lists) {
					for (const freq of (list && list.results) || [])
						seen[freq.band + ':' + freq.channel] = freq;
				}

				this.freqList = Object.keys(seen).map(function(key) {
					return seen[key];
				});
				this.countryList = (countries && countries.results) || [];
			});
		});
	},

	render() {
		const statusEl = renderStatus(this.status);

		const m = new form.Map('meshassistant');
		const s = m.section(form.TypedSection, 'meshassistant', _('Mesh Settings'));

		s.anonymous = true;
		s.addremove = false;

		s.tab('setup', _('Basic Setup'));
		s.tab('spectrum', _('Spectrum Settings'),
			_('Set the channel plan for the selected regular AP and mesh radios. The settings are written to the radios when the mesh configuration is reapplied; fields left at “Keep current” are not changed.'));
		s.tab('apmode', _('AP Mode'));
		s.tab('advanced', _('Advanced Settings'));

		let o;

		o = s.taboption('setup', form.Flag, 'enabled', _('Enable Mesh Networking'), _('Toggle this switch to activate or deactivate the Mesh Network on this device according to the settings specified in this configuration.'));
		o.default = '0';

		o = s.taboption('setup', form.ListValue, 'role', _('Mesh Mode'), _('Choose whether this device is a Server, Client, or Node in the mesh network.'));
		o.value('server', _('Server'));
		o.value('off', _('Node'));
		o.value('client', _('Client'));
		o.default = 'server';
		/*
		 * LuCI drops options whose value equals the form default, so the
		 * default "Server" would never reach UCI.  The script needs the
		 * literal role, so keep writing it.
		 */
		o.rmempty = false;

		o = s.taboption('setup', form.Flag, 'server_dhcp', _('Server Provides DHCP'), _('Keep this enabled when the Mesh server is the only gateway and should provide DHCP and IPv6 RA for the LAN. Disable it when another router on the LAN already provides DHCP: the server then keeps the gateway and DNS role but stops its own DHCP/RA server.'));
		o.default = '1';
		o.depends('role', 'server');

		o = s.taboption('setup', form.Value, 'wifi_id', _('WiFi Network SSID'), _('SSID for the regular WiFi network. This SSID is also used by the MLO access point and by radios without their own SSID.'));
		o.default = 'meshassistant_AC';
		/*
		 * With separate SSIDs this field only remains a fallback for radios
		 * without their own SSID, so hide it unless the shared SSID is the
		 * one actually configured.  MLO always uses the shared SSID.  The
		 * radio list is comma-joined, so two or more entries match.
		 */
		o.depends({ mlo: '0', ssid_mode: 'separate', wifi_radio: /^[^,]+(?:,[^,]+)+$/, '!reverse': true });

		o = s.taboption('setup', form.MultiValue, 'wifi_radio', _('Regular AP Radio'), _('Select one or more radios (2.4 GHz, 5 GHz and 6 GHz) for the regular WiFi access point. The SSID for each radio can be configured below.'));

		for (const [ value, label ] of this.apRadios)
			o.value(value, label);

		/*
		 * Keep a radio that is already saved even if it is no longer offered
		 * (for example a radio that is no longer present), so opening and
		 * saving the page cannot silently drop it.
		 */
		for (const value of listValues(uci.get('meshassistant', 'config', 'wifi_radio'))) {
			if (this.apRadios.some(function(choice) { return choice[0] === value; }))
				continue;

			const known = this.radios.find(function(choice) { return choice[0] === value; });
			o.value(value, known ? known[1] : value);
		}

		o.default = 'radio1';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return listValues(value).length > 0 || _('Select at least one radio.');
		};

		const wifiRadioOption = o;

		/*
		 * MLO combines exactly two radios into one Wi-Fi 7 access point.
		 * The dependency matches a MultiValue converted to its comma-joined
		 * form, so the checkbox appears once two radios are selected.  It is
		 * also shown for three or more radios: the dependent SSID options
		 * read an inactive option as null, so hiding MLO would hide SSID Mode
		 * and the per-radio SSIDs as well.  The validator below keeps MLO off
		 * unless exactly two radios are selected, which is all the driver and
		 * the setup script support.
		 */
		o = s.taboption('setup', form.Flag, 'mlo', _('Enable MLO'), _('Combine two selected radios into one Wi-Fi 7 Multi-Link Operation (MLO) access point. The radios are switched to EHT mode. MLO requires exactly two radios.'));
		o.default = '0';
		o.depends('wifi_radio', /^[^,]+(?:,[^,]+)+$/);
		/*
		 * The checkbox widget always hands its enabled value ("1") to the
		 * validator, so read the live checkbox state and the radio
		 * selection from the form instead of the passed value.
		 */
		o.validate = function(section_id) {
			if (this.formvalue(section_id) == '1' &&
			    listValues(wifiRadioOption.formvalue(section_id)).length !== 2)
				return _('MLO requires exactly two radios.');

			return true;
		};

		/*
		 * SSID Mode only matters once a second radio is selected; the
		 * comma-joined list therefore has to contain at least two entries.
		 */
		o = s.taboption('setup', form.ListValue, 'ssid_mode', _('SSID Mode'), _('Choose whether the selected radios share one SSID or use a separate SSID per radio. Separate SSIDs disable seamless 802.11r roaming between the radios.'));
		o.value('same', _('Same SSID'));
		o.value('separate', _('Separate SSIDs'));
		o.default = 'same';
		o.depends({ mlo: '0', wifi_radio: /^[^,]+(?:,[^,]+)+$/ });

		for (const [ value ] of this.apRadios) {
			const band = BAND_NAMES[radioBand(value)];
			const radioLabel = band ? '%s (%s)'.format(value, band) : value;

			o = s.taboption('setup', form.Value, 'wifi_id_' + value,
				_('SSID for %s').format(radioLabel),
				_('SSID used by this radio when separate SSIDs are enabled. Leave empty to use the shared SSID.'));
			o.depends({
				mlo: '0',
				ssid_mode: 'separate',
				wifi_radio: new RegExp('(^|,)' + value + '(,|$)')
			});
		}

		o = s.taboption('setup', form.ListValue, 'apRadio', _('Mesh Radio'), _('Select one radio interface for mesh backhaul traffic.'));
		for (const [ value, label ] of this.radios)
			o.value(value, label);
		o.default = 'radio0';

		o = s.taboption('setup', form.ListValue, 'wired_backhaul', _('Wired Backhaul Port'), _('Select the Ethernet port cabled to another Mesh device. The port is dedicated to wired backhaul and removed from the LAN bridge. Wired is used while the cable is connected; the Mesh radio is used when it is not. Choose None for wireless-only backhaul.'));
		o.value('none', _('None (wireless backhaul only)'));
		for (const [ value, label ] of this.wiredPorts)
			o.value(value, label);
		o.default = 'none';

		o = s.taboption('setup', form.Value, 'mesh_id', _('Mesh Network SSID'), _('Ensure that the SSID is the same across all the servers/nodes in your mesh network.'));
		o.default = 'meshassistant_AC';

		o = s.taboption('setup', form.Flag, 'encryption', _('Password Protection'), _('Enable this switch to require a password to join your Mesh Network.'));
		o.default = '0';

		o = s.taboption('setup', form.Value, 'key', _('Mesh Password'));
		o.default = 'meshassistant';
		o.password = true;
		o.datatype = 'minlength(8)';
		o.depends('encryption', '1');

		o = s.taboption('setup', form.Button, '_btn_reapply', _('Reapply meshassistant Settings'), _('Use this button to apply/reapply meshassistant configuration after you Save & Apply.'));
		const renderReapply = o.render;
		o.render = function() {
			return renderReapply.apply(this, arguments).then(function(node) {
				const description = node.querySelector('.cbi-value-description');

				if (description)
					description.classList.add('meshassistant-note');

				return node;
			});
		};
		o.onclick = ui.createHandlerFn(this, function() {
			return runScript([ '--detach' ]);
		});

		/*
		 * Spectrum settings are stored per radio in the meshassistant config
		 * and applied to wireless by the script on the next reapply.  A radio
		 * is shown only while it is selected as a regular AP radio or as the
		 * mesh radio; both roles are ORed so a radio used for both is shown
		 * once.  Empty values are removed from the UCI config, which tells the
		 * script to leave the radio's current setting alone.
		 */
		const spectrumBands = {};

		for (const [ radio ] of this.radios) {
			const band = radioBand(radio);

			if (!BAND_NAMES[band])
				continue;

			if (!spectrumBands[band])
				spectrumBands[band] = [];

			spectrumBands[band].push(radio);
		}

		function addRadioDeps(option, radio) {
			option.depends({ wifi_radio: new RegExp('(^|,)' + radio + '(,|$)') });
			option.depends({ apRadio: radio });
		}

		/*
		 * Only bands that an actual radio of this device uses are collected,
		 * so a router without a 6 GHz radio never gets a 6 GHz group.  With
		 * more than one band the groups become sub-tabs of the spectrum tab
		 * (see renderSpectrumTabs); a single-band device keeps a heading.
		 */
		const spectrumGroups = [];

		for (const band of [ '2g', '5g', '6g' ]) {
			if (spectrumBands[band]) {
				spectrumGroups.push({
					band: band,
					label: BAND_NAMES[band],
					radios: spectrumBands[band]
				});
			}
		}

		for (const group of spectrumGroups) {
			const band = group.band;
			const radios = group.radios;
			const bandLabel = group.label;

			if (spectrumGroups.length === 1) {
				const bandHeader = s.taboption('spectrum', form.DummyValue,
					'_spectrum_band_' + band, '', '');

				bandHeader.default = '<h3 class="meshassistant-spectrum-band">%s</h3>'
					.format(bandLabel);
				bandHeader.rawhtml = true;

				for (const radio of radios)
					addRadioDeps(bandHeader, radio);
			}

			for (const radio of radios) {
				const current = parseHtmode(uci.get('wireless', radio, 'htmode'));
				const currentChannel = uci.get('wireless', radio, 'channel') || 'auto';
				const currentTxpower = uci.get('wireless', radio, 'txpower') || '';
				const currentCountry = uci.get('wireless', radio, 'country') || '';

				const radioHeader = s.taboption('spectrum', form.DummyValue,
					'_spectrum_radio_' + radio, '', '');

				radioHeader.default = '<h4 class="meshassistant-spectrum-radio">%s - %s</h4>'
					.format(radio, bandLabel);
				radioHeader.rawhtml = true;
				addRadioDeps(radioHeader, radio);

				const bandOpt = s.taboption('spectrum', form.DummyValue,
					'spectrum_' + radio + '_band', _('Band'),
					_('Band plan of this radio (read-only).'));
				bandOpt.default = bandLabel;
				bandOpt.rawhtml = false;
				addRadioDeps(bandOpt, radio);

				const modeOpt = s.taboption('spectrum', form.ListValue,
					'spectrum_' + radio + '_mode', _('PHY Mode'),
					_('PHY layer protocol mode. Leave at “Keep current” to keep the radio mode.'));
				modeOpt.value('', _('Keep current (%s)')
					.format(current.mode || _('driver default')));
				for (const mode of BAND_MODES[band])
					modeOpt.value(mode, mode);
				modeOpt.default = '';
				/*
				 * An AP radio that participates in MLO is forced to EHT by
				 * the script, so do not offer a mode that would silently be
				 * overwritten.  The mesh radio keeps its mode selector.
				 */
				modeOpt.depends({
					wifi_radio: new RegExp('(^|,)' + radio + '(,|$)'),
					mlo: '0'
				});
				modeOpt.depends({ apRadio: radio });

				let widthOpt;

				modeOpt.validate = function(section_id, value) {
					if (!value)
						return true;

					let width = current.width;

					try {
						const selected = widthOpt && widthOpt.formvalue(section_id);

						if (selected)
							width = Number(selected);
					}
					catch (e) { }

					return validSpectrumPair(band, value, width) ||
						_('The selected PHY mode does not support this channel width.');
				};

				widthOpt = s.taboption('spectrum', form.ListValue,
					'spectrum_' + radio + '_width', _('Channel Width'),
					_('Channel bandwidth / channel bonding. Leave at “Keep current” to keep the radio width.'));
				widthOpt.value('', _('Keep current (%s)')
					.format(current.width ? current.width + ' MHz' : _('driver default')));
				for (const width of BAND_WIDTHS[band])
					widthOpt.value(String(width), width + ' MHz');
				widthOpt.default = '';
				addRadioDeps(widthOpt, radio);
				widthOpt.validate = function(section_id, value) {
					if (!value)
						return true;

					let mode = current.mode;

					try {
						const selected = modeOpt.formvalue(section_id);

						if (selected)
							mode = selected;
					}
					catch (e) { }

					return validSpectrumPair(band, mode, Number(value)) ||
						_('The selected PHY mode does not support this channel width.');
				};

				const channelOpt = s.taboption('spectrum', form.ListValue,
					'spectrum_' + radio + '_channel', _('Channel'),
					_('Channel planning / frequency assignment. Leave at “Keep current” to keep the radio channel.'));
				channelOpt.value('', _('Keep current (%s)').format(currentChannel));
				channelOpt.value('auto', _('Auto'));
				for (const freq of bandFrequencies(this.freqList, band)) {
					const label = isDfsChannel(band, freq.channel)
						? _('Channel %s (%s MHz, DFS)').format(freq.channel, freq.mhz)
						: _('Channel %s (%s MHz)').format(freq.channel, freq.mhz);

					channelOpt.value(String(freq.channel), label);
				}
				channelOpt.default = '';
				addRadioDeps(channelOpt, radio);

				const txpowerOpt = s.taboption('spectrum', form.Value,
					'spectrum_' + radio + '_txpower', _('Maximum Transmit Power'),
					_('Transmit power / EIRP in dBm. Leave empty to keep the current transmit power.'));
				txpowerOpt.default = '';
				txpowerOpt.placeholder = currentTxpower || '0';
				txpowerOpt.datatype = 'range(1,40)';
				addRadioDeps(txpowerOpt, radio);

				const countryOpt = s.taboption('spectrum', form.ListValue,
					'spectrum_' + radio + '_country', _('Country Code'),
					_('Regulatory domain (ISO/IEC 3166 alpha-2). Leave at “Keep current” to keep the current country code.'));
				countryOpt.value('', _('Keep current (%s)')
					.format(currentCountry || _('driver default')));

				const seenCountries = {};

				for (const country of this.countryList) {
					const code = country.iso3166 || country.code;

					if (!code || seenCountries[code])
						continue;

					seenCountries[code] = true;
					countryOpt.value(code, '%s - %s'.format(code, country.country || code));
				}

				countryOpt.default = '';
				addRadioDeps(countryOpt, radio);
			}
		}

		o = s.taboption('advanced', form.Flag, 'kvr', _('K/V/R'), _('Leave these settings as default unless you know what you are doing.'));
		o.default = '1';

		o = s.taboption('advanced', form.Value, 'mobility_domain', _('Mobility Domain'));
		o.default = '4f57';
		o.datatype = 'and(hexstring,rangelength(4,4))';

		o = s.taboption('advanced', form.Value, 'rssi_val', _('Good RSSI Threshold'));
		o.default = '-60';
		o.datatype = 'range(-120,-1)';

		o = s.taboption('advanced', form.Value, 'low_rssi_val', _('Bad RSSI Threshold'));
		o.default = '-88';
		o.datatype = 'range(-120,-1)';

		o = s.taboption('apmode', form.Value, 'hostname', _('Node Hostname'));
		o.default = 'node2';
		for (let i = 2; i <= 9; i++)
			o.value('node' + i, 'node' + i);
		o.datatype = 'string';
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.ListValue, 'ipmode', _('IP Mode'), _('Choose if the node uses DHCP or a Static IP'));
		o.value('dhcp', _('DHCP'));
		o.value('static', _('Static'));
		o.default = 'dhcp';
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'ipaddr', _('Static IP Address'));
		o.default = this.lanDefaults.ipaddr;
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'gateway', _('Mesh Gateway IP Address'));
		o.default = this.lanDefaults.gateway;
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'netmask', _('IPv4 netmask'));
		o.default = this.lanDefaults.netmask;
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'dns', _('DNS Server'));
		o.default = this.lanDefaults.dns;
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Button, '_btn_apmode', _('Enable Dumb AP Mode'), _('WARNING: THIS WILL CHANGE THE IP ADDRESS OF THIS NODE, YOU WILL LOSE ACCESS TO THIS UI'));
		o.onclick = ui.createHandlerFn(this, function() {
			ui.showModal(_('Enable Dumb AP Mode'), [
				E('p', {}, [
					_('WARNING: THIS WILL CHANGE THE IP ADDRESS OF THIS NODE, YOU WILL LOSE ACCESS TO THIS UI')
				]),
				E('p', {}, [ _('Continue?') ]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.hideModal
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(this, function() {
							ui.hideModal();
							return runScript([ '--detach', 'dumbap' ]);
						})
					}, _('Enable Dumb AP Mode'))
				])
			]);
		});
		o.depends('role', /^(off|client)$/);

		return m.render().then((mapEl) => {
			if (spectrumGroups.length > 1)
				renderSpectrumTabs(mapEl, spectrumGroups);

			const settingsEl = E('div', {
				'data-tab': 'settings',
				'data-tab-title': _('Mesh Settings'),
				'data-tab-active': 'true'
			}, [ mapEl ]);

			const statusPane = E('div', {
				'data-tab': 'status',
				'data-tab-title': _('Mesh Status')
			}, [ statusEl ]);

			const logContent = E('pre', {
				'style': 'white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto;margin:1rem 0 0 0.5rem;padding-bottom:0.5rem'
			}, [ this.logText || _('No log entries.') ]);

			const refreshLog = ui.createHandlerFn(this, function() {
				return fs.read(LOG_FILE).then((text) => {
					this.logText = text || '';
					logContent.textContent = this.logText || _('No log entries.');
				}).catch(function(err) {
					ui.addNotification(null, E('p', [
						_('Failed to refresh the log: %s').format(err)
					]), 'error');
				});
			});

			const clearLog = ui.createHandlerFn(this, function() {
				return fs.exec(SCRIPT, [ 'clearlog' ]).then(() => {
					this.logText = '';
					logContent.textContent = _('No log entries.');
				}).catch(function(err) {
					ui.addNotification(null, E('p', [
						_('Failed to clear the log: %s').format(err)
					]), 'error');
				});
			});

			const logPane = E('div', {
				'data-tab': 'log',
				'data-tab-title': _('Run Log')
			}, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'style': 'margin-bottom:0.5rem' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': refreshLog
						}, [ _('Refresh Log') ]),
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': clearLog
						}, [ _('Clear Log') ])
					]),
					logContent
				])
			]);

			/*
			 * Argon zeroes the top margin of the element that follows the tab
			 * menu, so set the gap inline; the theme rules cannot override it.
			 */
			const tabsEl = E('div', { 'style': 'margin-block-start: 0.5rem' },
				[ settingsEl, statusPane, logPane ]);
			const pageEl = E('div', {}, [ tabsEl ]);

			ui.tabs.initTabGroup(tabsEl.childNodes);

			return pageEl;
		});
	}
});
