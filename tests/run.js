'use strict';

const path = require('path');

const suites = [
	'utils.test.js',
	'view.test.js',
	'package.test.js',
	'i18n.test.js',
	'mutation.test.js',
	'script.test.js'
];

for (const suite of suites)
	require(path.join(__dirname, suite));
