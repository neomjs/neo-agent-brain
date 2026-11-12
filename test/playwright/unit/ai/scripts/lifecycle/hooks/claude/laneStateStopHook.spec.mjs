import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {test, expect} from '@playwright/test';

import {
    WRAP_UP_TOOL_NAME,
    extractLatestHumanUserMessageFromJsonl,
    extractTurnWrapUpAskFromJsonl,
    readOperatorPresenceRecord
} from '../../../../../../../../ai/scripts/lifecycle/hooks/claude/laneStateStopHook.mjs';
import {decideDeferenceStopHookAction, decideOperatorAway} from '../../../../../../../../ai/scripts/lifecycle/stopHookDecision.mjs';

const prompt     = text => ({type: 'user', message: {role: 'user', content: text}}),
      reply      = text => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text}]}}),
      wrapUp     = input => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id: 'w', name: WRAP_UP_TOOL_NAME, input}]}}),
      toolResult = () => ({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'w', content: [{type: 'text', text: 'Box shown.'}]}]}}),
      feedback   = () => ({type: 'user', isMeta: true, message: {role: 'user', content: 'Stop hook feedback: deference phrase'}}),
      jsonl      = records => records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n');

const ask     = 'Fix #20599 now so it ships in 13.4?',
      actions = [{label: 'Yes, fix it now'}, {label: 'After the cut'}];

/**
 * @summary The Claude desktop app closes a turn through a wrap-up tool call whose `ask` becomes a question
 * with buttons. The deference mirror reads the current turn's newest call, shaped as the real
 * transcript records are: the call, its tool result, then the closing text.
 */
test.describe('extractTurnWrapUpAskFromJsonl (#78)', () => {
    test('returns the current turn\'s ask and actions', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([
            prompt('please continue'), reply('Both PRs are open.'), wrapUp({recap: 'Done.', ask, actions}),
            toolResult(), {type: 'attachment', attachment: {type: 'hook'}}, reply('Closing message.')
        ]))).toEqual({ask, actions});
    });

    test('the newest call decides: a later wrap-up that asks nothing means no ask', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([
            prompt('go'), wrapUp({recap: 'First.', ask, actions}), toolResult(), wrapUp({recap: 'Then done.'}), toolResult()
        ]))).toBeNull();
    });

    test('an older turn\'s ask is never read: the prompt that opened this turn stops the walk', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([
            prompt('first'), wrapUp({recap: 'Old.', ask, actions}), toolResult(), reply('old'),
            prompt('second'), reply('No question this time.')
        ]))).toBeNull();
    });

    test('an ask the hook already answered is not read again after its feedback', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([
            prompt('go'), wrapUp({recap: 'Done.', ask, actions}), toolResult(), reply('Closing.'), feedback(), reply('Acting on it instead.')
        ]))).toBeNull();
    });

    test('a box in a turn the operator did not prompt blocks the stop once (#1618)', () => {
        const turn       = [prompt('[WAKE] route-review'), wrapUp({recap: 'Done.', ask, actions}), toolResult(), reply('Closing.')],
              unprompted = {operatorInLoop: false, enforcing: true};

        expect(decideDeferenceStopHookAction('Closing.', {...unprompted, wrapUpAsk: extractTurnWrapUpAskFromJsonl(jsonl(turn))}).action)
            .toBe('block');
        expect(decideDeferenceStopHookAction('Recorded on the ticket.', {
            ...unprompted,
            wrapUpAsk: extractTurnWrapUpAskFromJsonl(jsonl([...turn, feedback(), reply('Recorded on the ticket.')]))
        })).toBeNull();
    });

    test('malformed lines, a missing transcript and a non-string ask match nothing', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([prompt('go'), '{not json', wrapUp({ask: 42}), toolResult()]))).toBeNull();
        expect(extractTurnWrapUpAskFromJsonl('')).toBeNull();
        expect(extractTurnWrapUpAskFromJsonl(jsonl(['{not json', wrapUp({ask, actions})]))).toEqual({ask, actions});
    });
});

/**
 * @summary The Fleet writes the operator's presence to a host file and hands each seat its path at Start; the
 * adapter reads it once per turn-end and lets the record, not the prompting classifier, decide "away".
 */
test.describe('the operator presence record at the adapter seam (#1640)', () => {
    const at       = (record, timestamp) => ({...record, timestamp}),
          awayFrom = since => ({mode: 'away', since, until: null, writtenAt: since});
    let dir;

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-operator-presence-'))
    });

    test.afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    });

    test('the prompting message carries its record\'s timestamp; no candidate carries none', () => {
        expect(extractLatestHumanUserMessageFromJsonl(jsonl([at(prompt('good night'), '2026-11-12T22:03:00.000Z'), reply('On it.')])))
            .toEqual({text: 'good night', timestamp: '2026-11-12T22:03:00.000Z'});
        expect(extractLatestHumanUserMessageFromJsonl(jsonl([prompt('no stamp')]))).toEqual({text: 'no stamp', timestamp: null});
        expect(extractLatestHumanUserMessageFromJsonl('')).toEqual({text: '', timestamp: null});
    });

    test('reads the record; no path, no file, bad JSON or a non-object reads as no record', () => {
        const file = path.join(dir, 'operator-presence.json');

        fs.writeFileSync(file, JSON.stringify(awayFrom('2026-11-12T22:00:00.000Z')));
        expect(readOperatorPresenceRecord(file)).toEqual(awayFrom('2026-11-12T22:00:00.000Z'));

        expect(readOperatorPresenceRecord('')).toBeNull();
        expect(readOperatorPresenceRecord(path.join(dir, 'missing.json'))).toBeNull();
        fs.writeFileSync(file, '{half');
        expect(readOperatorPresenceRecord(file)).toBeNull();
        fs.writeFileSync(file, '[1]');
        expect(readOperatorPresenceRecord(file)).toBeNull();
    });

    test('Nightshift on: the operator\'s own handoff turn ends on a box ask and blocks once', () => {
        const file    = path.join(dir, 'operator-presence.json'),
              handoff = [at(prompt('back at 09:00, you can freely choose what to focus on'), '2026-11-12T22:03:00.000Z'),
                         wrapUp({recap: 'Done.', ask, actions}), toolResult(), reply('Closing.')],
              decide  = turn => {
                  const record  = readOperatorPresenceRecord(file),
                        message = extractLatestHumanUserMessageFromJsonl(jsonl(turn));

                  return decideDeferenceStopHookAction(turn.at(-1).message.content[0].text, {
                      operatorInLoop: true,
                      operatorAway  : decideOperatorAway(record, {
                          now                  : Date.parse('2026-11-12T22:10:00Z'),
                          graceMs              : 600000,
                          lastOperatorMessageAt: message.timestamp
                      }),
                      awaySince: record?.since ?? null,
                      enforcing: true,
                      wrapUpAsk: extractTurnWrapUpAskFromJsonl(jsonl(turn))
                  })
              };

        fs.writeFileSync(file, JSON.stringify(awayFrom('2026-11-12T22:00:00.000Z')));

        expect(decide(handoff).reason).toContain('The operator switched Nightshift on at 2026-11-12 22:00 UTC');
        expect(decide([...handoff, feedback(), reply('Taking the stated pick.')])).toBeNull();

        // Without a record the same operator-prompted turn is dialogue, and its ask asks nothing of him
        fs.rmSync(file);
        expect(decide(handoff)).toBeNull();
    });
});
