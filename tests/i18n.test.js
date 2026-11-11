'use strict';

const lib = require('./lib');

function unescape(s) {
	return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
		.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function parsePo(text) {
	const entries = [];
	let cur = { msgid: '', msgstr: '' };
	let field = null;

	for (let line of text.split(/\r?\n/)) {
		line = line.trim();

		if (!line || line.charAt(0) === '#')
			continue;

		let m = /^msgid\s+"(.*)"$/.exec(line);

		if (m) {
			if (cur.msgid || cur.msgstr) {
				entries.push(cur);
				cur = { msgid: '', msgstr: '' };
			}
			field = 'msgid';
			cur.msgid = unescape(m[1]);
			continue;
		}

		m = /^msgstr\s+"(.*)"$/.exec(line);

		if (m) {
			field = 'msgstr';
			cur.msgstr = unescape(m[1]);
			continue;
		}

		m = /^"(.*)"$/.exec(line);

		if (m && field)
			cur[field] += unescape(m[1]);
	}

	if (cur.msgid || cur.msgstr)
		entries.push(cur);

	return entries;
}

function extractMsgids(src) {
	const out = [];
	const re = /_\(\s*'((?:\\.|[^'\\])*)'\s*\)|_\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
	let m;

	while ((m = re.exec(src)))
		out.push(unescape(m[1] != null ? m[1] : m[2]));

	return out;
}

const poText = lib.read('po/zh_Hans/meshassistant.po');
const potText = lib.read('po/templates/meshassistant.pot');
const po = parsePo(poText).filter(e => e.msgid !== '');
const pot = parsePo(potText).filter(e => e.msgid !== '');
const view = lib.read('htdocs/luci-static/resources/view/meshassistant.js');
const menu = JSON.parse(lib.read(
	'root/usr/share/luci/menu.d/luci-app-meshassistant.json'));

const msgids = extractMsgids(view);
msgids.push(menu['admin/network/meshassistant'].title);

const poMap = new Map();
const potIds = new Set();

for (const e of po)
	poMap.set(e.msgid, e.msgstr);
for (const e of pot)
	potIds.add(e.msgid);

lib.eq(poMap.size, po.length, 'PO has no duplicate msgids');
lib.eq(potIds.size, pot.length, 'POT has no duplicate msgids');
lib.eq([...poMap.keys()].sort(), [...potIds].sort(), 'PO and POT msgid sets match');

for (const id of msgids) {
	lib.ok(poMap.has(id), 'PO covers source msgid: ' + JSON.stringify(id));
	lib.ok(poMap.get(id) !== '', 'translation is non-empty: ' + JSON.stringify(id));
}

for (const e of po) {
	lib.ok(msgids.includes(e.msgid), 'PO has no orphan msgid: ' + JSON.stringify(e.msgid));
	lib.eq(e.msgstr, e.msgstr.trim(), 'translation has no surrounding whitespace: ' +
		JSON.stringify(e.msgid));
}

for (const e of pot)
	lib.eq(e.msgstr, '', 'POT msgstr is empty: ' + JSON.stringify(e.msgid));

lib.ok(poText.includes('Language: zh_Hans'), 'PO language is zh_Hans');
lib.ok(poText.includes('nplurals=1; plural=0;'), 'PO plural form is singular');
lib.eq(poMap.get('Mesh Assistant'), 'MESH助手', 'menu title translates to MESH助手');
lib.eq(poMap.get('IP Address'), 'IP 地址', 'IP address column translates to IP 地址');
lib.eq(poMap.get('Backhaul'), '回程类型', 'backhaul column translates exactly');
lib.eq(poMap.get('Backhaul Status'), '回程状态',
	'backhaul status column translates exactly');
lib.eq(poMap.get('In Use'), '使用中',
	'used backhaul label translates exactly');
lib.eq(poMap.get('Standby'), '备用',
	'standby backhaul label translates exactly');
lib.eq(poMap.get('Wired'), '有线', 'wired medium translates exactly');
lib.eq(poMap.get('Wireless'), '无线', 'wireless medium translates exactly');
lib.eq(poMap.get('Number of Active Nodes: %d'), '活动节点数：%d',
	'node count placeholder preserved');
lib.eq(poMap.get('Failed to apply mesh settings: %s'), '应用 Mesh 设置失败：%s',
	'error placeholder preserved');
