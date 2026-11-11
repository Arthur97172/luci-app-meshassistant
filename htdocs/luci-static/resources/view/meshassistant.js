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
const SCRIPT = '/etc/meshassistant/shell/meshassistant.sh';
const PEERS_FILE = '/tmp/meshassistant_peers';
const LOG_FILE = '/tmp/meshassistant.log';
const BACKUP_DIR = '/etc/meshassistant/backup';
const BACKUP_SELECTION = '/tmp/meshassistant_backup_selection';

/*
 * How often the Mesh Status tab refreshes itself while it is the active tab.
 * The peer announcements are written every 10 seconds, so refreshing at the
 * same rate keeps the table current without reading batctl, the peer file and
 * the wireless stations more often than the underlying data changes.
 */
const STATUS_REFRESH_INTERVAL = 10000;

/*
 * The connected-device list changes far less often than the mesh table, and
 * reading it can be expensive because the nodes reverse-resolve unnamed
 * clients.  It refreshes on its own slower timer, so a slow clients read never
 * delays the Mesh Status table.
 */
const CLIENTS_REFRESH_INTERVAL = 60000;

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

/*
 * rpc.declare() with an `expect` of { results: [] } resolves to the value of
 * that key, so the frequency and country calls return the array itself.
 * Older LuCI replies may still wrap it, so accept both shapes.
 */
function rpcResults(value) {
	if (Array.isArray(value))
		return value;

	return (value && Array.isArray(value.results)) ? value.results : [];
}

/*
 * Every radio page ends with the same reminder: the spectrum settings only
 * match up when the server and the node/client are configured alike.
 */
