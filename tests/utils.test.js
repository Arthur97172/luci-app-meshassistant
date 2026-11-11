'use strict';

const lib = require('./lib');

const utils = lib.loadUtils();

const FIXTURE = [
	'[B.A.T.M.A.N. adv 2025.4, MainIF/MAC: eth0/aa:bb:cc:dd:ee:ff (bat0/11:22:33:44:55:66)]',
	'         Neighbor   last-seen      speed           IF',
	'aa:bb:cc:dd:ee:ff    2.345s (    450.0) [     wlan0]',
	'node-b  0.123s (   0.5) [wlan1]',
	'   wlan0\t  aa:bb:cc:dd:ee:ff    3.456s',
	'[B.A.T.M.A.N. adv 2025.4]',
	'garbage line'
].join('\n');

const rows = utils.parseNeighbors(FIXTURE);

lib.eq(rows.length, 3, 'parses three neighbor rows and skips headers/garbage');
lib.eq(rows[0], {
	neighbor: 'aa:bb:cc:dd:ee:ff',
	lastSeen: '2.345s',
	speed: '450.0',
	iface: 'wlan0'
}, 'parses BATMAN_V throughput row');
lib.eq(rows[1], {
	neighbor: 'node-b',
	lastSeen: '0.123s',
	speed: '0.5',
	iface: 'wlan1'
}, 'parses hostname neighbor row');
lib.eq(rows[2], {
	iface: 'wlan0',
	neighbor: 'aa:bb:cc:dd:ee:ff',
	lastSeen: '3.456s',
	speed: ''
}, 'parses BATMAN_IV / no-throughput row');

lib.eq(utils.parseNeighbors(''), [], 'empty output yields no rows');
lib.eq(utils.parseNeighbors(null), [], 'null output yields no rows');

lib.eq(utils.parseStatus(null), { ok: false, rows: [], local: [], role: '', active: null },
	'missing reply is an error');
lib.eq(utils.parseStatus({ code: 1, stdout: FIXTURE }),
	{ ok: false, rows: [], local: [], role: '', active: null }, 'nonzero exit is an error');
lib.eq(utils.parseStatus({ code: 0, stdout: FIXTURE }).rows.length, 3, 'successful reply exposes rows');

lib.eq(utils.parseStatus({ code: 0, stdout: FIXTURE }, '', {
	code: 0, stdout: 'state active=0'
}).active, false, 'parseStatus reports a stopped mesh');
lib.eq(utils.parseStatus({ code: 0, stdout: FIXTURE }, '', {
	code: 0, stdout: 'state active=1'
}).active, true, 'parseStatus reports a running mesh');
lib.eq(utils.parseStatus({ code: 0, stdout: FIXTURE }, '', {
	code: 0, stdout: 'local router 192.168.10.2 0.10 server'
}).active, null, 'a reply without the state line leaves it unknown');
lib.eq(utils.parseStatus({ code: 0, stdout: FIXTURE }, '', {
	code: 1, stdout: 'state active=0'
}).active, null, 'a failed link read leaves the state unknown');

const NOW = 1700000000;
const PEERS = [
	(NOW - 30) + ' aa:bb:cc:dd:ee:ff 192.168.10.111 OpenWrt',
	(NOW - 10) + ' AA:BB:CC:DD:EE:FF 192.168.10.112 newname 0.15 77:88:99:AA:BB:CC',
	(NOW - 500) + ' 11:22:33:44:55:66 192.168.10.50 stale',
	NOW + ' not-a-mac 192.168.10.60 badmac',
	NOW + ' de:ad:be:ef:00:02 - noip',
	NOW + ' de:ad:be:ef:00:03 192.168.10.61 badload 1.2.3',
	NOW + ' de:ad:be:ef:00:04 192.168.10.62 badlan 0.2 not-a-mac',
	'broken'
].join('\n');

lib.eq(utils.parsePeers(PEERS), [
	{ time: NOW - 30, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.111',
	  hostname: 'OpenWrt', load: '', lanMac: '', state: '', kind: '',
	  speed: '', iface: '' },
	{ time: NOW - 10, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.112',
	  hostname: 'newname', load: '0.15', lanMac: '77:88:99:aa:bb:cc', state: '',
	  kind: '', speed: '', iface: '' },
	{ time: NOW, mac: 'de:ad:be:ef:00:02', ip: '', hostname: 'noip',
	  load: '', lanMac: '', state: '', kind: '', speed: '', iface: '' },
	{ time: NOW, mac: 'de:ad:be:ef:00:03', ip: '192.168.10.61',
	  hostname: 'badload', load: '', lanMac: '', state: '', kind: '',
	  speed: '', iface: '' },
	{ time: NOW, mac: 'de:ad:be:ef:00:04', ip: '192.168.10.62',
	  hostname: 'badlan', load: '0.2', lanMac: '', state: '', kind: '',
	  speed: '', iface: '' }
], 'parses fresh peer announcements and skips stale or malformed lines');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 11:22:33:44:55:66 inuse'), [
	{ time: NOW, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.7', hostname: 'nodeC',
	  load: '0.10', lanMac: '11:22:33:44:55:66', state: 'inuse', kind: '',
	  speed: '', iface: '' }
], 'a version 4 announcement reports the backhaul state of the hardif');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - standby')[0].state,
	'standby', 'a version 4 announcement can report a standby hardif');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - bogus')[0].state,
	'', 'an unknown backhaul state is ignored');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired'), [
	{ time: NOW, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.7', hostname: 'nodeC',
	  load: '0.10', lanMac: '', state: 'inuse', kind: 'wired', speed: '',
	  iface: '' }
], 'a version 5 announcement reports the medium of the hardif');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - standby wlan')[0].kind,
	'wlan', 'a version 5 announcement can report a wireless hardif');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse bogus')[0].kind,
	'', 'an unknown medium is ignored');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 100000.0'), [
	{ time: NOW, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.7', hostname: 'nodeC',
	  load: '0.10', lanMac: '', state: 'inuse', kind: 'wired',
	  speed: '100000.0', iface: '' }
], 'a version 6 announcement reports the link speed of the hardif');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - standby wlan -')[0].speed,
	'', 'a hardif without a measured link speed reports none');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 1.2.3')[0].speed,
	'', 'a malformed link speed is ignored');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 100000.0 lan2'), [
	{ time: NOW, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.10.7', hostname: 'nodeC',
	  load: '0.10', lanMac: '', state: 'inuse', kind: 'wired',
	  speed: '100000.0', iface: 'lan2' }
], 'a version 7 announcement reports the hardif name');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 100000.0 -')[0].iface,
	'', 'a hardif announced without a name reports none');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 100000.0 bad/name')[0].iface,
	'', 'a malformed hardif name is ignored');
