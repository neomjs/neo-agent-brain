import Neo from 'neo.mjs/src/Neo.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';
import ConnectionService from '../../../services/neural-link/ConnectionService.mjs';

console.log('ConnectionService imported');
console.log('Is instance?', ConnectionService instanceof Neo.core.Base);

try {
    // construct auto-fires initAsync; ready() resolves once the singleton finished initializing
    await ConnectionService.ready();
    console.log('ConnectionService initialized');

    try {
        await ConnectionService.getComponentTree({});
    } catch (e) {
        console.log('Expected error (no session):', e.message);
    }
} catch (e) {
    console.error('Initialization failed', e);
}

process.exit(0);
