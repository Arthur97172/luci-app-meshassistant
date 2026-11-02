'require baseclass';

const SPEED_RE = /^(\S+)\s+(\d+\.\d+s)\s+\(\s*([\d.]+)\s*\)\s+\[([^\]]+)\]$/;
const PLAIN_RE = /^(\S+)\s+(\S+)\s+(\d+\.\d+s)$/;

function clean(s) {
	return String(s == null ? '' : s).trim();
}

return baseclass.extend({
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

	parseStatus(reply) {
		if (!reply || reply.code !== 0)
			return { ok: false, rows: [] };

		return { ok: true, rows: this.parseNeighbors(reply.stdout) };
	}
});
