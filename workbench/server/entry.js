'use strict';
/**
 * entry.js - the process entry point.
 *
 * Kept separate from server/index.js so that requiring the server module (in tests, or from
 * another tool) never has the side effect of binding a port.
 */

require('./index.js').start();