lib.eq(utils.parsePeers(NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.7 nodeC 0.10 - inuse wired 100000.0 '
	+ 'a-very-long-interface-name')[0].iface,
	'', 'a hardif name longer than IFNAMSIZ is ignored');
lib.eq(utils.parsePeers(''), [], 'empty peer file yields no entries');
lib.eq(utils.parsePeers(null), [], 'missing peer file yields no entries');
lib.eq(utils.parsePeers(PEERS, 20).length, 4,
	'the age limit is configurable');

const bareStatus = utils.parseStatus({ code: 0, stdout: FIXTURE }, '');

lib.eq(bareStatus.rows.map(function(row) { return row.ips.length; }), [ 0, 0, 0 ],
	'a neighbor without an announcement has no address to show');

const peerRows = utils.parseNeighbors(FIXTURE);
utils.annotatePeers(peerRows, utils.parsePeers(PEERS));

lib.eq(peerRows[0].hostname, 'newname',
	'the newest announcement for a MAC supplies the hostname');
lib.eq(peerRows[0].load, '0.15',
	'the newest announcement for a MAC supplies the load');
lib.eq(peerRows[0].ips, [ '192.168.10.112' ],
	'the announced address replaces an older address of the same host');
lib.eq(peerRows[0].lanMac, '77:88:99:aa:bb:cc',
	'the newest announcement for a MAC supplies the LAN bridge MAC');
lib.eq(peerRows[1].hostname, '', 'a neighbor without an announcement has no hostname');
lib.eq(peerRows[1].load, '', 'a neighbor without an announcement has no load');
lib.eq(peerRows[1].ips, [], 'a neighbor without an announcement has no address');
lib.eq(utils.annotatePeers([], []), [], 'annotating an empty row list is safe');

/*
 * A device that changed its LAN address: the neighbour table, the DHCP lease
 * files and the DAT cache can still map its MACs to the abandoned address.
 * Only the address the router announces for its LAN bridge may reach the row;
 * a wired client behind it has an address of its own that must not.
 */
const staleStatus = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.42 node-b 0.20 77:88:99:aa:bb:cc');

lib.eq(staleStatus.rows[0].ips, [ '192.168.10.42' ],
	'only the announced LAN address of the remote router is shown');

const v2Status = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.42 node-b 0.20');

lib.eq(v2Status.rows[0].ips, [ '192.168.10.42' ],
	'an announcement without the LAN MAC still supplies the router address');

const noAddressStatus = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	NOW + ' aa:bb:cc:dd:ee:ff - node-b 0.20 77:88:99:aa:bb:cc');

lib.eq(noAddressStatus.rows[0].ips, [],
	'a router that announces no address leaves the column empty');

const LINKS = [
	'kind wlan0 wlan aa:bb:cc:dd:ee:01',
	'kind wlan1 wlan',
	'kind eth9 wired aa:bb:cc:dd:ee:09',
	'kind wlan0 bogus',
	'iface wlan0 2437 6 40',
	'iface wlan2 5180',
	'busy wlan0 4',
	'busy wlan1 17',
	'busy wlan1 150',
	'peer wlan0 aa:bb:cc:dd:ee:ff -52',
	'peer wlan1 aa:bb:cc:dd:ee:ff -70',
	'peer wlan0 11:22:33:44:55:66 not-a-number',
	'peer wlan1 de:ad:be:ef:00:02 -60',
	'iface wlan0 0',
	'broken'
].join('\n');

const linkInfo = utils.parseLinkInfo({ code: 0, stdout: LINKS });

lib.eq(linkInfo, {
	wlan0: { kind: 'wlan', mac: 'aa:bb:cc:dd:ee:01', frequency: 2437, channel: 6,
		width: 40, busy: 4, signals: { 'aa:bb:cc:dd:ee:ff': -52 } },
	wlan1: { kind: 'wlan', busy: 17,
		signals: { 'aa:bb:cc:dd:ee:ff': -70, 'de:ad:be:ef:00:02': -60 } },
	eth9: { kind: 'wired', mac: 'aa:bb:cc:dd:ee:09' },
	wlan2: { frequency: 5180 }
}, 'parses the medium, MAC, frequency, channel, width, utilization and station signals');
lib.eq(linkInfo.wlan2, { frequency: 5180 },
	'the channel and width are optional on old drivers');
lib.eq(linkInfo.eth9, { kind: 'wired', mac: 'aa:bb:cc:dd:ee:09' },
	'a wired hardif is recorded without radio data');
lib.eq(linkInfo.wlan1.mac, undefined,
	'a kind line without a MAC is still accepted');
lib.eq(utils.parseLinkInfo({ code: 1, stdout: LINKS }), {},
	'a failed link info query yields no entries');
lib.eq(utils.parseLinkInfo(null), {}, 'missing link info yields no entries');

const linkRows = utils.parseNeighbors(FIXTURE);
utils.annotateLinks(linkRows, linkInfo);

