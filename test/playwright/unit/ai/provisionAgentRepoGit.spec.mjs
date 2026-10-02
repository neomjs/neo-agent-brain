import {test, expect}    from '@playwright/test';
import {execFile}        from 'child_process';
import fs                from 'fs';
import http              from 'http';
import os                from 'os';
import path              from 'path';
import {gitCloneCommand} from '../../../../ai/services/fleet/provisionAgentRepo.mjs';

// A seat's clone on a host whose Git setup is hostile, with a real `git` binary and no network: the poisoned
// HOME rewrites github.com to a local server, adds an ambient Authorization header, and names an askpass and a
// credential helper; GIT_ASKPASS is set too. A local proxy records every request and refuses all of them, so a
// clone that stays on github.com fails at the proxy, and a clone the ambient config redirected shows up as a
// request carrying the ambient header.

const AMBIENT = Buffer.from('ambient:AMBIENT_SECRET').toString('base64');

let rootDir, askpassPath, askpassMarker, server, port, requests;

test.beforeAll(async () => {
    rootDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-clone-isolation-'));
    askpassPath   = path.join(rootDir, 'askpass.sh');
    askpassMarker = path.join(rootDir, 'askpass-ran');
    requests      = [];

    fs.writeFileSync(askpassPath, `#!/bin/sh\ntouch '${askpassMarker}'\necho AMBIENT_SECRET\n`, {mode: 0o755});

    server = http.createServer((req, res) => {
        requests.push({method: req.method, url: req.url, authorization: req.headers.authorization ?? null});
        res.writeHead(401, {'WWW-Authenticate': 'Basic realm="poison"'});
        res.end()
    });
    server.on('connect', (req, socket) => {
        requests.push({method: 'CONNECT', url: req.url, authorization: null});
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;

    fs.writeFileSync(path.join(rootDir, '.gitconfig'), [
        `[url "http://127.0.0.1:${port}/"]`,
        '    insteadOf = https://github.com/',
        '[http]',
        `    extraHeader = Authorization: Basic ${AMBIENT}`,
        '[core]',
        `    askPass = ${askpassPath}`,
        '[credential]',
        '    helper = "!f() { echo username=ambient; echo password=AMBIENT_SECRET; }; f"',
        ''
    ].join('\n'))
});

test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(rootDir, {recursive: true, force: true})
});

/**
 * @summary Run one `git` invocation to completion under an environment, never throwing.
 * @param {String[]} args
 * @param {Object} env
 * @returns {Promise<Number>} The exit code
 */
const run = (args, env) => new Promise(resolve => {
    execFile('git', args, {cwd: rootDir, env, timeout: 20000}, error => resolve(error ? (error.code ?? 1) : 0))
});

test.describe('gitCloneCommand — a seat clone ignores the host\'s Git configuration', () => {
    test('an ambient rewrite, header, helper or askpass neither redirects nor authenticates the seat\'s clone', async () => {
        const
            proxy   = `http://127.0.0.1:${port}`,
            ambient = {
                ...process.env,
                HOME           : rootDir,
                XDG_CONFIG_HOME: path.join(rootDir, '.config'),
                GIT_ASKPASS    : askpassPath,
                SSH_ASKPASS    : askpassPath,
                HTTPS_PROXY    : proxy,
                https_proxy    : proxy,
                HTTP_PROXY     : proxy,
                http_proxy     : proxy,
                NO_PROXY       : '',
                no_proxy       : ''
            },
            {args, env} = gitCloneCommand('https://github.com/neomjs/private-fixture.git', path.join(rootDir, 'checkout'), 'ghp_bogus_seat_token', ambient);

        expect(await run(args, env), 'the refusing proxy fails the clone').not.toBe(0);
        expect(requests.map(({method, url}) => `${method} ${url}`), 'the clone stayed on github.com: one CONNECT, no rewritten request')
            .toEqual(['CONNECT github.com:443']);
        expect(requests.some(({authorization}) => authorization?.includes(AMBIENT)), 'no ambient header was sent').toBe(false);
        expect(fs.existsSync(askpassMarker), 'no askpass ran').toBe(false)
    });

    test('a host ~/.netrc entry authenticates the host\'s git, never the seat\'s environment', async () => {
        // curl retries a 401 with the netrc entry before git's own credential flow runs. The seat clone's TLS
        // hides its headers from the proxy, so netrc is witnessed over plain http against the local server:
        // the same request under a host environment whose HOME holds only a .netrc, and under the seat clone's.
        const
            netrcHome = fs.mkdtempSync(path.join(rootDir, 'netrc-home-')),
            netrc     = Buffer.from('ambient:NETRC_SECRET').toString('base64'),
            target    = `http://127.0.0.1:${port}/neomjs/private-fixture.git`,
            host      = {...process.env, HOME: netrcHome, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_PROXY: '*', no_proxy: '*'},
            {env}     = gitCloneCommand('https://github.com/neomjs/private-fixture.git', path.join(rootDir, 'checkout-2'), 'ghp_bogus_seat_token', host),
            probe     = async environment => {
                requests.length = 0;
                await run(['ls-remote', '--', target], environment);
                return requests.some(({authorization}) => authorization?.includes(netrc))
            };

        fs.writeFileSync(path.join(netrcHome, '.netrc'), 'machine 127.0.0.1 login ambient password NETRC_SECRET\n', {mode: 0o600});

        expect(await probe(host), 'the control: the host\'s git sends its netrc entry').toBe(true);
        expect(await probe(env), 'the seat clone\'s environment reads no netrc').toBe(false)
    });

    test('real git hands the seat\'s token only to the origin its helper key names, an IPv6 literal on its port included', async () => {
        // `git credential fill` under the clone's own `-c` pairs and environment: the password git produces, or null
        const fill = (origin, host) => new Promise(resolve => {
            const
                {args, env} = gitCloneCommand(`${origin}/group/project.git`, path.join(rootDir, 'unused'), 'glpat_fixture', process.env, origin),
                child       = execFile('git', [...args.slice(0, args.indexOf('clone')), 'credential', 'fill'], {cwd: rootDir, env, timeout: 20000},
                    (error, stdout) => resolve(error ? null : (/^password=(.*)$/m.exec(stdout)?.[1] ?? null)));

            child.stdin.end(`protocol=https\nhost=${host}\n\n`)
        });

        expect(await fill('https://[2001:db8::1]:8443', '[2001:db8::1]:8443')).toBe('glpat_fixture');
        expect(await fill('https://[2001:db8::1]:8443', '[2001:db8::1]:9443'), 'another port').toBeNull();
        expect(await fill('https://[2001:db8::1]:8443', '[2001:db8::2]:8443'), 'another address').toBeNull();
        expect(await fill('https://gitlab.example.com', 'gitlab.example.com')).toBe('glpat_fixture');
        expect(await fill('https://gitlab.example.com', 'gitlab.example.com.evil.example'), 'a suffix host').toBeNull()
    });
});
