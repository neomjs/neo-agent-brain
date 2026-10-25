import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'PublishExecutorUnitTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import crypto         from 'node:crypto';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {expect, test} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                              'neo.mjs/src/manager/Instance.mjs';
import RequestContextService       from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import FleetControlBridge          from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {wireOperatorComposeWriter} from '../../../../../../ai/services/fleet/wireOperatorComposeWriter.mjs';
import {
    X_REFRESH_MARGIN_MS,
    createFleetCustodyStore as createFleetCustodyStoreDirect
} from '../../../../../../ai/services/fleet/fleetCustodyStore.mjs';
import {
    createSocialPlatformClient as createSocialPlatformClientDirect
} from '../../../../../../ai/services/fleet/socialPlatformClient.mjs';
import {
    LINKEDIN_TOKEN_MAX_AGE_MS,
    PUBLICATION_STATES,
    PUBLISH_CHANNELS,
    PUBLISH_FORMATS,
    REFUSAL_CODES,
    REPLY_CLASSIFICATION_PRIMARY_SOURCE,
    SWITCH_STATES,
    computePublishRevisionDigest,
    createFleetCustodyStore,
    createPublishExecutor,
    createSocialPlatformClient,
    matchesRequestedPublishText,
    publish,
    readMetrics,
    reply
} from '../../../../../../ai/services/fleet/publishExecutor.mjs';

const NOW_MS  = Date.UTC(2026, 9, 25, 2, 0, 0);
const REQ_ID  = 'MESSAGE:97900000-0000-4000-8000-000000000001';
const PEER_ID = '@neo-fable-clio';
const SECRET  = 'x-oauth2-pkce-super-secret-token-99887766';

function buildPayload(overrides = {}) {
    return {
        schemaVersion: 1,
        channel      : PUBLISH_CHANNELS.x,
        account      : '@neomjs',
        text         : 'Neo v13.2 ships the two-hemisphere Agent OS and Fleet publish gate.',
        media        : [],
        hypothesis   : 'Founder-grade architecture posts with concrete receipts earn higher repo click-through.',
        format       : PUBLISH_FORMATS.post,
        inReplyTo    : null,
        ...overrides
    };
}

/**
 * In-memory double implementing `MailboxService`'s single-writer interface (`getMessage` and
 * `transitionPublishState`) with the same legal state-transition table as `MailboxService`.
 */
function createInMemoryMailbox(initialRequests = {}, reviewMessages = {}) {
    const store       = new Map(Object.entries(initialRequests));
    const reviews     = new Map(Object.entries(reviewMessages));
    const transitions = [];

    return {
        store,
        reviews,
        transitions,
        async getMessage({messageId} = {}) {
            if (store.has(messageId)) {
                return structuredClone(store.get(messageId));
            }
            if (reviews.has(messageId)) {
                return structuredClone(reviews.get(messageId));
            }
            return null;
        },
        async transitionPublishState(update = {}) {
            transitions.push(structuredClone(update));
            const targetId = update.taskId ?? update.messageId;
            const existing = store.get(targetId);
            if (!existing) {
                return {success: false, refused: REFUSAL_CODES.notFound};
            }

            const currentState = existing.publication.state;
            const newState     = update.newState;
            const legalMoves   = {
                queued    : new Set(['publishing', 'refused']),
                publishing: new Set(['published', 'refused', 'unresolved']),
                unresolved: new Set(['published', 'refused']),
                published : new Set([]),
                refused   : existing.publication.reservation ? new Set([]) : new Set(['queued'])
            };

            if (!legalMoves[currentState]?.has(newState)) {
                return {
                    success: false,
                    state  : currentState,
                    refused: REFUSAL_CODES.publishingInFlight,
                    reason : `Illegal publication state transition ${currentState} -> ${newState}`
                };
            }

            const reservedAt = update.reservedAt ?? existing.publication.reservedAt ?? new Date(NOW_MS).toISOString();
            const attemptId  = update.attemptId ?? existing.publication.attemptId ?? null;

            existing.publication = {
                ...existing.publication,
                state      : newState,
                attemptId,
                reservedAt : newState === PUBLICATION_STATES.publishing ? reservedAt : existing.publication.reservedAt,
                reservation: newState === PUBLICATION_STATES.publishing
                    ? {
                        attemptId,
                        revisionNumber: existing.currentRevision.revisionNumber,
                        revisionDigest: update.revisionDigest ?? existing.publication.revisionDigest,
                        reservedAt
                    }
                    : existing.publication.reservation,
                revisionNumber : existing.currentRevision.revisionNumber,
                revisionDigest : update.revisionDigest ?? existing.publication.revisionDigest,
                providerId     : update.providerId ?? existing.publication.providerId ?? null,
                readback       : update.readback ?? existing.publication.readback ?? null,
                readbackAt     : update.readbackAt ?? existing.publication.readbackAt ?? null,
                textAsPublished: update.textAsPublished !== undefined ? update.textAsPublished : existing.publication.textAsPublished,
                refusalReason  : newState === PUBLICATION_STATES.queued ? null : (update.refusalReason ?? null)
            };
            store.set(targetId, existing);
            return {
                success    : true,
                messageId  : targetId,
                taskId     : targetId,
                publication: structuredClone(existing.publication)
            };
        }
    };
}

function seedApprovedRequest({
    requestId    = REQ_ID,
    requester    = PEER_ID,
    payload      = buildPayload(),
    approved     = true,
    releaseState = null,
    attestation  = null,
    textInitial  = null
} = {}) {
    const revisionDigest = computePublishRevisionDigest(payload);
    const revision1Text  = textInitial ?? payload.text;
    const revisions      = [];

    if (textInitial && textInitial !== payload.text) {
        const rev1Payload = {...payload, text: textInitial};
        revisions.push({
            revisionNumber: 1,
            revisionDigest: computePublishRevisionDigest(rev1Payload),
            createdAt     : '2026-10-25T01:50:00.000Z',
            createdBy     : requester,
            payload       : rev1Payload,
            approval      : null,
            attestation   : null
        });
    }

    const revNum          = revisions.length + 1;
    const currentRevision = {
        revisionNumber: revNum,
        revisionDigest,
        createdAt     : '2026-10-25T01:55:00.000Z',
        createdBy     : revNum > 1 ? '@tobiu' : requester,
        payload,
        approval      : approved
            ? {
                approvedBy    : '@tobiu',
                approvedAt    : '2026-10-25T01:56:00.000Z',
                revisionNumber: revNum,
                revisionDigest
            }
            : null,
        attestation,
        releaseState
    };
    revisions.push(currentRevision);

    return {
        messageId     : requestId,
        requestId,
        from          : requester,
        requester,
        requestPublish: payload,
        revision      : currentRevision,
        revisions,
        currentRevision,
        publication   : {
            state                : PUBLICATION_STATES.queued,
            attemptId            : null,
            reservedAt           : null,
            reservation          : null,
            currentRevisionNumber: revNum,
            currentRevisionDigest: revisionDigest,
            revisionNumber       : revNum,
            revisionDigest,
            providerId           : null,
            readback             : null,
            readbackAt           : null,
            textAsRequested      : revision1Text,
            textAsPublished      : null,
            refusalReason        : null
        }
    };
}

test.describe.configure({mode: 'serial'});