function addSpectrumHint(s, radio) {
	const hint = s.taboption('spectrum', form.DummyValue,
		'spectrum_' + radio + '_hint', '', '');

	hint.default = '<p class="meshassistant-note meshassistant-spectrum-hint">%s</p>'
		.format(_('Make sure the “Server” and the “Node” or “Client” use the same settings.'));
	hint.rawhtml = true;
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
 * The spectrum settings of more than one radio interface are shown as
 * sub-tabs inside the Spectrum Settings tab: one page per radio interface,
 * titled with its band and interface name.
 *
 * The menu is built here instead of through ui.tabs.  LuCI's updateTabs()
 * hides every tab whose page has no visible rows, which would make the
 * sub-tabs come and go with the radio selection of the basic setup and with
 * every form re-render.  A radio interface must keep its tab in every state,
 * so the pages use their own attributes and the menu is always complete.
 *
 * For the same reason the menu does not use the cbi-tabmenu class: the theme
 * styles that class for the menus ui.tabs builds and may change the size or
 * colour of these items with the theme.  meshassistant.css styles the menu.
 */
function renderSpectrumTabs(mapEl, radios, state) {
	/*
	 * The tab menu items also carry a data-tab attribute, so a plain
	 * [data-tab="spectrum"] lookup finds the menu entry instead of the page.
	 * Only the page itself also carries data-tab-title.
	 */
	const container = mapEl.querySelector('[data-tab-title][data-tab="spectrum"]');

	if (!container)
		return;

	/*
	 * CBI rebuilds the whole map after a save, so this runs again on a fresh
	 * container.  Should it ever run twice on the same DOM, move the rows out
	 * of the old pages first so they are not thrown away with them.
	 */
	const previous = container.querySelector('.meshassistant-spectrum-tabs');

	if (previous) {
		for (const row of Array.from(previous.querySelectorAll('[data-name]')))
			container.appendChild(row);

		const menu = previous.previousElementSibling;

		if (menu && menu.classList.contains('meshassistant-spectrum-tabmenu'))
			menu.remove();

		previous.remove();
	}

	const rows = {};

	for (const { radio } of radios)
		rows[radio] = [];

	/*
	 * Every row of a radio is named after it: the heading is
	 * _spectrum_radio_<radio> and every field is spectrum_<radio>_<field>.
	 */
	for (const row of Array.from(container.querySelectorAll('[data-name]'))) {
		const name = row.getAttribute('data-name');

		for (const { radio } of radios) {
			if (name === '_spectrum_radio_' + radio ||
			    name.indexOf('spectrum_' + radio + '_') === 0) {
				rows[radio].push(row);
				break;
			}
		}
	}

	const panes = {};
	const items = {};
	const menu = E('ul', { 'class': 'meshassistant-spectrum-tabmenu' });

	const activate = function(radio) {
		state.active = radio;

		for (const entry of radios) {
			const isActive = entry.radio === radio;

			/* An empty style attribute removes the inline display rule. */
			panes[entry.radio].setAttribute('style', isActive ? '' : 'display:none');

			if (isActive)
				items[entry.radio].classList.add('meshassistant-spectrum-tab-active');
			else
				items[entry.radio].classList.remove('meshassistant-spectrum-tab-active');
		}
	};

	for (const { radio, label } of radios) {
		panes[radio] = E('div', {
			'class': 'meshassistant-spectrum-pane',
			'data-spectrum-tab': radio
		}, rows[radio]);

		items[radio] = E('li', { 'data-spectrum-tab': radio },
			E('a', {
				'href': '#',
				'title': label + ' (' + radio + ')',
				'click': function(ev) {
					if (ev && typeof ev.preventDefault === 'function')
						ev.preventDefault();

					activate(radio);
				}
			}, label + ' (' + radio + ')'));

		menu.appendChild(items[radio]);
	}

	/* Argon zeroes the top margin of the element after a tab menu. */
	const wrapper = E('div', {
		'class': 'meshassistant-spectrum-tabs',
		'style': 'margin-block-start: 0.5rem'
	}, radios.map(function(entry) {
		return panes[entry.radio];
	}));

	container.appendChild(menu);
	container.appendChild(wrapper);

	/* Keep the page the user last opened across re-renders. */
	const wanted = radios.filter(function(entry) { return entry.radio === state.active; });

	activate(wanted.length ? state.active : radios[0].radio);
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

function statusSubtitle(title, badge) {
	const text = [ title ];

	if (badge) {
		text.push(' ');
		text.push(E('span', { 'class': 'meshassistant-role' }, [ badge ]));
	}

	return E('div', {
		'class': 'cbi-section-descr',
		'style': 'font-size:0.95rem;font-weight:bold'
	}, text);
}

/*
 * The effective mesh role of this device.  An empty option is the server
 * default, and the "off" role is the form's Node choice.
 */
function meshRoleLabel(role) {
	switch (role) {
	case 'off':
		return _('Node');
	case 'client':
		return _('Client');
	default:
		return _('Server');
	}
}

function statusCell(label, value, extraClass) {
	const text = value == null || value === '' ? '-' : String(value);
	let cls = 'td';

	if (text === '-')
		cls += ' meshassistant-empty';
	if (extraClass)
		cls += ' ' + extraClass;

	return E('div', { 'class': cls, 'data-label': label }, [ text ]);
}

function statusStateCell(label, state) {
	if (state === 'inuse')
		return E('div', { 'class': 'td meshassistant-cell-state', 'data-label': label }, [
			E('span', { 'class': 'meshassistant-state meshassistant-state-inuse' }, [
				_('In Use')
			])
		]);

	if (state === 'standby')
		return E('div', { 'class': 'td meshassistant-cell-state', 'data-label': label }, [
			E('span', { 'class': 'meshassistant-state meshassistant-state-standby' }, [
				_('Standby')
			])
		]);

	return E('div', {
		'class': 'td meshassistant-cell-state meshassistant-empty',
		'data-label': label
	}, [ '-' ]);
}

function statusTable(rows) {
	const titles = [
		_('Node Hostname'),
		_('Backhaul'),
		_('Backhaul Status'),
		_('Node MAC'),
		_('IP Address'),
		_('Interface'),
		_('Load'),
		_('Link Rate'),
		_('Frequency'),
		_('Channel'),
		_('Channel Width'),
		_('Signal Strength'),
		_('Channel Utilization')
	];

	const table = E('div', { 'class': 'table meshassistant-status-table' }, [
		E('div', { 'class': 'tr table-titles' },
			titles.map(function(title) {
				return E('div', { 'class': 'th' }, [ title ]);
			}))
	]);

	for (const row of rows) {
		table.appendChild(E('div', { 'class': 'tr' }, [
			statusCell(titles[0], row.hostname, 'meshassistant-cell-host'),
			statusCell(titles[1],
				row.backhaul === 'wired' ? _('Wired') :
				row.backhaul === 'wlan' ? _('Wireless') : ''),
			statusStateCell(titles[2], row.backhaulState),
			statusCell(titles[3], row.neighbor),
			statusCell(titles[4], row.ips && row.ips.length ? row.ips.join(', ') : ''),
			statusCell(titles[5], row.iface),
			statusCell(titles[6], row.load),
			statusCell(titles[7], row.speed ? row.speed + ' Mbps' : ''),
			statusCell(titles[8], row.frequency),
			statusCell(titles[9], row.channel),
			statusCell(titles[10], row.width),
			statusCell(titles[11], row.signal),
			statusCell(titles[12], row.utilization)
		]));
	}

	return E('div', { 'class': 'meshassistant-status-scroll' }, [ table ]);
}

function clientsTable(rows) {
	const titles = [
		_('Hostname'),
		_('Interface'),
		_('MAC Address'),
		_('IPv4 Address'),
		_('Signal Strength')
	];

	const table = E('div', {
		'class': 'table meshassistant-status-table meshassistant-clients-table'
	}, [
		E('div', { 'class': 'tr table-titles' },
			titles.map(function(title) {
				return E('div', { 'class': 'th' }, [ title ]);
			}))
	]);

	for (const row of rows) {
		table.appendChild(E('div', { 'class': 'tr' }, [
			statusCell(titles[0], row.hostname, 'meshassistant-cell-host'),
			statusCell(titles[1], row.iface),
			statusCell(titles[2], row.mac),
			statusCell(titles[3], row.ip),
			statusCell(titles[4], row.signal == null ? '' : row.signal + ' dBm')
		]));
	}

	return E('div', { 'class': 'meshassistant-status-scroll' }, [ table ]);
}

/*
 * Devices attached to this router, below the Mesh Status table.  A failed
 * read is reported on its own so it cannot hide the mesh status above it.
 */
function renderClients(result) {
	const list = (result && result.clients) || [];
	const children = [
		E('h3', {}, [ _('Connected Devices') ])
	];

	if (result && !result.ok) {
		children.push(E('div', { 'class': 'alert-message error' }, [
			_('Unable to read the connected devices.')
		]));
	}
	else {
		children.push(E('div', { 'class': 'cbi-section-descr' }, [
			E('strong', {}, [
				_('Number of Connected Devices: %d').format(list.length)
			])
		]));

		if (list.length === 0)
			children.push(E('div', { 'class': 'cbi-section-descr' }, [
				_('No connected devices found.')
			]));
		else
			children.push(clientsTable(list));
	}

	return E('div', { 'class': 'cbi-section' }, children);
}

/*
 * Point out when the hardware could do 802.11k/v but client roaming is still
 * off, and when the switch is on while something needed for steering is
 * missing.  This keeps the feature discoverable without turning it on by
 * default.
 */
function roamingHint(caps, dawnUnstable) {
	if (!caps)
		return null;

	if (caps.kvr && !caps.wnm)
		return E('div', { 'class': 'alert-message warning' }, [
			_('Client roaming is on, but this wpad build lacks 802.11v. Install a full wpad build or turn roaming off.')
		]);

	if (caps.kvr && !caps.dawn)
		return E('div', { 'class': 'alert-message warning' }, [
			_('Client roaming is on, but DAWN is not installed, so clients are not steered.')
		]);

	if (caps.kvr && caps.dawn && caps.dawn_running === false)
		return E('div', { 'class': 'alert-message warning' }, [
			_('Client roaming is on, but the DAWN service is not running, so clients are not steered.')
		]);

	/*
	 * procd restarts DAWN after a crash within seconds, so the service
	 * keeps reporting "running" while it actually loses its client state.
	 * Only a respawn count that grew between two status reads exposed the
	 * loop to the page.
	 */
	if (caps.kvr && dawnUnstable)
		return E('div', { 'class': 'alert-message warning' }, [
			_('DAWN keeps restarting (respawn count: %d), so client steering is interrupted. Check the system log.')
				.format(caps.dawn_restarts)
		]);

	if (!caps.kvr && caps.wnm && caps.dawn)
		return E('div', { 'class': 'alert-message info' }, [
			_('This device supports 802.11k/v; client roaming can be enabled in Advanced Settings.')
		]);

	return null;
}

/*
 * The time of the snapshot, for the "Updated at" line.  Only the time is
 * shown; the page is not expected to stay open across a day boundary.
 */
function statusTime(ts) {
	const d = new Date(ts);
	const pad = function(n) { return (n < 10 ? '0' : '') + n; };

	return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function renderStatus(status, capabilities, dawnUnstable) {
	const rows = status.rows;

	// One node has one row per hardif, so the subtitle counts the devices, not
	// the links.  A neighbor without an announcement has no identity to share
	// and counts as its own device.
	const nodes = new Set(rows.map(function(row) {
		return utils.deviceKey(row);
	})).size;

	const children = [
		E('h3', {}, [ _('Mesh Status') ])
	];

	/*
	 * A mesh the user turned off is a configured state, not a read failure:
	 * say so instead of showing the red error.  The last snapshot may still
	 * be below it, marked with its age.
	 */
	if (status.active === false) {
		children.push(E('div', { 'class': 'alert-message info' }, [
			_('Mesh networking is disabled on this device.')
		]));
	}

	/* A disabled mesh has DAWN stopped with it, so capability advice there
	 * would only repeat what the notice above already says. */
	const hint = status.active === false ? null : roamingHint(capabilities, dawnUnstable);

	if (hint)
		children.push(hint);

	if (!status.ok) {
		if (status.active !== false) {
			children.push(E('div', { 'class': 'alert-message error' }, [
				_('Unable to read mesh status.')
			]));
		}
	}
	else {
		children.push(E('div', { 'class': 'cbi-section-descr' }, [
			E('strong', {}, [
				_('Number of Active Nodes: %d').format(nodes)
			])
		]));

		/*
		 * A failed refresh keeps the last good table, so it has to carry
		 * when it was read; otherwise a stale snapshot looks current.
		 */
		if (status.stale && status.updated) {
			children.push(E('div', { 'class': 'cbi-section-descr' }, [
				_('The last refresh failed; showing the status from %s.')
					.format(statusTime(status.updated))
			]));
		}
		else if (status.updated) {
			children.push(E('div', { 'class': 'cbi-section-descr' }, [
				_('Updated at %s').format(statusTime(status.updated))
			]));
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

		if (status.local && status.local.length) {
			children.push(statusSubtitle(_('Local Host'), meshRoleLabel(status.role)));
			children.push(statusTable(status.local));
		}
	}

	return E('div', { 'class': 'meshassistant-status-sections' }, [
		E('div', { 'class': 'cbi-section' }, children),
		renderClients(status.clients)
	]);
}

/*
 * Read only what the Mesh Status table displays.  The periodic refresh uses
 * this instead of load(), which would also read UCI, the radio list and the
 * run log and could disturb the form the user is filling in.  The connected
 * devices are read separately on their own timer, because that read is the
 * expensive one.
 */
function readMeshStatus() {
	return Promise.all([
		fs.exec(BATCTL, [ 'n' ]).catch(() => null),
		fs.read(PEERS_FILE).catch(() => ''),
		fs.exec(SCRIPT, [ 'linkinfo' ]).catch(() => null),
		fs.exec(BATCTL, [ 'o' ]).catch(() => null)
	]).then(function([ reply, peers, linkReply, originatorReply ]) {
		return utils.parseStatus(reply, peers, linkReply, originatorReply);
	});
}

function readClients() {
	return fs.exec(SCRIPT, [ 'clients' ])
		.catch(() => null)
		.then(function(reply) {
			return utils.parseClients(reply);
		});
}

/*
 * The script prints "key=value" lines for the client-roaming capability
 * check: kvr is the roaming switch, wnm whether the installed wpad build has
 * 802.11v, dawn whether DAWN is installed.  A failed or incomplete read
 * returns null, so the status page can tell "not supported" from "unknown"
 * and does not show a warning after a transient RPC failure.
 */
function parseCapabilities(reply) {
	const caps = {};
	const text = (reply && reply.stdout) || '';
	/* The probe prints switches and counters alike; only these keys are
	 * booleans, everything else is a number (the DAWN respawn count). */
	const flags = new Set([ 'kvr', 'wnm', 'dawn', 'dawn_running' ]);

	for (const line of text.split(/\r?\n/)) {
		const match = /^([a-z_]+)=(-?\d+)$/.exec(line);

		if (!match)
			continue;

		caps[match[1]] = flags.has(match[1])
			? match[2] === '1'
			: Number(match[2]);
	}

	if ((reply && reply.code) || !('wnm' in caps))
		return null;

	return caps;
}

/*
 * Backups
 *
 * The script prints one tab-separated line per archive from "backup list":
 * file name, creation time, hostname, LAN address and role.  The list is shown
 * newest first; the same order is used by the selection dialogs.
 */

function parseBackupList(reply) {
	const backups = [];
	const text = (reply && reply.stdout) || '';

	for (const line of text.split(/\r?\n/)) {
		if (!line)
			continue;

		const fields = line.split('\t');

		if (!fields[0])
			continue;

		backups.push({
			name: fields[0],
			created: fields[1] || '',
			hostname: fields[2] || '',
			lan_ip: fields[3] || '',
			role: fields[4] || ''
		});
	}

	backups.sort(function(a, b) {
		return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
	});

	return backups;
}

function backupRoleLabel(role) {
	switch (role) {
	case 'server':
		return _('Server');
	case 'off':
		return _('Node');
	case 'client':
		return _('Client');
	default:
		return role || '';
	}
}

function backupLabel(backup) {
	const parts = [];

	if (backup.created)
		parts.push(backup.created);
	if (backup.hostname)
		parts.push(backup.hostname);
	if (backup.lan_ip)
		parts.push(backup.lan_ip);

	const role = backupRoleLabel(backup.role);

	if (role)
		parts.push(role);

	parts.push(backup.name);

	return parts.join(' · ');
}

function backupSelect(backups, onChange) {
	const select = E('select', {
		'class': 'cbi-input-select',
		'style': 'width:100%'
	}, backups.map(function(backup) {
		return E('option', {
			'value': backup.name,
			'selected': backup === backups[0] ? '' : null
		}, [ backupLabel(backup) ]);
	}));

	select.addEventListener('change', function(ev) {
		onChange(ev.target.value);
	});

	return select;
}

function createAutoBackup() {
	return fs.exec(SCRIPT, [ 'backup', 'create' ]).then(function(reply) {
		if (reply && reply.code)
			throw new Error((reply.stderr || '').trim() || _('The backup command failed.'));
	}).catch(function(err) {
		ui.addNotification(null, E('p', [
			_('Failed to create the automatic backup: %s').format(err)
		]), 'warning');
	});
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
	status: { ok: true, rows: [], clients: { ok: true, clients: [] } },
	capabilities: null,
	dawnUnstable: false,
	logText: '',
	backups: [],
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
				callLanStatus('lan').catch(() => null),
				fs.read(PEERS_FILE).catch(() => ''),
				fs.exec(SCRIPT, [ 'linkinfo' ]).catch(() => null),
				fs.read(LOG_FILE).catch(() => ''),
				fs.exec(BATCTL, [ 'o' ]).catch(() => null),
				fs.exec(SCRIPT, [ 'capabilities' ]).catch(() => null),
				fs.exec(SCRIPT, [ 'clients' ]).catch(() => null)
			]);
		}).then(([ devices, reply, lanStatus, peers, linkReply, logText, originatorReply, capsReply, clientsReply ]) => {
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

			this.status = utils.parseStatus(reply, peers, linkReply, originatorReply);
			this.status.clients = utils.parseClients(clientsReply);
			this.status.updated = Date.now();
			this.status.stale = false;
			this.capabilities = parseCapabilities(capsReply);
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
						return [];
					});
				})),
				callCountryList(banded[0]).catch(function() {
					return [];
				})
			]).then(([ lists, countries ]) => {
				const seen = {};

				for (const list of lists) {
					for (const freq of rpcResults(list))
						seen[freq.band + ':' + freq.channel] = freq;
				}

				this.freqList = Object.keys(seen).map(function(key) {
					return seen[key];
				});
				this.countryList = rpcResults(countries);
			});
		});
	},

	/*
	 * The user asked for a snapshot of the configuration as it is before
	 * Save & Apply writes the form.  Overriding handleSaveApply (and not
	 * handleSave) leaves the plain Save button alone.
	 */
	handleSaveApply(ev, mode) {
		const self = this;

		return createAutoBackup().then(function() {
			if (typeof self.refreshBackups === 'function')
				self.refreshBackups();

			const base = view.prototype.handleSaveApply;

			return base ? base.call(self, ev, mode) : undefined;
		});
	},

	render() {
		const statusEl = renderStatus(this.status, this.capabilities, this.dawnUnstable);

		const m = new form.Map('meshassistant');
		const s = m.section(form.TypedSection, 'meshassistant', _('Mesh Settings'));

		s.anonymous = true;
		s.addremove = false;

		s.tab('setup', _('Basic Setup'));
		s.tab('spectrum', _('Spectrum Settings'));
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

		/*
		 * Default to the first radio the device reports.  A fixed radio name
		 * is not offered on every device, and a default outside the choices
		 * leaves the field empty, which fails the validator below on save.
		 */
		o.default = this.apRadios.length ? this.apRadios[0][0] : '';
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
		/*
		 * LuCI drops options whose value equals the form default, so the
		 * default Mesh radio would never reach UCI and the script would abort
		 * with "No radio specified in the config".  Keep writing it.
		 */
		o.rmempty = false;

		o = s.taboption('setup', form.ListValue, 'wired_backhaul', _('Wired Backhaul Port'), _('Select the Ethernet port cabled to another Mesh device. The port is dedicated to wired backhaul and removed from the LAN bridge. Wired is used while the cable is connected; the Mesh radio is used when it is not. Choose None for wireless-only backhaul.'));
		o.value('none', _('None (wireless backhaul only)'));
		for (const [ value, label ] of this.wiredPorts)
			o.value(value, label);
		o.default = 'none';

		o = s.taboption('setup', form.Value, 'mesh_id', _('Mesh Network SSID'), _('Ensure that the SSID is the same across all the servers/nodes in your mesh network.'));
		o.default = 'meshassistant_AC';
		/*
		 * The script needs the Mesh SSID to build the 802.11s interface.  With
		 * rmempty the default value would be dropped on save: mesh_batman would
		 * then have no device to bind to and LuCI would show
		 * "Device: nonexistent".  Write it even when it equals the default.
		 */
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return String(value == null ? '' : value).trim() !== '' ||
				_('Enter a mesh network SSID.');
		};

		o = s.taboption('setup', form.Flag, 'encryption', _('Password Protection'), _('Enable this switch to require a password to join your Mesh Network.'));
		o.default = '0';

		o = s.taboption('setup', form.Value, 'key', _('Mesh Password'));
		o.default = 'meshassistant';
		o.password = true;
		o.datatype = 'minlength(8)';
		o.depends('encryption', '1');
		/*
		 * Without rmempty the default password would be dropped on save:
		 * encryption would stay enabled while the script found an empty key
		 * and configured the APs and the mesh without encryption.  Keep it.
		 */
		o.rmempty = false;

		o = s.taboption('setup', form.Button, '_btn_reapply', _('Reapply meshassistant Settings'), _('Use this button to apply/reapply meshassistant configuration after you Save & Apply. The AP Mode address is applied here; if the address or the route is not applied correctly, the previous LAN settings are restored automatically.'));
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
		 * and applied to wireless by the script on the next reapply.  Every
		 * radio interface of the device gets its own page and its fields are
		 * always shown: the page layout does not follow the radio selection
		 * of the basic setup, which only decides where the mesh is used.
		 * Empty values are removed from the UCI config, which tells the
		 * script to leave the radio's current setting alone.
		 */
		const spectrumRadios = this.radios.map(function([ radio ]) {
			const band = radioBand(radio);

			return {
				band: BAND_NAMES[band] ? band : '',
				label: BAND_NAMES[band] || radio,
				radio: radio
			};
		});

		/* A single-radio device keeps a plain band heading instead. */
		if (spectrumRadios.length === 1 && spectrumRadios[0].band) {
			const bandHeader = s.taboption('spectrum', form.DummyValue,
				'_spectrum_band_' + spectrumRadios[0].band, '', '');

			bandHeader.default = '<h3 class="meshassistant-spectrum-band">%s</h3>'
				.format(spectrumRadios[0].label);
			bandHeader.rawhtml = true;
		}

		for (const { radio, band, label } of spectrumRadios) {
			const radioHeader = s.taboption('spectrum', form.DummyValue,
				'_spectrum_radio_' + radio, '', '');

			radioHeader.default = '<h4 class="meshassistant-spectrum-radio">%s - %s</h4>'
				.format(radio, label);
			radioHeader.rawhtml = true;

			/*
			 * A radio without band information has no channel plan, so its
			 * page only explains why it has no settings.
			 */
			if (!band) {
				const note = s.taboption('spectrum', form.DummyValue,
					'spectrum_' + radio + '_note', '', '');

				note.default = '<p class="meshassistant-note">%s</p>'
					.format(_('This radio interface reports no frequency band, so no spectrum settings are available.'));
				note.rawhtml = true;
				addSpectrumHint(s, radio);
				continue;
			}

			const current = parseHtmode(uci.get('wireless', radio, 'htmode'));
			const currentChannel = uci.get('wireless', radio, 'channel') || 'auto';
			const currentTxpower = uci.get('wireless', radio, 'txpower') || '';
			const currentCountry = uci.get('wireless', radio, 'country') || '';

			const bandOpt = s.taboption('spectrum', form.DummyValue,
				'spectrum_' + radio + '_band', _('Band'),
				_('Band plan of this radio (read-only).'));
			bandOpt.default = label;
			bandOpt.rawhtml = false;

			const modeOpt = s.taboption('spectrum', form.ListValue,
				'spectrum_' + radio + '_mode', _('PHY Mode'),
				_('PHY layer protocol mode. Leave at “Keep current” to keep the radio mode.'));
			modeOpt.value('', _('Keep current (%s)')
				.format(current.mode || _('driver default')));
			for (const mode of BAND_MODES[band])
				modeOpt.value(mode, mode);
			modeOpt.default = '';
			/*
			 * An AP radio that participates in MLO is forced to EHT by the
			 * script, so do not offer a mode that would silently be
			 * overwritten.  Inverted, the rule hides the selector only when
			 * the radio is one of the AP radios and MLO is on; every other
			 * radio keeps its selector whatever the basic setup selects.
			 */
			modeOpt.depends({
				wifi_radio: new RegExp('(^|,)' + radio + '(,|$)'),
				mlo: '1',
				'!reverse': true
			});

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
				const freqLabel = isDfsChannel(band, freq.channel)
					? _('Channel %s (%s MHz, DFS)').format(freq.channel, freq.mhz)
					: _('Channel %s (%s MHz)').format(freq.channel, freq.mhz);

				channelOpt.value(String(freq.channel), freqLabel);
			}
			channelOpt.default = '';

			const txpowerOpt = s.taboption('spectrum', form.Value,
				'spectrum_' + radio + '_txpower', _('Maximum Transmit Power'),
				_('Transmit power / EIRP in dBm. Leave empty to keep the current transmit power.'));
			txpowerOpt.default = '';
			txpowerOpt.placeholder = currentTxpower || '0';
			txpowerOpt.datatype = 'range(1,40)';

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

			addSpectrumHint(s, radio);
		}

		o = s.taboption('advanced', form.Flag, 'kvr', _('Client Roaming (802.11k/v)'), _('Let DAWN steer clients to the strongest access point. Requires a full wpad build; wpad-basic lacks 802.11v, so roaming stays off.'));
		o.default = '0';

		o = s.taboption('advanced', form.Value, 'mobility_domain', _('Mobility Domain'));
		o.default = '4f57';
		o.datatype = 'and(hexstring,rangelength(4,4))';
		/*
		 * Without rmempty the default would be dropped on save; the script
		 * would then derive a value from the Mesh SSID, which is stable but
		 * different from the one shown here.  Keep the value the user sees.
		 */
		o.rmempty = false;

		o = s.taboption('advanced', form.Value, 'rssi_val', _('Good RSSI Threshold'), _('DAWN scores a connection as good at or above this signal level.'));
		o.default = '-60';
		o.datatype = 'range(-120,-1)';
		o.depends('kvr', '1');

		o = s.taboption('advanced', form.Value, 'low_rssi_val', _('Bad RSSI Threshold'), _('Below this signal level DAWN treats the connection as poor and asks the client to move to a better access point.'));
		o.default = '-88';
		o.datatype = 'range(-120,-1)';
		o.depends('kvr', '1');

		o = s.taboption('apmode', form.Value, 'hostname', _('Node Hostname'));
		o.default = 'node2';
		for (let i = 2; i <= 9; i++)
			o.value('node' + i, 'node' + i);
		o.datatype = 'string';
		o.depends('role', /^(off|client)$/);
		/*
		 * Without rmempty the default hostname would be dropped on save and
		 * the script would leave the current hostname in place instead of
		 * applying the one shown in the form.  Keep it.
		 */
		o.rmempty = false;

		o = s.taboption('apmode', form.ListValue, 'ipmode', _('IP Mode'), _('Choose if the node uses DHCP or a Static IP'));
		o.value('dhcp', _('DHCP'));
		o.value('static', _('Static'));
		o.default = 'dhcp';
		o.depends('role', /^(off|client)$/);

		/*
		 * Static mode needs both an address and a netmask.  netifd reads a
		 * missing netmask as /32, which leaves the device answering ARP but
		 * unreachable; an empty one becomes /0.  The datatype only checks a
		 * non-empty value, so reject an empty one here as well: CBI removes
		 * empty options from the config, and the script must never apply a
		 * static LAN address without a mask.  The fields are prefilled with
		 * the current LAN addressing, so keep a value that equals the
		 * default as well; otherwise Save & Apply would silently drop it.
		 */
		o = s.taboption('apmode', form.Value, 'ipaddr', _('Static IP Address'));
		o.default = this.lanDefaults.ipaddr;
		o.datatype = 'ip4addr';
		o.rmempty = false;
		o.validate = [ function(section_id, value) {
			if (!utils.ipv4(value))
				return _('Enter a static IPv4 address.');
			return true;
		} ];
		/*
		 * Multiple depends() calls are OR'ed by LuCI; conditions that must
		 * hold together belong in one object.  Static mode alone is not
		 * enough here: the fields are only meaningful for node/client roles.
		 */
		o.depends({ role: /^(off|client)$/, ipmode: 'static' });

		o = s.taboption('apmode', form.Value, 'gateway', _('Mesh Gateway IP Address'));
		o.default = this.lanDefaults.gateway;
		o.datatype = 'ip4addr';
		/*
		 * A detected gateway is written even when it equals the prefilled
		 * default.  When no gateway was detected the field stays optional,
		 * because a static LAN without a default route is valid; rmempty=false
		 * would reject the empty value instead.
		 */
		o.rmempty = !o.default;
		o.depends({ role: /^(off|client)$/, ipmode: 'static' });

		o = s.taboption('apmode', form.Value, 'netmask', _('IPv4 netmask'));
		o.default = this.lanDefaults.netmask;
		o.datatype = 'ip4addr';
		o.rmempty = false;
		o.validate = [ function(section_id, value) {
			if (!utils.netmask(value))
				return _('Enter a valid IPv4 netmask, for example 255.255.255.0.');
			return true;
		} ];
		o.depends({ role: /^(off|client)$/, ipmode: 'static' });

		o = s.taboption('apmode', form.Value, 'dns', _('DNS Server'),
			_('The DNS server for this node. In DHCP mode it replaces the DNS servers advertised by the DHCP server; leave it empty to use them.'));
		/*
		 * Keep the default empty so the field can be cleared again: a filled
		 * default with rmempty=false cannot be emptied in LuCI.  The current
		 * server is shown as a placeholder; without an explicit value the
		 * script leaves the DHCP DNS servers in use and, in static mode,
		 * keeps the DNS server the LAN already has.
		 */
		o.default = '';
		o.placeholder = this.lanDefaults.dns;
		o.datatype = 'ip4addr';
		o.rmempty = true;
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

		/*
		 * CBI re-renders the whole map after every save (Map.save ends with
		 * renderContents), which throws away the radio pages and tab pane
		 * classes created below.  Decorate every render, not only the first.
		 */
		const spectrumState = { active: null };

		const decorateMap = function(mapEl) {
			if (spectrumRadios.length > 1)
				renderSpectrumTabs(mapEl, spectrumRadios, spectrumState);

			/*
			 * The four form tabs have very different content lengths.  Mark
			 * them so the stylesheet can give the active pane one height and
			 * remove the extra top padding Argon adds to every tab pane.
			 */
			for (const tab of [ 'setup', 'spectrum', 'apmode', 'advanced' ]) {
				const pane = mapEl.querySelector('[data-tab-title][data-tab="' + tab + '"]');

				if (pane)
					pane.classList.add('meshassistant-tab-pane');
			}

			return mapEl;
		};

		const renderContents = m.renderContents;

		m.renderContents = function() {
			return renderContents.apply(this, arguments).then(decorateMap);
		};

		return m.render().then((mapEl) => {
			const settingsEl = E('div', {
				'data-tab': 'settings',
				'data-tab-title': _('Mesh Settings'),
				'data-tab-active': 'true'
			}, [ mapEl ]);

			const statusPane = E('div', {
				'data-tab': 'status',
				'data-tab-title': _('Mesh Status')
			}, [ statusEl ]);

			/*
			 * Refresh the Mesh Status tab in place.  The mesh table and the
			 * connected-device list use separate timers: the mesh data is
			 * read every 10 seconds, the device list every 60.  Only the tab
			 * is refreshed while it is active and the browser tab is
			 * visible; the tab menu and the form are left untouched.
			 */
			let statusTimer = null;
			let clientsTimer = null;
			let statusBusy = false;
			let clientsBusy = false;

			const stopTimers = () => {
				if (statusTimer != null) {
					clearInterval(statusTimer);
					statusTimer = null;
				}

				if (clientsTimer != null) {
					clearInterval(clientsTimer);
					clientsTimer = null;
				}
			};

			const mayRefresh = () =>
				document.visibilityState !== 'hidden' &&
				statusPane.getAttribute('data-tab-active') === 'true';

			/*
			 * Re-render the whole status area and keep the horizontal scroll
			 * position of every table: the tables are wider than the page on
			 * a phone, and a refresh must not jump them back to the left.
			 */
			const renderCurrentStatus = () => {
				const offsets = Array.prototype.map.call(
					statusPane.querySelectorAll('.meshassistant-status-scroll'),
					function(el) { return el.scrollLeft; });

				const replacement = renderStatus(this.status, this.capabilities, this.dawnUnstable);

				while (statusPane.childNodes.length)
					statusPane.removeChild(statusPane.childNodes[0]);

				statusPane.appendChild(replacement);

				Array.prototype.forEach.call(
					statusPane.querySelectorAll('.meshassistant-status-scroll'),
					function(el, index) {
						if (offsets[index])
							el.scrollLeft = offsets[index];
					});
			};

			const refreshStatus = () => {
				if (statusPane.isConnected === false) {
					stopTimers();
					return Promise.resolve();
				}

				if (statusBusy || !mayRefresh())
					return Promise.resolve();

				statusBusy = true;

				/* DAWN can stop between page loads, so the capability probe
				 * runs on the same timer as the status read. */
				return Promise.all([
					readMeshStatus(),
					fs.exec(SCRIPT, [ 'capabilities' ]).catch(() => null)
				]).then(([ next, capsReply ]) => {
					const previous = this.status;
					const caps = parseCapabilities(capsReply);

					if (caps) {
						const previousCaps = this.capabilities;

						/*
						 * A respawn count that grows between two reads is
						 * the crash loop procd hides behind its fast
						 * restarts.  A lower count means the instance was
						 * recreated on purpose (a manual restart), so the
						 * warning no longer applies.
						 */
						if (previousCaps &&
						    typeof caps.dawn_restarts === 'number' &&
						    typeof previousCaps.dawn_restarts === 'number') {
							if (caps.dawn_restarts > previousCaps.dawn_restarts)
								this.dawnUnstable = true;
							else if (caps.dawn_restarts < previousCaps.dawn_restarts)
								this.dawnUnstable = false;
						}

						this.capabilities = caps;
					}

					if (next.ok) {
						next.updated = Date.now();
						next.stale = false;
						/* The device list belongs to the other timer. */
						next.clients = previous && previous.clients;
						this.status = next;
					}
					else if (previous && previous.ok) {
						/*
						 * A single failed read must not replace a good
						 * snapshot with the error message, but it must not
						 * pass it off as current either.  The applied state
						 * still comes from this read, so turning the mesh
						 * off is visible immediately.
						 */
						previous.active = next.active != null
							? next.active : previous.active;
						previous.stale = true;
						this.status = previous;
					}
					else {
						next.clients = previous && previous.clients;
						this.status = next;
					}

					renderCurrentStatus();
				}).catch(() => {
					/* Keep showing the last good snapshot. */
				}).then(() => {
					statusBusy = false;
				});
			};

			const refreshClients = () => {
				if (statusPane.isConnected === false) {
					stopTimers();
					return Promise.resolve();
				}

				if (clientsBusy || !mayRefresh())
					return Promise.resolve();

				clientsBusy = true;

				return readClients().then((clients) => {
					if (!clients || !this.status)
						return;

					/*
					 * Keep the last good device table when only the clients
					 * read fails, instead of replacing it with the error
					 * message.
					 */
					if (!clients.ok && this.status.clients && this.status.clients.ok)
						return;

					this.status.clients = clients;

					renderCurrentStatus();
				}).catch(() => {
					/* Keep showing the last good snapshot. */
				}).then(() => {
					clientsBusy = false;
				});
			};

			/*
			 * Switching back to the tab refreshes immediately instead of
			 * waiting for the next tick.
			 */
			statusTimer = setInterval(refreshStatus, STATUS_REFRESH_INTERVAL);
			clientsTimer = setInterval(refreshClients, CLIENTS_REFRESH_INTERVAL);
			statusPane.addEventListener('cbi-tab-active', function() {
				refreshStatus();
				refreshClients();
			});

			if (document.addEventListener)
				document.addEventListener('visibilitychange', function() {
					if (document.visibilityState !== 'hidden') {
						refreshStatus();
						refreshClients();
					}
				});

			if (typeof window !== 'undefined' && window.addEventListener)
				window.addEventListener('pagehide', stopTimers);

			const backupListEl = E('div', {
				'class': 'cbi-section-descr',
				/*
				 * Argon adds var(--section-inset) as horizontal padding to
				 * .cbi-section-descr.  The Run Log text has no such class, so
				 * clear the padding to keep both tabs aligned.
				 */
				'style': 'margin:0;padding:0'
			}, [
				_('Loading backups...')
			]);

			const renderBackupList = () => {
				const backups = this.backups || [];

				while (backupListEl.childNodes.length)
					backupListEl.removeChild(backupListEl.childNodes[0]);

				if (backups.length === 0) {
					/*
					 * Argon also pads every <p> inside .cbi-section, not just
					 * .cbi-section-descr; clear it so this line starts at the
					 * same x position as the storage path above.
					 */
					backupListEl.appendChild(E('p', { 'style': 'margin:0;padding:0' }, [
						_('No backups found.')
					]));
					return;
				}

				backupListEl.appendChild(E('ul', {
					'style': 'margin:0;padding-inline-start:1.2rem'
				}, backups.map(function(backup) {
					return E('li', {}, [ backupLabel(backup) ]);
				})));
			};

			/*
			 * This is called directly while rendering and after the backup
			 * commands, not only from a click, so it must not be wrapped in
			 * ui.createHandlerFn: that wrapper reads the event's currentTarget
			 * and throws when it is called without an event.
			 */
			const refreshBackups = () => {
				return fs.exec(SCRIPT, [ 'backup', 'list' ]).then((reply) => {
					if (reply && reply.code)
						throw new Error((reply.stderr || '').trim() ||
							_('The backup list could not be read.'));

					this.backups = parseBackupList(reply);
					renderBackupList();
				}).catch((err) => {
					this.backups = [];

					while (backupListEl.childNodes.length)
						backupListEl.removeChild(backupListEl.childNodes[0]);

					backupListEl.appendChild(E('p', { 'class': 'alert-message error' }, [
						_('Failed to read the backups: %s').format(err)
					]));
				});
			};

			this.refreshBackups = refreshBackups;

			const createBackup = ui.createHandlerFn(this, function() {
				return fs.exec(SCRIPT, [ 'backup', 'create' ]).then((reply) => {
					if (reply && reply.code)
						throw new Error((reply.stderr || '').trim() ||
							_('The backup command failed.'));

					return refreshBackups();
				}).catch((err) => {
					ui.addNotification(null, E('p', [
						_('Failed to create the backup: %s').format(err)
					]), 'error');
				});
			});

			const restoreBackup = ui.createHandlerFn(this, function() {
				const backups = this.backups || [];

				if (backups.length === 0) {
					ui.addNotification(null, E('p', [ _('No backups found.') ]), 'warning');
					return;
				}

				let selected = backups[0].name;
				const choice = [];

				if (backups.length > 1) {
					choice.push(E('div', { 'style': 'margin:0.5rem 0' }, [
						backupSelect(backups, function(name) { selected = name; })
					]));
				}
				else {
					choice.push(E('p', {}, [ backupLabel(backups[0]) ]));
				}

				ui.showModal(_('Restore Backup'), [
					E('p', {}, [
						_('Restoring a backup overwrites the current network, wireless, DHCP, firewall, system and Mesh Assistant configuration. The connection may drop and the management address may change.')
					]),
					E('p', {}, [
						_('A backup of the current configuration is created before restoring.')
					])
				].concat(choice, [
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

								return fs.write(BACKUP_SELECTION, selected, 384).then(function() {
									return fs.exec(SCRIPT, [ '--detach', 'backup', 'restore' ]);
								}).then(function(reply) {
									if (reply && reply.code)
										throw new Error((reply.stderr || '').trim() ||
											_('The restore command failed.'));

									ui.addNotification(null, E('p', [
										_('The backup is being restored in the background. The connection may drop.')
									]), 'info');
								}).catch(function(err) {
									ui.addNotification(null, E('p', [
										_('Failed to restore the backup: %s').format(err)
									]), 'error');
								});
							})
						}, _('Restore'))
					])
				]));
			});

			const deleteBackup = ui.createHandlerFn(this, function() {
				const backups = this.backups || [];

				if (backups.length === 0) {
					ui.addNotification(null, E('p', [ _('No backups found.') ]), 'warning');
					return;
				}

				let selected = backups[0].name;
				const choice = [];

				if (backups.length > 1) {
					choice.push(E('div', { 'style': 'margin:0.5rem 0' }, [
						backupSelect(backups, function(name) { selected = name; })
					]));
				}
				else {
					choice.push(E('p', {}, [ backupLabel(backups[0]) ]));
				}

				ui.showModal(_('Delete Backup'), [
					E('p', {}, [ _('Deleting a backup cannot be undone.') ])
				].concat(choice, [
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

								return fs.write(BACKUP_SELECTION, selected, 384).then(function() {
									return fs.exec(SCRIPT, [ 'backup', 'delete' ]);
								}).then(function(reply) {
									if (reply && reply.code)
										throw new Error((reply.stderr || '').trim() ||
											_('The delete command failed.'));

									return refreshBackups();
								}).catch(function(err) {
									ui.addNotification(null, E('p', [
										_('Failed to delete the backup: %s').format(err)
									]), 'error');
								});
							})
						}, _('Delete'))
					])
				]));
			});

			const clearBackups = ui.createHandlerFn(this, function() {
				if ((this.backups || []).length === 0) {
					ui.addNotification(null, E('p', [ _('No backups found.') ]), 'warning');
					return;
				}

				ui.showModal(_('Clear Backups'), [
					E('p', {}, [ _('All backups will be deleted. This cannot be undone.') ]),
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

								return fs.exec(SCRIPT, [ 'backup', 'clear' ]).then(function(reply) {
									if (reply && reply.code)
										throw new Error((reply.stderr || '').trim() ||
											_('The clear command failed.'));

									return refreshBackups();
								}).catch(function(err) {
									ui.addNotification(null, E('p', [
										_('Failed to clear the backups: %s').format(err)
									]), 'error');
								});
							})
						}, _('Clear All'))
					])
				]);
			});

			const backupPane = E('div', {
				'data-tab': 'backup',
				'data-tab-title': _('Backup Management')
			}, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'style': 'margin-bottom:0.5rem' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': createBackup
						}, [ _('Create Backup') ]),
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': restoreBackup
						}, [ _('Restore Backup') ]),
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': deleteBackup
						}, [ _('Delete Backup') ]),
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'style': 'margin:0.5rem 0 0 0.5rem',
							'click': clearBackups
						}, [ _('Clear Backups') ])
					]),
					/*
					 * Match the Run Log content offset so both tabs line up.
					 * The margins belong on one wrapper because adjacent
					 * sibling margins would otherwise not collapse with the
					 * button row in the same way.
					 */
					E('div', {
						/*
						 * Same spacing as the Run Log content: the bottom
						 * padding keeps a gap below the last line.
						 */
						'style': 'margin:1rem 0 0 0.5rem;padding-bottom:0.5rem'
					}, [
						E('p', {
							'class': 'cbi-section-descr',
							'style': 'margin:0 0 0.5rem 0;padding:0'
						}, [
							_('Backups are stored in %s.').format(BACKUP_DIR)
						]),
						backupListEl
					])
				])
			]);

			refreshBackups();

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
				[ settingsEl, statusPane, backupPane, logPane ]);
			const pageEl = E('div', {}, [ tabsEl ]);

			ui.tabs.initTabGroup(tabsEl.childNodes);

			/*
			 * Argon draws the theme's own page tab bar, the one a page with
			 * sibling menu entries gets, as a rounded panel that separates the
			 * tabs from the page; the theme selects that bar through its
			 * "tabs" class.  The menu built by initTabGroup only has
			 * "cbi-tabmenu", which the theme leaves as free-standing pills.
			 * Give the menu both classes so the in-page tabs sit in the same
			 * panel.  Themes that style the two classes alike, like
			 * Bootstrap, are unaffected.
			 */
			const tabMenu = tabsEl.previousElementSibling;

			if (tabMenu != null && tabMenu.classList != null &&
			    tabMenu.classList.contains('cbi-tabmenu'))
				tabMenu.classList.add('tabs');

			return pageEl;
		});
	}
});
