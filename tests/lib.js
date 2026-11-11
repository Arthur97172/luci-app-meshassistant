'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.MESHASSISTANT_ROOT
	? path.resolve(process.env.MESHASSISTANT_ROOT)
	: path.resolve(__dirname, '..');

let checks = 0;
let failures = 0;

function ok(cond, label, detail) {
	checks++;

	if (!cond) {
		failures++;
		console.log('FAIL  ' + label);
		if (detail)
			console.log('      ' + String(detail).replace(/\n/g, '\n      '));
	}
}

function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);

	ok(a === e, label, a === e ? null : 'got:  ' + a + '\nwant: ' + e);
}

function summary(name) {
	const c = checks;
	const f = failures;

	console.log((f ? 'FAILED' : 'ok') + '  ' + name +
		' (' + c + ' checks, ' + f + ' failures)');

	checks = 0;
	failures = 0;

	if (f)
		process.exitCode = 1;

	return f === 0;
}

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function installFormat() {
	if (String.prototype.format)
		return;

	String.prototype.format = function() {
		const args = Array.prototype.slice.call(arguments);

		return String(this).replace(/%[sd]/g, function() {
			const v = args.shift();
			return (v == null) ? '' : String(v);
		});
	};
}

function loadUtils() {
	installFormat();

	const file = process.env.MESHASSISTANT_UTILS_JS ||
		path.join(ROOT, 'htdocs/luci-static/resources/meshassistant/utils.js');
	const src = fs.readFileSync(file, 'utf8');
	const baseclass = {
		extend(props) {
			function C() {}
			Object.assign(C.prototype, props);
			return C;
		}
	};

	const C = new Function('baseclass', src)(baseclass);

	return new C();
}

module.exports = {
	ROOT, ok, eq, summary, read, installFormat, loadUtils
};