test.describe('publishExecutor (#979)', () => {
    test('AC-1: publish records publishing before the platform call and published with the provider id after it; a second call for the same id and digest is a no-op with the recorded provider id', async () => {
        const request = seedApprovedRequest({
            textInitial: 'Draft v1 before operator edit.',
            payload    : buildPayload({text: 'Edited & approved v2 body for X.'})
        });
        const digest  = request.currentRevision.revisionDigest;
        const mailbox = createInMemoryMailbox({[REQ_ID]: request});

        let   stateAtPlatformDispatch = null;
        const platformCalls           = [];

        const platform = {
            async publishPost(call) {
                platformCalls.push(call);
                stateAtPlatformDispatch = (await mailbox.getMessage({messageId: REQ_ID})).publication.state;
                return {
                    providerId: 'tweet-189900112233',
                    readback  : {
                        providerId: 'tweet-189900112233',
                        text      : call.text,
                        readbackAt: new Date(NOW_MS).toISOString()
                    }
                };
            }
        };

        const executor = createPublishExecutor({
            mailbox,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform,
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-ac1'
        });

        const first = await executor.publish(REQ_ID, digest);

        expect(stateAtPlatformDispatch).toBe(PUBLICATION_STATES.publishing);
        expect(mailbox.transitions.map(t => t.newState)).toEqual([
            PUBLICATION_STATES.publishing,
            PUBLICATION_STATES.published
        ]);
        expect(first).toMatchObject({
            ok             : true,
            state          : PUBLICATION_STATES.published,
            noop           : false,
            reconciled     : false,
            requestId      : REQ_ID,
            attemptId      : 'attempt-ac1',
            revisionNumber : 2,
            revisionDigest : digest,
            providerId     : 'tweet-189900112233',
            textAsRequested: 'Draft v1 before operator edit.',
            textAsPublished: 'Edited & approved v2 body for X.'
        });
        expect(platformCalls).toHaveLength(1);

        // Second call for the same id and digest is an idempotent no-op with the recorded providerId
        const second = await executor.publish(REQ_ID, digest);
        expect(second).toMatchObject({
            ok             : true,
            state          : PUBLICATION_STATES.published,
            noop           : true,
            requestId      : REQ_ID,
            revisionDigest : digest,
            providerId     : 'tweet-189900112233',
            textAsRequested: 'Draft v1 before operator edit.',
            textAsPublished: 'Edited & approved v2 body for X.'
        });
        expect(platformCalls).toHaveLength(1);

        // A call with a different digest on an already-published request is refused without calling the platform
        const differentDigest = await executor.publish(REQ_ID, '0'.repeat(64));
        expect(differentDigest).toMatchObject({
            ok        : false,
            state     : PUBLICATION_STATES.published,
            refused   : REFUSAL_CODES.alreadyPublished,
            providerId: 'tweet-189900112233'
        });
        expect(platformCalls).toHaveLength(1);
    });

    test('AC-2: a crash between the platform call and the published record leaves publishing; the next run reconciles against recent posts created at or after reservedAt and records published without a second post, or unresolved when it cannot tell', async () => {
        // Arm A: positive reconciliation match at/after reservedAt adopts providerId and records `published` without a second post
        const reqA     = seedApprovedRequest();
        const digestA  = reqA.currentRevision.revisionDigest;
        const mailboxA = createInMemoryMailbox({[REQ_ID]: reqA});

        let publishCallsA = 0;
        let recentCallsA  = 0;

        const executorA = createPublishExecutor({
            mailbox      : mailboxA,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-crash-a',
            platform     : {
                async publishPost() {
                    publishCallsA++;
                    throw new Error('ECONNRESET: socket hang up after platform accepted POST /2/tweets');
                },
                async listRecentPosts() {
                    recentCallsA++;
                    return [
                        {
                            id       : 'tweet-reconciled-777',
                            text     : reqA.currentRevision.payload.text,
                            createdAt: new Date(NOW_MS + 1000).toISOString()
                        }
                    ];
                }
            }
        });

        await expect(executorA.publish(REQ_ID, digestA)).rejects.toThrow(/publish dispatch interrupted after recording publishing/);
        expect((await mailboxA.getMessage({messageId: REQ_ID})).publication.state).toBe(PUBLICATION_STATES.publishing);
        expect(publishCallsA).toBe(1);

        const reconciled = await executorA.publish(REQ_ID, digestA);
        expect(reconciled).toMatchObject({
            ok            : true,
            state         : PUBLICATION_STATES.published,
            reconciled    : true,
            attemptId     : 'attempt-crash-a',
            revisionDigest: digestA,
            providerId    : 'tweet-reconciled-777'
        });
        expect(publishCallsA).toBe(1);
        expect(recentCallsA).toBe(1);
        expect((await mailboxA.getMessage({messageId: REQ_ID})).publication.state).toBe(PUBLICATION_STATES.published);

        // Arm B: when recent-posts read cannot locate the post, records `unresolved` without a second post and blocks bypass
        const reqB     = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000002'});
        const digestB  = reqB.currentRevision.revisionDigest;
        const mailboxB = createInMemoryMailbox({[reqB.requestId]: reqB});

        let   publishCallsB = 0;
        const executorB     = createPublishExecutor({
            mailbox      : mailboxB,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-crash-b',
            platform     : {
                async publishPost() {
                    publishCallsB++;
                    throw new Error('ETIMEDOUT waiting for platform response');
                },
                async listRecentPosts() {
                    return [];
                }
            }
        });

        await expect(executorB.publish(reqB.requestId, digestB)).rejects.toThrow(/publish dispatch interrupted/);
        expect((await mailboxB.getMessage({messageId: reqB.requestId})).publication.state).toBe(PUBLICATION_STATES.publishing);

        const unresolvedResult = await executorB.publish(reqB.requestId, digestB);
        expect(unresolvedResult).toMatchObject({
            ok            : false,
            state         : PUBLICATION_STATES.unresolved,
            refused       : REFUSAL_CODES.unresolved,
            attemptId     : 'attempt-crash-b',
            revisionDigest: digestB
        });
        expect(publishCallsB).toBe(1);
        expect((await mailboxB.getMessage({messageId: reqB.requestId})).publication.state).toBe(PUBLICATION_STATES.unresolved);

        // Subsequent attempts with the same or a different digest remain refused while `unresolved`
        const bypassAttempt = await executorB.publish(reqB.requestId, 'f'.repeat(64));
        expect(bypassAttempt).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.unresolved,
            refused: REFUSAL_CODES.unresolved
        });
        expect(publishCallsB).toBe(1);
    });

    test('AC-3: a revision digest that does not match the approval is refused; a switch state read at publish time below the request release state refuses the queued request', async () => {
        // Arm A: revision digest mismatch against approval is refused (`refused: digest`)
        const reqMismatch = seedApprovedRequest();
        reqMismatch.currentRevision.approval.revisionDigest = 'a'.repeat(64);
        const digestMismatch  = reqMismatch.currentRevision.revisionDigest;
        const mailboxMismatch = createInMemoryMailbox({[REQ_ID]: reqMismatch});

        let   platformCalled = false;
        const executor       = createPublishExecutor({
            mailbox    : mailboxMismatch,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalled = true; return {providerId: 'never'}; }}
        });

        const mismatchRes = await executor.publish(REQ_ID, digestMismatch);
        expect(mismatchRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
        expect(platformCalled).toBe(false);

        // Arm B: stale caller-passed digest that does not match currentRevision after an Edit
        // refuses the call (`refused: digest`) WITHOUT writing `refused` to the stored request
        const reqEdited     = seedApprovedRequest({textInitial: 'Initial draft', payload: buildPayload({text: 'Edited text'})});
        const staleDigest   = reqEdited.revisions[0].revisionDigest;
        const mailboxEdited = createInMemoryMailbox({[REQ_ID]: reqEdited});
        const staleRes      = await executor.publish(REQ_ID, staleDigest, {mailbox: mailboxEdited});
        expect(staleRes).toMatchObject({
            ok              : false,
            state           : PUBLICATION_STATES.refused,
            publicationState: PUBLICATION_STATES.queued,
            refused         : REFUSAL_CODES.digest
        });
        expect((await mailboxEdited.getMessage({messageId: REQ_ID})).publication.state).toBe(PUBLICATION_STATES.queued);
        expect(mailboxEdited.transitions).toHaveLength(0);
        expect(platformCalled).toBe(false);

        // Arm C: switch state read at publish time downgraded below the queued request's release state refuses (`refused: switch`)
        const reqDowngraded = seedApprovedRequest({
            requestId   : 'MESSAGE:97900000-0000-4000-8000-000000000003',
            approved    : false,
            releaseState: SWITCH_STATES.autoApprove
        });
        const digestDowngraded  = reqDowngraded.currentRevision.revisionDigest;
        const mailboxDowngraded = createInMemoryMailbox({[reqDowngraded.requestId]: reqDowngraded});

        const downgradedRes = await publish(reqDowngraded.requestId, digestDowngraded, {
            mailbox    : mailboxDowngraded,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalled = true; return {providerId: 'never'}; }}
        });

        expect(downgradedRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.switch
        });
        expect(platformCalled).toBe(false);

        // Arm D: `auto-approve after a cross-family review attestation` verifies reviewer family + structured revisionDigest
        const payloadAttested = buildPayload({text: 'Cross-family attested post.'});
        const digestAttested  = computePublishRevisionDigest(payloadAttested);
        const reviewMsgId     = 'MESSAGE:97900000-0000-4000-8000-000000000099';
        const reqAttested     = seedApprovedRequest({
            requestId  : 'MESSAGE:97900000-0000-4000-8000-000000000004',
            payload    : payloadAttested,
            approved   : false,
            attestation: {
                reviewerMessageId: reviewMsgId,
                revisionNumber   : 1,
                revisionDigest   : digestAttested
            }
        });
        const mailboxAttested = createInMemoryMailbox(
            {[reqAttested.requestId]: reqAttested},
            {
                [reviewMsgId]: {
                    messageId     : reviewMsgId,
                    from          : '@neo-gpt-sophie',
                    body          : `Approved digest ${digestAttested}`,
                    revisionDigest: digestAttested
                }
            }
        );

        const attestedRes = await publish(reqAttested.requestId, digestAttested, {
            mailbox              : mailboxAttested,
            credentials          : {'x:@neomjs': {accessToken: SECRET}},
            switchStore          : {[`${PEER_ID}:x`]: SWITCH_STATES.autoApproveAttested},
            resolveIdentityFamily: async id => (id === PEER_ID ? 'claude' : 'gpt'),
            platform             : {async publishPost() { return {providerId: 'tweet-attested-1'}; }}
        });
        expect(attestedRes).toMatchObject({
            ok        : true,
            state     : PUBLICATION_STATES.published,
            providerId: 'tweet-attested-1'
        });

        // Arm E: media byte-digest mismatch at publish time is refused (`refused: digest`)
        const mediaBytes   = Buffer.from('original-approved-image-bytes', 'utf8');
        const mediaSha256  = crypto.createHash('sha256').update(mediaBytes).digest('hex');
        const reqWithMedia = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000005',
            payload  : buildPayload({
                media: [{uri: 'resources/post-card.png', sha256: mediaSha256, mimeType: 'image/png'}]
            })
        });
        const tamperedMediaRes = await publish(reqWithMedia.requestId, reqWithMedia.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqWithMedia.requestId]: reqWithMedia}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            mediaReader: async () => Buffer.from('tampered-bytes-on-disk', 'utf8'),
            platform   : {async publishPost() { return {providerId: 'never'}; }}
        });
        expect(tamperedMediaRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
    });

    test('AC-4: no verb returns, logs or embeds a token; a missing, expired, or 60-day-expired LinkedIn token yields refused: credential', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-custody-979-'));
        const xCredDir = path.join(tempRoot, 'social-credentials', 'x');
        await fs.mkdir(xCredDir, {recursive: true});
        await fs.writeFile(
            path.join(xCredDir, '_neomjs.json'),
            JSON.stringify({accessToken: SECRET, refreshToken: 'refresh-secret-token-001122', expiresAt: NOW_MS + 60_000}),
            'utf8'
        );

        const logLines = [];
        const logger   = {
            info : entry => logLines.push(entry),
            warn : entry => logLines.push(entry),
            error: entry => logLines.push(entry)
        };

        try {
            const custody = createFleetCustodyStore({custodyDir: tempRoot, now: () => NOW_MS});
            const req     = seedApprovedRequest();
            const digest  = req.currentRevision.revisionDigest;
            const mailbox = createInMemoryMailbox({[REQ_ID]: req});

            const executor = createPublishExecutor({
                mailbox,
                custody,
                switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
                logger,
                now        : () => NOW_MS,
                platform   : {
                    async publishPost({token}) {
                        expect(token).toBe(SECRET);
                        return {
                            providerId: 'tweet-custody-1',
                            tokenLeak : SECRET,
                            readback  : {providerId: 'tweet-custody-1', text: req.currentRevision.payload.text}
                        };
                    },
                    async readMetrics({token}) {
                        expect(token).toBe(SECRET);
                        const err = new Error(`Platform upstream error with Bearer ${token} and raw ${SECRET}`);
                        throw err;
                    }
                }
            });

            const pubResult     = await executor.publish(REQ_ID, digest);
            const metricsResult = await executor.readMetrics('tweet-custody-1');
            const replyResult   = await executor.reply({inReplyTo: 'tweet-99'});

            // Missing credential yields `refused: credential`
            const reqMissing = seedApprovedRequest({
                requestId: 'MESSAGE:97900000-0000-4000-8000-000000000006',
                payload  : buildPayload({account: '@missing-account'})
            });
            const mailboxMissing = createInMemoryMailbox({[reqMissing.requestId]: reqMissing});
            const missingRes     = await executor.publish(reqMissing.requestId, reqMissing.currentRevision.revisionDigest, {
                mailbox: mailboxMissing
            });
            expect(missingRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // Expired token yields `refused: credential`
            const reqExpired     = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000007'});
            const mailboxExpired = createInMemoryMailbox({[reqExpired.requestId]: reqExpired});
            const expiredRes     = await executor.publish(reqExpired.requestId, reqExpired.currentRevision.revisionDigest, {
                mailbox: mailboxExpired,
                now    : () => NOW_MS + 120_000
            });
            expect(expiredRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // LinkedIn 60-day token expiry yields `refused: credential`
            const liPayload = buildPayload({channel: PUBLISH_CHANNELS.linkedin, account: 'neomjs-org'});
            const reqLi     = seedApprovedRequest({
                requestId: 'MESSAGE:97900000-0000-4000-8000-000000000008',
                payload  : liPayload
            });
            const liCustody = createFleetCustodyStore({
                credentials: {
                    'linkedin:neomjs-org': {
                        accessToken: 'li-secret-token-60d',
                        issuedAt   : NOW_MS - LINKEDIN_TOKEN_MAX_AGE_MS
                    }
                },
                now: () => NOW_MS
            });
            const liRes = await executor.publish(reqLi.requestId, reqLi.currentRevision.revisionDigest, {
                mailbox    : createInMemoryMailbox({[reqLi.requestId]: reqLi}),
                custody    : liCustody,
                switchStore: {[`${PEER_ID}:linkedin`]: SWITCH_STATES.approveEach}
            });
            expect(liRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // Negative log and return assertion: no return value, mailbox record, or log entry contains any secret
            const serializedEverything = JSON.stringify({
                pubResult,
                metricsResult,
                replyResult,
                missingRes,
                expiredRes,
                liRes,
                logLines,
                mailboxTransitions: mailbox.transitions
            });

            expect(serializedEverything).not.toContain(SECRET);
            expect(serializedEverything).not.toContain('refresh-secret-token-001122');
            expect(serializedEverything).not.toContain('li-secret-token-60d');
        } finally {
            await fs.rm(tempRoot, {recursive: true, force: true});
        }
    });

    test('AC-5: reply refuses with the unresolved-classification reason and names the primary source to verify; publish enforces the same gate on reply and unverified link-reply formats', async () => {
        const replyRes = await reply({inReplyTo: 'tweet-third-party-123'});
        expect(replyRes).toMatchObject({
            ok           : false,
            refused      : REFUSAL_CODES.replyClassificationUnresolved,
            primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE
        });
        expect(replyRes.reason).toContain(REPLY_CLASSIFICATION_PRIMARY_SOURCE);

        // `publish` also refuses `format: 'reply'`
        const reqReply = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000009',
            payload  : buildPayload({format: PUBLISH_FORMATS.reply, inReplyTo: 'tweet-third-party-123'})
        });
        const pubReplyRes = await publish(reqReply.requestId, reqReply.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqReply.requestId]: reqReply}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach}
        });
        expect(pubReplyRes).toMatchObject({
            ok           : false,
            state        : PUBLICATION_STATES.refused,
            refused      : REFUSAL_CODES.replyClassificationUnresolved,
            primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE
        });

        // `publish` refuses `format: 'link-reply'` targeting an unverified or third-party post,
        // and allows `format: 'link-reply'` when targeting an already-published parent on the same account
        const parentId  = 'MESSAGE:97900000-0000-4000-8000-000000000010';
        const parentReq = seedApprovedRequest({requestId: parentId});
        parentReq.publication.state      = PUBLICATION_STATES.published;
        parentReq.publication.providerId = 'tweet-parent-owned-555';

        const validLinkReply = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000011',
            payload  : buildPayload({
                format   : PUBLISH_FORMATS.linkReply,
                inReplyTo: parentId,
                text     : 'Read the full architecture guide: https://neomjs.com'
            })
        });

        const mailboxLink = createInMemoryMailbox({
            [parentId]                : parentReq,
            [validLinkReply.requestId]: validLinkReply
        });

        let   dispatchedInReplyTo = null;
        const okLinkReplyRes      = await publish(validLinkReply.requestId, validLinkReply.currentRevision.revisionDigest, {
            mailbox    : mailboxLink,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {
                async publishPost(call) {
                    dispatchedInReplyTo = call.inReplyTo;
                    return {providerId: 'tweet-self-reply-556'};
                }
            }
        });

        expect(okLinkReplyRes).toMatchObject({
            ok        : true,
            state     : PUBLICATION_STATES.published,
            providerId: 'tweet-self-reply-556'
        });
        expect(dispatchedInReplyTo).toBe('tweet-parent-owned-555');
    });

    test('AC-6: readMetrics returns the owned object metrics with source, window and claim class; an unavailable metric is unknown, never zero; maps X API v2 *_count fields and derives channel/account from the published record', async () => {
        const req     = seedApprovedRequest();
        const digest  = req.currentRevision.revisionDigest;
        const mailbox = createInMemoryMailbox({[REQ_ID]: req});

        const executor = createPublishExecutor({
            mailbox,
            credentials: {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now        : () => NOW_MS,
            platform   : {
                async publishPost(call) {
                    return {
                        providerId: 'tweet-189900112233',
                        readback  : {providerId: 'tweet-189900112233', text: call.text}
                    };
                },
                async readMetrics({providerId, channel, account}) {
                    expect(providerId).toBe('tweet-189900112233');
                    expect(channel).toBe('x');
                    expect(account).toBe('@neomjs');
                    return {
                        source        : 'x-v2-owned-object-metrics',
                        window        : '30d',
                        claimClass    : 'owned-object-telemetry',
                        public_metrics: {
                            impression_count: 1420,
                            like_count      : 38,
                            retweet_count   : 9,
                            reply_count     : 0
                        },
                        non_public_metrics: {
                            url_link_clicks    : 64,
                            // user_profile_clicks and engagements intentionally omitted / unavailable
                            user_profile_clicks: null
                        }
                    };
                }
            }
        });

        await executor.publish(REQ_ID, digest);

        // Call `readMetrics(providerId)` without passing `channel` or `account` — derived from the published record
        const xMetricsRes = await executor.readMetrics('tweet-189900112233');

        expect(xMetricsRes).toEqual({
            ok        : true,
            providerId: 'tweet-189900112233',
            channel   : 'x',
            account   : '@neomjs',
            source    : 'x-v2-owned-object-metrics',
            window    : '30d',
            claimClass: 'owned-object-telemetry',
            metrics   : {
                impressions        : 1420,
                likes              : 38,
                reposts            : 9,
                replies            : 0,
                quotes             : 'unknown',
                bookmarks          : 'unknown',
                url_link_clicks    : 64,
                user_profile_clicks: 'unknown',
                engagements        : 'unknown'
            }
        });
    });

    test('Fail-closed pre-dispatch and reconciliation seams: missing write verb, lost compare-and-set, rejected attestation text, missing mediaReader, stale caller digest, and pre-reservedAt reconciliation all fail closed', async () => {
        // Case 1: mailbox with `getMessage` but no `transitionPublishState` verb refuses and makes 0 platform calls
        const req1           = seedApprovedRequest();
        let   platformCalls1 = 0;
        const res1           = await publish(REQ_ID, req1.currentRevision.revisionDigest, {
            mailbox    : {async getMessage() { return req1; }},
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalls1++; return {providerId: 'never'}; }}
        });
        expect(res1.ok).toBe(false);
        expect(res1.refused).toBe(REFUSAL_CODES.publishingInFlight);
        expect(platformCalls1).toBe(0);

        // Case 2: `transitionPublishState` returns `false` (lost compare-and-set) -> refuses and makes 0 platform calls
        let   platformCalls2 = 0;
        const res2           = await publish(REQ_ID, req1.currentRevision.revisionDigest, {
            mailbox: {
                async getMessage() { return req1; },
                async transitionPublishState() { return false; }
            },
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalls2++; return {providerId: 'never'}; }}
        });
        expect(res2.ok).toBe(false);
        expect(res2.refused).toBe(REFUSAL_CODES.publishingInFlight);
        expect(platformCalls2).toBe(0);

        // Case 3: attested switch with a cross-family message "REJECTED: do not publish <digest>" refuses (`refused: attestation`)
        const payload3  = buildPayload({text: 'Candidate post under cross-family attestation.'});
        const digest3   = computePublishRevisionDigest(payload3);
        const reviewId3 = 'MESSAGE:97900000-0000-4000-8000-000000000333';
        const req3      = seedApprovedRequest({
            requestId  : 'MESSAGE:97900000-0000-4000-8000-000000000033',
            payload    : payload3,
            approved   : false,
            attestation: {reviewerMessageId: reviewId3, revisionDigest: digest3}
        });
        const mailbox3 = createInMemoryMailbox(
            {[req3.requestId]: req3},
            {[reviewId3]: {messageId: reviewId3, from: '@neo-gpt-sophie', body: `REJECTED: do not publish ${digest3}`}}
        );
        let   platformCalls3 = 0;
        const res3           = await publish(req3.requestId, digest3, {
            mailbox              : mailbox3,
            credentials          : {'x:@neomjs': {accessToken: SECRET}},
            switchStore          : {[`${PEER_ID}:x`]: SWITCH_STATES.autoApproveAttested},
            resolveIdentityFamily: async id => (id === PEER_ID ? 'claude' : 'gpt'),
            platform             : {async publishPost() { platformCalls3++; return {providerId: 'never'}; }}
        });
        expect(res3).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.attestation
        });
        expect(platformCalls3).toBe(0);

        // Case 4: one media descriptor with no `mediaReader` refuses (`refused: digest`);
        // with `mediaReader`, verified `{bytes: Buffer, sha256, mimeType}` (without `uri`) is passed to `publishPost`
        const mediaBytes4  = Buffer.from('verified-card-png-bytes', 'utf8');
        const mediaHash4   = crypto.createHash('sha256').update(mediaBytes4).digest('hex');
        const req4NoReader = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000044',
            payload  : buildPayload({
                media: [{uri: 'resources/card.png', sha256: mediaHash4, mimeType: 'image/png'}]
            })
        });
        let   platformCalls4 = 0;
        const res4NoReader   = await publish(req4NoReader.requestId, req4NoReader.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[req4NoReader.requestId]: req4NoReader}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalls4++; return {providerId: 'never'}; }}
        });
        expect(res4NoReader).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
        expect(platformCalls4).toBe(0);

        const req4WithReader = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000045',
            payload  : buildPayload({
                media: [{uri: 'resources/card.png', sha256: mediaHash4, mimeType: 'image/png'}]
            })
        });
        let   uploadedMedia4 = null;
        const res4WithReader = await publish(req4WithReader.requestId, req4WithReader.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[req4WithReader.requestId]: req4WithReader}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            mediaReader: async () => mediaBytes4,
            platform   : {
                async publishPost(call) {
                    uploadedMedia4 = call.media;
                    return {providerId: 'tweet-media-ok'};
                }
            }
        });
        expect(res4WithReader.ok).toBe(true);
        expect(uploadedMedia4).toHaveLength(1);
        expect(Buffer.isBuffer(uploadedMedia4[0].bytes)).toBe(true);
        expect(uploadedMedia4[0].bytes.equals(mediaBytes4)).toBe(true);
        expect(uploadedMedia4[0].sha256).toBe(mediaHash4);
        expect(uploadedMedia4[0].mimeType).toBe('image/png');
        expect(uploadedMedia4[0].uri).toBeUndefined();

        // Case 5: a call carrying a stale digest refuses the call without writing `refused` to the valid request,
        // so a subsequent call with the current revision's digest still publishes
        const req5 = seedApprovedRequest({
            requestId  : 'MESSAGE:97900000-0000-4000-8000-000000000055',
            textInitial: 'Draft v1 before edit',
            payload    : buildPayload({text: 'Approved v2 after edit'})
        });
        const mailbox5   = createInMemoryMailbox({[req5.requestId]: req5});
        const staleCall5 = await publish(req5.requestId, req5.revisions[0].revisionDigest, {
            mailbox    : mailbox5,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { return {providerId: 'never'}; }}
        });
        expect(staleCall5.ok).toBe(false);
        expect(staleCall5.refused).toBe(REFUSAL_CODES.digest);
        expect((await mailbox5.getMessage({messageId: req5.requestId})).publication.state).toBe(PUBLICATION_STATES.queued);

        const validCall5 = await publish(req5.requestId, req5.currentRevision.revisionDigest, {
            mailbox    : mailbox5,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { return {providerId: 'tweet-after-stale-call'}; }}
        });
        expect(validCall5).toMatchObject({
            ok        : true,
            state     : PUBLICATION_STATES.published,
            providerId: 'tweet-after-stale-call'
        });

        // Case 6: `publishing` reconciliation ignores an older post with identical text created BEFORE `reservedAt`,
        // and also treats multiple matching posts created at/after `reservedAt` as `unresolved`
        const req6Old = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000066'});
        req6Old.publication.state      = PUBLICATION_STATES.publishing;
        req6Old.publication.attemptId  = 'attempt-6-old';
        req6Old.publication.reservedAt = new Date(NOW_MS).toISOString();
        const mailbox6Old = createInMemoryMailbox({[req6Old.requestId]: req6Old});

        const res6Old = await publish(req6Old.requestId, req6Old.currentRevision.revisionDigest, {
            mailbox    : mailbox6Old,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now        : () => NOW_MS,
            platform   : {
                async listRecentPosts() {
                    return [
                        {
                            id       : 'tweet-from-yesterday',
                            text     : req6Old.currentRevision.payload.text,
                            createdAt: new Date(NOW_MS - 60_000).toISOString()
                        }
                    ];
                }
            }
        });
        expect(res6Old).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.unresolved,
            refused: REFUSAL_CODES.unresolved
        });

        const req6Multi = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000067'});
        req6Multi.publication.state      = PUBLICATION_STATES.publishing;
        req6Multi.publication.attemptId  = 'attempt-6-multi';
        req6Multi.publication.reservedAt = new Date(NOW_MS).toISOString();
        const mailbox6Multi = createInMemoryMailbox({[req6Multi.requestId]: req6Multi});

        const res6Multi = await publish(req6Multi.requestId, req6Multi.currentRevision.revisionDigest, {
            mailbox    : mailbox6Multi,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now        : () => NOW_MS,
            platform   : {
                async listRecentPosts() {
                    return [
                        {
                            id       : 'tweet-candidate-1',
                            text     : req6Multi.currentRevision.payload.text,
                            createdAt: new Date(NOW_MS + 1000).toISOString()
                        },
                        {
                            id       : 'tweet-candidate-2',
                            text     : req6Multi.currentRevision.payload.text,
                            createdAt: new Date(NOW_MS + 2000).toISOString()
                        }
                    ];
                }
            }
        });
        expect(res6Multi).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.unresolved,
            refused: REFUSAL_CODES.unresolved
        });

        // Non-blocking checks: channel-only switch key does not govern peers, and approval without revisionNumber is refused
        const reqUnapproved = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000068',
            approved : false
        });
        const channelOnlyRes = await publish(reqUnapproved.requestId, reqUnapproved.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqUnapproved.requestId]: reqUnapproved}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {x: SWITCH_STATES.autoApprove},
            platform   : {async publishPost() { return {providerId: 'never'}; }}
        });
        expect(channelOnlyRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.switch
        });

        const reqMissingRevNum = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000069'
        });
        delete reqMissingRevNum.currentRevision.approval.revisionNumber;
        const missingRevNumRes = await publish(reqMissingRevNum.requestId, reqMissingRevNum.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqMissingRevNum.requestId]: reqMissingRevNum}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { return {providerId: 'never'}; }}
        });
        expect(missingRevNumRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
    });

    test('Real MailboxService contract integration: createPublishExecutor drives MailboxService verbs end-to-end including t.co link-rewrite read-back and pre-dispatch refused -> queued re-queue', async () => {
        const mailboxAiConfig        = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;
        const GraphService           = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        const MailboxService         = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        const LifecycleService       = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        const {cleanupChromaManager} = await import('../memory-core/util.mjs');

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        try {
            GraphService.upsertNode({
            id        : '@tobiu',
            type      : 'AgentIdentity',
            name      : 'Tobi',
            properties: {accountType: 'human', trustTier: 'operator'}
        });
        GraphService.upsertNode({
            id        : '@neo-gemini-maryam',
            type      : 'AgentIdentity',
            name      : 'Maryam',
            properties: {accountType: 'agent', modelFamily: 'gemini'}
        });
        GraphService.upsertNode({
            id        : '@neo-opus-ada',
            type      : 'AgentIdentity',
            name      : 'Ada',
            properties: {accountType: 'agent', modelFamily: 'claude'}
        });

        // 1. Originating seat submits a `requestPublish` Task to `@tobiu`
        const initialPayload = buildPayload({
            text: 'Neo v13.2 ships the two-hemisphere Agent OS. Full architecture notes: https://neomjs.com/blog/agent-os'
        });
        const created = await RequestContextService.run({agentIdentityNodeId: '@neo-gemini-maryam'}, () =>
            MailboxService.addMessage({
                to            : '@tobiu',
                subject       : '[requestPublish] real MailboxService integration test',
                body          : initialPayload.text,
                taggedConcepts: ['requestPublish'],
                requestPublish: initialPayload
            })
        );
        const requestId  = created.messageId;
        const rev1Digest = created.revisionDigest;
        expect(rev1Digest).toBe(computePublishRevisionDigest(initialPayload));

        // 2. Cross-family review message containing a rejection verdict ("REJECTED: do not publish <digest>")
        // is refused by `MailboxService.attestPublishRevision`
        const rejectedReviewMsg = await RequestContextService.run({agentIdentityNodeId: '@neo-opus-ada'}, () =>
            MailboxService.addMessage({
                to     : '@tobiu',
                subject: `[requestPublish-review] REJECTED ${rev1Digest}`,
                body   : `REJECTED: do not publish ${rev1Digest}`
            })
        );
        await expect(
            RequestContextService.run({agentIdentityNodeId: '@neo-gemini-maryam'}, () =>
                MailboxService.attestPublishRevision({
                    taskId           : requestId,
                    reviewerMessageId: rejectedReviewMsg.messageId,
                    revisionDigest   : rev1Digest
                })
            )
        ).rejects.toMatchObject({code: 'refused: attestation'});

        // 3. Valid cross-family review message is accepted by `executor.attestRevision` and stamps structured `revisionDigest` on the review message node
        const validReviewMsg = await RequestContextService.run({agentIdentityNodeId: '@neo-opus-ada'}, () =>
            MailboxService.addMessage({
                to     : '@tobiu',
                subject: `[requestPublish-review] APPROVED ${rev1Digest}`,
                body   : `Verified claims and receipts for revisionDigest ${rev1Digest}`
            })
        );

        let   activeCredentials = {};
        const executor          = createPublishExecutor({
            mailbox: MailboxService,
            custody: {
                async readCredential({channel, account}) {
                    const token = activeCredentials[`${channel}:${account}`];
                    if (!token) {
                        return {
                            ok    : false,
                            code  : REFUSAL_CODES.credential,
                            reason: `${REFUSAL_CODES.credential} — no token configured`
                        };
                    }
                    return {ok: true, token, record: {channel, account}};
                }
            },
            switchStore          : {'@neo-gemini-maryam:x': SWITCH_STATES.approveEach},
            resolveIdentityFamily: async id => (id === '@neo-gemini-maryam' ? 'gemini' : 'claude'),
            now                  : () => NOW_MS,
            mintAttemptId        : () => 'attempt-real-mailbox-1',
            platform             : {
                async publishPost() {
                    return {
                        providerId: 'x-real-mailbox-9001',
                        readback  : {
                            providerId: 'x-real-mailbox-9001',
                            // X wraps links in https://t.co/... in read-back
                            text      : 'Neo v13.2 ships the two-hemisphere Agent OS. Full architecture notes: https://t.co/AbCdEf1234',
                            readbackAt: new Date(NOW_MS).toISOString()
                        }
                    };
                }
            }
        });

        await RequestContextService.run({agentIdentityNodeId: '@neo-gemini-maryam'}, () =>
            executor.attestRevision(requestId, {
                reviewerMessageId: validReviewMsg.messageId,
                revisionDigest   : rev1Digest
            })
        );
        const fetchedReviewMsg = await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            MailboxService.getMessage({messageId: validReviewMsg.messageId})
        );
        expect(fetchedReviewMsg.revisionDigest).toBe(rev1Digest);

        // 4. Operator approves Revision 1, then attempts publish while credential is missing -> pre-dispatch `refused: credential`
        await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            executor.approveRevision(requestId, rev1Digest)
        );
        const refusedNoCred = await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            executor.publish(requestId, rev1Digest)
        );
        expect(refusedNoCred).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.credential
        });

        // 5. Because `refused: credential` occurred pre-dispatch (no `publishing` reservation), operator can re-queue (`refused -> queued`)
        const requeued = await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            MailboxService.transitionPublishState({
                taskId  : requestId,
                newState: PUBLICATION_STATES.queued
            })
        );
        expect(requeued.publication.state).toBe(PUBLICATION_STATES.queued);

        // 6. Operator supplies the credential and publishes Revision 1 with X `https://t.co/...` link rewrite in read-back
        activeCredentials = {'x:@neomjs': SECRET};
        expect(
            matchesRequestedPublishText(
                'Neo v13.2 ships the two-hemisphere Agent OS. Full architecture notes: https://t.co/AbCdEf1234',
                initialPayload.text
            )
        ).toBe(true);

        const publishedRes = await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            executor.publish(requestId, rev1Digest)
        );
        expect(publishedRes).toMatchObject({
            ok             : true,
            state          : PUBLICATION_STATES.published,
            attemptId      : 'attempt-real-mailbox-1',
            revisionNumber : 1,
            revisionDigest : rev1Digest,
            providerId     : 'x-real-mailbox-9001',
            textAsRequested: initialPayload.text,
            textAsPublished: 'Neo v13.2 ships the two-hemisphere Agent OS. Full architecture notes: https://t.co/AbCdEf1234'
        });

        const storedAfterPublish = await RequestContextService.run({agentIdentityNodeId: '@tobiu'}, () =>
            MailboxService.getMessage({messageId: requestId})
        );
            expect(storedAfterPublish.publication).toMatchObject({
                state          : PUBLICATION_STATES.published,
                attemptId      : 'attempt-real-mailbox-1',
                providerId     : 'x-real-mailbox-9001',
                textAsRequested: initialPayload.text,
                textAsPublished: 'Neo v13.2 ships the two-hemisphere Agent OS. Full architecture notes: https://t.co/AbCdEf1234',
                reservation    : {
                    attemptId     : 'attempt-real-mailbox-1',
                    revisionNumber: 1,
                    revisionDigest: rev1Digest
                }
            });
        } finally {
            await cleanupChromaManager();
            if (mailboxAiConfig?.messageWal?.dir) {
                await fs.rm(mailboxAiConfig.messageWal.dir, {recursive: true, force: true});
            }
        }
    });

    test('#1267 AC-1: createSocialPlatformClient dispatches X v2 and LinkedIn HTTP calls (publishPost with in-memory verifiedMedia[].bytes, listRecentPosts with createdAt, readMetrics, and verifyOwnedPost)', async () => {
        const httpCalls  = [];
        const mediaBytes = Buffer.from('png-card-binary-payload-1267', 'utf8');
        const mediaHash  = crypto.createHash('sha256').update(mediaBytes).digest('hex');

        const mockFetch = async (url, init = {}) => {
            const urlStr = String(url);
            httpCalls.push({url: urlStr, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body});

            // X media upload
            if (urlStr === 'https://api.x.com/2/media/upload' && init.method === 'POST') {
                const parsed = JSON.parse(init.body);
                expect(parsed.media).toBe(mediaBytes.toString('base64'));
                expect(parsed.media_type).toBe('image/png');
                return {ok: true, status: 200, async json() { return {data: {id: 'x-media-701'}}; }};
            }

            // X post creation
            if (urlStr === 'https://api.x.com/2/tweets' && init.method === 'POST') {
                const parsed = JSON.parse(init.body);
                expect(parsed.media).toEqual({media_ids: ['x-media-701']});
                return {
                    ok    : true,
                    status: 201,
                    async json() {
                        return {
                            data: {
                                id        : 'tweet-http-1267',
                                text      : `${parsed.text} https://t.co/xyz987`,
                                created_at: '2026-10-25T02:01:00.000Z'
                            }
                        };
                    }
                };
            }

            // X tweet read-back / metrics / verifyOwnedPost
            if (urlStr.startsWith('https://api.x.com/2/tweets/tweet-http-1267')) {
                if (urlStr.includes('expansions=author_id')) {
                    return {
                        ok    : true,
                        status: 200,
                        async json() {
                            return {
                                data    : {id: 'tweet-http-1267', author_id: '4242'},
                                includes: {users: [{id: '4242', username: 'neomjs'}]}
                            };
                        }
                    };
                }
                if (urlStr.includes('non_public_metrics')) {
                    return {
                        ok    : true,
                        status: 200,
                        async json() {
                            return {
                                data: {
                                    id            : 'tweet-http-1267',
                                    public_metrics: {
                                        impression_count: 2500,
                                        like_count      : 91,
                                        retweet_count   : 18,
                                        reply_count     : 4,
                                        quote_count     : 2
                                    },
                                    non_public_metrics: {
                                        url_link_clicks: 112
                                    }
                                }
                            };
                        }
                    };
                }
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            data: {
                                id        : 'tweet-http-1267',
                                text      : 'Live X adapter post https://t.co/xyz987',
                                created_at: '2026-10-25T02:01:00.000Z'
                            }
                        };
                    }
                };
            }

            // X user lookup + recent tweets
            if (urlStr === 'https://api.x.com/2/users/by/username/neomjs') {
                return {ok: true, status: 200, async json() { return {data: {id: '4242', username: 'neomjs'}}; }};
            }
            if (urlStr.startsWith('https://api.x.com/2/users/4242/tweets')) {
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    id        : 'tweet-http-1267',
                                    text      : 'Live X adapter post',
                                    created_at: '2026-10-25T02:01:00.000Z'
                                }
                            ]
                        };
                    }
                };
            }

            // LinkedIn image initializeUpload + binary PUT + post creation + read-back + listRecentPosts + readMetrics
            if (urlStr === 'https://api.linkedin.com/rest/images?action=initializeUpload' && init.method === 'POST') {
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            value: {
                                uploadUrl: 'https://api.linkedin.com/mediaUpload/li-img-1',
                                image    : 'urn:li:image:990011'
                            }
                        };
                    }
                };
            }
            if (urlStr === 'https://api.linkedin.com/mediaUpload/li-img-1' && init.method === 'PUT') {
                expect(Buffer.isBuffer(init.body)).toBe(true);
                expect(init.body.equals(mediaBytes)).toBe(true);
                return {ok: true, status: 201, async json() { return {}; }};
            }
            if (urlStr === 'https://api.linkedin.com/rest/posts' && init.method === 'POST') {
                const parsed = JSON.parse(init.body);
                expect(parsed.author).toBe('urn:li:organization:neomjs-org');
                expect(parsed.content).toEqual({media: {id: 'urn:li:image:990011'}});
                return {
                    ok     : true,
                    status : 201,
                    headers: {get: name => (name.toLowerCase() === 'x-restli-id' ? 'urn:li:share:556677' : null)},
                    async json() { return {}; }
                };
            }
            if (urlStr === 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A556677' && init.method === 'GET') {
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            id         : 'urn:li:share:556677',
                            author     : 'urn:li:organization:neomjs-org',
                            commentary : 'Live LinkedIn adapter post',
                            publishedAt: Date.UTC(2026, 9, 25, 2, 2, 0)
                        };
                    }
                };
            }
            if (urlStr.startsWith('https://api.linkedin.com/rest/posts?author=')) {
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            elements: [
                                {
                                    id         : 'urn:li:share:556677',
                                    commentary : 'Live LinkedIn adapter post',
                                    publishedAt: Date.UTC(2026, 9, 25, 2, 2, 0)
                                }
                            ]
                        };
                    }
                };
            }
            if (urlStr.startsWith('https://api.linkedin.com/rest/organizationalEntityShareStatistics')) {
                return {
                    ok    : true,
                    status: 200,
                    async json() {
                        return {
                            elements: [
                                {
                                    totalShareStatistics: {
                                        impressionCount: 840,
                                        clickCount     : 47,
                                        likeCount      : 29,
                                        commentCount   : 5
                                    }
                                }
                            ]
                        };
                    }
                };
            }

            return {ok: false, status: 404, async json() { return {error: 'not-found'}; }};
        };

        const client = createSocialPlatformClient({fetch: mockFetch, now: () => NOW_MS});

        // 1. X publishPost uploads verified in-memory bytes directly without touching any disk path
        const xPublished = await client.publishPost({
            channel       : PUBLISH_CHANNELS.x,
            account       : '@neomjs',
            token         : SECRET,
            text          : 'Live X adapter post',
            media         : [{bytes: mediaBytes, sha256: mediaHash, mimeType: 'image/png'}],
            attemptId     : 'attempt-http-x',
            revisionDigest: 'd'.repeat(64)
        });
        expect(xPublished).toMatchObject({
            providerId: 'tweet-http-1267',
            createdAt : '2026-10-25T02:01:00.000Z',
            readback  : {
                providerId: 'tweet-http-1267',
                text      : 'Live X adapter post https://t.co/xyz987'
            }
        });

        // 2. X listRecentPosts returns createdAt timestamps; verifyOwnedPost checks author username
        const xRecent = await client.listRecentPosts({
            channel: PUBLISH_CHANNELS.x,
            account: '@neomjs',
            token  : SECRET
        });
        expect(xRecent).toEqual([
            {
                id        : 'tweet-http-1267',
                providerId: 'tweet-http-1267',
                text      : 'Live X adapter post',
                createdAt : '2026-10-25T02:01:00.000Z'
            }
        ]);
        expect(await client.verifyOwnedPost({
            channel   : PUBLISH_CHANNELS.x,
            account   : '@neomjs',
            providerId: 'tweet-http-1267',
            token     : SECRET
        })).toBe(true);
        expect(await client.verifyOwnedPost({
            channel   : PUBLISH_CHANNELS.x,
            account   : '@other-account',
            providerId: 'tweet-http-1267',
            token     : SECRET
        })).toBe(false);

        // 3. LinkedIn publishPost + listRecentPosts + verifyOwnedPost + readMetrics through executor
        const liPublished = await client.publishPost({
            channel: PUBLISH_CHANNELS.linkedin,
            account: 'neomjs-org',
            token  : 'li-token-1267',
            text   : 'Live LinkedIn adapter post',
            media  : [{bytes: mediaBytes, sha256: mediaHash, mimeType: 'image/png'}]
        });
        expect(liPublished).toMatchObject({
            providerId: 'urn:li:share:556677',
            createdAt : '2026-10-25T02:02:00.000Z',
            readback  : {
                providerId: 'urn:li:share:556677',
                text      : 'Live LinkedIn adapter post'
            }
        });

        const liRecent = await client.listRecentPosts({
            channel: PUBLISH_CHANNELS.linkedin,
            account: 'neomjs-org',
            token  : 'li-token-1267'
        });
        expect(liRecent).toEqual([
            {
                id        : 'urn:li:share:556677',
                providerId: 'urn:li:share:556677',
                text      : 'Live LinkedIn adapter post',
                createdAt : '2026-10-25T02:02:00.000Z'
            }
        ]);
        expect(await client.verifyOwnedPost({
            channel   : PUBLISH_CHANNELS.linkedin,
            account   : 'neomjs-org',
            providerId: 'urn:li:share:556677',
            token     : 'li-token-1267'
        })).toBe(true);

        const liMetrics = await readMetrics('urn:li:share:556677', {
            channel    : PUBLISH_CHANNELS.linkedin,
            account    : 'neomjs-org',
            credentials: {'linkedin:neomjs-org': {accessToken: 'li-token-1267'}},
            platform   : client
        });
        expect(liMetrics).toEqual({
            ok        : true,
            providerId: 'urn:li:share:556677',
            channel   : 'linkedin',
            account   : 'neomjs-org',
            source    : 'linkedin-community-management-api',
            window    : 'lifetime',
            claimClass: 'owned-object-telemetry',
            metrics   : {
                impressions      : 840,
                uniqueImpressions: 'unknown',
                clicks           : 47,
                likes            : 29,
                comments         : 5,
                shares           : 'unknown',
                engagement       : 'unknown'
            }
        });
        expect(httpCalls.length).toBeGreaterThanOrEqual(8);
    });

    test('#1267 AC-2: createFleetCustodyStore rotates expired X tokens via offline.access refreshToken, atomically persists rotated credentials with 0o600 permissions, and returns refused: credential without secret leakage when refresh fails', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-custody-1267-refresh-'));
        const xCredDir = path.join(tempRoot, 'social-credentials', 'x');
        const credFile = path.join(xCredDir, '_neomjs.json');
        await fs.mkdir(xCredDir, {recursive: true});

        const EXPIRED_ACCESS  = 'expired-x-access-token-111';
        const INITIAL_REFRESH = 'initial-x-refresh-token-222';
        const CLIENT_SECRET   = 'x-oauth-client-secret-333';
        const ROTATED_ACCESS  = 'rotated-x-access-token-444';
        const ROTATED_REFRESH = 'rotated-x-refresh-token-555';

        await fs.writeFile(
            credFile,
            JSON.stringify({
                accessToken : EXPIRED_ACCESS,
                refreshToken: INITIAL_REFRESH,
                clientId    : 'neo-x-client-id',
                clientSecret: CLIENT_SECRET,
                scopes      : ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
                expiresAt   : new Date(NOW_MS - 60_000).toISOString()
            }),
            {encoding: 'utf8', mode: 0o600}
        );

        try {
            let   refreshCalls = 0;
            const custodyOk    = createFleetCustodyStore({
                custodyDir: tempRoot,
                now       : () => NOW_MS,
                fetch     : async (url, init = {}) => {
                    refreshCalls++;
                    expect(url).toBe('https://api.x.com/2/oauth2/token');
                    expect(init.method).toBe('POST');
                    expect(init.body).toContain('grant_type=refresh_token');
                    expect(init.body).toContain(`refresh_token=${INITIAL_REFRESH}`);
                    const expectedBasic = Buffer.from(`neo-x-client-id:${CLIENT_SECRET}`).toString('base64');
                    expect(init.headers.Authorization).toBe(`Basic ${expectedBasic}`);

                    return {
                        ok    : true,
                        status: 200,
                        async json() {
                            return {
                                access_token : ROTATED_ACCESS,
                                refresh_token: ROTATED_REFRESH,
                                expires_in   : 7200
                            };
                        }
                    };
                }
            });

            const rotated = await custodyOk.readCredential({channel: PUBLISH_CHANNELS.x, account: '@neomjs'});
            expect(refreshCalls).toBe(1);
            expect(rotated).toMatchObject({
                ok     : true,
                rotated: true,
                token  : ROTATED_ACCESS,
                record : {
                    channel  : 'x',
                    account  : '@neomjs',
                    expiresAt: new Date(NOW_MS + 7200 * 1000).toISOString(),
                    updatedAt: new Date(NOW_MS).toISOString()
                }
            });

            // Verify atomic persistence on disk with 0o600 permissions and no leftover .tmp files
            const stat = await fs.stat(credFile);
            expect(stat.mode & 0o777).toBe(0o600);
            const dirEntries = await fs.readdir(xCredDir);
            expect(dirEntries).toEqual(['_neomjs.json']);

            const persisted = JSON.parse(await fs.readFile(credFile, 'utf8'));
            expect(persisted).toMatchObject({
                accessToken : ROTATED_ACCESS,
                refreshToken: ROTATED_REFRESH,
                expiresAt   : new Date(NOW_MS + 7200 * 1000).toISOString(),
                updatedAt   : new Date(NOW_MS).toISOString()
            });

            // When the refreshed token later expires and the refresh endpoint fails, returns `refused: credential` with zero secret leakage
            const custodyFail = createFleetCustodyStore({
                custodyDir: tempRoot,
                now       : () => NOW_MS + 8000 * 1000,
                fetch     : async () => ({
                    ok    : false,
                    status: 400,
                    async json() {
                        return {
                            error            : 'invalid_grant',
                            error_description: `Refresh token ${ROTATED_REFRESH} rejected for client secret ${CLIENT_SECRET} and bearer ${ROTATED_ACCESS}`
                        };
                    }
                })
            });

            const failedRefresh = await custodyFail.readCredential({
                channel: PUBLISH_CHANNELS.x,
                account: '@neomjs',
                nowMs  : NOW_MS + 8000 * 1000
            });
            expect(failedRefresh.ok).toBe(false);
            expect(failedRefresh.code).toBe(REFUSAL_CODES.credential);

            const serializedFailure = JSON.stringify(failedRefresh);
            for (const secret of [EXPIRED_ACCESS, INITIAL_REFRESH, CLIENT_SECRET, ROTATED_ACCESS, ROTATED_REFRESH]) {
                expect(serializedFailure).not.toContain(secret);
            }
        } finally {
            await fs.rm(tempRoot, {recursive: true, force: true});
        }
    });

    test('#1267 AC-3: FleetControlBridge exposes publish, readMetrics, and reply wired to MailboxService and <userData>/brain/fleet, with no MCP tool exposure to agent seats', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-bridge-1267-'));
        const xCredDir = path.join(tempRoot, 'social-credentials', 'x');
        await fs.mkdir(xCredDir, {recursive: true});
        await fs.writeFile(
            path.join(xCredDir, '_neomjs.json'),
            JSON.stringify({accessToken: SECRET, expiresAt: NOW_MS + 3600_000}),
            {encoding: 'utf8', mode: 0o600}
        );

        try {
            const req     = seedApprovedRequest();
            const digest  = req.currentRevision.revisionDigest;
            const mailbox = createInMemoryMailbox({[REQ_ID]: req});

            const composeWriter = wireOperatorComposeWriter({
                addMessage            : async () => ({}),
                getMessage            : arg => mailbox.getMessage(arg),
                transitionPublishState: arg => mailbox.transitionPublishState(arg)
            });

            const customExecutor = createPublishExecutor({
                mailbox    : composeWriter,
                custodyDir : tempRoot,
                switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
                now        : () => NOW_MS,
                platform   : {
                    async publishPost(call) {
                        return {
                            providerId: 'tweet-bridge-1267',
                            readback  : {providerId: 'tweet-bridge-1267', text: call.text}
                        };
                    },
                    async readMetrics() {
                        return {
                            source        : 'x-v2-owned-object-metrics',
                            window        : '30d',
                            claimClass    : 'owned-object-telemetry',
                            public_metrics: {impression_count: 512, like_count: 19}
                        };
                    }
                }
            });

            FleetControlBridge.composeWriter   = composeWriter;
            FleetControlBridge.publishExecutor = customExecutor;
            FleetControlBridge.registry        = {
                getDataDir: () => tempRoot
            };

            const pubOut = await FleetControlBridge.publish(REQ_ID, digest);
            expect(pubOut).toMatchObject({
                ok        : true,
                state     : PUBLICATION_STATES.published,
                providerId: 'tweet-bridge-1267'
            });

            // Also verify auto-derived executor when `publishExecutor` is not explicitly injected
            FleetControlBridge.publishExecutor = null;
            const idempotentViaCompose = await FleetControlBridge.publish({
                requestId     : REQ_ID,
                revisionDigest: digest
            });
            expect(idempotentViaCompose).toMatchObject({
                ok        : true,
                noop      : true,
                state     : PUBLICATION_STATES.published,
                providerId: 'tweet-bridge-1267'
            });

            FleetControlBridge.publishExecutor = customExecutor;
            const metricsOut = await FleetControlBridge.readMetrics('tweet-bridge-1267');
            expect(metricsOut).toMatchObject({
                ok        : true,
                providerId: 'tweet-bridge-1267',
                channel   : 'x',
                account   : '@neomjs'
            });
            expect(metricsOut.metrics.impressions).toBe(512);
            expect(metricsOut.metrics.likes).toBe(19);
            expect(metricsOut.metrics.url_link_clicks).toBe('unknown');

            const replyOut = await FleetControlBridge.reply({inReplyTo: 'tweet-third-party-1'});
            expect(replyOut).toMatchObject({
                ok           : false,
                refused      : REFUSAL_CODES.replyClassificationUnresolved,
                primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE
            });

            // Verify zero MCP tool exposure of `publish`, `readMetrics`, or `reply` across all agent-facing MCP OpenAPI specs
            const mcpSpecPaths = [
                '../../../../../../ai/mcp/server/memory-core/openapi.yaml',
                '../../../../../../ai/mcp/server/github-workflow/openapi.yaml',
                '../../../../../../ai/mcp/server/knowledge-base/openapi.yaml',
                '../../../../../../ai/mcp/server/neural-link/openapi.yaml'
            ];
            for (const relPath of mcpSpecPaths) {
                const absPath = path.resolve(import.meta.dirname, relPath);
                const content = await fs.readFile(absPath, 'utf8');
                expect(content).not.toMatch(/operationId:\s*(publish|readMetrics|reply)\b/);
            }
        } finally {
            FleetControlBridge.composeWriter   = null;
            FleetControlBridge.publishExecutor = null;
            FleetControlBridge.registry        = null;
            await fs.rm(tempRoot, {recursive: true, force: true});
        }
    });

    test('#1267 RA-1 & Observation-4: FleetControlBridge strips seam overrides from wire params and resolves readMetrics durably from MailboxService across executor instances', async () => {
        const unapprovedReq = seedApprovedRequest({
            approved: false
        });
        const digest  = unapprovedReq.currentRevision.revisionDigest;
        const mailbox = createInMemoryMailbox({[REQ_ID]: unapprovedReq});

        let   platformCalls  = 0;
        const customExecutor = createPublishExecutor({
            mailbox,
            credentials: {'x:@neomjs': SECRET},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now        : () => NOW_MS,
            platform   : {
                async publishPost() {
                    platformCalls += 1;
                    return {providerId: 'should-not-publish'};
                }
            }
        });

        try {
            FleetControlBridge.publishExecutor = customExecutor;

            // Attempt wire injection of switchStore: auto-approve and non-function platform override
            const bypassAttempt = await FleetControlBridge.publish({
                requestId     : REQ_ID,
                revisionDigest: digest,
                switchStore   : {[`${PEER_ID}:x`]: SWITCH_STATES.autoApprove},
                platform      : 'malicious-non-function',
                custody       : {readCredential: async () => ({ok: true, token: 'injected'})}
            });

            expect(bypassAttempt).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.switch
            });
            expect(platformCalls).toBe(0);

            // Verify durable readMetrics lookup from MailboxService on a fresh executor instance with no in-memory publishedByProviderId entry
            const publishedReq = seedApprovedRequest({
                payload: {
                    channel: PUBLISH_CHANNELS.linkedin,
                    account: 'urn:li:organization:998877',
                    format : PUBLISH_FORMATS.post,
                    text   : 'Published LinkedIn org post'
                }
            });
            publishedReq.publication.state      = PUBLICATION_STATES.published;
            publishedReq.publication.providerId = 'urn:li:share:55443322';
            const durableMailbox  = createInMemoryMailbox({[REQ_ID]: publishedReq});
            let   metricsCallArgs = null;
            const freshExecutor   = createPublishExecutor({
                mailbox    : durableMailbox,
                credentials: {'linkedin:urn:li:organization:998877': SECRET},
                now        : () => NOW_MS,
                platform   : {
                    async readMetrics(args) {
                        metricsCallArgs = args;
                        return {
                            source    : 'linkedin-community-management-api',
                            window    : 'lifetime',
                            claimClass: 'owned-object-telemetry',
                            statistics: {impressions: 900, likes: 45}
                        };
                    }
                }
            });

            FleetControlBridge.publishExecutor = freshExecutor;
            const metricsOut = await FleetControlBridge.readMetrics({
                providerId: 'urn:li:share:55443322',
                custody   : {readCredential: async () => ({ok: false, reason: 'injected-custody-must-be-ignored'})},
                platform  : 'injected-platform-must-be-ignored'
            });

            expect(metricsOut).toMatchObject({
                ok        : true,
                providerId: 'urn:li:share:55443322',
                channel   : PUBLISH_CHANNELS.linkedin,
                account   : 'urn:li:organization:998877'
            });
            expect(metricsCallArgs).toMatchObject({
                providerId: 'urn:li:share:55443322',
                channel   : PUBLISH_CHANNELS.linkedin,
                account   : 'urn:li:organization:998877'
            });
        } finally {
            FleetControlBridge.publishExecutor = null;
        }
    });

    test('#1267 RA-3 & RA-4: fleetCustodyStore single-flight refresh, 60s pre-expiry margin, non-clobbering concurrent bundle writes, and split module exports', async () => {
        expect(createFleetCustodyStoreDirect).toBe(createFleetCustodyStore);
        expect(createSocialPlatformClientDirect).toBe(createSocialPlatformClient);
        expect(X_REFRESH_MARGIN_MS).toBe(60_000);

        const tempRoot   = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-custody-ra3-'));
        const bundlePath = path.join(tempRoot, 'social-credentials.json');

        // Seed two accounts in the shared bundle:
        // - @neomjs expires 30s from NOW_MS (inside the 60s pre-expiry margin -> must rotate!)
        // - @neo-gemini-maryam is already expired -> must also rotate without clobbering @neomjs
        await fs.writeFile(
            bundlePath,
            JSON.stringify({
                'x:@neomjs': {
                    accessToken : 'old-access-neomjs',
                    refreshToken: 'old-refresh-neomjs',
                    expiresAt   : new Date(NOW_MS + 30_000).toISOString()
                },
                'x:@neo-gemini-maryam': {
                    accessToken : 'old-access-maryam',
                    refreshToken: 'old-refresh-maryam',
                    expiresAt   : new Date(NOW_MS - 5_000).toISOString()
                }
            }, null, 2),
            {encoding: 'utf8', mode: 0o600}
        );

        try {
            let neomjsRefreshCalls = 0;
            let maryamRefreshCalls = 0;

            const store = createFleetCustodyStoreDirect({
                custodyDir: tempRoot,
                now       : () => NOW_MS,
                fetch     : async (_url, init) => {
                    const params = new URLSearchParams(init.body);
                    const rt     = params.get('refresh_token');
                    await new Promise(resolve => setTimeout(resolve, 15));

                    if (rt === 'old-refresh-neomjs') {
                        neomjsRefreshCalls += 1;
                        return {
                            ok    : true,
                            status: 200,
                            async json() {
                                return {
                                    access_token : `new-access-neomjs-${neomjsRefreshCalls}`,
                                    refresh_token: `new-refresh-neomjs-${neomjsRefreshCalls}`,
                                    expires_in   : 7200
                                };
                            }
                        };
                    }

                    if (rt === 'old-refresh-maryam') {
                        maryamRefreshCalls += 1;
                        return {
                            ok    : true,
                            status: 200,
                            async json() {
                                return {
                                    access_token : `new-access-maryam-${maryamRefreshCalls}`,
                                    refresh_token: `new-refresh-maryam-${maryamRefreshCalls}`,
                                    expires_in   : 7200
                                };
                            }
                        };
                    }

                    return {ok: false, status: 400, async json() { return {error: 'unexpected_token'}; }};
                }
            });

            // Fire two concurrent reads for @neomjs (testing single-flight + 60s pre-expiry margin)
            // and one concurrent read for @neo-gemini-maryam (testing serialized non-clobbering bundle write)
            const [resNeomjs1, resNeomjs2, resMaryam] = await Promise.all([
                store.readCredential({channel: PUBLISH_CHANNELS.x, account: '@neomjs', nowMs: NOW_MS}),
                store.readCredential({channel: PUBLISH_CHANNELS.x, account: '@neomjs', nowMs: NOW_MS}),
                store.readCredential({channel: PUBLISH_CHANNELS.x, account: '@neo-gemini-maryam', nowMs: NOW_MS})
            ]);

            expect(neomjsRefreshCalls).toBe(1);
            expect(maryamRefreshCalls).toBe(1);
            expect(resNeomjs1).toMatchObject({ok: true, rotated: true, token: 'new-access-neomjs-1'});
            expect(resNeomjs2).toMatchObject({ok: true, rotated: true, token: 'new-access-neomjs-1'});
            expect(resMaryam).toMatchObject({ok: true, rotated: true, token: 'new-access-maryam-1'});

            // Verify both rotated accounts survived in social-credentials.json without clobbering one another
            const persistedBundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
            expect(persistedBundle['x:@neomjs'].accessToken).toBe('new-access-neomjs-1');
            expect(persistedBundle['x:@neomjs'].refreshToken).toBe('new-refresh-neomjs-1');
            expect(persistedBundle['x:@neo-gemini-maryam'].accessToken).toBe('new-access-maryam-1');
            expect(persistedBundle['x:@neo-gemini-maryam'].refreshToken).toBe('new-refresh-maryam-1');

            // Also verify POST /2/tweets sends only standard Authorization + Content-Type headers
            let   capturedTweetHeaders = null;
            const client               = createSocialPlatformClientDirect({
                now  : () => NOW_MS,
                fetch: async (_url, init) => {
                    if (init?.method === 'POST') {
                        capturedTweetHeaders = init.headers;
                    }
                    return {ok: true, status: 201, async json() { return {data: {id: 'tweet-hdr-1', text: 'hello'}}; }};
                }
            });
            await client.publishPost({
                channel       : PUBLISH_CHANNELS.x,
                account       : '@neomjs',
                format        : PUBLISH_FORMATS.post,
                text          : 'hello',
                token         : 'tok-1',
                attemptId     : 'attempt-hdr-1',
                revisionDigest: 'digest-hdr-1'
            });
            expect(capturedTweetHeaders).toEqual({
                'Authorization': 'Bearer tok-1',
                'Content-Type' : 'application/json'
            });
        } finally {
            await fs.rm(tempRoot, {recursive: true, force: true});
        }
    });
});
