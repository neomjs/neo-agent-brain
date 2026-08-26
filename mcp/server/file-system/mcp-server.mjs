import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';
import Server          from './Server.mjs';

try {
    await Neo.create(Server).ready();
} catch (error) {
    console.error('Fatal error during file-system server initialization:', error);
    process.exit(1);
}
