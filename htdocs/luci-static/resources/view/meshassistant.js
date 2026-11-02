'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require network';
'require meshassistant.utils as utils';

const BATCTL = '/usr/sbin/batctl';
const SCRIPT = '/meshassistant/meshassistant.sh';

function radioOptions(devices) {
	const choices = [];

	for (const dev of devices)
		choices.push([ dev.getName(), dev.getI18n() || dev.getName() ]);

	return choices;
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
	}
	else if (rows.length === 0) {
		children.push(E('div', { 'class': 'cbi-section-descr' }, [
			_('No neighbor nodes found.')
		]));
	}
	else {
		const table = E('div', { 'class': 'table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, [ _('Interface') ]),
				E('div', { 'class': 'th' }, [ _('Neighbor Nodes') ]),
				E('div', { 'class': 'th' }, [ _('Last Seen Timestamp') ])
			])
		]);

		for (const row of rows) {
			table.appendChild(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td' }, [ row.iface || '-' ]),
				E('div', { 'class': 'td' }, [ row.neighbor ]),
				E('div', { 'class': 'td' }, [ row.lastSeen ])
			]));
		}

		children.push(table);
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
	status: { ok: true, rows: [] },

	load() {
		return Promise.all([
			uci.load('meshassistant'),
			uci.load('wireless')
		]).then(() => {
			return Promise.all([
				network.getWifiDevices().catch(() => []),
				fs.exec(BATCTL, [ 'n' ]).catch(() => null)
			]);
		}).then(([ devices, reply ]) => {
			this.radios = devices.length
				? radioOptions(devices)
				: uci.sections('wireless', 'wifi-device').map(function(s) {
					return [ s['.name'], s['.name'] ];
				});

			this.status = utils.parseStatus(reply);
		});
	},

	render() {
		const statusEl = renderStatus(this.status);
		const descEl = E('div', {}, [
			E('p', {}, [
				_('First set up the Mesh gateway server, then set up the nodes. When configuring a Mesh node, first enable Mesh WiFi on the radio device and establish a connection, then enable it as a DHCP node. The default settings are usually sufficient for most Mesh WiFi configurations.')
			]),
			E('p', {}, [
				_('Mesh is powered by Batman-adv. Official website:'), ' ',
				E('a', {
					'href': 'https://www.open-mesh.org/projects/batman-adv/wiki',
					'target': '_blank',
					'rel': 'noopener noreferrer'
				}, [ 'https://www.open-mesh.org/projects/batman-adv/wiki' ])
			])
		]);

		const m = new form.Map('meshassistant', _('Easy Mesh WiFi Setup'), descEl);
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

		o = s.taboption('setup', form.ListValue, 'wifi_radio', _('Regular AP Radio'), _('Select the radio to be used for the regular WiFi access point.'));
		for (const [ value, label ] of this.radios)
			o.value(value, label);
		o.default = 'radio1';

		o = s.taboption('setup', form.ListValue, 'apRadio', _('Mesh Radio'), _('Select one radio interface for mesh backhaul traffic.'));
		for (const [ value, label ] of this.radios)
			o.value(value, label);
		o.default = 'radio0';

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
		o.default = '192.168.8.3';
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'gateway', _('Mesh Gateway IP Address'));
		o.default = '192.168.8.1';
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'netmask', _('IPv4 netmask'));
		o.default = '255.255.255.0';
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Value, 'dns', _('DNS Server'));
		o.default = '192.168.8.1';
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.depends('role', /^(off|client)$/);

		o = s.taboption('apmode', form.Button, '_btn_apmode', _('Enable Dumb AP Mode'), _('WARNING: THIS WILL CHANGE THE IP ADDRESS OF THIS NODE, YOU WILL LOSE ACCESS TO THIS UI'));
		o.onclick = ui.createHandlerFn(this, function() {
			return runScript([ '--detach', 'dumbap' ]);
		});
		o.depends('role', /^(off|client)$/);

		return m.render().then(function(mapEl) {
			return E([ statusEl, mapEl ]);
		});
	}
});
