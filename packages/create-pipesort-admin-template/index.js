#!/usr/bin/env node

/**
 * Copyright (c) 2019, Pipesort, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

var currentNodeVersion = process.versions.node;
var semver = currentNodeVersion.split('.');
var major = semver[0];

if (major < 8) {
  console.error(
    'You are running Node ' +
      currentNodeVersion +
      '.\n' +
      'Create-Pipesort-Admin-Template requires Node 8 or higher. \n' +
      'Please update your version of Node.'
  );
  process.exit(1);
}

require('./createAdminTemplate');