lib.eq(linkRows[0].frequency, '2437 MHz', 'the row interface supplies the frequency');
lib.eq(linkRows[0].backhaul, 'wlan', 'the row interface supplies the backhaul medium');
lib.eq(linkRows[0].channel, '6', 'the row interface supplies the channel');
lib.eq(linkRows[0].width, '40 MHz', 'the row interface supplies the channel width');
lib.eq(linkRows[0].utilization, '4%', 'the row interface supplies the channel utilization');
lib.eq(linkRows[0].signal, '-52 dBm', 'the neighbor MAC supplies the signal strength');
lib.eq(linkRows[1].frequency, '', 'an interface without link info has no frequency');
lib.eq(linkRows[1].channel, '', 'an interface without link info has no channel');
lib.eq(linkRows[1].width, '', 'an interface without link info has no channel width');
lib.eq(linkRows[1].utilization, '17%', 'the channel utilization is matched by interface name');
lib.eq(linkRows[1].signal, '', 'a neighbor without a station entry has no signal');
lib.eq(linkRows[2].frequency, '2437 MHz', 'the frequency is matched by interface name');
lib.eq(linkRows[2].channel, '6', 'the channel is matched by interface name');
lib.eq(linkRows[2].width, '40 MHz', 'the channel width is matched by interface name');
lib.eq(linkRows[2].utilization, '4%', 'the channel utilization is matched by interface name');
lib.eq(linkRows[2].signal, '-52 dBm',
	'the signal is matched by both interface name and neighbor MAC');
lib.eq(utils.annotateLinks([ { iface: 'eth9', neighbor: '' } ], linkInfo)[0].backhaul,
	'wired', 'a wired hardif row is labelled wired');
lib.eq(utils.annotateLinks([ { iface: 'wlan2', neighbor: '' } ], linkInfo)[0].backhaul,
	'', 'an interface without a kind has no medium');
lib.eq(utils.annotateLinks([], {}), [], 'annotating an empty row list is safe');

const withLinks = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	'',
	{ code: 0, stdout: 'iface wlan0 2437\npeer wlan0 aa:bb:cc:dd:ee:ff -52' });

lib.eq(withLinks.rows[0].frequency, '2437 MHz',
	'parseStatus attaches the interface frequency');
lib.eq(withLinks.rows[0].signal, '-52 dBm',
	'parseStatus attaches the neighbor signal strength');

const withPeers = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	NOW + ' aa:bb:cc:dd:ee:ff 192.168.10.111 OpenWrt');

lib.eq(withPeers.rows[0].hostname, 'OpenWrt', 'parseStatus attaches peer hostnames');
lib.eq(withPeers.rows[0].ips, [ '192.168.10.111' ], 'parseStatus attaches peer addresses');
lib.eq(withPeers.rows.find(function(row) { return row.neighbor === 'node-b'; }).hostname,
	'', 'parseStatus leaves unmatched rows without a hostname');
lib.eq(withPeers.rows.map(function(row) { return row.iface; }),
	[ 'wlan0', 'wlan0', 'wlan1' ],
	'parseStatus groups rows of the same device together');

const ORIGINATORS = [
	'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: lan2/00:58:28:22:67:f9 (bat0/86:10:45:55:ab:8c BATMAN_V)]',
	'   Originator        last-seen ( throughput)  Nexthop           [outgoingIF]',
	'   00:58:28:12:82:e4    0.330s (     1471.5) 00:58:28:12:81:54 [mesh_radio2]',
	' * 00:58:28:12:82:e4    0.330s (     1890.1) 00:58:28:12:82:e4 [mesh_radio2]',
	'   00:58:28:12:82:e4    0.330s (     1091.7) 00:58:28:12:81:50 [      lan2]',
	'   00:58:28:12:81:54    0.070s (      964.3) 00:58:28:12:82:e4 [mesh_radio2]',
	'   00:58:28:12:81:54    0.070s (     1868.4) 00:58:28:12:81:54 [mesh_radio2]',
	' * 00:58:28:12:81:54    0.070s (   100000.0) 00:58:28:12:81:50 [      lan2]'
].join('\n');

const originators = utils.parseOriginators(ORIGINATORS);

lib.eq(originators['00:58:28:12:82:e4'], {
	nexthop: '00:58:28:12:82:e4',
	iface: 'mesh_radio2',
	throughput: 1890.1
}, 'the selected nexthop of an originator is the one marked with a star');
lib.eq(originators['00:58:28:12:81:54'], {
	nexthop: '00:58:28:12:81:50',
	iface: 'lan2',
	throughput: 100000
}, 'the outgoing interface of the selected nexthop keeps its name');
lib.eq(utils.parseOriginators(''), {}, 'empty originator output yields no entries');
lib.eq(utils.parseOriginators(null), {}, 'null originator output yields no entries');

const DUAL_PEERS = [
	NOW + ' 00:58:28:12:81:50 192.168.10.2 node2 0.08',
	NOW + ' 00:58:28:12:81:54 192.168.10.2 node2 0.08',
	NOW + ' 00:58:28:12:82:e4 192.168.10.3 node3 0.20'
].join('\n');

const stateRows = [
	{ neighbor: '00:58:28:12:81:50', iface: 'lan2',
	  ips: [ '192.168.10.2' ], hostname: 'node2' },
	{ neighbor: '00:58:28:12:81:54', iface: 'mesh_radio2',
	  ips: [ '192.168.10.2' ], hostname: 'node2' },
	{ neighbor: '00:58:28:12:82:e4', iface: 'mesh_radio2',
	  ips: [ '192.168.10.3' ], hostname: 'node3' }
];

utils.annotateBackhaulState(stateRows, originators, utils.parsePeers(DUAL_PEERS));

lib.eq(stateRows.map(function(row) { return row.backhaulState; }),
	[ 'inuse', 'standby', 'inuse' ],
	'the selected link of a dual-link device is in use, its other link is a standby');

