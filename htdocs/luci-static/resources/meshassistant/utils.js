'require baseclass';

const SPEED_RE = /^(\S+)\s+(\d+\.\d+s)\s+\(\s*([\d.]+)\s*\)\s+\[([^\]]+)\]$/;
const PLAIN_RE = /^(\S+)\s+(\S+)\s+(\d+\.\d+s)$/;

function clean(s) {
	return String(s == null ? '' : s).trim();
}

function isMac(value) {
	return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(value);
}

function isIPv4(value) {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value !== '0.0.0.0';
}

function firstValue(value) {
	if (Array.isArray(value))
		value = value[0];

	return clean(value).split(/\s+/)[0] || '';
}

return baseclass.extend({
	// MAC addresses are compared case-insensitively: batctl prints them in
	// lower case while LuCI host hints may keep the case of the DHCP lease.
	macKey(mac) {
		const key = clean(mac).toLowerCase();

		return isMac(key) ? key : '';
	},

	ipv4(value) {
		const ip = clean(value);

		return isIPv4(ip) ? ip : '';
	},

	// Convert an IPv4 prefix length (the "mask" of network.interface status)
	// to the dotted netmask shown by LuCI.
	prefixToNetmask(prefix) {
		if (prefix == null || clean(prefix) === '')
			return '';

		const bits = Number(prefix);

		if (!Number.isInteger(bits) || bits < 0 || bits > 32)
			return '';

		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

		return [
			(mask >>> 24) & 0xff,
			(mask >>> 16) & 0xff,
			(mask >>> 8) & 0xff,
			mask & 0xff
		].join('.');
	},

	// Canonical dotted form of an IPv4 netmask, or an empty string when the
	// value is not a contiguous mask.  0.0.0.0 is rejected as well: a /0 LAN
	// would route the whole IPv4 space onto the bridge.  netifd reads a
	// missing netmask as /32 and an empty one as /0, so the AP Mode form must
	// never store a value that is not a real mask.
	netmask(value) {
		const parts = clean(value).split('.');

		if (parts.length !== 4)
			return '';

		const octets = [];

		for (const part of parts) {
			if (!/^(0|[1-9]\d{0,2})$/.test(part))
				return '';

			const octet = Number(part);

			if (octet > 255)
				return '';

			octets.push(octet);
		}

		const mask = ((octets[0] << 24) | (octets[1] << 16) |
			(octets[2] << 8) | octets[3]) >>> 0;

		if (mask === 0)
			return '';

		const host = (~mask) >>> 0;

		return (host & (host + 1)) === 0 ? octets.join('.') : '';
	},

	// Defaults for the node's static LAN settings.  They come from the LAN
	// interface as it is currently configured: the live status of
	// network.interface (DHCP lease or static address, route, DNS) is used
	// first and the UCI section is only a fallback, so the form never offers
	// an address that does not belong to this LAN.  An empty string means
	// that no value could be detected.
	lanDefaults(status, lan) {
		status = status || {};
		lan = lan || {};

		let ipaddr = '';
		let netmask = '';
		let gateway = '';
		let dns = '';

		const addresses = Array.isArray(status['ipv4-address'])
			? status['ipv4-address'] : [];

		for (const addr of addresses) {
			const ip = this.ipv4(addr && addr.address);

			if (ip) {
				ipaddr = ip;

				if (addr.mask != null)
					netmask = this.prefixToNetmask(addr.mask);
				break;
			}
		}

		const uciAddr = firstValue(lan.ipaddr);
		const cidr = uciAddr.split('/');

		if (!ipaddr)
			ipaddr = this.ipv4(cidr[0]);

		if (!netmask) {
			if (cidr[1])
				netmask = this.prefixToNetmask(cidr[1]);
			else
				netmask = this.ipv4(firstValue(lan.netmask));
		}

		const routes = Array.isArray(status.route) ? status.route : [];

		for (const route of routes) {
			if (clean(route && route.target) !== '0.0.0.0' ||
			    Number(route.mask) !== 0)
				continue;

			gateway = this.ipv4(route.nexthop);

			if (gateway)
				break;
		}

		if (!gateway)
			gateway = this.ipv4(firstValue(lan.gateway));

		const servers = Array.isArray(status['dns-server'])
			? status['dns-server'] : [];

		for (const server of servers) {
			dns = this.ipv4(server);

			if (dns)
				break;
		}

		if (!dns)
			dns = this.ipv4(firstValue(lan.dns));

		if (!dns)
			dns = gateway;

		return {
			ipaddr: ipaddr,
			netmask: netmask,
			gateway: gateway,
			dns: dns
		};
	},

	// Newest announcement per MAC.  A device announces every few seconds, so
	// several lines for the same MAC can be fresh at the same time.
	latestPeers(entries) {
		const latest = {};

		for (const entry of entries || []) {
			const previous = latest[entry.mac];

			if (!previous || entry.time >= previous.time)
				latest[entry.mac] = entry;
		}

		return latest;
	},

	// Peer announcements written by the daemon.  Each line is
	// "<epoch> <mesh MAC> <IPv4|-> <hostname> <load|-> [<LAN MAC|->]".  The
	// load field is missing in lines written before version 2 of the
	// announcement and the LAN MAC in lines written before version 3.  The age
	// is measured against the newest entry in the file, not the browser clock:
	// a router without NTP can have a clock that is far from the browser's.
	parsePeers(text, maxAge) {
		const entries = [];
		const limit = maxAge == null ? 120 : Number(maxAge);
		let latest = null;

		for (let line of String(text == null ? '' : text).split(/\r?\n/)) {
			line = line.trim();

			if (!line)
				continue;

			const parts = line.split(/\s+/);

			if (parts.length < 4)
				continue;

			const time = Number(parts[0]);
			const mac = this.macKey(parts[1]);
			const ip = parts[2] === '-' ? '' : this.ipv4(parts[2]);
			const hostname = clean(parts[3]);
			const load = /^\d+(\.\d+)?$/.test(clean(parts[4])) ? clean(parts[4]) : '';
			const lanMac = this.macKey(parts[5]);

			if (!Number.isFinite(time) || !mac || !hostname)
				continue;

			entries.push({ time: time, mac: mac, ip: ip, hostname: hostname,
				load: load, lanMac: lanMac });

			if (latest == null || time > latest)
				latest = time;
		}

		if (latest == null || !(limit >= 0))
			return entries;

		const cutoff = latest - limit;

		return entries.filter(function(entry) {
			return entry.time >= cutoff;
		});
	},

	// Attach the announced identity to every neighbor row.  When a MAC was
	// announced several times, the newest announcement wins.
	//
	// The announced IPv4 address is the address of the neighbor router's LAN
	// bridge, which is the only address the "IP Address" column shows.  Client
	// devices behind the router are not the neighbor; listing their addresses
	// made the column grow whenever a wired terminal or a DHCP lease appeared.
	// An announcement without an address (a router whose LAN has no IPv4) leaves
	// the row without one instead of guessing from the neighbour table, where
	// abandoned addresses can linger.
	annotatePeers(rows, entries) {
		const latest = this.latestPeers(entries);

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const peer = mac ? latest[mac] : null;

			row.hostname = peer ? peer.hostname : '';
			row.load = peer ? (peer.load || '') : '';
			row.ips = peer && peer.ip ? [ peer.ip ] : [];
		}

		return rows;
	},

	// "linkinfo" output of the helper script.  The radio driver reports the
	// frequency, channel and width of a hardif and the signal of each
	// station; the app merges them with the neighbor rows by interface name
	// and MAC.  Missing values are simply absent, which is normal for a wired
	// backhaul.  The channel and width follow the frequency and may be
	// missing when the driver does not expose them:
	//   kind <hardif> wlan|wired
	//   iface <hardif> <MHz> [<channel> <width MHz>]
	parseLinkInfo(reply) {
		const links = {};

		if (!reply || reply.code !== 0)
			return links;

		for (let line of String(reply.stdout == null ? '' : reply.stdout).split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts[0] === 'iface' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const frequency = Number(parts[2]);
				const channel = Number(parts[3]);
				const width = Number(parts[4]);

				if (!iface || !Number.isFinite(frequency) || frequency <= 0)
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].frequency = frequency;
				if (Number.isInteger(channel) && channel > 0)
					links[iface].channel = channel;
				if (Number.isFinite(width) && width > 0)
					links[iface].width = width;
			}
			else if (parts[0] === 'busy' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const busy = Number(parts[2]);

				if (!iface || !Number.isFinite(busy) || busy < 0 || busy > 100)
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].busy = Math.round(busy);
			}
			else if (parts[0] === 'peer' && parts.length >= 4) {
				const iface = clean(parts[1]);
				const mac = this.macKey(parts[2]);
				const signal = Number(parts[3]);

				if (!iface || !mac || !Number.isFinite(signal))
					continue;

				if (!links[iface])
					links[iface] = {};
				if (!links[iface].signals)
					links[iface].signals = {};
				links[iface].signals[mac] = signal;
			}
			else if (parts[0] === 'kind' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const kind = clean(parts[2]);
				const mac = this.macKey(parts[3]);

				if (!iface || (kind !== 'wired' && kind !== 'wlan'))
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].kind = kind;
				if (mac)
					links[iface].mac = mac;
			}
		}

		return links;
	},

	// "linkinfo" also prints one line identifying this device:
	//   local <hostname> <IPv4|-> <load|-> [<role>]
	// The hostname and load are the same values the daemon announces to the
	// other mesh devices.  The role is the effective meshassistant role; it is
	// missing in output from versions before it was added.
	parseLocalInfo(reply) {
		if (!reply || reply.code !== 0)
			return null;

		for (let line of String(reply.stdout == null ? '' : reply.stdout).split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts[0] !== 'local' || parts.length < 4)
				continue;

			const hostname = clean(parts[1]);
			const ip = this.ipv4(parts[2]);
			const load = /^\d+(\.\d+)?$/.test(clean(parts[3])) ? clean(parts[3]) : '';
			const role = clean(parts[4]);

			if (!hostname)
				continue;

			return {
				hostname: hostname,
				ip: ip,
				load: load,
				role: (role === 'server' || role === 'off' || role === 'client') ? role : ''
			};
		}

		return null;
	},

	// The "batctl n" header names the primary mesh interface and its MAC:
	// "[..., MainIF/MAC: mesh_radio0/02:58:28:12:81:52 (bat0/...)]".
	parseLocalIdentity(stdout) {
		const m = /MainIF\/MAC:\s*([^\/\s]+)\/([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/.exec(
			String(stdout == null ? '' : stdout));

		if (!m)
			return null;

		const iface = clean(m[1]);
		const mac = this.macKey(m[2]);

		if (!iface || !mac)
			return null;

		return { iface: iface, neighbor: mac };
	},

	// Attach the backhaul medium and the radio frequency, channel, width,
	// channel utilization and the peer signal to every neighbor row.  The
	// radio values all depend on the hardif named by "batctl n": a wired
	// backhaul has no radio settings and no station signal, so those cells
	// stay empty.
	annotateLinks(rows, links) {
		links = links || {};

		for (const row of rows) {
			const iface = clean(row.iface);
			const link = links[iface] || {};
			const mac = this.macKey(row.neighbor);
			const signal = mac && link.signals ? link.signals[mac] : null;

			row.backhaul = link.kind === 'wired' || link.kind === 'wlan' ? link.kind : '';
			row.frequency = link.frequency ? link.frequency + ' MHz' : '';
			row.channel = link.channel ? String(link.channel) : '';
			row.width = link.width ? link.width + ' MHz' : '';
			row.utilization = link.busy == null ? '' : link.busy + '%';
			row.signal = signal == null ? '' : signal + ' dBm';
		}

		return rows;
	},

	parseNeighbors(stdout) {
		const rows = [];

		for (let line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
			line = line.trim();

			if (!line)
				continue;

			let m = SPEED_RE.exec(line);

			if (m) {
				rows.push({
					neighbor: clean(m[1]),
					lastSeen: clean(m[2]),
					speed: clean(m[3]),
					iface: clean(m[4])
				});
				continue;
			}

			m = PLAIN_RE.exec(line);

			if (m) {
				rows.push({
					iface: clean(m[1]),
					neighbor: clean(m[2]),
					lastSeen: clean(m[3]),
					speed: ''
				});
			}
		}

		return rows;
	},

	// "batctl o" originator table.  Every line names an originator, the
	// throughput of one candidate nexthop and that nexthop's outgoing
	// interface; the candidate batman currently uses is marked with "*":
	//   * 00:58:28:12:81:54  0.070s ( 100000.0) 00:58:28:12:81:50 [ lan2]
	// Only the selected candidate is kept, keyed by originator.
	parseOriginators(stdout) {
		const selected = {};
		const re = /^(\*)?\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\S+\s+\(\s*([\d.]+)\s*\)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\[\s*([^\]\s]+)\s*\]$/;

		for (let line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
			const m = re.exec(line.trim());

			if (!m || !m[1])
				continue;

			const originator = this.macKey(m[2]);
			const nexthop = this.macKey(m[4]);
			const throughput = Number(m[3]);

			if (!originator || !nexthop || !Number.isFinite(throughput))
				continue;

			selected[originator] = {
				nexthop: nexthop,
				iface: clean(m[5]),
				throughput: throughput
			};
		}

		return selected;
	},

	// Mark each row's link as the one batman currently uses ("inuse") or as
	// a standby ("standby").  A device announces every hardif MAC under the
	// same address, so the announced MACs of one device form a group; the
	// group member that has a selected originator is that device's own
	// originator.  Its selected nexthop names the link used to reach the
	// device, while the device's other links stay up as a standby.
	//
	// A row whose device cannot be identified keeps the empty state and the
	// view prints a dash.
	annotateBackhaulState(rows, originators, entries) {
		originators = originators || {};

		const latest = this.latestPeers(entries);
		const groupMacs = {};

		for (const mac of Object.keys(latest)) {
			const peer = latest[mac];
			const key = peer.ip || peer.hostname;

			if (!key)
				continue;

			if (!groupMacs[key])
				groupMacs[key] = [];
			groupMacs[key].push(mac);
		}

		const deviceState = {};

		for (const key of Object.keys(groupMacs)) {
			let best = null;

			for (const mac of groupMacs[key]) {
				const entry = originators[mac];

				if (entry && (!best || entry.throughput > best.throughput))
					best = entry;
			}

			if (best)
				deviceState[key] = best;
		}

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const key = (row.ips && row.ips[0]) || row.hostname;
			const state = (key && deviceState[key]) || (mac && originators[mac]) || null;

			if (!state) {
				row.backhaulState = '';
				continue;
			}

			const iface = clean(row.iface);
			const sameNexthop = mac === state.nexthop;
			const sameIface = !iface || !state.iface || iface === state.iface;

			row.backhaulState = sameNexthop && sameIface ? 'inuse' : 'standby';
		}

		return rows;
	},

	// The local device has no link to itself.  Its row mirrors the neighbor
	// link with the strongest signal, so the signal and link rate columns
	// carry the same kind of values as the remote rows.  A wired backhaul has
	// no signal; the first neighbor then supplies the link rate.
	strongestLink(rows) {
		let best = null;
		let bestSignal = -Infinity;

		for (const row of rows || []) {
			const signal = parseInt(row && row.signal, 10);

			if (!Number.isFinite(signal))
				continue;

			if (signal > bestSignal) {
				bestSignal = signal;
				best = row;
			}
		}

		return best || (rows && rows.length ? rows[0] : null);
	},

	// Build the "Local Host" rows: one row per hardif bat0 currently uses.  The
	// hostname, LAN address, load and role are the identity of this device and
	// repeat on each row; the hardif, its MAC and its medium come from the
	// "linkinfo" kind lines.  Signal and link rate are not measured for the
	// device itself, so they mirror its best neighbor on the same hardif.
	parseLocalRows(statusStdout, linkReply, rows, originators) {
		const info = this.parseLocalInfo(linkReply);

		if (!info)
			return [];

		const identity = this.parseLocalIdentity(statusStdout) || {};
		const links = this.parseLinkInfo(linkReply);
		const ifaces = Object.keys(links).filter(function(iface) {
			return links[iface].kind;
		});

		// Without kind lines (for example when batctl cannot list the
		// interfaces) keep the identity row that the old single-row layout
		// showed.
		if (ifaces.length === 0)
			ifaces.push(identity.iface || '');

		const local = ifaces.map(function(iface) {
			return this.buildLocalRow(info, identity, links, rows, iface);
		}, this);

		return this.annotateLocalState(local, originators);
	},

	buildLocalRow(info, identity, links, rows, iface) {
		const link = links[iface] || {};
		const mac = link.mac || (iface && iface === identity.iface ? identity.neighbor : '') || '';
		const peers = (rows || []).filter(function(row) {
			return clean(row.iface) === iface;
		});
		const peer = this.strongestLink(peers);
		let signal = peer ? (peer.signal || '') : '';

		// A radio can see stations that batman does not list as neighbors yet;
		// fall back to the strongest station signal of this hardif.
		if (!signal && link.signals) {
			let best = null;

			for (const station of Object.keys(link.signals)) {
				if (best == null || link.signals[station] > link.signals[best])
					best = station;
			}

			if (best != null)
				signal = link.signals[best] + ' dBm';
		}

		return {
			hostname: info.hostname,
			neighbor: mac,
			ips: info.ip ? [ info.ip ] : [],
			iface: iface,
			backhaul: link.kind || '',
			frequency: link.frequency ? link.frequency + ' MHz' : '',
			channel: link.channel ? String(link.channel) : '',
			width: link.width ? link.width + ' MHz' : '',
			signal: signal,
			load: info.load || '',
			utilization: link.busy == null ? '' : link.busy + '%',
			speed: peer ? (peer.speed || '') : '',
			lastSeen: peer ? (peer.lastSeen || '') : '',
			backhaulState: ''
		};
	},

	// Mark the local link "inuse" when batman selects its hardif as the
	// outgoing interface for at least one originator.  The other local hardifs
	// are standbys.  Without any selected originator the state is unknown and
	// the view prints a dash.
	annotateLocalState(rows, originators) {
		originators = originators || {};

		const inUse = {};
		let any = false;

		for (const mac of Object.keys(originators)) {
			const entry = originators[mac];

			if (!entry || !entry.iface)
				continue;

			any = true;
			inUse[clean(entry.iface)] = true;
		}

		for (const row of rows) {
			const iface = clean(row.iface);

			row.backhaulState = (!any || !iface) ? '' : (inUse[iface] ? 'inuse' : 'standby');
		}

		return rows;
	},

	parseStatus(reply, peerText, linkReply, originatorReply) {
		if (!reply || reply.code !== 0)
			return { ok: false, rows: [], local: [], role: '' };

		const rows = this.parseNeighbors(reply.stdout);
		const peers = this.parsePeers(peerText);
		const links = this.parseLinkInfo(linkReply);
		const originators = this.parseOriginators(
			originatorReply && originatorReply.stdout);
		const info = this.parseLocalInfo(linkReply);

		this.annotatePeers(rows, peers);
		this.annotateLinks(rows, links);
		this.annotateBackhaulState(rows, originators, peers);

		return {
			ok: true,
			rows: rows,
			local: this.parseLocalRows(reply.stdout, linkReply, rows, originators),
			role: info ? info.role : ''
		};
	}
});
