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

	// batctl returns a JSON array; treat malformed output like no data so a
	// failure of an optional query never hides the neighbor list.
	jsonArray(reply) {
		if (!reply || reply.code !== 0)
			return [];

		const text = clean(reply.stdout);

		if (!text)
			return [];

		try {
			const data = JSON.parse(text);

			return Array.isArray(data) ? data : [];
		}
		catch (e) {
			return [];
		}
	},

	// "batctl meshif bat0 transtable_global_json": one entry per client MAC
	// reachable through batman-adv, with the originator (neighbor) that
	// announced it.
	parseTranstableGlobal(reply) {
		const entries = [];

		for (const item of this.jsonArray(reply)) {
			if (!item || typeof item != 'object')
				continue;

			const address = this.macKey(item.tt_address);
			const originator = this.macKey(item.orig_address);

			if (address && originator)
				entries.push({ address: address, originator: originator });
		}

		return entries;
	},

	// "batctl meshif bat0 dat_cache_json": client MAC -> IPv4 address.
	parseDatCache(reply) {
		const entries = [];

		for (const item of this.jsonArray(reply)) {
			if (!item || typeof item != 'object')
				continue;

			const mac = this.macKey(item.dat_cache_hwaddress);
			const ip = this.ipv4(item.dat_cache_ip4address);

			if (mac && ip)
				entries.push({ mac: mac, ip: ip });
		}

		return entries;
	},

	// Build MAC -> [IPv4] from the LuCI host hints.  The result of
	// network.getHostHints() is a Hosts object with a "hosts" map; a plain map
	// is accepted as well.  Older LuCI versions used "ipv4" instead of
	// "ipaddrs".
	hostIPs(hostHints) {
		const map = {};

		if (!hostHints)
			return map;

		const hosts = hostHints.hosts || hostHints;

		for (const mac of Object.keys(hosts)) {
			const key = this.macKey(mac);
			const entry = hosts[mac] || {};

			if (!key)
				continue;

			let addrs = entry.ipaddrs || entry.ipv4 || [];

			if (!Array.isArray(addrs))
				addrs = [ addrs ];

			for (const addr of addrs) {
				const ip = this.ipv4(addr);

				if (ip) {
					if (!map[key])
						map[key] = [];
					if (map[key].indexOf(ip) === -1)
						map[key].push(ip);
				}
			}
		}

		return map;
	},

	// Attach the IPv4 addresses of every neighbor to its row.  The addresses
	// of a neighbor are the ones of its own MAC plus the ones of the client
	// MACs that the mesh transit table reports behind that originator.
	annotateIPs(rows, ttEntries, datEntries, hostHints) {
		const ipByMac = this.hostIPs(hostHints);

		for (const entry of datEntries) {
			if (!ipByMac[entry.mac])
				ipByMac[entry.mac] = [];
			if (ipByMac[entry.mac].indexOf(entry.ip) === -1)
				ipByMac[entry.mac].push(entry.ip);
		}

		const clientsByOriginator = {};

		for (const entry of ttEntries) {
			if (!clientsByOriginator[entry.originator])
				clientsByOriginator[entry.originator] = [];
			clientsByOriginator[entry.originator].push(entry.address);
		}

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const ips = [];
			const addrs = [];

			if (mac && ipByMac[mac])
				addrs.push.apply(addrs, ipByMac[mac]);

			if (mac && clientsByOriginator[mac]) {
				for (const client of clientsByOriginator[mac]) {
					if (ipByMac[client])
						addrs.push.apply(addrs, ipByMac[client]);
				}
			}

			for (const ip of addrs) {
				if (ips.indexOf(ip) === -1)
					ips.push(ip);
			}

			row.ips = ips;
		}

		return rows;
	},

	// Peer announcements written by the daemon.  Each line is
	// "<epoch> <mesh MAC> <IPv4|-> <hostname> <load|->".  The load field is
	// missing in lines written before version 2 of the announcement.  The age
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

			if (!Number.isFinite(time) || !mac || !hostname)
				continue;

			entries.push({ time: time, mac: mac, ip: ip, hostname: hostname, load: load });

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

	// Attach the announced hostname and IP to every neighbor row.  When a MAC
	// was announced several times, the newest announcement wins.  An
	// announced address is the neighbor's real LAN address, so it is placed
	// first in the IP list.
	annotatePeers(rows, entries) {
		const latest = {};

		for (const entry of entries || []) {
			const previous = latest[entry.mac];

			if (!previous || entry.time >= previous.time)
				latest[entry.mac] = entry;
		}

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const peer = mac ? latest[mac] : null;

			row.hostname = peer ? peer.hostname : '';
			row.load = peer ? (peer.load || '') : '';

			if (!Array.isArray(row.ips))
				row.ips = [];

			if (peer && peer.ip && row.ips.indexOf(peer.ip) === -1)
				row.ips.unshift(peer.ip);
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

				if (!iface || (kind !== 'wired' && kind !== 'wlan'))
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].kind = kind;
			}
		}

		return links;
	},

	// "linkinfo" also prints one line identifying this device:
	//   local <hostname> <IPv4|-> <load|->
	// The hostname and load are the same values the daemon announces to the
	// other mesh devices.
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

			if (!hostname)
				continue;

			return { hostname: hostname, ip: ip, load: load };
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

	// Build the "Local Host" row: the identity of this device.  The hostname,
	// LAN address and load come from the "linkinfo" helper; the hardif, its
	// MAC and its medium from the "batctl n" header and "linkinfo".  Signal
	// and link rate are not measured for the device itself, so they mirror
	// its best neighbor link.
	parseLocalRow(statusStdout, linkReply, rows) {
		const info = this.parseLocalInfo(linkReply);

		if (!info)
			return null;

		const identity = this.parseLocalIdentity(statusStdout) || {};
		const links = this.parseLinkInfo(linkReply);
		const link = links[identity.iface] || {};
		const peer = this.strongestLink(rows);

		return {
			hostname: info.hostname,
			neighbor: identity.neighbor || '',
			ips: info.ip ? [ info.ip ] : [],
			iface: identity.iface || '',
			backhaul: link.kind || '',
			frequency: link.frequency ? link.frequency + ' MHz' : '',
			channel: link.channel ? String(link.channel) : '',
			width: link.width ? link.width + ' MHz' : '',
			signal: peer ? (peer.signal || '') : '',
			load: info.load || '',
			utilization: link.busy == null ? '' : link.busy + '%',
			speed: peer ? (peer.speed || '') : '',
			lastSeen: peer ? (peer.lastSeen || '') : ''
		};
	},

	parseStatus(reply, ttReply, datReply, hostHints, peerText, linkReply) {
		if (!reply || reply.code !== 0)
			return { ok: false, rows: [], local: null };

		const rows = this.parseNeighbors(reply.stdout);

		this.annotateIPs(rows,
			this.parseTranstableGlobal(ttReply),
			this.parseDatCache(datReply),
			hostHints);
		this.annotatePeers(rows, this.parsePeers(peerText));
		this.annotateLinks(rows, this.parseLinkInfo(linkReply));

		return {
			ok: true,
			rows: rows,
			local: this.parseLocalRow(reply.stdout, linkReply, rows)
		};
	}
});