/*
 * The remote device knows which of its hardifs it forwards over.  Its
 * announcement wins over this device's originator table, which only says
 * which local link this device uses to reach the remote device.
 */
const ANNOUNCED_PEERS = [
	NOW + ' 00:58:28:12:81:50 192.168.10.2 node2 0.08 - inuse',
	NOW + ' 00:58:28:12:81:54 192.168.10.2 node2 0.08 - standby',
	NOW + ' 00:58:28:12:82:e4 192.168.10.3 node3 0.20 - standby'
].join('\n');

const announcedRows = stateRows.map(function(row) {
	return { neighbor: row.neighbor, iface: row.iface, ips: row.ips,
		hostname: row.hostname };
});

utils.annotateBackhaulState(announcedRows, originators,
	utils.parsePeers(ANNOUNCED_PEERS));

lib.eq(announcedRows.map(function(row) { return row.backhaulState; }),
	[ 'inuse', 'standby', 'standby' ],
	'the announced state of a remote hardif wins over local originator data');

const unknownState = { neighbor: 'de:ad:be:ef:00:09', iface: 'wlan0',
	ips: [], hostname: '' };

utils.annotateBackhaulState([ unknownState ], originators, []);

lib.eq(unknownState.backhaulState, '',
	'a neighbor without originator data has no state');

const directState = { neighbor: '00:58:28:12:82:e4', iface: 'mesh_radio2',
	ips: [], hostname: '' };

utils.annotateBackhaulState([ directState ], originators, []);

lib.eq(directState.backhaulState, 'inuse',
	'a neighbor that is its own selected originator is in use without an announcement');

const STATE_NEIGHBORS = [
	'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: lan2/00:58:28:22:67:f9 (bat0/86:10:45:55:ab:8c BATMAN_V)]',
	'         Neighbor   last-seen      speed           IF',
	'00:58:28:12:81:50    0.690s (   100000.0) [      lan2]',
	'00:58:28:12:81:54    0.010s (     1870.0) [mesh_radio2]',
	'00:58:28:12:82:e4    0.310s (     1889.0) [mesh_radio2]'
].join('\n');

const stateStatus = utils.parseStatus(
	{ code: 0, stdout: STATE_NEIGHBORS },
	DUAL_PEERS,
	null,
	{ code: 0, stdout: ORIGINATORS });

lib.eq(stateStatus.rows.map(function(row) { return row.backhaulState; }),
	[ 'inuse', 'standby', 'inuse' ],
	'parseStatus marks the backhaul state from the originator table');

const noOriginatorStatus = utils.parseStatus(
	{ code: 0, stdout: STATE_NEIGHBORS }, DUAL_PEERS);

lib.eq(noOriginatorStatus.rows.map(function(row) { return row.backhaulState; }),
	[ '', '', '' ],
	'parseStatus without an originator table leaves the backhaul state empty');

/*
 * The node that is two hops away cannot see the wired hardif of a remote
 * device in its neighbor table, even though the device announces that hardif.
 * The announced rows fill the gap, labelled with the medium the device
 * reported, and keep the wiring of a device together.
 */
const TWO_HOP_NEIGHBORS = [
	'[B.A.T.M.A.N. adv 2026.3-openwrt-1, MainIF/MAC: mesh_radio2/00:58:28:12:82:e4 (bat0/86:10:45:55:ab:8c BATMAN_V)]',
	'         Neighbor   last-seen      speed           IF',
	'02:58:28:22:67:fc    0.010s (     1889.0) [mesh_radio2]',
	'00:58:28:12:81:54    0.010s (     1870.0) [mesh_radio2]'
].join('\n');

const TWO_HOP_PEERS = [
	NOW + ' 00:58:28:22:67:f9 192.168.10.1 OpenWrt 0.10 - inuse wired 100000.0 lan2',
	NOW + ' 02:58:28:22:67:fc 192.168.10.1 OpenWrt 0.10 - inuse wlan 1200.0 mesh_radio2',
	NOW + ' 00:58:28:12:81:50 192.168.10.2 node2 0.08 - inuse wired 100000.0 wan',
	NOW + ' 00:58:28:12:81:54 192.168.10.2 node2 0.08 - standby wlan 1870.0 mesh_radio2',
	NOW + ' 00:58:28:12:82:e4 192.168.10.3 node3 0.20 - inuse wlan 1933.2 mesh_radio2'
].join('\n');

const TWO_HOP_LINK = [
	'local node3 192.168.10.3 0.20 off',
	'kind mesh_radio2 wlan 00:58:28:12:82:e4',
	'iface mesh_radio2 6255 61 320',
	'busy mesh_radio2 4',
	'peer mesh_radio2 00:58:28:12:81:54 -73'
].join('\n');

const twoHopStatus = utils.parseStatus(
	{ code: 0, stdout: TWO_HOP_NEIGHBORS },
	TWO_HOP_PEERS,
	{ code: 0, stdout: TWO_HOP_LINK });

lib.eq(twoHopStatus.rows.map(function(row) {
	return [ row.hostname, row.iface, row.backhaul, row.backhaulState, row.neighbor ];
}), [
	[ 'OpenWrt', 'lan2', 'wired', 'inuse', '00:58:28:22:67:f9' ],
	[ 'OpenWrt', 'mesh_radio2', 'wlan', 'inuse', '02:58:28:22:67:fc' ],
	[ 'node2', 'wan', 'wired', 'inuse', '00:58:28:12:81:50' ],
	[ 'node2', 'mesh_radio2', 'wlan', 'standby', '00:58:28:12:81:54' ]
], 'parseStatus lists every announced hardif of a remote device, wired first');

lib.eq(twoHopStatus.rows.map(function(row) { return row.ips[0]; }),
	[ '192.168.10.1', '192.168.10.1', '192.168.10.2', '192.168.10.2' ],
	'the announced rows carry the address of their device');
