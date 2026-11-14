#!/usr/bin/env node
/**
 * @module ai/scripts/fleet/primarySessionWake
 * @summary Enrolls one explicitly selected seat for a supervised native wake canary.
 *
 * Run on the receiver host after validating the installed generation, with legacy dispatch
 * quiescent. The selection takes effect at the next authorized Fleet arm and confers no
 * session ownership. Status reads the marker without opening a native chat or waking a seat.
 */
import {parseArgs}                             from 'node:util';
import {isEntryModule}                         from '../../services/shared/isEntryModule.mjs';
import {enrollNativeWake, readNativeWakeOptIn} from '../../daemons/wake/fleetPrimarySessionWake.mjs';

const usage = 'primarySessionWake.mjs <status|enroll> --agent <registry-id> --family <codex-desktop|antigravity> --manifest <receiver-file> [--state <receiver-state-dir>]';

/** @summary Runs the host-local enrollment command. All inputs are explicit and no secret is printed. */
export async function runPrimarySessionWakeCli(argv) {
    const {positionals,values} = parseArgs({args:argv,allowPositionals:true,
        options:{agent:{type:'string'},family:{type:'string'},manifest:{type:'string'},state:{type:'string'},help:{type:'boolean'}}});
    if (values.help) return {usage};
    if (positionals.length !== 1 || !values.agent || !values.manifest || !['antigravity','codex-desktop'].includes(values.family)) {
        throw new Error(usage)
    }
    const options = {manifestPath:values.manifest, agentId:values.agent, family:values.family};
    if (positionals[0] === 'status' && !values.state) return {enrollment:await readNativeWakeOptIn(options)};
    if (positionals[0] === 'enroll' && values.state) return {enrollment:await enrollNativeWake({...options,stateDir:values.state})};
    throw new Error(usage)
}

if (isEntryModule(import.meta.url)) {
    runPrimarySessionWakeCli(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
        console.error(error.message);
        process.exitCode = 1
    })
}
