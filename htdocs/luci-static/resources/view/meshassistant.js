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

function radioOptions(devices) {
	const choices = [];

	for (const dev of devices)
		choices.push([ dev.getName(), dev.getI18n() || dev.getName() ]);

	return choices;
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
		_('Frequency'),
		_('Signal Strength'),
		_('Load'),
		_('Channel Utilization'),
		_('Link Rate'),
		_('Last Seen Timestamp')
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
			E('div', { 'class': 'td' }, [ row.frequency || '-' ]),
			E('div', { 'class': 'td' }, [ row.signal || '-' ]),
			E('div', { 'class': 'td' }, [ row.load || '-' ]),
			E('div', { 'class': 'td' }, [ row.channel || '-' ]),
			E('div', { 'class': 'td' }, [ row.speed ? row.speed + ' Mbps' : '-' ]),
			E('div', { 'class': 'td' }, [ row.lastSeen || '-' ])
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
			 * The regular AP may use up to two radios so the same WiFi
			 * network is served on any two of 2.4 GHz, 5 GHz and 6 GHz.
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
		});
	},

	render() {
		const statusEl = renderStatus(this.status);

		const m = new form.Map('meshassistant');
		const s = m.section(form.TypedSection, 'meshassistant', _('Mesh Settings'));

		s.anonymous = true;
		s.addremove = false;

		s.tab('setup', _('Basic Setup'));
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

		o = s.taboption('setup', form.Flag, 'server_dhcp', _('Server Provides DHCP'), _('Keep this enabled when the Mesh server is the only gateway and should provide DHCP and IPv6 RA for the LAN. Disable it when another router on the LAN already provides DHCP: the server then keeps the gateway and DNS role but stops its own DHCP/RA server.'));
		o.default = '1';
		o.depends('role', 'server');

		o = s.taboption('setup', form.Value, 'wifi_id', _('WiFi Network SSID'), _('SSID for the regular WiFi network.'));
		o.default = 'meshassistant_AC';

		o = s.taboption('setup', form.MultiValue, 'wifi_radio', _('Regular AP Radio'), _('Select one or two radios (2.4 GHz, 5 GHz and 6 GHz) for the regular WiFi access point. All selected radios use the same SSID.'));

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
			const count = listValues(value).length;

			if (count === 0)
				return _('Select at least one radio.');

			return count <= 2 || _('Select at most two radios.');
		};

		/*
		 * MLO combines exactly two radios into one Wi-Fi 7 access point.
		 * The dependency matches a MultiValue converted to its comma-joined
		 * form, so the checkbox appears only while two radios are selected.
		 */
		o = s.taboption('setup', form.Flag, 'mlo', _('Enable MLO'), _('Combine the two selected radios into one Wi-Fi 7 Multi-Link Operation (MLO) access point. The selected radios are switched to EHT mode.'));
		o.default = '0';
		o.depends('wifi_radio', /^[^,]+,[^,]+$/);

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