lib.eq(twoHopStatus.rows[0].signal, '',
	'the announced row of a hardif this device cannot hear has no signal');
lib.eq(twoHopStatus.rows[1].frequency, '6255 MHz',
	'the direct neighbor keeps the radio values of its interface');
lib.eq(twoHopStatus.rows.map(function(row) { return row.speed; }),
	[ '100000.0', '1889.0', '100000.0', '1870.0' ],
	'an announced hardif carries the rate its own device measures, ' +
	'while a direct neighbor keeps the locally measured rate');

const ivRow = { neighbor: '11:22:33:44:55:66', iface: '', speed: '' };
utils.mergeAnnouncedRows([ ivRow ],
	utils.parsePeers(NOW + ' 11:22:33:44:55:66 192.168.10.9 node4 0.10 - inuse wlan 777.0 wlan9'),
	{}, null);
lib.eq(ivRow.speed, '777.0',
	'an announcement fills the rate of a row the local table cannot measure');
lib.eq(ivRow.iface, 'wlan9',
	'an announcement fills the interface of a row the local table cannot name');

const localIfaceRow = { neighbor: '11:22:33:44:55:66', iface: 'mesh_radio2', speed: '' };
utils.mergeAnnouncedRows([ localIfaceRow ],
	utils.parsePeers(NOW + ' 11:22:33:44:55:66 192.168.10.9 node4 0.10 - inuse wlan 777.0 wlan9'),
	{}, null);
lib.eq(localIfaceRow.iface, 'mesh_radio2',
	'a direct neighbor keeps the interface "batctl n" reports for the local link');

const noIdentityStatus = utils.parseStatus(
	{ code: 0, stdout: TWO_HOP_NEIGHBORS }, TWO_HOP_PEERS);

lib.eq(noIdentityStatus.rows.map(function(row) { return row.neighbor; }),
	[ '02:58:28:22:67:fc', '00:58:28:12:81:54' ],
	'without a local identity no announced row is added');

/*
 * Every router ships with the same hostname and a LAN without DHCP leaves the
 * announcements without an address, so neither field identifies a device.
 * The announced LAN bridge MAC is unique per device and shared by all of its
 * hardifs, so it keeps the two devices apart.
 */
lib.eq(utils.deviceKey({ lanMac: 'AA:00:00:00:00:91', ips: [ '192.168.10.9' ],
	hostname: 'OpenWrt' }), 'aa:00:00:00:00:91',
	'the LAN bridge MAC is the device key');
lib.eq(utils.deviceKey({ lanMac: 'bogus', ip: '192.168.10.9' }), '192.168.10.9',
	'an unusable LAN bridge MAC falls back to the address');
lib.eq(utils.deviceKey({ ips: [ '192.168.10.8' ], hostname: 'node' }), '192.168.10.8',
	'a row without a LAN bridge MAC falls back to its address');
lib.eq(utils.deviceKey({ hostname: 'node', neighbor: 'de:ad:be:ef:00:09' }), 'node',
	'a row without an address falls back to its hostname');
lib.eq(utils.deviceKey({ neighbor: 'de:ad:be:ef:00:09' }), 'de:ad:be:ef:00:09',
	'a row without any announcement falls back to its neighbor');
lib.eq(utils.deviceKey(null), '', 'a missing entry has no device key');

const TWIN_PEERS = [
	NOW + ' aa:00:00:00:00:01 - OpenWrt 0.10 aa:00:00:00:00:91 inuse wired',
	NOW + ' aa:00:00:00:00:02 - OpenWrt 0.10 aa:00:00:00:00:91 standby wlan',
	NOW + ' bb:00:00:00:00:01 - OpenWrt 0.10 bb:00:00:00:00:91 inuse wired',
	NOW + ' bb:00:00:00:00:02 - OpenWrt 0.10 bb:00:00:00:00:91 standby wlan'
].join('\n');

const twinStatus = utils.parseStatus({ code: 0, stdout: '' }, TWIN_PEERS,
	{ code: 0, stdout: TWO_HOP_LINK });

lib.eq(twinStatus.rows.map(function(row) { return row.neighbor; }), [
	'aa:00:00:00:00:01', 'aa:00:00:00:00:02',
	'bb:00:00:00:00:01', 'bb:00:00:00:00:02'
], 'devices with the same hostname and no address stay apart');
lib.eq(twinStatus.rows.map(function(row) { return row.backhaul; }),
	[ 'wired', 'wlan', 'wired', 'wlan' ],
	'each device keeps its wired row before its wireless row');
lib.eq(new Set(twinStatus.rows.map(function(row) {
	return utils.deviceKey(row);
})).size, 2, 'the two devices count once each');
lib.eq(twinStatus.rows[0].hostname, 'OpenWrt',
	'the shared hostname is still shown on every row');

const mixedPeers = TWIN_PEERS + '\n' +
	NOW + ' cc:00:00:00:00:01 - OpenWrt 0.10';

const mixedStatus = utils.parseStatus({ code: 0, stdout: '' }, mixedPeers,
	{ code: 0, stdout: TWO_HOP_LINK });

lib.eq(mixedStatus.rows.length, 5,
	'an announcement without a LAN MAC falls back to its hostname');
lib.eq(new Set(mixedStatus.rows.map(function(row) {
	return utils.deviceKey(row);
})).size, 3, 'the fallback device is counted on its own');

const LOCAL = [
	'local OpenWrt 192.168.10.111 0.15',
	'kind eth0 wired',
	'iface eth0 2437',
	'busy eth0 6',
	'peer eth0 aa:bb:cc:dd:ee:ff -24'
].join('\n');

lib.eq(utils.parseLocalInfo({ code: 0, stdout: LOCAL }),
	{ hostname: 'OpenWrt', ip: '192.168.10.111', load: '0.15', role: '' },
	'parses the local identity line');
