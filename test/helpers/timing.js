'use strict';

// Wall-clock limits are tuned for a developer machine; shared CI runners are slower and noisier.
const SCALE = process.env.CI ? 5 : 1;

module.exports = { budget: ms => ms * SCALE };
