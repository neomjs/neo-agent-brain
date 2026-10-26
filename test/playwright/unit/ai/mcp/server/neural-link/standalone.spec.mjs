import {test, expect} from '@playwright/test';
import path           from 'path';
import {launch, standalonePlacement} from '../../../../../../../ai/mcp/server/neural-link/standalone.mjs';

/**
 * The standalone launcher declares the plane's placement and the Bridge's `--cwd`; nothing else.
 * Both are checked through an injected spawn, so no process starts.
 */
test.describe('ai/mcp/server/neural-link/standalone', () => {
    test('the placement puts the plane and its one member beneath one per-user root', () => {
        expect(standalonePlacement({homedir: '/home/dev'})).toEqual({
            NEO_NL_LOG_PATH    : path.join('/home/dev', '.neo-ai', 'neural-link', 'logs'),
            NEO_PLANE_DATA_ROOT: path.join('/home/dev', '.neo-ai', 'neural-link')
        });
    });

    test('launch starts the packaged server with the package root as --cwd and the placement env', () => {
        const calls = [];

        launch({
            argv   : ['--debug'],
            env    : {NEO_NL_PORT: '18181', NEO_PLANE_DATA_ROOT: '/somewhere/else/.neo-ai-data', PATH: '/usr/bin'},
            homedir: '/home/dev',
            root   : '/pkg',
            spawnFn: (command, args, options) => {calls.push({args, command, options}); return {}}
        });

        expect(calls).toHaveLength(1);

        const [{args, command, options}] = calls;

        expect(command).toBe(process.execPath);
        expect(args).toEqual([path.join('/pkg', 'ai/mcp/server/neural-link/mcp-server.mjs'), '--cwd', '/pkg', '--debug']);
        expect(options.stdio).toBe('inherit');

        // The standalone plane is its own: another deployment's exported root cannot redirect it.
        expect(options.env.NEO_PLANE_DATA_ROOT).toBe(path.join('/home/dev', '.neo-ai', 'neural-link'));
        expect(options.env.NEO_NL_LOG_PATH).toBe(path.join('/home/dev', '.neo-ai', 'neural-link', 'logs'));
        // Everything else passes through, the Bridge port included.
        expect(options.env.NEO_NL_PORT).toBe('18181');
        expect(options.env.PATH).toBe('/usr/bin');
    });
});