lib.eq(utils.parseLocalInfo({ code: 0, stdout: 'local node2 - -' }),
	{ hostname: 'node2', ip: '', load: '', role: '' },
	'the local identity accepts a missing address and load');
lib.eq(utils.parseLocalInfo({ code: 0, stdout: 'local node2 - - server' }).role,
	'server', 'the local identity carries the effective role');
lib.eq(utils.parseLocalInfo({ code: 0, stdout: 'local node2 - - off' }).role,
	'off', 'the node role is reported');
lib.eq(utils.parseLocalInfo({ code: 0, stdout: 'local node2 - - client' }).role,
	'client', 'the client role is reported');
lib.eq(utils.parseLocalInfo({ code: 0, stdout: 'local node2 - - bogus' }).role,
	'', 'an unknown role is dropped');
lib.eq(utils.parseLocalInfo({ code: 1, stdout: LOCAL }), null,
	'a failed link info query has no local identity');
lib.eq(utils.parseLocalInfo(null), null, 'missing link info has no local identity');

lib.eq(utils.parseLocalIdentity(FIXTURE), {
	iface: 'eth0',
	neighbor: 'aa:bb:cc:dd:ee:ff'
}, 'parses the primary hardif and MAC from the batctl header');
lib.eq(utils.parseLocalIdentity(''), null, 'missing header has no identity');

lib.eq(utils.parseLocalRows(FIXTURE, { code: 0, stdout: LOCAL }), [ {
	hostname: 'OpenWrt',
	neighbor: 'aa:bb:cc:dd:ee:ff',
	ips: [ '192.168.10.111' ],
	iface: 'eth0',
	backhaul: 'wired',
	frequency: '2437 MHz',
	channel: '',
	width: '',
	signal: '-24 dBm',
	load: '0.15',
	utilization: '6%',
	speed: '',
	lastSeen: '',
	backhaulState: ''
} ], 'the local row combines the identity and the hardif link data');

const LINK_ROWS = [
	{ iface: 'eth0', signal: '-70 dBm', speed: '100.0', lastSeen: '0.400s' },
	{ iface: 'eth0', signal: '-42 dBm', speed: '650.0', lastSeen: '0.200s' },
	{ iface: 'wlan0', signal: '-80 dBm', speed: '50.0', lastSeen: '0.900s' }
];

lib.eq(utils.strongestLink(LINK_ROWS.slice(0, 2)), LINK_ROWS[1],
	'the strongest signal selects the neighbor link');
lib.eq(utils.strongestLink([]), null, 'no neighbors leave no link to mirror');
lib.eq(utils.strongestLink([ { speed: '10.0', lastSeen: '1.000s' } ]).speed, '10.0',
	'a wired link without a signal still supplies its values');

const localWithLink = utils.parseLocalRows(FIXTURE, { code: 0, stdout: LOCAL }, LINK_ROWS);

lib.eq(localWithLink.length, 1, 'one hardif yields one local row');
lib.eq(localWithLink[0].signal, '-42 dBm',
	'the local row mirrors the strongest signal of its own hardif');
lib.eq(localWithLink[0].speed, '650.0',
	'the local row mirrors the strongest link rate of its own hardif');
lib.eq(localWithLink[0].lastSeen, '0.200s',
	'the local row mirrors the strongest last-seen time of its own hardif');

const LOCAL_DUAL = [
	'local OpenWrt 192.168.10.1 0.10 server',
	'kind lan2 wired 00:58:28:22:67:f9',
	'kind mesh_radio2 wlan 02:58:28:22:67:fc',
	'iface mesh_radio2 6255 61 320',
	'busy mesh_radio2 4',
	'peer mesh_radio2 00:58:28:12:81:54 -73'
].join('\n');

const dualLocalRows = utils.parseLocalRows(FIXTURE, { code: 0, stdout: LOCAL_DUAL },
	utils.parseNeighbors(STATE_NEIGHBORS), originators);

lib.eq(dualLocalRows.map(function(row) {
	return [ row.iface, row.backhaul, row.neighbor, row.ips[0], row.backhaulState ];
}), [
	[ 'lan2', 'wired', '00:58:28:22:67:f9', '192.168.10.1', 'inuse' ],
	[ 'mesh_radio2', 'wlan', '02:58:28:22:67:fc', '192.168.10.1', 'inuse' ]
], 'a server marks every hardif batman uses for an originator in use');
lib.eq(dualLocalRows[1].frequency, '6255 MHz',
	'the radio values stay on the wireless hardif row');
lib.eq(dualLocalRows[1].signal, '-73 dBm',
	'the wireless row falls back to its own station signal');
lib.eq(utils.parseLocalRows(FIXTURE, { code: 0, stdout: LOCAL_DUAL },
	utils.parseNeighbors(STATE_NEIGHBORS), {}).map(function(row) {
	return row.backhaulState;
}), [ '', '' ], 'without a selected originator the local state is unknown');

const WIRED_ONLY = [
	' * 00:58:28:12:81:54    0.070s (   100000.0) 00:58:28:12:81:50 [      lan2]'
].join('\n');

lib.eq(utils.parseLocalRows(FIXTURE, { code: 0, stdout: LOCAL_DUAL }, [],
	utils.parseOriginators(WIRED_ONLY)).map(function(row) {
	return row.backhaulState;
}), [ 'inuse', 'standby' ],
	'a node marks the hardif it forwards over in use and the other one standby');

const fallbackLocal = utils.parseLocalRows(FIXTURE,
	{ code: 0, stdout: 'local OpenWrt 192.168.10.111 0.15' }, []);

lib.eq(fallbackLocal.length, 1, 'a link info without hardif lines keeps one row');
lib.eq([ fallbackLocal[0].iface, fallbackLocal[0].neighbor, fallbackLocal[0].backhaul ],
	[ 'eth0', 'aa:bb:cc:dd:ee:ff', '' ],
	'the fallback row uses the primary hardif and its MAC');
