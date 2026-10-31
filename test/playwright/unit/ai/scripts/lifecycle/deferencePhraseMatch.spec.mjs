import {test, expect} from '@playwright/test';

import {DEFERENCE_PHRASES,
        DEFERENCE_REMINDER,
        INDEFINITE_DEFERENCE_OBJECTS,
        buildDeferenceReminder,
        detectDeferencePhrase,
        matchDeferencePhrase} from '../../../../../../ai/scripts/lifecycle/deferencePhraseMatch.mjs';

/**
 * @summary Distinguishes executed-decision reports from genuine operator handbacks.
 */
test.describe('deferencePhraseMatch', () => {
    const reports = [
        ['recorded', 'I recorded your call as #42: the decision is in the ticket.'],
        ['followed', 'I followed your call and kept the old source.'],
        ['implemented', 'I implemented your call.'],
        ['applied', 'I applied your call.'],
        ['took', 'I took your call as the decision.'],
        ['went with', 'I went with your call.'],
        ['case folding', 'I RECORDED YOUR CALL.'],
        ['soft wraps', 'I went\n with\nyour\ncall.'],
        ['emphasis', 'I **recorded** __your call__.'],
        ['multiple executed reports', 'I recorded your call and followed your call.']
    ];

    for (const [name, text] of reports) {
        test(`executed report: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBeNull();
        });
    }

    const handbacks = [
        ['direct question', 'Your call?'],
        ['nonadjacent verb', 'recorded it — your call?'],
        ['prior sentence', 'I recorded the decision. Your call?'],
        ['question after report', 'I recorded your call. Your call?'],
        ['emphasized choice after report', 'I went with your call.\n\n**Your call:** A or B?'],
        ['question after citation', 'per #1 your call, but honestly, your call?'],
        ['citation tokens after executed verb', 'I recorded rule 1 your call?'],
        ['intervening pronoun', 'I recorded it, your call?']
    ];

    for (const [name, text] of handbacks) {
        test(`genuine handback: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBe('your call');
        });
    }

    const existingExemptions = [
        ['adjacent citation', 'per your call'],
        ['citation bridge', "per #1 that's your call"],
        ['operator direction', 'as you directed your call'],
        ['phrase mention', 'the phrase your call'],
        ['reported wording', 'reported your call'],
        ['identifier', 'your_call']
    ];

    for (const [name, text] of existingExemptions) {
        test(`existing exemption: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBeNull();
        });
    }

    test('operator dialogue retains the carve', () => {
        expect(detectDeferencePhrase('Your call?', {operatorInLoop: true})).toBeNull();
    });

    test('autonomous turns still detect genuine handbacks', () => {
        expect(detectDeferencePhrase('Your call?', {operatorInLoop: false})).toBe('your call');
    });
});

/**
 * @summary The adjacency carves: a cited, negated, confessed or quoted "your call" is not a handback.
 *
 * Every sentence below comes from a live Stop-hook firing recorded on the hook's false-positive umbrella
 * ticket, named by its author and date; the controls are the fair hits recorded beside them.
 */
test.describe('deferencePhraseMatch adjacency carves', () => {
    const silent = [
        ['temporal citation, hours after (Grace, 2026-10-29)',
            'Emmy rigged it to our skeleton and drove it with the existing walk animation, which is what you asked for, about three hours after your call.'],
        ['temporal citation, days since', 'The index row has not moved two days since your call.'],
        ['temporal citation, an hour after', 'The deploy was green an hour after your call.'],
        ['contrast, rather than (Grace, 2026-10-24)',
            'The e2e-brain tier stays at ten shards, my decision rather than your call.'],
        ['negation, not … to make (Grace, 2026-10-24)', 'This is not your call to make; I decided ten shards.'],
        ['contrast, instead of (Grace, 2026-10-24)', 'Ten shards, instead of your call, per the policy.'],
        ['negated contraction', "The shard count isn't your call; the policy settled it."],
        ['confession, telling you … was (Ada, 2026-09-21)',
            'The first was telling you the fork-CI approval was your call when `maintain: true` made it mine.'],
        ['confession, I told you … was', 'I told you yesterday that the fork-CI approval was your call; it was mine.'],
        ['blockquote line (Ada, 2026-09-21 addendum)', '> Your call?\n\nThat was the quoted sentence; the decision is recorded on the ticket.'],
        ['indented blockquote line', '  > Twelve or ten shards — your call.\n\nQuoted from the earlier turn, now decided.']
    ];

    for (const [name, text] of silent) {
        test(`silent: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBeNull();
        });
    }

    const fires = [
        ['decision handback with whether (Vega, 2026-08-17)',
            'merge-ready under the exception — your call whether that window applies'],
        ['which is your call (Grace, 2026-10-24)', 'That trade is runner budget against margin, which is your call.'],
        ['future deference, after without a duration (Grace, 2026-10-29)', "I'll continue after your call"],
        ['terminal after your call? (Grace, 2026-10-29)', 'Do we ship tonight, after your call?'],
        ['dash before the phrase (Grace, 2026-10-24)', 'Twelve or ten shards — your call.'],
        ['not is not adjacent (Grace, 2026-10-24)', 'Not sure which is better — your call.'],
        ['comma breaks adjacency (Grace, 2026-10-24)', 'Whether to wait or not, your call.'],
        ['retroactive deference without attribution (Ada, 2026-09-21)', 'That was your call.'],
        ['grading an order after executing it (Grace, 2026-08-10)', 'Your call to revert the whole file was right.'],
        ['want is not a negated contraction', 'I want your call on the shard count.'],
        ['told you without a copula before the phrase', 'I told you: your call.'],
        ['inline > is text, not a blockquote', 'The margin > the budget, so your call.'],
        ['a live use after a blockquote mention', '> per your call, ten shards.\n\nTwelve or ten next week — your call?']
    ];

    for (const [name, text] of fires) {
        test(`fires: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBe('your call');
        });
    }

    test('the negation carve does not reach other phrases through ordinary prose', () => {
        expect(matchDeferencePhrase("I did not finish; want me to take the parser lane next?")).toBe('want me to');
    });
});

/**
 * Direct coverage for the deference-register phrase match. The matcher is pure; hook specs cover
 * the runtime block path and the operator-dialogue carve.
 */
test.describe('ai/scripts/lifecycle/deferencePhraseMatch', () => {
    test('matches the real session slip', () => {
        expect(matchDeferencePhrase('So - which do you want me driving next?')).toBe('do you want me');
    });

    test("matches the operator-flagged lane-handback slip (#16325)", () => {
        // The list already carried "if you'd rather" and "unless you want me", so this composition read
        // as covered while returning null - on the autonomous path too, not just under the operator carve.
        expect(matchDeferencePhrase("That's next unless you'd rather I take something else."))
            .toBe("unless you'd rather");

        // The negative control that keeps the addition honest: a decisive authority-boundary statement
        // is not deference, and must stay silent.
        expect(matchDeferencePhrase('Next: #16208. The merge is yours per critical_gates 1.')).toBeNull();

        // The near-miss guard that already existed for "unless you ..." must survive.
        expect(matchDeferencePhrase('The test fails unless you mock the system clock.')).toBeNull();

        // Reporting the phrase is not using it - this ticket's own body does exactly that.
        expect(matchDeferencePhrase("The phrase unless you'd rather is part of the deference register."))
            .toBeNull();
    });

    test('unless you want matches only the closed indefinite-object vocabulary', () => {
        expect(INDEFINITE_DEFERENCE_OBJECTS).toEqual([
            'something',
            'anything',
            'otherwise'
        ]);

        expect(matchDeferencePhrase('Taking the parser lane next unless you want something else first.'))
            .toBe('unless you want');
        expect(matchDeferencePhrase('Taking the parser lane next unless you want anything else.'))
            .toBe('unless you want');
        expect(matchDeferencePhrase('Taking the parser lane next unless you want otherwise.'))
            .toBe('unless you want');
        expect(matchDeferencePhrase('Taking the parser lane next UNLESS YOU WANT ANYTHING else.'))
            .toBe('unless you want');

        expect(matchDeferencePhrase('The default is fine unless you want deterministic isolation.')).toBeNull();
        expect(matchDeferencePhrase('Keep the current plan unless you want a smaller batch size.')).toBeNull();
        expect(matchDeferencePhrase('Use the first parser unless you want the other parser.')).toBeNull();
        expect(matchDeferencePhrase('Use the first parser unless you want another parser.')).toBeNull();
        expect(matchDeferencePhrase('Idempotent unless you want another run to overwrite state.')).toBeNull();
        expect(matchDeferencePhrase('Taking the parser lane next unless you want.')).toBeNull();

        // The longer existing entry stays independently reachable rather than being shadowed by
        // the new prefix phrase.
        expect(matchDeferencePhrase('I can take it unless you want me elsewhere.')).toBe('unless you want me')
    });

    test('indefinite-object matching reads grammar rather than Markdown layout', () => {
        expect(matchDeferencePhrase('Taking the parser lane next **unless you want** something else first.'))
            .toBe('unless you want');
        expect(matchDeferencePhrase('Taking the parser lane next unless you want\n    anything else first.'))
            .toBe('unless you want');

        // A concrete object remains ordinary prose across the same soft-wrap path.
        expect(matchDeferencePhrase('Keep the default unless you want\n    deterministic isolation.')).toBeNull();

        // A paragraph break ends the clause. The next paragraph cannot be recruited as the object.
        expect(matchDeferencePhrase('Taking the parser lane next unless you want\n\nsomething else is available.'))
            .toBeNull()
    });

    test('matches each tight phrase case-insensitively', () => {
        expect(matchDeferencePhrase('WOULD YOU LIKE ME TO open the PR?')).toBe('would you like me to');
        expect(matchDeferencePhrase('I can take it unless you want me elsewhere.')).toBe('unless you want me');
        expect(matchDeferencePhrase('Want me to start the refactor?')).toBe('want me to');
        expect(matchDeferencePhrase('Your steer on the next lane.')).toBe('Your steer on');
        expect(matchDeferencePhrase("IF YOU'D RATHER, I can leave this parked.")).toBe("if you'd rather");
        expect(matchDeferencePhrase("I can take it UNLESS YOU'D RATHER I picked another.")).toBe("unless you'd rather");
        expect(matchDeferencePhrase('I can do this, or steer me elsewhere.')).toBe('or steer me elsewhere');
        expect(matchDeferencePhrase('Your call on the branch cut.')).toBe('your call');
        expect(matchDeferencePhrase('Your move.')).toBe('your move');
    });

    test('does not match deliberately excluded near-misses', () => {
        expect(matchDeferencePhrase('Should I refactor this? Yes - doing it.')).toBeNull();
        expect(matchDeferencePhrase('Shall I open the PR - opening it.')).toBeNull();
        expect(matchDeferencePhrase('Happy to take the next lane.')).toBeNull();
        expect(matchDeferencePhrase('No rush on the merge.')).toBeNull();
        expect(matchDeferencePhrase('Whenever you want to merge is fine.')).toBeNull();
        expect(matchDeferencePhrase('Does this make more sense to you?')).toBeNull();
    });

    test('does not match technical substring collisions', () => {
        expect(matchDeferencePhrase('The fix routes through your callback handler.')).toBeNull();
        expect(matchDeferencePhrase('The test fails unless you mock the system clock.')).toBeNull();
        expect(matchDeferencePhrase('Restored your moved files to their original paths.')).toBeNull();
    });

    test('does not match phrases quoted as markdown code literals', () => {
        expect(matchDeferencePhrase("Added `Your steer on`, `if you'd rather`, and `or steer me elsewhere`."))
            .toBeNull();
        expect(matchDeferencePhrase('```text\nYour steer on the next lane.\n```')).toBeNull();
    });

    test('does not match quoted or reported phrase mentions', () => {
        expect(matchDeferencePhrase('The "your call" firing was a demonstrable false positive.')).toBeNull();
        expect(matchDeferencePhrase("The 'per your call' firing was a demonstrable false positive.")).toBeNull();
        expect(matchDeferencePhrase('The phrase your call is mentioned in the #14420 corpus.')).toBeNull();
        expect(matchDeferencePhrase("The phrase if you'd rather is part of the deference register.")).toBeNull();
    });

    test('does not match attributive citations of an operator decision', () => {
        expect(matchDeferencePhrase('Clio owns it, per your call.')).toBeNull();
        expect(matchDeferencePhrase('The ownership route stands as you directed: your call is the source.'))
            .toBeNull();
    });

    test('the citation may NAME the authority it cites (#16411)', () => {
        // From a live false positive on a merge-eligibility hand-off. The merge gate (§critical_gates
        // rule 1) requires handing a merge to the operator, so every correct execution of that gate ends on a
        // sentence assigning the decision — and the accurate way to write one names the gate. The old
        // adjacency anchor (`/\bper\s+$/`) matched only the citation-FREE `per your call`, so the honest
        // phrasing tripped while the phrasing that passed cited nothing.
        expect(matchDeferencePhrase("Merge-eligible; per §critical_gates #1 that's your call.")).toBeNull();
        expect(matchDeferencePhrase("As you said, per gate #1, that's your call.")).toBeNull();
        // Anticipated rather than transcript-observed, and the narrowest of the four: a dash bridging the
        // citation to the phrase. Cut this assertion and the dash characters together if a reviewer wants
        // the exemption held to observed forms only — the word allowlist, not the punctuation, is what
        // keeps the guard below honest.
        expect(matchDeferencePhrase('Eligible per rule 1 — your call.')).toBeNull();

        // A backticked citation is replaced by a space upstream in `stripMarkdownCode`, so this predicate
        // sees `per   that's` with the citation erased. Whitespace alone therefore has to bridge, or the
        // most idiomatic form in this repo would remain a false positive.
        expect(matchDeferencePhrase("Merge-eligible; per `§critical_gates #1` that's your call.")).toBeNull();
    });

    test('a citation anchor does NOT exempt ordinary deference around it (#16411)', () => {
        // The over-correction, pinned rather than intended. Widening to "`per` appears anywhere in the
        // 80-character window" would exempt exactly the slip this detector exists to catch, so the bridge
        // is an allowlist: any ordinary prose between the anchor and the phrase still fires.
        expect(matchDeferencePhrase("Per your earlier note, I've left the direction open, your call."))
            .toBe('your call');
        expect(matchDeferencePhrase('As you said the sequencing matters, so which one first — your call?'))
            .toBe('your call');
        // Citation SHAPE is not authority: a §section or #ticket nearby exempts nothing without an anchor.
        expect(matchDeferencePhrase('§critical_gates #1 is the gate. Your call on the merge?'))
            .toBe('your call');
    });

    test('still matches live deference uses of your call', () => {
        expect(matchDeferencePhrase('Your call on the branch cut.')).toBe('your call');
        expect(matchDeferencePhrase("It's your call whether I pick this up.")).toBe('your call');
    });

    test('still fires when a live use follows a carved mention of the same phrase', () => {
        expect(matchDeferencePhrase('The phrase your call recurs. Your call on the merge?')).toBe('your call');
        expect(matchDeferencePhrase('Clio owns it per your call, but honestly, your call?')).toBe('your call');
    });

    test('operator-dialogue carve skips the phrase match', () => {
        expect(detectDeferencePhrase('Your call on the exact color.', {operatorInLoop: true})).toBeNull();
        expect(detectDeferencePhrase('Your call on the exact color.', {operatorInLoop: false})).toBe('your call');
        expect(detectDeferencePhrase("If you'd rather, I can move it.", {operatorInLoop: true})).toBeNull();
        expect(detectDeferencePhrase("If you'd rather, I can move it.", {operatorInLoop: false}))
            .toBe("if you'd rather");
    });

    test('returns null on empty or non-string input', () => {
        expect(matchDeferencePhrase('')).toBeNull();
        expect(matchDeferencePhrase(null)).toBeNull();
        expect(matchDeferencePhrase(undefined)).toBeNull();
    });

    test('reminder is self-explaining and routes to peers / ideation rather than operator permission', () => {
        const reminder = buildDeferenceReminder('your call');

        expect(DEFERENCE_PHRASES).toContain('do you want me');
        expect(DEFERENCE_PHRASES).toContain('Your steer on');
        expect(DEFERENCE_PHRASES).toContain("if you'd rather");
        expect(DEFERENCE_PHRASES).toContain("unless you'd rather");
        expect(DEFERENCE_PHRASES).toContain('or steer me elsewhere');
        expect(DEFERENCE_REMINDER).toContain('helpful assistant');
        expect(reminder).toContain('equal peer');
        expect(reminder).toContain('A2A message with peers');
        expect(reminder).toContain('ideation-sandbox');
        expect(reminder).toContain('mutable substrate');
        expect(reminder).toContain('deference phrase "your call"');
    });

    test('the permission-gate form: names the action, then attaches a gate that does not exist (#16706)', () => {
        // Operator-caught 2026-08-11 during a live client incident. This is the subtlest form and the
        // one that survives a self-audit, because it reads as courtesy: the agent identifies the
        // highest-value action — there, the cheapest unrun probe of a seven-week outage — takes credit
        // for identifying it, and then does not do it. The work is named and not done.
        //
        // Asserts the EXACT matched entry, never truthiness. An arm that only asserts truthiness passes
        // through ANY neighbouring phrase, so it cannot prove the entry under test contributes
        // anything. That is how a since-dropped `if you want me` arm "passed" while being satisfied
        // entirely by the pre-existing `want me to`.
        expect(matchDeferencePhrase('The one thing I would still act on immediately if you want it: run ollama ps on that host.'))
            .toBe('if you want it');
        expect(matchDeferencePhrase('I would still probe that host if you want it.'))
            .toBe('if you want it');
    });

    test('the permission-gate entry does NOT reserve ordinary technical conditionals (#16966)', () => {
        // The blocking finding of @neo-gpt's review, executed at exact head rather than argued: both
        // sentences below are legitimate engineering prose, and an ENFORCING Stop hook that turns them
        // into blocking directives taxes correct work on every autonomous turn. The discriminator is
        // clause POSITION — once the pronoun carries a predicate (`it to reject …`) or the verb takes a
        // noun object, the phrase governs that object rather than gating the agent's own action.
        expect(matchDeferencePhrase('Set maxQueue to zero if you want it to reject excess work.')).toBeFalsy();
        expect(matchDeferencePhrase('Keep the fixture local if you would like deterministic isolation.')).toBeFalsy();
        expect(matchDeferencePhrase('Shrink the batch if you want it to complete on CPU-only hardware.')).toBeFalsy();
    });

    test('clause position is GRAMMAR, never Markdown layout', () => {
        // Both arms are precision defects a reviewer replayed against the first clause-terminal repair,
        // and they share one root: layout characters were read as grammar.

        // (1) Inline emphasis must be TRANSPARENT. Agents bold the phrase they are deferring with, so
        // this is the specimen's most likely written form — and reading `*` as a following word made the
        // guard MISS it. A false negative on the shape the entry exists to catch is worse than the false
        // positive that motivated the guard in the first place.
        expect(matchDeferencePhrase('The one thing I would still act on immediately **if you want it**: run ollama ps.'))
            .toBe('if you want it');
        expect(matchDeferencePhrase('I would still probe that host *if you want it*.')).toBe('if you want it');
        // The arm that ISOLATES the pre-scan emphasis strip. The two arms above are also satisfied by the
        // post-soft-wrap strip, so removing the first one leaves them green — a partially vacuous test I
        // only found by mutating each half separately. Emphasis running straight into END-OF-TEXT reaches
        // neither the punctuation test nor the paragraph-break test, so only the first strip can save it.
        expect(matchDeferencePhrase('I would still probe that host **if you want it**')).toBe('if you want it');

        // UNDERSCORE emphasis is the case that survived the first two repairs, and it failed one level
        // EARLIER than they did: the matcher's boundary class is `[^a-z0-9_]`, which counts `_` as a WORD
        // character, so the phrase never matched and no amount of terminal normalization could see it.
        // Same root — layout read as grammar — one stage upstream.
        expect(matchDeferencePhrase('I would still probe that host __if you want it__: now.')).toBe('if you want it');
        expect(matchDeferencePhrase('I would still probe that host _if you want it_.')).toBe('if you want it');
        expect(matchDeferencePhrase('I would still probe that host ~~if you want it~~.')).toBe('if you want it');
    });

    test('emphasis stripping must not rewrite IDENTIFIERS into phrases', () => {
        // The regression my own fix could introduce, so it is pinned rather than trusted. A blanket
        // `[*_~] -> ' '` would turn `your_call` into `your call` and MANUFACTURE a match out of an
        // identifier — inventing deference where there is only code. Emphasis removal is therefore
        // delimiter-scoped: an opener needs whitespace/bracket before it, a closer needs
        // whitespace/punctuation after it, and an intra-word underscore matches neither.
        expect(matchDeferencePhrase('The your_call handler routes through the shared seam.')).toBeNull();
        expect(matchDeferencePhrase('Set wal_autocheckpoint before the your_move guard runs.')).toBeNull();
        // …and the genuine phrase still fires in the same sentence shape, so the guard above is not
        // silently suppressing real matches.
        expect(matchDeferencePhrase('The your_call handler is fine. Your call on the branch cut.'))
            .toBe('your call');

        // (2) A SOFT WRAP is whitespace, not a clause end. Hard-wrapped prose splits the predicate
        // across a newline, and treating that newline as terminal resurrects the false positive above.
        expect(matchDeferencePhrase('Set maxQueue to zero if you want it\nto reject excess work.')).toBeFalsy();
        expect(matchDeferencePhrase('Shrink the batch if you want it\n    to complete on CPU-only hardware.')).toBeFalsy();

        // (3) …but a BLANK line is a paragraph break, which genuinely does end the clause. Without this
        // arm, folding newlines away would swallow the terminal case at the end of a paragraph.
        expect(matchDeferencePhrase('I would still probe that host if you want it\n\nNext lane: #16982.'))
            .toBe('if you want it');
    });

    test('the two noisy variants are GONE, not merely untested (#16966)', () => {
        // A dropped phrase has to be absent from the list, not just absent from the arms above —
        // otherwise a later edit re-adds the false-positive surface and every test still passes.
        expect(DEFERENCE_PHRASES).not.toContain('if you would like');
        expect(DEFERENCE_PHRASES).not.toContain('if you want me');
        // …while the form the redundant entry was supposed to cover is still caught by its neighbour.
        expect(matchDeferencePhrase('I can wire the KB probe too if you want me to.')).toBe('want me to');
    });

    test('NON-VACUITY — a declarative lane claim carries no deference PHRASE', () => {
        // Without this arm a matcher that flagged every sentence would pass the arms above.
        //
        // ⚠️ SCOPE, stated exactly, because the obvious phrasing of this comment is wrong: these
        // sentences are clean **to this matcher**, which is not the same as correct behaviour. A
        // declarative claim hands nothing back to the operator, so there is no deference phrase to
        // find — but "Taking X now." at TURN-TERMINAL with nothing after it is the STRUCTURAL slip,
        // and this matcher runs at exactly that position. Announcing a lane is required behaviour
        // only when execution follows; at the moment the hook fires, the announcement is all there
        // is. Saying is not acting.
        //
        // The module docstring already names the boundary: this is the PHRASED half, and the
        // phraseless half belongs to the no-hold gate and the value floor. A future reader must not
        // take a falsy result here as a verdict that the turn was fine.
        expect(matchDeferencePhrase('Taking the starved-record lane now.')).toBeFalsy();
        expect(matchDeferencePhrase('I will take FIX-2 next.')).toBeFalsy();
        expect(matchDeferencePhrase('Running ollama ps on that host now.')).toBeFalsy();
    });
});
