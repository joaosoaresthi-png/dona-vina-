import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const clientPath = path.join(path.dirname(require.resolve('whatsapp-web.js')), 'src', 'Client.js');
let source = fs.readFileSync(clientPath, 'utf8');
let changed = false;

const debugWaitStart = source.indexOf(".waitForFunction('window.Debug?.VERSION != undefined'");
if (debugWaitStart < 0) throw new Error('whatsapp-web.js Debug.VERSION wait not found; review the dependency before deploying.');
let debugWaitEnd = source.indexOf('.catch((err) => {', debugWaitStart);
if (debugWaitEnd < 0) throw new Error('whatsapp-web.js Debug.VERSION wait shape changed; review before deploying.');
let debugWait = source.slice(debugWaitStart, debugWaitEnd);
if (!debugWait.includes('polling: 200')) {
  if (!debugWait.includes('signal: abort.signal,')) throw new Error('Could not locate the Debug.VERSION wait options.');
  debugWait = debugWait.replace('signal: abort.signal,', 'signal: abort.signal,\n                    polling: 200,');
  source = source.slice(0, debugWaitStart) + debugWait + source.slice(debugWaitEnd);
  changed = true;
}

const socketWaitStart = source.indexOf('const needAuthHandle = await this.pupPage.waitForFunction(');
if (socketWaitStart < 0) throw new Error('whatsapp-web.js socket-state wait not found; review the dependency before deploying.');
const socketOptionsStart = source.indexOf('{ timeout: authTimeout', socketWaitStart);
if (socketOptionsStart < 0) throw new Error('Could not locate the socket-state wait options.');
const socketOptionsEnd = source.indexOf('}', socketOptionsStart);
if (socketOptionsEnd < 0) throw new Error('Socket-state wait options are incomplete.');
const socketOptions = source.slice(socketOptionsStart, socketOptionsEnd + 1);
if (!socketOptions.includes('polling: 200')) {
  if (socketOptions !== '{ timeout: authTimeout }') throw new Error('Socket-state wait options changed; review before deploying.');
  source = source.slice(0, socketOptionsStart) + '{ timeout: authTimeout, polling: 200 }' + source.slice(socketOptionsEnd + 1);
  changed = true;
}

const patchedDebugStart = source.indexOf(".waitForFunction('window.Debug?.VERSION != undefined'");
const patchedDebugEnd = source.indexOf('.catch((err) => {', patchedDebugStart);
const patchedSocketStart = source.indexOf('const needAuthHandle = await this.pupPage.waitForFunction(');
const patchedSocketEnd = source.indexOf('}', source.indexOf('{ timeout: authTimeout', patchedSocketStart));
if (!source.slice(patchedDebugStart, patchedDebugEnd).includes('polling: 200') ||
    !source.slice(source.indexOf('{ timeout: authTimeout', patchedSocketStart), patchedSocketEnd).includes('polling: 200')) {
  throw new Error('Both whatsapp-web.js auth readiness waits must use interval polling.');
}

if (changed) fs.writeFileSync(clientPath, source);