lib.eq(utils.parseLocalRows(FIXTURE, null, []), [],
	'a missing link info query yields no local rows');

const LOCAL_STATUS_LINK = [
	'local OpenWrt 192.168.10.111 0.15 server',
	'kind wlan0 wlan aa:bb:cc:dd:ee:ff',
	'iface wlan0 2437 1 20',
	'busy wlan0 6',
	'peer wlan0 aa:bb:cc:dd:ee:ff -24'
].join('\n');

const withLocal = utils.parseStatus(
	{ code: 0, stdout: FIXTURE },
	'',
	{ code: 0, stdout: LOCAL_STATUS_LINK });

lib.eq(withLocal.local.length, 1, 'parseStatus exposes the local rows');
lib.eq(withLocal.role, 'server', 'parseStatus exposes the effective role');
lib.eq(withLocal.local[0].hostname, 'OpenWrt', 'the local row has the hostname');
lib.eq(withLocal.local[0].channel, '1', 'the local row has the hardif channel');
lib.eq(withLocal.local[0].width, '20 MHz', 'the local row has the hardif channel width');
lib.eq(withLocal.local[0].utilization, '6%', 'the local row has the hardif channel utilization');
lib.eq(withLocal.local[0].signal, '-24 dBm',
	'the local row mirrors the neighbor signal from its own hardif');
lib.eq(withLocal.local[0].speed, '450.0',
	'the local row mirrors the neighbor link rate from its own hardif');
lib.eq(withLocal.local[0].lastSeen, '2.345s',
	'the local row mirrors the neighbor last-seen time from its own hardif');
lib.eq(withLinks.local, [], 'parseStatus has no local rows without a link info query');

lib.eq(utils.prefixToNetmask(24), '255.255.255.0', 'prefix 24 becomes a dotted netmask');
lib.eq(utils.prefixToNetmask(16), '255.255.0.0', 'prefix 16 becomes a dotted netmask');
lib.eq(utils.prefixToNetmask(25), '255.255.255.128', 'non-octet prefix is converted');
lib.eq(utils.prefixToNetmask(0), '0.0.0.0', 'prefix 0 is accepted');
lib.eq(utils.prefixToNetmask(32), '255.255.255.255', 'prefix 32 is accepted');
lib.eq(utils.prefixToNetmask('24'), '255.255.255.0', 'numeric strings are accepted');
lib.eq(utils.prefixToNetmask(33), '', 'prefix above 32 is rejected');
lib.eq(utils.prefixToNetmask(24.5), '', 'fractional prefix is rejected');
lib.eq(utils.prefixToNetmask('x'), '', 'non-numeric prefix is rejected');
lib.eq(utils.prefixToNetmask(null), '', 'missing prefix is rejected');

lib.eq(utils.netmask('255.255.255.0'), '255.255.255.0', 'a /24 netmask is accepted');
lib.eq(utils.netmask('255.255.255.255'), '255.255.255.255', 'a /32 netmask is accepted');
lib.eq(utils.netmask(' 255.255.0.0 '), '255.255.0.0', 'surrounding spaces are ignored');
lib.eq(utils.netmask('255.0.255.0'), '', 'a non-contiguous netmask is rejected');
lib.eq(utils.netmask('255.255.255.1'), '', 'a netmask with a host bit is rejected');
lib.eq(utils.netmask('0.0.0.0'), '', 'a /0 netmask is rejected');
lib.eq(utils.netmask('255.255.255'), '', 'a short netmask is rejected');
lib.eq(utils.netmask('256.0.0.0'), '', 'an octet above 255 is rejected');
lib.eq(utils.netmask('255.255.255.010'), '', 'a leading zero is rejected');
lib.eq(utils.netmask(''), '', 'an empty netmask is rejected');
lib.eq(utils.netmask(null), '', 'a missing netmask is rejected');

lib.eq(utils.lanDefaults({
	proto: 'dhcp',
	'ipv4-address': [ { address: '192.168.10.123', mask: 24 } ],
	route: [
		{ target: '2000::', mask: 0, nexthop: 'fe80::1' },
		{ target: '0.0.0.0', mask: 0, nexthop: '192.168.10.111' }
	],
	'dns-server': [ '192.168.10.111', '1.1.1.1' ]
}), {
	ipaddr: '192.168.10.123',
	netmask: '255.255.255.0',
	gateway: '192.168.10.111',
	dns: '192.168.10.111'
}, 'live LAN status supplies the static defaults');

lib.eq(utils.lanDefaults({
	'ipv4-address': [ { address: '10.0.0.7', mask: 16 } ],
	route: [],
	'dns-server': []
}, {}), {
	ipaddr: '10.0.0.7',
	netmask: '255.255.0.0',
	gateway: '',
	dns: ''
}, 'missing gateway and DNS stay empty instead of a guessed address');

lib.eq(utils.lanDefaults({}, {
	ipaddr: '192.168.10.100/24',
	gateway: '192.168.10.1',
	dns: '192.168.10.1 8.8.8.8'
}), {
	ipaddr: '192.168.10.100',
	netmask: '255.255.255.0',
	gateway: '192.168.10.1',
	dns: '192.168.10.1'
}, 'UCI values are the fallback and a CIDR address supplies the prefix');

lib.eq(utils.lanDefaults(null, {
	ipaddr: '192.168.10.100',
	netmask: '255.255.255.0'
}), {
	ipaddr: '192.168.10.100',
	netmask: '255.255.255.0',
	gateway: '',
	dns: ''
}, 'DNS falls back to the gateway only when a gateway exists');

lib.eq(utils.lanDefaults(null, null), {
	ipaddr: '',
	netmask: '',
	gateway: '',
	dns: ''
}, 'without any LAN data all defaults are empty');

lib.eq(utils.lanLeaseAddress({
	'ipv4-address': [ { address: '192.168.10.123', mask: 24 } ]
}), '192.168.10.123', 'a DHCP lease supplies the LAN address');

