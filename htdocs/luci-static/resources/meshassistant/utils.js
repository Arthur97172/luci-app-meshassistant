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

	parseStatus(reply, ttReply, datReply, hostHints) {
		if (!reply || reply.code !== 0)
			return { ok: false, rows: [] };

		const rows = this.parseNeighbors(reply.stdout);

		this.annotateIPs(rows,
			this.parseTranstableGlobal(ttReply),
			this.parseDatCache(datReply),
			hostHints);

		return { ok: true, rows: rows };
	}
});
