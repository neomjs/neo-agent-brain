import {test, expect} from '@playwright/test';

import {
    WRAP_UP_TOOL_NAME,
    extractTurnWrapUpAskFromJsonl
} from '../../../../../../../../ai/scripts/lifecycle/hooks/claude/laneStateStopHook.mjs';

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
 * with buttons. The deference mirror reads the current turn's newest call (#78), shaped as the real
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

    test('malformed lines, a missing transcript and a non-string ask match nothing', () => {
        expect(extractTurnWrapUpAskFromJsonl(jsonl([prompt('go'), '{not json', wrapUp({ask: 42}), toolResult()]))).toBeNull();
        expect(extractTurnWrapUpAskFromJsonl('')).toBeNull();
        expect(extractTurnWrapUpAskFromJsonl(jsonl(['{not json', wrapUp({ask, actions})]))).toEqual({ask, actions});
    });
});