lib.eq(utils.lanLeaseAddress({ up: false, 'ipv4-address': [] }), '',
	'an interface without an address has no lease');

lib.eq(utils.lanLeaseAddress({ 'ipv4-address': [ { address: 'nonsense' } ] }), '',
	'an unparsable address is not a lease');

lib.eq(utils.lanLeaseAddress(null), null,
	'an unreadable LAN status is unknown, not a missing lease');

const CLIENTS = [
	'client aa:bb:cc:dd:ee:01 phy0.0-ap0 iphone 192.168.10.20 -61',
	'client aa:bb:cc:dd:ee:02 lan2 printer - -',
	'client aa:bb:cc:dd:ee:03 phy0.1-ap0 - 192.168.10.30 -70',
	'garbage line',
	'client not-a-mac phy0.0-ap0 x - -'
].join('\n');

const clientList = utils.parseClients({ code: 0, stdout: CLIENTS });

lib.ok(clientList.ok, 'a successful client read is marked ok');
lib.eq(clientList.clients.map(function(c) { return c.mac; }),
	[ 'aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:03' ],
	'clients sort by interface, then unnamed-hostname order and MAC');
lib.eq(clientList.clients[1], {
	mac: 'aa:bb:cc:dd:ee:01',
	iface: 'phy0.0-ap0',
	hostname: 'iphone',
	ip: '192.168.10.20',
	signal: -61
}, 'a named wireless client keeps every field');
lib.eq(clientList.clients[0].signal, null, 'a wired client has no signal');
lib.eq(clientList.clients[0].ip, '', 'a missing IPv4 address stays empty');
lib.eq(clientList.clients[2].hostname, '', 'a "-" hostname stays empty');

lib.eq(utils.parseClients({ code: 0, stdout: [
	'client aa:bb:cc:dd:ee:05 phy0.0-ap0 phone 192.168.10.50 -80',
	'client aa:bb:cc:dd:ee:05 phy0.1-ap0 phone 192.168.10.50 -55'
].join('\n') }).clients, [{
	mac: 'aa:bb:cc:dd:ee:05',
	iface: 'phy0.1-ap0',
	hostname: 'phone',
	ip: '192.168.10.50',
	signal: -55
}], 'an MLO device is kept once with the strongest link');

lib.eq(utils.parseClients({ code: 1, stdout: CLIENTS }),
	{ ok: false, clients: [] }, 'a failed read yields an error result');
lib.eq(utils.parseClients(null), { ok: false, clients: [] },
	'a missing reply yields an error result');

/* Hostapd's get_status counters, one line per BSS. */
const ROAMING = [
	'bss phy0.0-ap0 2462 40 26 3',
	'bss phy0.1-ap0 5180 - - -',
	'garbage'
].join('\n');

lib.eq(utils.parseRoaming({ code: 0, stdout: ROAMING }), [
	{ iface: 'phy0.0-ap0', freq: 2462, nr: 40, btmTx: 26, btmRx: 3 },
	{ iface: 'phy0.1-ap0', freq: 5180, nr: null, btmTx: null, btmRx: null }
], 'roaming counters are parsed and missing values stay empty');
lib.eq(utils.parseRoaming({ code: 1, stdout: ROAMING }), [],
	'a failed roaming read yields no rows');
lib.eq(utils.parseRoaming(null), [], 'a missing roaming reply yields no rows');

/* A channel plan must be the same on every node: the nodes are sorted by
 * name and each takes its position, so no coordination is needed. */
const PLAN_RADIOS = [
	{ band: '2g', width: 40 },
	{ band: '5g', width: 80 },
	{ band: '6g', width: 320 }
];
const NODES = [ 'node3', 'OpenWrt', 'node2' ];

const plan = utils.channelPlan(NODES, 'node2', PLAN_RADIOS);

lib.eq(plan.map(function(p) {
	return [ p.band, p.width, p.channel ];
}), [ [ '2g', 20, '6' ], [ '5g', 80, '100' ] ],
	'the middle node gets the middle channel of each band');
lib.eq(plan.map(function(p) { return p.index; }), [ 1, 1 ],
	'the node position comes from the sorted names');
lib.eq(plan[0].count, 3, 'the plan counts all nodes');

lib.eq(utils.channelPlan(NODES, 'OpenWrt', PLAN_RADIOS).map(function(p) {
	return p.channel;
}), [ '1', '36' ], 'the first node gets the first channel');
lib.eq(utils.channelPlan(NODES, 'node3', PLAN_RADIOS).map(function(p) {
	return p.channel;
}), [ '11', '149' ], 'the last node gets the last channel');

lib.eq(utils.channelPlan([ 'b', 'a' ], 'b', [ { band: '2g', width: 40 } ])[0],
	{ band: '2g', width: 40, channel: '11', count: 2, index: 1 },
	'40 MHz stays on 2.4 GHz while the non-overlapping slots suffice');

lib.eq(utils.channelPlan([ 'b', 'a' ], 'b', [ { band: '5g', width: 160 } ])[0].width,
	160, '160 MHz stays when two nodes fit');
lib.eq(utils.channelPlan([ 'c', 'b', 'a' ], 'a', [ { band: '5g', width: 160 } ])[0],
	{ band: '5g', width: 80, channel: '36', count: 3, index: 0 },
	'a third node narrows 160 MHz to 80 MHz');

lib.eq(utils.channelPlan(NODES, 'node2', [
	{ band: '2g', width: 20, mesh: true },
	{ band: '5g', width: 20 }
]).map(function(p) { return p.band; }), [ '5g' ],
	'a radio carrying the mesh backhaul is left alone');

lib.eq(utils.channelPlan([], 'solo', [ { band: '5g', width: 80 } ])[0],
	{ band: '5g', width: 80, channel: '36', count: 1, index: 0 },
	'a lone node plans the first channel of its band');

lib.summary('utils');