lib.eq(poMap.get('Mesh Settings'), 'Mesh 设置',
	'mesh settings tab translates exactly');
lib.eq(poMap.get('Mesh Status'), 'Mesh 状态',
	'mesh status tab translates exactly');
lib.eq(poMap.get('Load'), '负载', 'load column translates exactly');
lib.eq(poMap.get('Remote Hosts'), '远程主机',
	'remote hosts subtitle translates exactly');
lib.eq(poMap.get('Local Host'), '本机',
	'local host subtitle translates exactly');
lib.eq(poMap.get('Node MAC'), '节点MAC',
	'node MAC column translates exactly');
lib.eq(poMap.get('Run Log'), '运行日志',
	'run log tab translates exactly');
lib.eq(poMap.get('Clear Log'), '清空日志',
	'clear log button translates exactly');
lib.eq(poMap.get('No log entries.'), '暂无日志。',
	'empty run log message translates exactly');
lib.eq(poMap.get('Failed to clear the log: %s'), '清空日志失败：%s',
	'clear log error placeholder preserved');
lib.eq(poMap.get('Refresh Log'), '刷新日志',
	'refresh log button translates exactly');
lib.eq(poMap.get('Failed to refresh the log: %s'), '刷新日志失败：%s',
	'refresh log error placeholder preserved');
lib.eq(poMap.get('Channel'), '信道',
	'channel column translates exactly');
lib.eq(poMap.get('Channel Utilization'), '信道占用率',
	'channel utilization column translates exactly');
lib.eq(poMap.get('Channel Width'), '通道宽度',
	'channel width column translates exactly');
lib.eq(poMap.get('Link Rate'), '链路速率',
	'link rate column translates exactly');
lib.eq(poMap.get('Enable MLO'), '启用 MLO',
	'MLO flag translates exactly');
lib.eq(poMap.get('Combine two selected radios into one Wi-Fi 7 Multi-Link Operation (MLO) access point. The radios are switched to EHT mode. MLO requires exactly two radios.'),
	'将所选的两个射频合并为一个 Wi-Fi 7 多链路操作（MLO）接入点，射频会自动切换为 EHT 模式。启用 MLO 需要恰好选择两个射频。',
	'MLO description translates exactly');
lib.eq(poMap.get('MLO requires exactly two radios.'), '启用 MLO 需要恰好选择两个射频。',
	'MLO radio-count message translates exactly');
lib.eq(poMap.get('Select at least one radio.'), '请至少选择一个射频。',
	'AP radio validation message translates exactly');
lib.eq(poMap.get('Select one or more radios (2.4 GHz, 5 GHz and 6 GHz) for the regular WiFi access point. The SSID for each radio can be configured below.'),
	'选择一个或多个射频（2.4 GHz、5 GHz 与 6 GHz）用于普通 WiFi 接入点。各射频的 SSID 可在下方配置。',
	'AP radio description translates exactly');
lib.eq(poMap.get('SSID Mode'), 'SSID 模式',
	'SSID mode label translates exactly');
lib.eq(poMap.get('Same SSID'), '相同 SSID',
	'same SSID choice translates exactly');
lib.eq(poMap.get('Separate SSIDs'), '不同 SSID',
	'separate SSID choice translates exactly');
lib.eq(poMap.get('SSID for %s'), 'SSID（%s）',
	'per-radio SSID label translates exactly');
lib.eq(poMap.get('SSID used by this radio when separate SSIDs are enabled. Leave empty to use the shared SSID.'),
	'启用不同 SSID 时该射频使用的 SSID。留空则使用公共 SSID。',
	'per-radio SSID description translates exactly');
lib.eq(poMap.get('Choose whether the selected radios share one SSID or use a separate SSID per radio. Separate SSIDs disable seamless 802.11r roaming between the radios.'),
	'选择选中的射频共用一个 SSID，还是每个射频使用各自的 SSID。使用不同 SSID 时，射频之间无法通过 802.11r 无缝漫游。',
	'SSID mode description translates exactly');
lib.eq(poMap.get('SSID for the regular WiFi network. This SSID is also used by the MLO access point and by radios without their own SSID.'),
	'普通 WiFi 网络的 SSID。MLO 接入点以及没有单独 SSID 的射频也使用此 SSID。',
	'shared SSID description translates exactly');

lib.summary('i18n');
