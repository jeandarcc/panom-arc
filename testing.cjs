'use strict';

const { applyArcAnchors } = require('./shared.cjs');

async function load() {
  return import('./testing.mjs');
}

module.exports = {
  applyArcAnchors,
  runArcCameraRoundTrip: (...args) => load().then((m) => m.runArcCameraRoundTrip(...args)),
  runArcClientBackendSimulation: (...args) => load().then((m) => m.runArcClientBackendSimulation(...args)),
  runArcAdversarialCameraSimulation: (...args) => load().then((m) => m.runArcAdversarialCameraSimulation(...args)),
  runArcDifficultySweep: (...args) => load().then((m) => m.runArcDifficultySweep(...args)),
  runArcRealisticAuthLoop: (...args) => load().then((m) => m.runArcRealisticAuthLoop(...args)),
  runArcNetworkProfileSweep: (...args) => load().then((m) => m.runArcNetworkProfileSweep(...args)),
  runArcStartupSelfTests: (...args) => load().then((m) => m.runArcStartupSelfTests(...args)),
};
